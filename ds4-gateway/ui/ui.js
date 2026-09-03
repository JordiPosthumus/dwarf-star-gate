import { capacity, phase } from './activity.js';
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
function chart(series, kind, now, ceiling) {
  const values = series.filter(s => s.kind === kind && now - s.time < 900000);
  const max = ceiling || Math.max(1, ...values.map(s => s.tps));
  const points = values.map(s => `${((s.time - (now - 900000)) / 900000 * 300).toFixed(1)},${(48 - s.tps / max * 40).toFixed(1)}`).join(' ');
  return `<svg class="chart ${kind}" viewBox="0 0 300 55" preserveAspectRatio="none" role="img" aria-label="${kind} last 15 minutes, scale zero to ${Math.ceil(max)} tokens per second"><line x1="0" y1="48" x2="300" y2="48"/><polyline points="${points}"/></svg>`;
}
function telemetryStatus(d) {
  if (d.telemetry_configured === false) return 'Engine timings not configured';
  return `${d.telemetry_source === 'file' ? 'Model log' : 'Journal'} ${d.connected ? 'connected' : 'disconnected'}`;
}
function analyticsMetrics(snapshot,metric='queue',worker='') {
  const finite=x=>Number.isFinite(x)&&x>=0;
  const rows=(snapshot?.rows||[]).filter(r=>!worker || r.node===worker);
  const eligible=rows.filter(r=>metric==='queue'?finite(r.queue_ms)&&r.queue_ms>=1000:r.service_state==='complete'&&finite(r.service_ms));
  const pairs=eligible.map(r=>({node:r.node,at:r.at,actual:metric==='queue'?r.queue_ms:r.service_ms,
    predicted:metric==='queue'?r.predicted_queue_ms:r.predicted_service_ms})).filter(r=>finite(r.predicted));
  return {pairs,eligible:eligible.length,missing:eligible.length-pairs.length,
    immediate:rows.filter(r=>finite(r.queue_ms)&&r.queue_ms<1000).length,
    unfinished:rows.filter(r=>r.service_state==='pending').length,excluded:rows.filter(r=>r.service_state==='excluded').length,
    coverage:eligible.length?pairs.length/eligible.length*100:null,
    mae:pairs.length?pairs.reduce((sum,r)=>sum+Math.abs(r.actual-r.predicted),0)/pairs.length:null};
}
function predictionChart(pairs) {
  if(!pairs.length)return '<p class="analytics-empty">No matched predictions yet.<br>Unknown estimates are not plotted as zero.</p>';
  const max=Math.max(1000,...pairs.flatMap(p=>[p.actual,p.predicted])),unit=max>=120000?60000:1000,label=unit===60000?'min':'s';
  const x=v=>48+v/max*180,y=v=>202-v/max*180;
  return `<svg viewBox="0 0 266 246" role="img" aria-label="Predicted versus actual duration in ${label}; identical axes; dots above the diagonal took longer than predicted"><title>${pairs.length} paired requests; predictions were saved at admission</title><text x="48" y="12">Actual (${label})</text>${[0,.5,1].map(f=>`<line class="analytics-grid" x1="48" x2="228" y1="${y(f*max)}" y2="${y(f*max)}"/><text x="41" y="${y(f*max)+4}" text-anchor="end">${fmt(f*max/unit)}</text><text x="${x(f*max)}" y="219" text-anchor="middle">${fmt(f*max/unit)}</text>`).join('')}<line class="analytics-equal" x1="48" y1="202" x2="228" y2="22"/>${pairs.map(p=>`<circle class="${p.actual>p.predicted?'underestimated':'estimated'}" cx="${x(p.predicted).toFixed(2)}" cy="${y(p.actual).toFixed(2)}" r="3"><title>${esc(p.node)}: predicted ${fmt(p.predicted/1000)}s, actual ${fmt(p.actual/1000)}s</title></circle>`).join('')}<text x="138" y="240" text-anchor="middle">Predicted (${label})</text></svg>`;
}
let analyticsState=null,analyticsLoading=false,analyticsWorkerSignature='',analyticsChartSignature='';
function renderAnalytics() {
  const a=analyticsState,worker=$('analytics-worker'),metric=$('analytics-metric').value;
  const ids=[...new Set((a?.rows||[]).map(r=>r.node))].sort(),signature=JSON.stringify(ids);
  if(signature!==analyticsWorkerSignature) {
    analyticsWorkerSignature=signature;const previous=worker.value;
    worker.innerHTML='<option value="">All servers</option>'+ids.map(id=>`<option value="${esc(id)}">${esc(id)}</option>`).join('');
    worker.value=ids.includes(previous)?previous:'';
  }
  const m=analyticsMetrics(a,metric,worker.value);
  $('analytics-status').textContent=a?.demo?'Synthetic demo · not measured predictions':({disabled:'Enable evidence collection to see analytics.',waiting:'Waiting for saved evidence.',catching_up:'Reading recent evidence — counts are partial.',rescanning:'Evidence files changed — rebuilding the recent window.',unavailable:'Evidence unavailable — previous values are historical.',ready:'Shadow baseline · unvalidated'})[a?.status]||'Analytics unavailable — previous values are historical.';
  const chartSignature=JSON.stringify(m.pairs);
  if(chartSignature!==analyticsChartSignature){analyticsChartSignature=chartSignature;$('analytics-chart').innerHTML=predictionChart(m.pairs);}
  $('analytics-stats').innerHTML=`<div><span class="label">PAIRED REQUESTS</span><strong>${fmt(m.pairs.length)}</strong></div><div><span class="label">PREDICTION COVERAGE</span><strong>${m.coverage===null?'—':fmt(m.coverage)+'%'}</strong></div><div><span class="label">MEAN ABSOLUTE ERROR</span><strong>${m.mae===null?'—':fmt(m.mae/1000)+'s'}</strong></div>`;
  $('analytics-detail').textContent=`Recent window: up to ${fmt(a?.window_limit||500)} dispatched non-Genie requests from the latest two daily evidence files. ${fmt(m.missing)} missing estimates; ${metric==='queue'?`${fmt(m.immediate)} waits under 1s excluded from this graph`:`${fmt(m.unfinished)} unfinished and ${fmt(m.excluded)} failed/output-limited or otherwise incomplete responses excluded`}. ${fmt(a?.not_dispatched||0)} observed requests ended before dispatch (all servers; not zero waits).${a?.partial_history?' Older file content was skipped by the bounded reader.':''}${a?.rejected_events||a?.malformed_lines?` Evidence gaps: ${fmt(a.rejected_events)} rejected/unjoined events, ${fmt(a.malformed_lines)} malformed/oversized lines.`:''}`;
}
async function loadAnalytics() {
  if(analyticsLoading)return;analyticsLoading=true;
  try {const r=await fetch('/api/analytics',{cache:'no-store',signal:AbortSignal.timeout(5000)});if(!r.ok)throw new Error();analyticsState=await r.json();}
  catch {analyticsState={...analyticsState,status:'unavailable'};}
  finally {analyticsLoading=false;renderAnalytics();}
}
function embeddingInfo(ds) {
  const e=ds?.embedding_collection;
  if(!e?.enabled)return 'Embeddings off. Numerical collection can continue independently.';
  return `Local embeddings ${e.ready?'ready':e.error||'starting'} · ${fmt(e.completed)} encoded / ${fmt(e.observed)} observed · ${fmt(e.pending)} queued · ${fmt(e.failed)} failed · ${fmt(e.dropped)} dropped · ${fmt(e.missing)} unavailable text · last batch ${fmt(e.last_duration_ms)} ms · ${e.model||'unknown encoder'} @ ${typeof e.revision==='string'?e.revision.slice(0,8):'unknown revision'} · ${fmt(e.dimensions)} dimensions. Latest user + bounded recent conversation; no raw text saved. Not used for routing.`;
}
function cacheCostText(result) {
  const part=p=>p?.estimated_ms===null||p?.estimated_ms===undefined?
    (p?.status==='insufficient_evidence'?`unknown (${fmt(p.samples)}/3 required matching samples)`:'unknown (not measured)'):
    `${fmt(p.estimated_ms/1000)} s (${fmt(p.samples)} samples${p.status==='no_cache_payload'?', no payload to load':Number.isFinite(p.observed_min_ms)?`, observed ${fmt(p.observed_min_ms/1000)}–${fmt(p.observed_max_ms/1000)} s`:''})`;
  return `Disk payload load: ${part(result.disk_load)}. Prefill: ${part(result.prefill)}. These are component estimates, not total acquisition or completion time. Prefix search, later engine synchronization and remote transfer are unmeasured. Cache existence is not verified; observed ranges are not confidence intervals.`;
}
function timeline(d,now) {
  const rows=d.activity||[],start=now-900000;
  return `<svg class="activity-timeline" viewBox="0 0 100 10" preserveAspectRatio="none" role="img" aria-label="Observed activity over the last fifteen minutes; blank sections are unknown">${rows.map(r=>{
    const left=Math.max(start,r.start),right=Math.min(now,r.end),width=Math.max(0,(right-left)/9000);
    return `<rect class="phase-${esc(r.phase)}" x="${Math.max(0,(left-start)/9000)}" width="${width}" height="10"><title>${esc(r.phase)} · ${Math.round((right-left)/1000)}s</title></rect>`;
  }).join('')}</svg><div class="phase-legend"><span>Idle</span><span>Prefill</span><span>Thinking</span><span>Answering</span><span>Unknown / working</span></div><div class="chart-caption">15m activity · sampled every 2s · not GPU utilization</div>`;
}
function device(d, w, now, stale, index = 1, scales={}) {
  const state = phase(d,w,now,stale);
  const bad = stale || !w?.is_healthy;
  const metric = (kind, title) => {
    const m = d[kind];
    return `<div><span class="label">${title}</span><div class="rate ${kind}">${fmt(m?.tps)}<em>t/s</em></div><div class="metric-note">avg ${fmt(m?.average)} · ${age(m?.time, now)}</div>${chart(d.series, kind, now,scales[kind])}<div class="chart-caption">15m · 0–${fmt(scales[kind])} t/s · shared ${kind} scale</div></div>`;
  };
  const prompt = d.prompt ? `Last prompt: ${fmt(d.prompt.prompt)} tokens · ${fmt(d.prompt.cached)} reused · ${esc(d.prompt.cache)}` : 'No prompt start observed yet';
  return `<article class="device"><div class="device-top"><div class="device-name"><span class="device-number">${String(index).padStart(2,'0')}</span>${esc(d.id.replace(/^spark/, 'Spark '))}</div><span class="badge ${bad ? 'bad' : w?.load ? 'busy' : ''}">${esc(state==='decode'?'answering':state)}</span></div>${timeline(d,now)}${thinkingIndicator(w,stale,now)}<div class="metrics">${metric('decode','DECODE')}${metric('prefill','PREFILL')}</div><p class="prompt-note">${prompt}</p><div class="cache"><div><strong>${fmt(d.cache.reused)}</strong><span>Prefix reused</span></div><div><strong>${fmt(d.cache.cold)}</strong><span>Cold starts</span></div><div><strong>${fmt(d.cache.resident_misses)}</strong><span>Resident misses</span></div><div><strong>${fmt(d.cache.disk_restores)}</strong><span>Disk restores</span></div></div><p class="cache-note">Observed since ${d.observed_since ? clock(d.observed_since) : 'connecting'} · RAM misses ≠ cold starts</p><div class="device-foot"><span>${fmt(w?.queued)} queued · ${fmt(w?.assigned_sessions)} assigned sessions</span><span>${telemetryStatus(d)} · ${w?.load ? `${fmt(w.active_seconds)}s active` : 'last sample '+age(d.last_event,now)}</span></div></article>`;
}
const headlineSeverity=value=>['good','info','warning','critical'].includes(value)?value:'info';
function healthHeadlines(snapshot, ticker) {
  if(!snapshot?.gateway || snapshot.gateway_error)return {level:'unknown',items:[{severity:'info',text:'Gateway status unavailable; recommendations withheld until fresh evidence returns.'}]};
  if(ticker?.state==='ready' && ticker.entries?.length)return {
    level:ticker.entries.some(e=>e.severity==='critical')?'critical':ticker.entries.some(e=>e.severity==='warning')?'warn':ticker.entries.some(e=>e.severity==='good')?'ok':'info',evidence_at:ticker.evidence_at,
    label:`Genie assessment · evidence ${clock(ticker.evidence_at)}${ticker.refreshing?' · updating':ticker.review_error?' · latest refresh failed':''}`,
    items:ticker.entries.map(e=>({severity:headlineSeverity(e.severity),text:`${e.text}${e.recommendation?` Recommendation: ${e.recommendation}`:''}`})),
  };
  const message={off:'Gate Genie is off. Enable him below for generated health observations.',
    reviewing:'Gate Genie is reviewing fleet evidence. His observations and recommendations will appear here.',
    pending:'Waiting for a Genie assessment from the selected server.',
    stale:'The last assessment is over 10 minutes old or has no valid evidence time. Request a fresh review below.',
    changed:'Fleet health or membership changed since the last assessment. Request a fresh review before acting on old advice.',
    invalid:'Genie returned no valid ticker entries. Read his assessment below or request another review.',
    error:'The Genie review failed. Check his status below; no replacement advice has been invented.',
    unavailable:'Genie status is unavailable. Waiting for a fresh assessment.'};
  return {level:'unknown',label:'Genie status',items:[{severity:'info',text:message[ticker?.state] || 'Connecting to Gate Genie…'}]};
}
let wirePaused=false,wireSnapshot=null,wireSignature=null,wireState=null;
function renderHealthWire(snapshot) {
  wireSnapshot=snapshot;
  const wire=$('health-wire');
  if(wirePaused || wire.matches(':hover, :focus-within'))return;
  const news=healthHeadlines(snapshot,wireState),signature=JSON.stringify(news);
  $('health-wire-asof').textContent=news.label || 'Status unavailable';
  if(signature===wireSignature)return;
  wireSignature=signature;wire.dataset.level=news.level;
  for(const id of ['health-wire-text','health-wire-copy']) {
    const group=$(id);group.replaceChildren(...news.items.map(entry=>{
      const item=document.createElement('span');item.className='health-wire-item';item.dataset.severity=headlineSeverity(entry.severity);
      const label=document.createElement('span');label.className='health-wire-severity';label.textContent={good:'Good',info:'Info',warning:'Warning',critical:'Critical'}[item.dataset.severity]+': ';
      const text=document.createElement('span');text.textContent=entry.text;item.append(label,text);return item;
    }));
  }
  // Measure one complete group, including the deliberate gaps, at 42px/s.
  // Polling preserves the animated track rather than restarting its animation.
  $('health-wire-track').style.animationDuration=`${Math.max(15,$('health-wire-text').getBoundingClientRect().width/42)}s`;
}
function render(s) {
  const g = s.gateway, now = s.time, stale = !!s.gateway_error;
  renderHealthWire(s);
  $('connection').textContent = s.demo ? '◉ Demo telemetry' : stale ? 'Status unavailable' : '● Live telemetry';
  $('warning').hidden = !s.gateway_error && !s.telemetry_error;
  $('warning').textContent = [s.gateway_error,s.telemetry_error].filter(Boolean).join(' · ');
  $('model').textContent = s.demo ? `${g?.model || 'DS4'} · illustrative data · no real DS4 servers connected` : `${g?.model || 'DS4'} · one active gateway request per DS4 server · session-affinity routing`;
  $('available').textContent = g ? `${g.available} / ${g.total}` : '—'; $('active').textContent = fmt(g?.active); $('queued').textContent = fmt(g?.queued); $('context').textContent = g ? `${fmt(g.context_length / 1024)} Ki tokens` : '—';
  const cap=capacity(g,stale),scales=Object.fromEntries(['decode','prefill'].map(kind=>[kind,Math.ceil(Math.max(1,...s.devices.flatMap(d=>d.series.filter(p=>p.kind===kind && now-p.time<900000).map(p=>p.tps))))]));
  $('capacity-value').textContent=cap?.percent!=null?`${cap.percent}% occupied`:'Unknown';
  $('capacity-note').textContent=cap?`${cap.occupied} / ${cap.eligible} eligible slots occupied · ${cap.free} immediately free · ${fmt(g.queued)} waiting`:'Gateway status is unavailable';
  $('capacity-meter').value=cap?.percent||0;$('capacity-meter').hidden=cap?.percent==null;
  $('devices').innerHTML = s.devices.map((d,i) => device(d,g?.workers.find(w => w.id === d.id),now,stale,i+1,scales)).join('');
  const ds=g?.dataset;
  $('embedding-detail').textContent=embeddingInfo(ds);
  const selector=$('cache-cost-worker'),selected=selector.value,options=(g?.workers||[]).map(w=>`<option value="${esc(w.id)}">${esc(w.id)}</option>`).join('');
  if(selector.innerHTML!==options){selector.innerHTML=options;if((g?.workers||[]).some(w=>w.id===selected))selector.value=selected;}
  $('dataset-status').textContent=stale?'Collector status stale':!ds?.enabled?'Collector not enabled':ds.error||'Collecting routing evidence';
  $('dataset-detail').textContent=ds?`${fmt(ds.written)} events saved this gateway run · ${fmt(ds.bytes/1048576)} MiB stored · ${fmt(ds.pending)} pending · ${fmt(ds.dropped)} dropped · ${fmt(ds.finished)} finishes (${fmt(ds.missing_usage)} missing usage, ${fmt(ds.truncated)} output-limited, ${fmt(ds.failed_or_cancelled)} failed/cancelled) · last write ${age(ds.last_write,now)}`:'Existing engine metrics are separate from the new request dataset.';
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
  catch { $('connection').textContent = 'Disconnected'; $('warning').hidden = false; $('warning').textContent = 'Dashboard connection lost. Values below are historical, not live.'; renderHealthWire({time:Date.now(),gateway_error:true}); }
  finally { setTimeout(poll, document.hidden ? 10000 : 2000); }
}
let controlsWired = false, workerBusy = false, workersLoading = false, csrfToken = null,recoveryState=null;
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
    renderRecovery(data.recovery);
    $('pool-context-form').hidden=!data.context_limit_control;
    $('pool-context-note').hidden=!data.context_limit_control;
    if(!contextDirty){contextExpected=data.minimum_context;$('pool-context-input').value=String(data.minimum_context);}
  } catch(e) { workerMessage(e.message,true);$('recovery-status').textContent='Recovery controls unavailable; last state is stale';$('recovery-toggle').disabled=true; }
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
    workerMessage(action==='recover'?`Recovery accepted: ${data.id}. See executor receipts below.`:action==='recovery-policy'?`Automatic recovery ${data.automatic?'enabled':'disabled'}.`:action==='context'?`Pool limit saved: ${fmt(data.minimum_context)} tokens. Applied now; model servers and Pi unchanged.`:action==='add'?'Registered paused. Enable routing when ready.':action==='drain'?'Draining. Admitted requests will finish before removal.':action==='remove'?'Removed from this gateway. Model server left running.':'Routing enabled.');
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
function renderGenieReports(reports = []) {
  const container = $('genie-reports');
  const existing = new Map([...container.children].map(node => [node.dataset.reportId, node]));
  const keep = new Set();
  let position = 0;
  for (const [index, report] of reports.entries()) {
    let node = existing.get(report.id);
    if (index >= 3 && !node?.open && !node?.contains(document.activeElement)) continue;
    if (keep.has(report.id)) continue;
    keep.add(report.id);
    if (!node) {
      node = document.createElement('details');
      node.dataset.reportId = report.id;
      const summary = document.createElement('summary');
      summary.textContent = `${clock(report.time)} · ${report.source} · ${report.actions_taken?.length?'recovery requested; see executor receipts':'assessment, no actions'}${report.evidence_at?` · evidence ${clock(report.evidence_at)}`:''}`;
      const answer = document.createElement('p');
      answer.className = 'genie-answer';
      answer.textContent = report.text;
      if(report.actions_taken?.length)answer.textContent+='\n\nAction request results: '+report.actions_taken.map(a=>`${a.worker_id}: ${a.state}${a.id?` (${a.id})`:''}`).join('; ');
      node.append(summary, answer);
    }
    // Completed reports are immutable. Keep their actual DOM nodes so polling
    // cannot reset disclosure state, keyboard focus or a selected passage.
    if (container.children[position] !== node) container.insertBefore(node, container.children[position] || null);
    position++;
  }
  for (const node of [...container.children]) {
    // Even a report rotated out of the server's history stays readable until
    // the reader closes it. This is page-local, not persistent report storage.
    if (!keep.has(node.dataset.reportId) && !node.open && !node.contains(document.activeElement)) node.remove();
  }
}
poll();
$('analytics-metric').addEventListener('change',renderAnalytics);
$('analytics-worker').addEventListener('change',renderAnalytics);
let cacheCostBusy=false;
$('cache-cost-form').addEventListener('submit',async event=>{
  event.preventDefault();if(cacheCostBusy)return;cacheCostBusy=true;
  const form=event.currentTarget,button=form.querySelector('button');button.disabled=true;
  const params=new URLSearchParams(new FormData(form));$('cache-cost-result').textContent='Reading measured component costs…';
  try{const r=await fetch('/api/cache-cost?'+params,{signal:AbortSignal.timeout(5000)}),data=await r.json();if(!r.ok)throw new Error(data.error||'Cost evidence unavailable');$('cache-cost-result').textContent=cacheCostText(data);}
  catch(e){$('cache-cost-result').textContent=e.message;}
  finally{button.disabled=false;cacheCostBusy=false;}
});
void loadAnalytics();setInterval(()=>{if(!document.hidden)void loadAnalytics();},10000);
$('health-wire-pause').addEventListener('click',()=>{
  wirePaused=!wirePaused;$('health-wire').dataset.paused=String(wirePaused);
  $('health-wire-pause').textContent=wirePaused?'Resume ticker':'Pause ticker';
  $('health-wire-pause').setAttribute('aria-pressed',String(wirePaused));
  if(!wirePaused && wireSnapshot)renderHealthWire(wireSnapshot);
});
$('health-wire').addEventListener('mouseleave',()=>{if(wireSnapshot)renderHealthWire(wireSnapshot);});
$('health-wire').addEventListener('focusout',()=>queueMicrotask(()=>{if(wireSnapshot)renderHealthWire(wireSnapshot);}));
let genieToken=null,genieState=null;
async function genieAction(input) {
  try {const r=await fetch('/api/genie',{method:'POST',headers:{'content-type':'application/json','x-dsg-csrf':genieToken},body:JSON.stringify(input)});
    const data=await r.json();if(!r.ok)throw new Error(data.error||'Genie request failed');await loadGenie();
  } catch(e){$('genie-status').textContent=e.message;}
}
async function loadGenie() {
  try {const r=await fetch('/api/genie',{signal:AbortSignal.timeout(5000)});if(!r.ok)throw new Error();const s=await r.json();genieToken=s.csrf_token;genieState=s;wireState=s.ticker;
    if(wireSnapshot)renderHealthWire(wireSnapshot);
    $('genie-status').textContent=!s.configured?'Not configured':s.error||(!s.enabled?'Off':s.busy?'Reviewing fleet evidence…':`Enabled · last review ${age(s.last_check,Date.now())}`);
    $('genie-mode').textContent=s.mode==='bounded-recovery'?'bounded recovery available':'observation only';
    $('genie-toggle').disabled=!s.configured;$('genie-toggle').textContent=s.enabled?'Turn off':'Enable';
    $('genie-source').disabled=!s.fallback_available||s.busy;$('genie-source').value=s.source||'primary';
    $('genie-review').disabled=$('genie-send').disabled=!s.enabled||s.busy;
    renderGenieReports(s.reports || []);
  } catch{$('genie-status').textContent='Genie status unavailable';wireState={state:'unavailable'};if(wireSnapshot)renderHealthWire(wireSnapshot);}
}
$('genie-toggle').addEventListener('click',()=>genieAction({action:'enable',enabled:!genieState?.enabled}));
$('genie-source').addEventListener('change',()=>genieAction({action:'source',source:$('genie-source').value}));
$('genie-review').addEventListener('click',()=>genieAction({action:'ask'}));
$('genie-chat').addEventListener('submit',e=>{e.preventDefault();void genieAction({action:'ask',question:$('genie-question').value});});
void loadGenie();setInterval(loadGenie,5000);

function renderRecovery(state) {
  recoveryState=state;
  $('recovery-status').textContent=!state?.configured?'Not configured. Endpoint registration alone grants no restart authority.':state.automatic?'Automatic recovery ON · GG + known-fatal watcher':'Automatic recovery OFF · operator recovery available';
  $('recovery-toggle').textContent=state?.automatic?'Disable automatic recovery':'Enable automatic recovery';
  $('recovery-toggle').disabled=!state?.configured||workerBusy;
  $('recovery-workers').innerHTML=(state?.workers||[]).map(w=>`<p><strong>${esc(w.worker_id)}</strong> · ${esc(w.state)} · ${esc(w.eligible?'recovery eligible':(w.reason||'checking').replaceAll('_',' '))} <button type="button" class="button" data-recover="${esc(w.worker_id)}" ${!w.eligible||workerBusy?'disabled':''}>Recover</button>${w.last_action?.restart_issued&&['reconciliation_needed','failed'].includes(w.last_action.state)?` <button type="button" class="button" data-recheck="${esc(w.last_action.id)}" ${workerBusy?'disabled':''}>Recheck only</button>`:''}</p>`).join('');
  // Plain text receipts, not another auto-collapsing disclosure panel.
  $('recovery-actions').replaceChildren(...(state?.operations||[]).slice(0,8).map(op=>{
    const p=document.createElement('p');p.textContent=`${clock(op.updated_at)} · ${op.worker_id} · ${op.actor} · ${op.state.replaceAll('_',' ')}${op.error?` · ${op.error.replaceAll('_',' ')}`:''}${op.proof?` · ${op.proof.samples.map(s=>`${s.label}: ${s.cached_tokens}/${s.prompt_tokens} cached`).join(' · ')}`:''} · ${op.id}`;return p;
  }));
}
$('recovery-toggle').addEventListener('click',()=>{
  if(!recoveryState?.configured)return;
  if(!recoveryState.automatic&&!window.confirm('Allow GG and the known-fatal watcher to restart registered DS4 services after identity and fault checks? RAM-resident caches are lost; server settings and disk caches are preserved.'))return;
  void workerAction('recovery-policy',{enabled:!recoveryState.automatic});
});
$('recovery-workers').addEventListener('click',event=>{
  const recheck=event.target.closest('button[data-recheck]');if(recheck&&!recheck.disabled){void workerAction('recovery-recheck',{action_id:recheck.dataset.recheck});return;}
  const button=event.target.closest('button[data-recover]');if(!button||button.disabled)return;
  const worker=recoveryState?.workers.find(w=>w.worker_id===button.dataset.recover);
  if(worker?.eligible)void workerAction('recover',{worker_id:worker.worker_id,evidence_id:worker.evidence_id,action_id:crypto.randomUUID()});
});
