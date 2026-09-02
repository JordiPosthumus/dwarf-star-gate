const $ = id => document.getElementById(id);
const fmt = n => Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: 1 }) : '—';
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const age = (time, now) => !time ? 'no sample yet' : now - time < 5000 ? 'just now' : now - time < 60000 ? `${Math.floor((now-time)/1000)}s ago` : `${Math.floor((now-time)/60000)}m ago`;
const clock = t => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
function thinkingInfo(t) {
  if (!t) return { label:'Unavailable', detail:'This request predates thinking telemetry, or no request has been observed.' };
  if (t.status === 'pending') return { label:'Reading request', detail:'Waiting for the request upload to finish.' };
  if (t.status === 'not_specified') return { label:'Not specified', detail:'No recognized thinking fields were supplied. The server chooses its default.' };
  if (t.status !== 'specified') return { label:'Unknown', detail:({capture_limit:'Upload exceeded the 8 MiB metadata observation budget. The full request still passes through unchanged.',encoded_body:'Encoded request body; not inspected.',invalid_json:'Request metadata could not be parsed.',incomplete_body:'Request upload did not finish.'})[t.reason] || 'Requested thinking metadata unavailable.' };
  const f = t.fields || {}, values = Object.values(f), parts = [];
  const efforts = [...new Set(['reasoning_effort','reasoning.effort','output_config.effort'].map(k=>f[k]).filter(v=>typeof v==='string' && v!=='unrecognized'))];
  const modes = [...new Set([f.thinking, f.enable_thinking, f['thinking.type']].map(v=>v===true || v==='enabled' ? 'ON' : v===false || v==='disabled' ? 'OFF' : v==='adaptive' ? 'ADAPTIVE' : null).filter(Boolean))];
  parts.push(...modes, ...efforts.map(v=>v.toUpperCase()));
  if (Number.isSafeInteger(f['thinking.budget_tokens'])) parts.push(`${fmt(f['thinking.budget_tokens'])} token budget`);
  if (values.includes('unrecognized')) parts.push('Unrecognized field');
  const detail = Object.entries(f).map(([k,v])=>`${k}=${v}`).join('; ');
  return { label:parts.join(' · ') || (values.length ? 'Not set' : 'Unknown'), detail:`${detail}. Requested settings only—not proof of the engine's effective level. Multiple controls are shown without assuming precedence.` };
}
function thinkingIndicator(w, stale, now) {
  const info = thinkingInfo(w?.load ? w.requested_thinking : w?.last_requested_thinking);
  const scope = stale ? 'Historical snapshot' : w?.load ? 'Current request' : w?.last_request_finished_at ? `Last request · ${age(Date.parse(w.last_request_finished_at),now)}` : 'No active request';
  return `<div class="requested-thinking"><span class="label">REQUESTED THINKING</span><strong title="${esc(info.detail)}">${esc(info.label)}</strong><span class="thinking-scope">${esc(scope)}</span></div>`;
}
function chart(series, kind, now) {
  const values = series.filter(s => s.kind === kind && now - s.time < 900000);
  const max = Math.max(1, ...values.map(s => s.tps));
  const points = values.map(s => `${((s.time - (now - 900000)) / 900000 * 300).toFixed(1)},${(48 - s.tps / max * 40).toFixed(1)}`).join(' ');
  return `<svg class="chart ${kind}" viewBox="0 0 300 55" preserveAspectRatio="none" role="img" aria-label="${kind} last 15 minutes, scale zero to ${Math.ceil(max)} tokens per second"><line x1="0" y1="48" x2="300" y2="48"/><polyline points="${points}"/></svg>`;
}
function device(d, w, now, stale) {
  const state = stale ? 'status stale' : !w ? 'unknown' : !w.is_healthy ? 'unhealthy' : w.drained ? 'drained' : w.load ? d.connected && now - d.last_event < 30000 ? d.phase : 'working' : 'idle';
  const bad = stale || !w?.is_healthy;
  const metric = (kind, title) => {
    const m = d[kind];
    return `<div><span class="label">${title}</span><div class="rate ${kind}">${fmt(m?.tps)}<em>t/s</em></div><div class="metric-note">avg ${fmt(m?.average)} · ${age(m?.time, now)}</div>${chart(d.series, kind, now)}<div class="chart-caption">15m · zero-based, independent scale</div></div>`;
  };
  const prompt = d.prompt ? `Last prompt: ${fmt(d.prompt.prompt)} tokens · ${fmt(d.prompt.cached)} reused · ${esc(d.prompt.cache)}` : 'No prompt start observed yet';
  return `<article class="device"><div class="device-top"><div class="device-name"><span class="device-number">${esc(d.id.replace('spark','').padStart(2,'0'))}</span>${esc(d.id.replace(/^spark/, 'Spark '))}</div><span class="badge ${bad ? 'bad' : w?.load ? 'busy' : ''}">${esc(state)}</span></div>${thinkingIndicator(w,stale,now)}<div class="metrics">${metric('decode','DECODE')}${metric('prefill','PREFILL')}</div><p class="prompt-note">${prompt}</p><div class="cache"><div><strong>${fmt(d.cache.reused)}</strong><span>Prefix reused</span></div><div><strong>${fmt(d.cache.cold)}</strong><span>Cold starts</span></div><div><strong>${fmt(d.cache.resident_misses)}</strong><span>Resident misses</span></div><div><strong>${fmt(d.cache.disk_restores)}</strong><span>Disk restores</span></div></div><p class="cache-note">Observed since ${d.observed_since ? clock(d.observed_since) : 'connecting'} · RAM misses ≠ cold starts</p><div class="device-foot"><span>${fmt(w?.queued)} queued · ${fmt(w?.assigned_sessions)} assigned sessions</span><span>${d.connected ? 'Journal connected' : 'Journal disconnected'} · ${w?.load ? `${fmt(w.active_seconds)}s active` : 'last sample '+age(d.last_event,now)}</span></div></article>`;
}
function render(s) {
  const g = s.gateway, now = s.time, stale = !!s.gateway_error;
  $('connection').textContent = s.demo ? '◉ Demo telemetry' : stale ? 'Status unavailable' : '● Live telemetry';
  $('warning').hidden = !s.gateway_error && !s.telemetry_error;
  $('warning').textContent = [s.gateway_error,s.telemetry_error].filter(Boolean).join(' · ');
  $('model').textContent = s.demo ? `${g?.model || 'DS4'} · illustrative data · no workers connected` : `${g?.model || 'DS4'} · one active generation per Spark · session-affinity routing`;
  $('available').textContent = g ? `${g.available} / ${g.total}` : '—'; $('active').textContent = fmt(g?.active); $('queued').textContent = fmt(g?.queued); $('context').textContent = g ? `${fmt(g.context_length / 1024)} Ki tokens` : '—';
  $('devices').innerHTML = s.devices.map(d => device(d,g?.workers.find(w => w.id === d.id),now,stale)).join('');
  const rows = s.events.filter(e => e.event === 'request_finished').slice(-12).reverse();
  $('requests').innerHTML = rows.length ? rows.map(e => `<tr><td>${e.time ? clock(e.time) : '—'}</td><td>${esc(e.node)}</td><td class="${e.outcome === 'complete' ? 'success' : e.outcome === 'client_cancelled' ? 'cancelled' : 'failure'}">${esc(e.outcome?.replaceAll('_',' ') || 'unknown')}</td><td>${fmt(e.elapsed_ms / 1000)}s</td><td>${fmt(e.queue_ms)}ms</td><td>${fmt(e.usage?.cached_tokens)} / ${fmt(e.usage?.prompt_tokens)}</td><td>${fmt(e.usage?.completion_tokens)}</td><td class="mono" title="${esc(e.request_id)}">${esc(e.request_id?.slice(0,8))}</td></tr>`).join('') : '<tr><td colspan="8" class="muted">No request completions in the observed log tail.</td></tr>';
  $('updated').textContent = `Gateway checked ${s.gateway_at ? clock(s.gateway_at) : '—'} · dashboard started ${clock(s.started)}`;
}
async function poll() {
  try { const r = await fetch('/api/status', { cache: 'no-store', signal: AbortSignal.timeout(5000) }); if (!r.ok) throw new Error(); render(await r.json()); }
  catch { $('connection').textContent = 'Disconnected'; $('warning').hidden = false; $('warning').textContent = 'Dashboard connection lost. Values below are historical, not live.'; }
  finally { setTimeout(poll, document.hidden ? 10000 : 2000); }
}
poll();
