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
function telemetryStatus(d) {
  if (d.telemetry_configured === false) return 'Engine timings not configured';
  return `${d.telemetry_source === 'file' ? 'Model log' : 'Journal'} ${d.connected ? 'connected' : 'disconnected'}`;
}
function device(d, w, now, stale, index = 1) {
  const state = stale ? 'status stale' : !w ? 'unknown' : !w.is_healthy ? 'unhealthy' : w.drained ? 'drained' : w.load ? d.connected && now - d.last_event < 30000 ? d.phase : 'working' : 'idle';
  const bad = stale || !w?.is_healthy;
  const metric = (kind, title) => {
    const m = d[kind];
    return `<div><span class="label">${title}</span><div class="rate ${kind}">${fmt(m?.tps)}<em>t/s</em></div><div class="metric-note">avg ${fmt(m?.average)} · ${age(m?.time, now)}</div>${chart(d.series, kind, now)}<div class="chart-caption">15m · zero-based, independent scale</div></div>`;
  };
  const prompt = d.prompt ? `Last prompt: ${fmt(d.prompt.prompt)} tokens · ${fmt(d.prompt.cached)} reused · ${esc(d.prompt.cache)}` : 'No prompt start observed yet';
  return `<article class="device"><div class="device-top"><div class="device-name"><span class="device-number">${String(index).padStart(2,'0')}</span>${esc(d.id.replace(/^spark/, 'Spark '))}</div><span class="badge ${bad ? 'bad' : w?.load ? 'busy' : ''}">${esc(state)}</span></div>${thinkingIndicator(w,stale,now)}<div class="metrics">${metric('decode','DECODE')}${metric('prefill','PREFILL')}</div><p class="prompt-note">${prompt}</p><div class="cache"><div><strong>${fmt(d.cache.reused)}</strong><span>Prefix reused</span></div><div><strong>${fmt(d.cache.cold)}</strong><span>Cold starts</span></div><div><strong>${fmt(d.cache.resident_misses)}</strong><span>Resident misses</span></div><div><strong>${fmt(d.cache.disk_restores)}</strong><span>Disk restores</span></div></div><p class="cache-note">Observed since ${d.observed_since ? clock(d.observed_since) : 'connecting'} · RAM misses ≠ cold starts</p><div class="device-foot"><span>${fmt(w?.queued)} queued · ${fmt(w?.assigned_sessions)} assigned sessions</span><span>${telemetryStatus(d)} · ${w?.load ? `${fmt(w.active_seconds)}s active` : 'last sample '+age(d.last_event,now)}</span></div></article>`;
}
function render(s) {
  const g = s.gateway, now = s.time, stale = !!s.gateway_error;
  $('connection').textContent = s.demo ? '◉ Demo telemetry' : stale ? 'Status unavailable' : '● Live telemetry';
  $('warning').hidden = !s.gateway_error && !s.telemetry_error;
  $('warning').textContent = [s.gateway_error,s.telemetry_error].filter(Boolean).join(' · ');
  $('model').textContent = s.demo ? `${g?.model || 'DS4'} · illustrative data · no real DS4 servers connected` : `${g?.model || 'DS4'} · one active gateway request per DS4 server · session-affinity routing`;
  $('available').textContent = g ? `${g.available} / ${g.total}` : '—'; $('active').textContent = fmt(g?.active); $('queued').textContent = fmt(g?.queued); $('context').textContent = g ? `${fmt(g.context_length / 1024)} Ki tokens` : '—';
  $('devices').innerHTML = s.devices.map((d,i) => device(d,g?.workers.find(w => w.id === d.id),now,stale,i+1)).join('');
  $('worker-management').hidden = !s.worker_management;
  $('control-mode').textContent = s.worker_management ? '[ server controls ]' : '[ read only ]';
  $('control-note').textContent = 'Model settings unchanged.';
  if(s.worker_management) { wireWorkerControls(); void loadWorkers(); }
  const rows = s.events.filter(e => e.event === 'request_finished').slice(-12).reverse();
  $('requests').innerHTML = rows.length ? rows.map(e => `<tr><td>${e.time ? clock(e.time) : '—'}</td><td>${esc(e.node)}</td><td class="${e.outcome === 'complete' ? 'success' : e.outcome === 'client_cancelled' ? 'cancelled' : 'failure'}">${esc(e.outcome?.replaceAll('_',' ') || 'unknown')}</td><td>${fmt(e.elapsed_ms / 1000)}s</td><td>${fmt(e.queue_ms)}ms</td><td>${fmt(e.usage?.cached_tokens)} / ${fmt(e.usage?.prompt_tokens)}</td><td>${fmt(e.usage?.completion_tokens)}</td><td class="mono" title="${esc(e.request_id)}">${esc(e.request_id?.slice(0,8))}</td></tr>`).join('') : '<tr><td colspan="8" class="muted">No request completions in the observed log tail.</td></tr>';
  $('updated').textContent = `Gateway checked ${s.gateway_at ? clock(s.gateway_at) : '—'} · dashboard started ${clock(s.started)}`;
}
async function poll() {
  try { const r = await fetch('/api/status', { cache: 'no-store', signal: AbortSignal.timeout(5000) }); if (!r.ok) throw new Error(); render(await r.json()); }
  catch { $('connection').textContent = 'Disconnected'; $('warning').hidden = false; $('warning').textContent = 'Dashboard connection lost. Values below are historical, not live.'; }
  finally { setTimeout(poll, document.hidden ? 10000 : 2000); }
}
let controlsWired = false, workerBusy = false, workersLoading = false, csrfToken = null;
let contextDirty=false, contextExpected=null;
function workerMessage(text, error = false) {
  $('worker-message').textContent = text; $('worker-message').classList.toggle('error',error);
}
function workerRows(workers) {
  return workers.map(w=>{
    const busy=!!w.load || w.queued>0;
    const routing=w.drained ? busy ? 'Draining' : 'Paused' : w.is_healthy ? 'Enabled' : 'Unavailable';
    const id=esc(w.id);
    return `<tr><td>${id}</td><td>${fmt(w.context_length)}</td><td>${routing}</td><td>${fmt(w.load)} / ${fmt(w.queued)}</td><td class="worker-actions"><button class="button" data-action="${w.drained?'resume':'drain'}" data-id="${id}" ${workerBusy || (w.drained&&!w.is_healthy)?'disabled':''}>${w.drained?'Enable':'Drain'}</button><button class="button" data-action="remove" data-id="${id}" ${workerBusy||!w.drained||busy?'disabled':''}>Remove</button></td></tr>`;
  }).join('') || '<tr><td colspan="5">No workers registered.</td></tr>';
}
async function loadWorkers() {
  if(workersLoading||workerBusy)return;
  workersLoading=true;
  try {
    const r=await fetch('/api/workers',{cache:'no-store',signal:AbortSignal.timeout(5000)}), data=await r.json();
    if(!r.ok||!data.enabled)throw new Error(data.error||'Worker controls unavailable');
    csrfToken=data.csrf_token; $('worker-rows').innerHTML=workerRows(data.workers);
    $('pool-context-form').hidden=!data.context_limit_control;
    $('pool-context-note').hidden=!data.context_limit_control;
    if(!contextDirty){contextExpected=data.minimum_context;$('pool-context-input').value=String(data.minimum_context);}
  } catch(e) { workerMessage(e.message,true); }
  finally { workersLoading=false; }
}
async function workerAction(action, input) {
  if(workerBusy)return;
  if(!csrfToken){workerMessage('Worker controls are connecting; try again shortly.',true);return;}
  workerBusy=true;
  $('worker-form').querySelector('button').disabled=true;
  $('pool-context-form').querySelector('button').disabled=true;
  $('worker-rows').querySelectorAll('button').forEach(b=>{b.disabled=true;});
  workerMessage(action==='context'?'Checking enabled server capacities…':action==='add'?'Checking model and context…':'Updating worker routing…');
  try {
    const r=await fetch(`/api/workers/${action}`,{method:'POST',headers:{'content-type':'application/json','x-dsg-csrf':csrfToken},body:JSON.stringify(input),signal:AbortSignal.timeout(35000)});
    const data=await r.json();if(!r.ok)throw new Error(data.error||'Worker control failed');
    workerMessage(action==='context'?`Pool limit saved: ${fmt(data.minimum_context)} tokens. Applied now; model servers and Pi unchanged.`:action==='add'?'Registered paused. Enable routing when ready.':action==='drain'?'Draining. Admitted requests will finish before removal.':action==='remove'?'Removed from this gateway. Model server left running.':'Routing enabled.');
    if(action==='context'){contextDirty=false;contextExpected=data.minimum_context;}
    if(action==='add')$('worker-form').reset();
  } catch(e) { workerMessage(`${e.message}. Check the worker list before retrying.`,true); }
  finally { workerBusy=false;$('worker-form').querySelector('button').disabled=false;$('pool-context-form').querySelector('button').disabled=false;updateConnectionFields();void loadWorkers(); }
}
function updateConnectionFields() {
  const form=$('worker-form'), remote=form.elements.connection.value==='ssh';
  $('ssh-host-field').hidden=!remote;$('remote-port-field').hidden=!remote;
  form.elements.ssh.disabled=!remote;form.elements.ssh.required=remote;form.elements.remote_port.disabled=!remote;
  $('endpoint-label').textContent=remote?'Local tunnel URL (free port)':'Local server URL';
  form.elements.url.placeholder=remote?'http://127.0.0.1:38003':'http://127.0.0.1:8000';
}
function wireWorkerControls() {
  if(controlsWired)return;controlsWired=true;
  const form=$('worker-form');form.elements.connection.addEventListener('change',updateConnectionFields);
  $('pool-context-input').addEventListener('input',()=>{contextDirty=true;});
  $('pool-context-form').addEventListener('submit',e=>{
    e.preventDefault();const value=Number($('pool-context-input').value);
    if(!Number.isSafeInteger(value)||value<=0){workerMessage('Enter a positive whole token count.',true);return;}
    if(value<contextExpected&&!window.confirm(`Lower the advertised pool context from ${fmt(contextExpected)} to ${fmt(value)} tokens? This can change client compaction behavior. Model servers and existing requests are not resized.`))return;
    void workerAction('context',{context_length:value,expected_context_length:contextExpected});
  });
  form.addEventListener('submit',e=>{
    e.preventDefault();const worker={id:form.elements.id.value.trim(),url:form.elements.url.value.trim()};
    if(form.elements.connection.value==='ssh'){worker.ssh=form.elements.ssh.value.trim();worker.remote_port=Number(form.elements.remote_port.value);}
    void workerAction('add',{worker});
  });
  $('worker-rows').addEventListener('click',e=>{
    const button=e.target.closest('button[data-action]');if(!button||button.disabled)return;
    const {action,id}=button.dataset;
    if(action==='remove'&&!window.confirm(`Remove ${id} from the gateway? Its model server and caches will be left running.`))return;
    void workerAction(action,action==='remove'?{id}:{workers:[id]});
  });
}
poll();
