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
function healthHeadlines(s) {
  const g=s?.gateway;
  if(!g || s.gateway_error)return {level:'unknown',items:['Status feed unavailable. No fresh health verdict until telemetry returns.']};
  const items=[],workers=g.workers || [],name=w=>w.id.replace(/^spark(\d+)$/,'Spark $1');
  for(const w of workers) {
    if(w.quarantine) {
      const reason=({accelerator_checkpoint_failure:'accelerator/checkpoint failure',fatal_accelerator_error:'fatal accelerator error',incomplete_sse:'incomplete response stream'})[w.quarantine.reason] || 'generation failure';
      items.push(`${name(w)}: quarantined after ${reason}. Benched, not forgotten.`);
    } else if(!w.is_healthy)items.push(`${name(w)}: unavailable; cause not established. No guesswork in this bulletin.`);
    else if(w.drained)items.push(`${name(w)}: routing paused${w.load || w.queued ? '; admitted work is still draining' : ''}.`);
  }
  const queued=workers.filter(w=>w.queued>0).sort((a,b)=>b.queued-a.queued);
  for(const w of queued.slice(0,3))items.push(`${name(w)}: ${w.queued} queued, ${w.load || 0} active.${w.queued>=3?' Patience is doing overtime.':''}`);
  if(queued.length>3)items.push(`${queued.length-3} other servers also have waiting requests.`);
  const waits=(s.events || []).filter(e=>e.event==='request_finished' && e.outcome==='complete' && Number.isFinite(e.queue_ms) && e.queue_ms>=60000 && Number.isFinite(Date.parse(e.time)) && s.time-Date.parse(e.time)>=0 && s.time-Date.parse(e.time)<=900000);
  const longest=waits.reduce((best,e)=>!best || e.queue_ms>best.queue_ms?e:best,null);
  if(longest) {
    const seconds=Math.floor(longest.queue_ms/1000);
    items.push(`Recent completed request on ${longest.node}: ${Math.floor(seconds/60)}m ${seconds%60}s spent queued — longest in the observed last 15 minutes, not a current ETA.`);
  }
  const free=g.draining?0:workers.filter(w=>w.is_healthy && !w.drained && !w.load && !w.queued).length;
  if(free && g.queued>0)items.push(`${free} eligible slot${free===1?'':'s'} free while ${g.queued} requests wait. Affinity or ordering may be holding the line; not proof of a routing bug.`);
  if(g.dataset?.error)items.push('Evidence collector reports an error. Check its panel; inference is a separate system.');
  if(g.draining)items.push('Gateway is draining; new admission is stopped.');
  if(!workers.length)items.push('No DS4 servers registered. The newsroom is open; the fleet is not.');
  if(!items.length)items.push(`No fresh health flags: ${workers.length} available servers, ${g.active || 0} active requests, ${free} free slots. Suspiciously civilised.`);
  return {level:items.length===1 && items[0].startsWith('No fresh health flags:')?'ok':'warn',items};
}
let wirePaused=false,wireSnapshot=null,wireSignature=null;
function renderHealthWire(snapshot) {
  wireSnapshot=snapshot;
  const wire=$('health-wire');
  if(wirePaused || wire.matches(':hover, :focus-within'))return;
  const news=healthHeadlines(snapshot),signature=JSON.stringify(news);
  $('health-wire-asof').textContent=`Live facts · ${clock(snapshot.time || Date.now())}`;
  if(signature===wireSignature)return;
  wireSignature=signature;wire.dataset.level=news.level;
  const text=news.items.join('   •   ');
  $('health-wire-text').textContent=text;$('health-wire-copy').textContent=text;
  // Roughly 24px/s in this monospace face; the animated track itself is never
  // replaced by polling, so unchanged bulletins do not jump back to the start.
  $('health-wire-track').style.animationDuration=`${Math.max(30,text.length*7/24)}s`;
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
      summary.textContent = `${clock(report.time)} · ${report.source} · assessment, no actions`;
      const answer = document.createElement('p');
      answer.className = 'genie-answer';
      answer.textContent = report.text;
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
  try {const r=await fetch('/api/genie',{signal:AbortSignal.timeout(5000)});if(!r.ok)throw new Error();const s=await r.json();genieToken=s.csrf_token;genieState=s;
    $('genie-status').textContent=!s.configured?'Not configured':s.error||(!s.enabled?'Off':s.busy?'Reviewing fleet evidence…':`Enabled · last review ${age(s.last_check,Date.now())}`);
    $('genie-toggle').disabled=!s.configured;$('genie-toggle').textContent=s.enabled?'Turn off':'Enable';
    $('genie-source').disabled=!s.fallback_available||s.busy;$('genie-source').value=s.source||'primary';
    $('genie-review').disabled=$('genie-send').disabled=!s.enabled||s.busy;
    renderGenieReports(s.reports || []);
  } catch{$('genie-status').textContent='Genie status unavailable';}
}
$('genie-toggle').addEventListener('click',()=>genieAction({action:'enable',enabled:!genieState?.enabled}));
$('genie-source').addEventListener('change',()=>genieAction({action:'source',source:$('genie-source').value}));
$('genie-review').addEventListener('click',()=>genieAction({action:'ask'}));
$('genie-chat').addEventListener('submit',e=>{e.preventDefault();void genieAction({action:'ask',question:$('genie-question').value});});
void loadGenie();setInterval(loadGenie,5000);
