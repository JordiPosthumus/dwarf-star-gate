// Read-only, allowlisted DS4 telemetry. Never retain raw journal messages.
export function parseTiming(message, time = Date.now()) {
  if (typeof message !== 'string' || !message.includes('ds4-server:')) return null;
  let m;
  if ((m = message.match(/ctx=(\d+)\.\.(\d+):(\d+).*?prefill chunk (\d+)\/(\d+) \([\d.]+%\) chunk=([\d.]+) t\/s avg=([\d.]+) t\/s ([\d.]+)s/)))
    return { time, kind: 'prefill', cached: +m[1], prompt: +m[2], processed: +m[4], total: +m[5], tps: +m[6], average: +m[7], seconds: +m[8] };
  if ((m = message.match(/gen=(\d+).*?decoding chunk=([\d.]+) t\/s avg=([\d.]+) t\/s ([\d.]+)s/)))
    return { time, kind: 'decode', generated: +m[1], tps: +m[2], average: +m[3], seconds: +m[4], thinking: message.includes(' THINKING') };
  if ((m = message.match(/ctx=(\d+)\.\.(\d+):(\d+).*?prompt start/)))
    return { time, kind: 'start', cached: +m[1], prompt: +m[2], new_tokens: +m[3] };
  if ((m = message.match(/ctx=(\d+)\.\.(\d+):(\d+).*?prompt done ([\d.]+)s/)))
    return { time, kind: 'prefill_done', cached: +m[1], prompt: +m[2], new_tokens: +m[3], seconds: +m[4], average: +m[4] > 0 ? +m[3] / +m[4] : null };
  if ((m = message.match(/gen=(\d+).*?finish=(\w+)/)))
    return { time, kind: 'finish', generated: +m[1], outcome: ['stop', 'length', 'tool_calls', 'error', 'cancelled'].includes(m[2]) ? m[2] : 'other' };
  if (message.includes('live kv cache miss')) return { time, kind: 'resident_miss' };
  if ((m = message.match(/kv cache hit .*?tokens=(\d+).*?load=([\d.]+) ms/)))
    return { time, kind: 'disk_restore', cached: +m[1], load_ms: +m[2] };
  return null;
}

export function safeGatewayEvent(raw) {
  if (!raw || !['request_dispatched', 'request_finished'].includes(raw.event)) return null;
  const e = { event: raw.event };
  if (typeof raw.time === 'string' && Number.isFinite(Date.parse(raw.time))) e.time = raw.time;
  if (typeof raw.node === 'string' && /^[\w-]{1,64}$/.test(raw.node)) e.node = raw.node;
  if (typeof raw.request_id === 'string' && /^[\da-f-]{36}$/.test(raw.request_id)) e.request_id = raw.request_id;
  if (typeof raw.session === 'string' && /^[\da-f]{12}$/.test(raw.session)) e.session = raw.session;
  if (['new', 'existing', 'none', 'reassigned'].includes(raw.affinity)) e.affinity = raw.affinity;
  if (['complete', 'client_cancelled', 'upstream_error', 'upstream_stream_error', 'upstream_aborted', 'upstream_http_error', 'incomplete_sse', 'connection_closed', 'timeout'].includes(raw.outcome)) e.outcome = raw.outcome;
  else if (raw.outcome) e.outcome = 'other';
  for (const key of ['queue_ms', 'elapsed_ms']) if (Number.isFinite(raw[key]) && raw[key] >= 0) e[key] = raw[key];
  if (typeof raw.sse_done === 'boolean') e.sse_done = raw.sse_done;
  if (Number.isInteger(raw.detail)) e.http_status = raw.detail;
  if (raw.usage) {
    e.usage = {};
    for (const key of ['prompt_tokens', 'completion_tokens', 'cached_tokens'])
      if (Number.isFinite(raw.usage[key]) && raw.usage[key] >= 0) e.usage[key] = raw.usage[key];
  }
  return e;
}

// Bounded cursor deduplication across a reader reconnect. Cursor is never shell input
// until it has passed this strict character/length validation.
export class JournalReader {
  constructor(device) { this.device = device; this.seen = new Set(); this.cursor = null; this.last_time = null; }
  accept(j) {
    const cursor = j?.__CURSOR;
    if (typeof cursor !== 'string' || !/^[\da-z=;_-]{1,1024}$/.test(cursor) || this.seen.has(cursor)) return null;
    const time = Number(j.__REALTIME_TIMESTAMP) / 1000;
    if (!Number.isFinite(time) || time <= 0) return null;
    this.cursor = cursor; this.last_time = time; this.seen.add(cursor);
    if (this.seen.size > 5000) this.seen.delete(this.seen.values().next().value);
    const e = parseTiming(j.MESSAGE, time);
    if (e) this.device.accept(e);
    return e;
  }
}

export class DeviceTelemetry {
  constructor(id) {
    this.id = id; this.connected = false; this.observed_since = null; this.last_event = null;
    this.phase = 'unknown'; this.decode = null; this.prefill = null; this.prompt = null;
    this.cache = { starts: 0, reused: 0, cold: 0, resident_misses: 0, disk_restores: 0 };
    this.series = []; this.recent = []; this.pending_disk = null; this.current = null;
  }
  accept(e) {
    if (!e) return;
    this.observed_since ??= e.time; this.last_event = e.time;
    if (e.kind === 'resident_miss') this.cache.resident_misses++;
    if (e.kind === 'disk_restore') { this.cache.disk_restores++; this.pending_disk = e; }
    if (e.kind === 'start') {
      this.phase = 'prefill'; this.cache.starts++;
      e.cached > 0 ? this.cache.reused++ : this.cache.cold++;
      const disk = this.pending_disk && e.time - this.pending_disk.time < 60000;
      this.prompt = { ...e, cache: e.cached === 0 ? 'cold' : disk ? 'disk restore' : 'prefix reuse' };
      this.pending_disk = null; this.current = { time: e.time, generated: 0 };
    }
    if (e.kind === 'prefill' && e.processed > 0) { this.prefill = e; this.phase = 'prefill'; }
    if (e.kind === 'prefill_done') {
      // Keep the engine's rounded average where present; otherwise derive from new tokens only.
      this.prefill = { ...e, tps: this.prefill?.time >= (this.current?.time ?? e.time) ? this.prefill.tps : e.average };
      this.phase = 'decode';
    }
    if (e.kind === 'decode') { this.decode = e; this.phase = e.thinking ? 'thinking' : 'decode'; }
    if (e.kind === 'finish') this.phase = 'idle';
    if ((e.kind === 'decode' || e.kind === 'prefill') && e.tps > 0) {
      this.series.push({ time: e.time, kind: e.kind, tps: e.tps });
      this.series = this.series.filter(s => e.time - s.time < 15 * 60000).slice(-180);
    }
    if (!['decode', 'prefill'].includes(e.kind)) { this.recent.push(e); this.recent = this.recent.slice(-30); }
  }
  snapshot() {
    const { current, pending_disk, ...visible } = this;
    return visible;
  }
}
