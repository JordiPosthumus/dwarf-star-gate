// Read-only, allowlisted DS4 telemetry. Never retain raw journal messages.
import { createHash } from 'node:crypto';
import { safeRequestedThinking } from './requested-thinking.mjs';
import { CacheCosts } from './cache-cost.mjs';
const JOURNAL_ID=/^[\da-f]{32}$/i, WORKER_ID=/^[a-zA-Z0-9][\w-]{0,63}$/;

// A stock systemd invocation ID is the strongest existing process-lifetime
// boundary in the journal. The boot/PID fallback is explicitly weaker because
// PIDs can eventually be reused. Export only a domain-separated digest: raw OS
// identifiers never enter metrics, diagnostics or Genie evidence.
export function journalProcessEpoch(record, workerId) {
  if(!record||!WORKER_ID.test(workerId))return null;
  const invocation=typeof record._SYSTEMD_INVOCATION_ID==='string'&&JOURNAL_ID.test(record._SYSTEMD_INVOCATION_ID)?record._SYSTEMD_INVOCATION_ID.toLowerCase():null;
  const boot=typeof record._BOOT_ID==='string'&&JOURNAL_ID.test(record._BOOT_ID)?record._BOOT_ID.toLowerCase():null;
  const pid=typeof record._PID==='string'&&/^[1-9]\d{0,9}$/.test(record._PID)?record._PID:null;
  const source=invocation?'systemd_invocation':boot&&pid?'boot_pid_fallback':null;
  const identity=invocation??(source?`${boot}:${pid}`:null);
  if(!identity)return null;
  return {backend_epoch:createHash('sha256').update(`dsg-backend-epoch-v1\0${workerId}\0${source}\0${identity}`).digest('hex'),
    backend_epoch_source:source,backend_epoch_confidence:source==='systemd_invocation'?'strong':'bounded'};
}
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
  if (['complete', 'client_cancelled', 'upstream_error', 'upstream_stream_error', 'upstream_aborted', 'upstream_http_error', 'upstream_engine_error', 'incomplete_sse', 'sse_observation_limited', 'connection_closed', 'timeout'].includes(raw.outcome)) e.outcome = raw.outcome;
  else if (raw.outcome) e.outcome = 'other';
  for (const key of ['queue_ms', 'elapsed_ms']) if (Number.isFinite(raw[key]) && raw[key] >= 0) e[key] = raw[key];
  if (typeof raw.sse_done === 'boolean') e.sse_done = raw.sse_done;
  if (['terminal','terminal_without_done','terminal_without_finish_reason','terminal_reason_unobserved','engine_error','clean_eof_no_terminal','partial_sse_event','observation_limited'].includes(raw.stream_end)) e.stream_end = raw.stream_end;
  if (raw.requested_thinking) e.requested_thinking = safeRequestedThinking(raw.requested_thinking);
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
    const parsed = parseTiming(j.MESSAGE, time);
    if (!parsed)return null;
    const epoch=journalProcessEpoch(j,this.device.id);
    const e={...parsed,...(epoch??{backend_epoch:null,backend_epoch_source:null,backend_epoch_confidence:'unavailable'})};
    this.device.accept(e);
    return e;
  }
}

export class DeviceTelemetry {
  constructor(id) {
    this.costs=new CacheCosts();
    this.id = id; this.connected = false; this.observed_since = null; this.last_event = null;
    this.backend_epoch=null;this.backend_epoch_source=null;this.backend_epoch_confidence='unavailable';
    this.backend_epoch_observed_at=null;this.backend_epoch_changes=0;this.backend_epoch_evidence_gaps=0;this.cache_observed_since=null;
    this.phase = 'unknown'; this.decode = null; this.prefill = null; this.prompt = null;
    this.cache = { starts: 0, reused: 0, cold: 0, resident_misses: 0, disk_restores: 0 };
    this.series = []; this.recent = []; this.pending_disk = null; this.current = null;
  }
  observeEpoch(e) {
    const id=typeof e.backend_epoch==='string'&&/^[\da-f]{64}$/.test(e.backend_epoch)?e.backend_epoch:null;
    const source=['systemd_invocation','boot_pid_fallback','local_listen_marker'].includes(e.backend_epoch_source)?e.backend_epoch_source:null;
    const confidence=['strong','bounded'].includes(e.backend_epoch_confidence)?e.backend_epoch_confidence:null;
    if(!id||!source||!confidence){this.backend_epoch_evidence_gaps=Math.min(Number.MAX_SAFE_INTEGER,this.backend_epoch_evidence_gaps+1);return false;}
    if(id===this.backend_epoch)return true;
    const changed=!!this.backend_epoch;
    this.backend_epoch=id;this.backend_epoch_source=source;this.backend_epoch_confidence=confidence;
    this.backend_epoch_observed_at=e.time;this.cache_observed_since=e.time;
    if(changed)this.backend_epoch_changes=Math.min(Number.MAX_SAFE_INTEGER,this.backend_epoch_changes+1);
    // A process boundary invalidates spans and learned component samples. It
    // does not touch DS4, its cache files, the service, routing or inference.
    this.costs=new CacheCosts(id,confidence);this.phase='unknown';this.decode=null;this.prefill=null;this.prompt=null;
    this.cache={starts:0,reused:0,cold:0,resident_misses:0,disk_restores:0};
    this.series=[];this.recent=[];this.pending_disk=null;this.current=null;
    return true;
  }
  accept(e) {
    if (!e) return;
    const journalEvent=Object.hasOwn(e,'backend_epoch');
    const attributable=!journalEvent||this.observeEpoch(e);
    if(attributable)this.costs.accept(e);
    this.observed_since ??= e.time; this.last_event = e.time;
    this.cache_observed_since??=e.time;
    if (e.kind === 'resident_miss'&&attributable) this.cache.resident_misses++;
    if (e.kind === 'disk_restore'&&attributable) { this.cache.disk_restores++; this.pending_disk = e; }
    if (e.kind === 'start') {
      this.phase = 'prefill';
      if(attributable){this.cache.starts++;e.cached > 0 ? this.cache.reused++ : this.cache.cold++;}
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
    const { current, pending_disk, costs, ...visible } = this;
    return {...visible,cache_cost:costs.snapshot()};
  }
}
