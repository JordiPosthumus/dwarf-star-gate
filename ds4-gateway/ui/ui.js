import { capacity, phase } from './activity.js';
const $ = id => document.getElementById(id);
const fmt = n => Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: 1 }) : '—';
const fmtWhole = n => Number.isFinite(n) ? Math.round(n).toLocaleString() : '—';
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const age = (time, now) => !time ? 'no sample yet' : now - time < 5000 ? 'just now' : now - time < 60000 ? `${Math.floor((now-time)/1000)}s ago` : `${Math.floor((now-time)/60000)}m ago`;
const remaining = (time, now) => !time ? 'unknown' : time <= now ? 'expired' : time-now < 60000 ? `${Math.ceil((time-now)/1000)}s` : time-now < 3600000 ? `${Math.ceil((time-now)/60000)}m` : `${(Math.ceil((time-now)/360000)/10).toFixed(1).replace(/\.0$/,'')}h`;
const clock = t => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
function predictionSessionLabel(evidence){
  if(!Number.isSafeInteger(evidence?.known_sessions)||evidence.known_sessions<0)return `${fmt(evidence?.sessions??0)} recorded groups`;
  return `${fmt(evidence.known_sessions)} known sessions${evidence.unknown_identity_requests>0?` · ${fmt(evidence.unknown_identity_requests)} requests without identity`:''}`;
}
function forecastLabel(f, now, stale=false) {
  if (!f || !Number.isFinite(f.at) || !Number.isFinite(f.seconds) || f.seconds<0 || f.at>now) return 'ETA unknown';
  if (stale || now-f.at>60000) return 'Forecast stale';
  if (f.stage!=='remaining') return `Total est. ${fmtWhole(f.seconds)}s`;
  const left=f.seconds-(now-f.at)/1000;
  return left<=0?'Estimate exceeded':`ETA ~${fmtWhole(left)}s`;
}
function knownWaiting(gateway,door) {
  const core=Number.isSafeInteger(gateway?.queued)&&gateway.queued>=0?gateway.queued:0;
  const held=door?.holding&&Number.isSafeInteger(door.held)&&door.held>=0?door.held:0;
  return {core,held,total:core+held};
}
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
  const qualifier=stale?'Stale':!w?.load&&w?.last_request_finished_at?'Last':'';
  return `<div class="requested-thinking" title="${esc(scope+'. Requested settings, not proof of effective reasoning. '+info.detail)}"><span class="label">Thinking</span><strong>${esc(info.label)}</strong>${qualifier?`<span class="thinking-scope">${qualifier}</span>`:''}</div>`;
}
function chart(series, kind, now, ceiling) {
  const values = (series??[]).filter(s => s?.kind === kind && Number.isFinite(s.time) && Number.isFinite(s.tps) && s.tps>=0 && s.time<=now && now - s.time < 900000).sort((a,b)=>a.time-b.time);
  const max = Number.isFinite(ceiling)&&ceiling>0?ceiling:Math.max(1, ...values.map(s => s.tps));
  const groups=[];for(const sample of values){const current=groups.at(-1);if(!current||sample.time-current.at(-1).time>90000)groups.push([sample]);else current.push(sample);}
  const first=values[0],last=values.at(-1),leading=first&&first.time-(now-900000)>90000,trailing=last&&now-last.time>90000;
  const gapCount=Math.max(0,groups.length-1)+Number(!!leading)+Number(!!trailing),gapWidth=8;
  const durations=groups.map(g=>Math.max(1,g.at(-1).time-g[0].time)),total=durations.reduce((sum,n)=>sum+n,0);
  const available=294-gapCount*gapWidth,parts=[];let cursor=3,lastPoint=null;
  const marker=(x,ms,scope)=>{
    const label=`${Math.round(ms/1000)}s ${scope} collapsed. Idle-coloured separator marks missing rate measurements, not proof of idle; no interpolated speed.`;
    return `<g class="chart-gap" tabindex="0" role="img" aria-label="${label}"><title>${label}</title><line class="chart-gap-line" x1="${x.toFixed(1)}" y1="8" x2="${x.toFixed(1)}" y2="52"/></g>`;
  };
  // Give each missing interval one narrow separator. Only measured runs get
  // horizontal space; the x axis is deliberately not a shared wall-clock axis.
  if(!first)parts.push(marker(150,900000,'without rate samples'));
  if(leading){parts.push(marker(cursor+gapWidth/2,first.time-(now-900000),'before the first sample'));cursor+=gapWidth;}
  groups.forEach((group,index)=>{
    if(index){parts.push(marker(cursor+gapWidth/2,group[0].time-groups[index-1].at(-1).time,'between rate measurements'));cursor+=gapWidth;}
    const width=available*durations[index]/total,start=group[0].time;
    const point=s=>`${(cursor+(group.length===1?width/2:(s.time-start)/durations[index]*width)).toFixed(1)},${(52-s.tps/max*44).toFixed(1)}`;
    lastPoint=point(group.at(-1)).split(',');
    parts.push(group.length===1?`<circle class="chart-point" cx="${lastPoint[0]}" cy="${lastPoint[1]}" r="2.5"/>`:`<polyline points="${group.map(point).join(' ')}"/>`);
    cursor+=width;
  });
  if(trailing)parts.push(marker(cursor+gapWidth/2,now-last.time,'since the last sample'));
  else if(lastPoint)parts.push(`<circle class="chart-last" cx="${lastPoint[0]}" cy="${lastPoint[1]}" r="3.2"/>`);
  return `<svg class="chart ${kind}" viewBox="0 0 300 60" preserveAspectRatio="none" role="img" aria-label="${kind} last 15 minutes, shared speed scale zero to ${Math.ceil(max)} tokens per second; gaps collapsed to idle-coloured separators, horizontal positions are not wall-clock aligned"><line class="chart-grid" x1="0" y1="8" x2="300" y2="8"/><line class="chart-grid" x1="0" y1="30" x2="300" y2="30"/><line class="chart-baseline" x1="0" y1="52" x2="300" y2="52"/>${parts.join('')}</svg>`;
}
function hardwareMiniChart(series,value,ceiling,label){
  const rows=(series??[]).map(sample=>({time:sample.time,value:value(sample)})).filter(sample=>Number.isFinite(sample.time)&&Number.isFinite(sample.value)).sort((a,b)=>a.time-b.time),max=Math.max(1,ceiling??0,...rows.map(row=>row.value));
  const newest=rows.at(-1)?.time??Date.now(),from=newest-900000,point=row=>`${Math.max(0,(row.time-from)/900000*100).toFixed(1)},${(22-Math.min(1,row.value/max)*20).toFixed(1)}`;
  const groups=[];for(const row of rows.filter(row=>row.time>=from)){const current=groups.at(-1);if(!current||row.time-current.at(-1).time>60000)groups.push([row]);else current.push(row);}
  return `<svg class="hardware-mini-chart" viewBox="0 0 100 24" preserveAspectRatio="none" role="img" aria-label="${esc(label)} over the last 15 minutes">${groups.map(group=>group.length===1?`<circle cx="${point(group[0]).split(',')[0]}" cy="${point(group[0]).split(',')[1]}" r="1.4"/>`:`<polyline points="${group.map(point).join(' ')}"/>`).join('')}</svg>`;
}
function hardwareMarkup(h,now){
  if(!h?.configured)return '';
  const current=h.current??{},stale=h.state==='stale'||!h.last_sample_at||now-h.last_sample_at>60000,series=h.series??[];
  const memoryPct=Number.isFinite(current.memory_used_bytes)&&Number.isFinite(current.memory_total_bytes)&&current.memory_total_bytes>0?100*current.memory_used_bytes/current.memory_total_bytes:null;
  const activity=current.accelerator_activity_pct,power=current.power_watts,clockMhz=current.clock_mhz;
  const powerMax=Math.max(100,Math.ceil(Math.max(0,...series.map(sample=>sample.power_watts??0))/50)*50);
  const status=({waiting:'waiting for first sample',connecting:'connecting',disconnected:String(h.reason??'adapter unavailable').replaceAll('_',' '),stale:'sample stale',connected:`sample ${age(h.last_sample_at,now)}`})[stale?'stale':h.state]??'unavailable';
  const item=(kind,label,display,chart,secondary,detail)=>`<div class="hardware-reading ${kind}${stale?' stale':''}" title="${esc(`${detail} · ${status}`)}"><span>${label}</span><strong>${display}</strong>${chart}<small>${secondary}</small></div>`;
  return `<div class="hardware-strip" aria-label="Read-only hardware telemetry; ${esc(status)}">${item('memory','RAM',Number.isFinite(memoryPct)?fmtWhole(memoryPct)+'%':'—',hardwareMiniChart(series,s=>Number.isFinite(s.memory_used_bytes)&&Number.isFinite(s.memory_total_bytes)&&s.memory_total_bytes>0?100*s.memory_used_bytes/s.memory_total_bytes:null,100,'host memory used'),current.memory_scope==='host_unified'?'unified host':'host',current.memory_scope==='host_unified'?'Unified host memory used; not dedicated GPU RAM':'Host memory used')}${item('accelerator','GPU',Number.isFinite(activity)?fmtWhole(activity)+'%':'—',hardwareMiniChart(series,s=>s.accelerator_activity_pct,100,'accelerator activity'),Number.isFinite(clockMhz)?`${fmtWhole(clockMhz)} MHz${current.clock_scope==='sm'?' SM':''}`:'clock —',current.accelerator_scope==='gpu_kernel_time'?'Share of the sample period with GPU kernels executing':'Accelerator activity')}${item('power','POWER',Number.isFinite(power)?fmtWhole(power)+' W':'—',hardwareMiniChart(series,s=>s.power_watts,powerMax,'measured power draw'),current.power_scope==='compute_module'?'compute module':current.power_scope==='system'?'whole system':current.power_scope==='gpu_only'?'GPU only':'scope —',current.power_scope==='compute_module'?'Measured compute-module power used for energy integration':current.power_scope==='system'?'Measured whole-system power used for energy integration':current.power_scope==='gpu_only'?'Measured GPU power only; excluded from whole-machine energy estimates':'Power unavailable; no TDP estimate is substituted')}</div>`;
}
function telemetryStatus(d) {
  if (d.telemetry_configured === false) return 'Engine timings not configured';
  return `${d.telemetry_source === 'file' ? 'Model log' : 'Journal'} ${d.connected ? 'connected' : 'disconnected'}`;
}
function analyticsMetrics(snapshot,metric='queue',worker='') {
  const finite=x=>Number.isFinite(x)&&x>=0;
  const rows=(snapshot?.rows||[]).filter(r=>!worker || r.node===worker);
  const eligible=rows.filter(r=>metric==='queue'?finite(r.queue_ms)&&r.queue_ms>=1000:r.service_state==='complete'&&(finite(r.service_ms)||r.forecast_eligible===true));
  const pairs=eligible.map(r=>({node:r.node,at:r.at,actual:metric==='queue'?r.queue_ms:r.service_ms,
    predicted:metric==='queue'?r.predicted_queue_ms:r.predicted_service_ms})).filter(r=>finite(r.predicted)&&finite(r.actual));
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
  return `<svg viewBox="0 0 266 246" role="img" aria-label="Predicted versus actual duration in ${label}; identical axes; dots above the diagonal took longer than predicted"><title>${pairs.length} paired requests; frozen forecasts at the selected stage</title><text x="48" y="12">Actual (${label})</text>${[0,.5,1].map(f=>`<line class="analytics-grid" x1="48" x2="228" y1="${y(f*max)}" y2="${y(f*max)}"/><text x="41" y="${y(f*max)+4}" text-anchor="end">${fmt(f*max/unit)}</text><text x="${x(f*max)}" y="219" text-anchor="middle">${fmt(f*max/unit)}</text>`).join('')}<line class="analytics-equal" x1="48" y1="202" x2="228" y2="22"/>${pairs.map(p=>`<circle class="${p.actual>p.predicted?'underestimated':'estimated'}" cx="${x(p.predicted).toFixed(2)}" cy="${y(p.actual).toFixed(2)}" r="3"><title>${esc(p.node)}: predicted ${fmt(p.predicted/1000)}s, actual ${fmt(p.actual/1000)}s</title></circle>`).join('')}<text x="138" y="240" text-anchor="middle">Predicted (${label})</text></svg>`;
}
let analyticsState=null,analyticsLoading=false,analyticsWorkerSignature='',analyticsChartSignature='',genieState=null;
const fleetSpeedWindows=new Set(['1h','12h','24h']);let fleetSpeedWindow='12h';
try{const saved=globalThis.localStorage?.getItem('dsg-fleet-speed-window-v1');if(fleetSpeedWindows.has(saved))fleetSpeedWindow=saved;}catch{/* Browser privacy settings may deny storage; 12h remains the safe default. */}
function compactValue(n){return !Number.isFinite(n)?'—':n>=1000000?fmt(n/1000000)+'M':n>=1000?fmt(n/1000)+'k':fmtWhole(n);}
function renderFleetSpeed(a){
  const speed=a?.fleet_speed,ready=speed?.status==='ready'&&speed?.schema===1,window=ready?speed.windows?.[fleetSpeedWindow]:null;
  if($('fleet-speed-window').value!==fleetSpeedWindow)$('fleet-speed-window').value=fleetSpeedWindow;
  const setGauge=kind=>{
    const phase=window?.[kind],max=speed?.calibration?.[kind]?.max_tps,value=phase?.mean_tps,valid=Number.isFinite(value)&&Number.isFinite(max)&&max>0;
    const gauge=$(`fleet-speed-${kind}`),fill=valid?Math.min(100,100*value/max):0,activity=Number.isFinite(phase?.activity_lower_bound_pct)?Math.min(100,phase.activity_lower_bound_pct):0;
    gauge.style.setProperty('--speed-fill',String(fill));gauge.style.setProperty('--activity-fill',String(activity));$(`fleet-${kind}-speed`).textContent=valid?fmtWhole(value):'—';
    const label=valid?`${kind} active-phase mean ${fmtWhole(value)} tokens per second over ${fleetSpeedWindow}; gauge calibrated zero to ${fmtWhole(max)}; at least ${fmt(activity)} percent of current configured fleet-hours observed in this phase; ${fmt(phase.samples)} timing intervals across ${fmt(phase.observed_workers)} workers`:`${kind} speed unavailable for ${fleetSpeedWindow}`;
    gauge.setAttribute('aria-label',label);
  };
  setGauge('decode');setGauge('prefill');
  const tokens=window?.decode?.tokens_observed,energy=window?.energy,estimated=energy?.estimated_kwh,efficiency=Number.isFinite(tokens)&&Number.isFinite(estimated)&&estimated>0?tokens/estimated:null;
  $('fleet-speed-value').textContent=ready?`${Number.isFinite(tokens)?compactValue(tokens)+' tok':'No generation evidence'} · ${Number.isFinite(estimated)?`≈${fmt(estimated)} kWh${Number.isFinite(efficiency)?` · ${compactValue(efficiency)} tok/kWh`:''}`:'energy awaiting power data'}`:'Timing evidence unavailable';
  const state=({catching_up:'Loading saved engine timings.',rescanning:'Rebuilding saved engine timings.',waiting:'No saved engine timings yet.',unavailable:'Engine timing history unavailable.'})[speed?.status]||'Engine timing history unavailable.';
  const partial=!!(speed?.partial_history||speed?.malformed_lines||speed?.rejected_records||speed?.evicted_intervals),power=energy?.status==='estimated_from_measured_power'?`Energy extrapolates ${fmt(energy.measured_kwh)} measured kWh per worker only after at least 80% measured-power coverage; aggregate coverage ${fmt(energy.coverage_pct)}%.`:energy?.status==='insufficient_power_coverage'?`Power coverage is ${fmt(energy.coverage_pct)}%; no fleet-energy estimate is shown until every current worker reaches 80%.`:'No measured power samples are available, so DSG does not invent an energy estimate.';
  const detail=ready?`Selected window: ${fleetSpeedWindow}. Each speed is a duration-weighted active mean: total observed token deltas divided by total observed active-phase seconds; repeated cumulative DS4 log lines are differenced first. Gauge ceilings are the padded, rounded 95th percentile of valid 24-hour engine intervals. The thin outer arcs are lower bounds on phase activity across the current configured fleet; missing telemetry and other phases are not called idle. ${power}${partial?' Evidence gaps or bounded-history limits are present.':''}`:state;
  $('fleet-speed-summary').title=detail;$('fleet-speed-summary').setAttribute?.('aria-label',ready?`Fleet speed over ${fleetSpeedWindow}. Decode ${fmtWhole(window?.decode?.mean_tps)} tokens per second. Prefill ${fmtWhole(window?.prefill?.mean_tps)} tokens per second. ${Number.isFinite(estimated)?`Estimated energy ${fmt(estimated)} kilowatt hours.`:'Energy unavailable.'}`:state);
}
function renderAnalytics() {
  const a=analyticsState,worker=$('analytics-worker'),metric=$('analytics-metric').value;
  renderFleetSpeed(a);
  const ids=[...new Set((a?.rows||[]).map(r=>r.node))].sort(),signature=JSON.stringify(ids);
  if(signature!==analyticsWorkerSignature) {
    analyticsWorkerSignature=signature;const previous=worker.value;
    worker.innerHTML='<option value="">All servers</option>'+ids.map(id=>`<option value="${esc(id)}">${esc(id)}</option>`).join('');
    worker.value=ids.includes(previous)?previous:'';
  }
  const xgb=metric.startsWith('xgb-'),stage=metric.slice(4),versions=(a?.model_series||[]).filter(m=>m.stage===stage).sort((a,b)=>(b.last_forecast_at??0)-(a.last_forecast_at??0)),version=$('analytics-version');
  $('analytics-version-label').hidden=!xgb;
  const latest=versions[0],options=latest?`<option value="">Current / latest · ${esc(latest.id.slice(0,12))}</option>`+versions.slice(1).map(m=>`<option value="${esc(m.id)}">History · ${esc(m.id.slice(0,12))}</option>`).join(''):'';
  if(version.innerHTML!==options){const old=version.value;version.innerHTML=options;version.value=versions.slice(1).some(m=>m.id===old)?old:'';}
  const selected=version.value?versions.find(m=>m.id===version.value):latest,m=analyticsMetrics(xgb?{rows:selected?.rows||[]}:a,xgb?'service':metric,worker.value);
  $('analytics-status').textContent=a?.demo?'Synthetic demo · not measured predictions':({disabled:'Enable evidence collection to see analytics.',waiting:'Waiting for saved evidence.',catching_up:'Reading recent evidence — counts are partial.',rescanning:'Evidence files changed — rebuilding the recent window.',unavailable:'Evidence unavailable — previous values are historical.',ready:'Shadow baseline · unvalidated'})[a?.status]||'Analytics unavailable — previous values are historical.';
  if(xgb&&a?.status==='ready'&&!a.demo)$('analytics-status').textContent=selected?`XGB ${stage} · model ${selected.id.slice(0,12)} · ${selected.rows.some(r=>r.experimental)?'includes experimental forecasts':'validated forecasts'}`:'No forecasts at this stage yet';
  $('analytics-contract').textContent=xgb?stage==='remaining'?'One frozen forecast per request: the first at or after 30 seconds. Actual = server time remaining at that moment, not total duration.':stage==='admission'?'Frozen before dispatch/upload. Current prompt embeddings are not available.':'Updated total server-time forecast, frozen separately after upload or embeddings. Not an admission-time forecast.':'Admission-time historical baseline, not XGB. Embeddings do not enter this baseline.';
  const chartSignature=JSON.stringify(m.pairs);
  if(chartSignature!==analyticsChartSignature){analyticsChartSignature=chartSignature;$('analytics-chart').innerHTML=predictionChart(m.pairs);}
  $('analytics-stats').innerHTML=`<div><span class="label">PAIRED REQUESTS</span><strong>${fmt(m.pairs.length)}</strong></div><div><span class="label">PREDICTION COVERAGE</span><strong>${m.coverage===null?'—':fmt(m.coverage)+'%'}</strong></div><div><span class="label">MEAN ABSOLUTE ERROR</span><strong>${m.mae===null?'—':fmt(m.mae/1000)+'s'}</strong></div>`;
  const h=a?.handovers,handover=h?.total?` Applied handovers: ${fmt(h.total)} observed · ${fmt(h.completed)} completed · ${fmt(h.pending)} pending · ${fmt(h.excluded)} excluded; destination outcome only, no invented no-move result.`:'';
  $('analytics-detail').textContent=`Recent window: up to ${fmt(a?.window_limit||500)} dispatched non-Genie requests from the latest two daily evidence files. ${fmt(m.missing)} missing estimates; ${metric==='queue'?`${fmt(m.immediate)} waits under 1s excluded from this graph`:`${fmt(m.unfinished)} unfinished and ${fmt(m.excluded)} failed/output-limited or otherwise incomplete responses excluded`}. ${fmt(a?.not_dispatched||0)} observed requests ended before dispatch (all servers; not zero waits).${handover}${a?.partial_history?' Older file content was skipped by the bounded reader.':''}${a?.rejected_events||a?.malformed_lines||h?.rejected_events?` Evidence gaps: ${fmt(a.rejected_events)} rejected/unjoined prediction events, ${fmt(h?.rejected_events||0)} rejected handover events, ${fmt(a.malformed_lines)} malformed/oversized lines.`:''}`;
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
  return `Local embeddings ${e.ready?'ready':e.error||'starting'} · ${fmt(e.completed)} encoded / ${fmt(e.observed)} observed · ${fmt(e.pending)} queued · ${fmt(e.failed)} failed · ${fmt(e.dropped)} dropped · ${fmt(e.missing)} unavailable text · last batch ${fmt(e.last_duration_ms)} ms · ${e.model||'unknown encoder'} @ ${typeof e.revision==='string'?e.revision.slice(0,8):'unknown revision'} · ${fmt(e.dimensions)} dimensions. Latest user + bounded recent conversation; no raw text saved. Optional updated-forecast inputs, not initial-routing features.`;
}
function cacheCostText(result) {
  const part=p=>p?.estimated_ms===null||p?.estimated_ms===undefined?
    (p?.status==='insufficient_evidence'?`unknown (${fmt(p.samples)}/3 required matching samples)`:'unknown (not measured)'):
    `${fmt(p.estimated_ms/1000)} s (${fmt(p.samples)} samples${p.status==='no_cache_payload'?', no payload to load':Number.isFinite(p.observed_min_ms)?`, observed ${fmt(p.observed_min_ms/1000)}–${fmt(p.observed_max_ms/1000)} s`:''})`;
  return `Disk payload load: ${part(result.disk_load)}. Prefill: ${part(result.prefill)}. These are component estimates, not total acquisition or completion time. Prefix search, later engine synchronization and remote transfer are unmeasured. Cache existence is not verified; observed ranges are not confidence intervals.`;
}
function cacheEvidenceText(snapshot,stale=false) {
  if(stale)return 'Cache evidence health unavailable; no prior value is treated as current.';
  const devices=snapshot?.devices||[],configured=devices.filter(d=>d.telemetry_configured).length;
  const epochs=devices.filter(d=>d.telemetry_configured&&typeof d.backend_epoch==='string').length,a=snapshot?.attribution,counts=a?.counts;
  if(!a||!counts)return `${fmt(epochs)} / ${fmt(configured)} telemetry-enabled servers have an observed process epoch · request attribution unavailable.`;
  const quality=a.quality;
  if(quality?.schema===1&&Number.isFinite(quality.resolved_starts)&&Number.isFinite(quality.counts?.corroborated)){
    const gaps=Object.entries(quality.reason_counts||{}).slice(0,3).map(([reason,n])=>`${fmt(n)} ${reason.replaceAll('_',' ')}`).join(' · ');
    const rate=Number.isFinite(quality.corroboration_rate_pct)?`${fmt(quality.corroboration_rate_pct)}%`:'unknown';
    return `${fmt(epochs)} / ${fmt(configured)} telemetry-enabled servers have an observed process epoch · attribution yield: ${fmt(quality.counts.corroborated)} / ${fmt(quality.resolved_starts)} resolved starts corroborated (${rate}), ${fmt(quality.pending_starts)} pending, ${fmt(quality.counts.abstained)} abstained${gaps?` (${gaps})`:''}. Corroborated remains bounded shadow evidence, not protocol proof or a cache-hit verdict.`;
  }
  const reasons={};for(const row of a.recent||[])if(row.status==='abstained')reasons[row.reason]=(reasons[row.reason]||0)+1;
  const gaps=Object.entries(reasons).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([reason,n])=>`${fmt(n)} ${reason.replaceAll('_',' ')}`).join(' · ');
  return `${fmt(epochs)} / ${fmt(configured)} telemetry-enabled servers have an observed process epoch · recent engine starts: ${fmt(counts.corroborated)} corroborated, ${fmt(counts.candidate)} pending candidates, ${fmt(counts.abstained)} abstained${gaps?` (${gaps})`:''}. Corroborated is still a bounded candidate, not protocol proof or a cache-hit verdict.`;
}
function relocationReason(row) {
  const worker=row.conflicting_worker?` on ${row.conflicting_worker}`:'';
  return ({gateway_stopping:'gateway is stopping',gateway_draining:'gateway is draining',source_not_active:'source became idle and should dispatch normally',cancelled_queue_head:'a cancelled queue head is still settling',already_dispatched:'request has already reached DS4',same_session_active:`the same session is still active${worker}`,same_session_queued:`the same session has earlier queued work${worker}`,same_session_waiting:'the same session has an earlier recovery wait',no_idle_destination:'no other DS4 server is immediately free',durable_home_mismatch:'durable session ownership changed',offer_ready:'an exact handover offer is ready'})[row.reason]||`blocked by ${row.reason}`;
}
function relocationEmpty(diagnostics) {
  const rows=diagnostics?.sources??[];
  if(!rows.length)return 'No continuity-safe queued handover is currently available.';
  return `No safe handover right now — ${rows.slice(0,4).map(row=>`${row.source}: ${relocationReason(row)}`).join(' · ')}${rows.length>4?' · more queued work omitted':''}.`;
}
function compactWait(seconds) {
  if(!Number.isFinite(seconds)||seconds<0)return null;
  if(seconds<120)return `${Math.ceil(seconds)}s`;
  return `${Math.ceil(seconds/60)}m`;
}
function schedulingExplanation(g,workers,capacity) {
  if(!g||!capacity?.free||!g.queued)return '';
  const continuity=g.continuity,diagnostics=continuity?.relocation?.diagnostics,rows=diagnostics?.sources??[];
  const row=rows.find(item=>item.destination&&item.reason==='offer_ready')??rows[0];
  const idle=(diagnostics?.idle_destinations??[])[0]??workers.find(w=>w.is_healthy&&!w.drained&&!w.quarantine&&!w.load&&!w.queued)?.id;
  if(!row)return ` ${idle||'A server'} is free, but this snapshot has no safe-handover explanation; inspect Manage DS4 servers.`;
  const route=idle?`${idle} is free; `:'';
  if(row.automatic_reason==='automatic_wait_threshold'){
    const threshold=continuity.automatic_affinity_rebalance_min_wait_ms,remaining=Number.isFinite(threshold)?threshold/1000-row.waiting_seconds:null,wait=compactWait(remaining);
    return ` ${route}${row.source}'s next queued session keeps its warm home${wait?` for up to ${wait} more`:''}; then the DSG core may hand it over automatically.`;
  }
  if(row.automatic_reason==='affinity_automatic_disabled')return ` ${route}strict affinity keeps ${row.source}'s queued session at home until an exact manual or Genie handover.`;
  if(row.automatic_reason==='automatic_ready')return ` ${route}${row.source}'s queued request is eligible for automatic core handover now.`;
  return ` ${route}${row.source}'s queue cannot move yet: ${relocationReason(row)}.`;
}
function timeline(d,now) {
  const rows=d.activity||[],start=now-900000;
  const band=phase=>phase==='prefill'?'prefill':phase==='thinking'||phase==='decode'?'decode':['idle','paused','unavailable'].includes(phase)?'idle-off':'unknown';
  return `<svg class="activity-timeline" viewBox="0 0 100 10" preserveAspectRatio="none" role="img" aria-label="Observed activity over the last fifteen minutes: blue is prefill, green is decode or generation, red is idle or off, and dark gaps are unknown telemetry">${rows.map(r=>{
    const left=Math.max(start,r.start),right=Math.min(now,r.end),width=Math.max(0,(right-left)/9000);
    return `<rect class="phase-${band(r.phase)}" x="${Math.max(0,(left-start)/9000)}" width="${width}" height="10"><title>${esc(r.phase)} · ${Math.round((right-left)/1000)}s</title></rect>`;
  }).join('')}</svg>`;
}
function routingInfo(w,{stale=false,recovering=false}={}) {
  if(stale||!w)return {level:'unknown',label:'STATUS UNKNOWN',detail:'Live gateway status is unavailable. Routing controls are disabled until it returns.',action:null};
  const busy=!!w.load||w.queued>0,held=!!w.holds?.length,locked=!!w.maintenance_locks?.length;
  const reasons=[];
  if(w.quarantine)reasons.push(({repeated_inference_failures:'DSG isolated this server after repeated inference failures.',fatal_accelerator_error:'DSG isolated this server after a fatal accelerator error.',accelerator_checkpoint_failure:'DSG isolated this server after an accelerator checkpoint failure.'})[w.quarantine.reason]||'DSG isolated this server after a generation fault.');
  if(w.operator_paused)reasons.push('An operator paused gateway routing.');
  if(w.last_operator_action){const action=w.last_operator_action,source=action.control_channel.replaceAll('_',' ');reasons.push(`Last local operator control: ${action.action} via ${source} at ${new Date(action.time).toLocaleString()}. The source label identifies the client path, not a human identity.`);}
  if(held)reasons.push(`Reserved by ${w.holds.map(h=>h.owner_id).join(', ')}. The owning agent must release its hold; Resume cannot override it.`);
  if(locked)reasons.push(`Maintenance lock${w.maintenance_locks.length===1?'':'s'}: ${w.maintenance_locks.map(lock=>lock.name).join(', ')}. Release each exact lock in Settings; routing remains paused until a separate checked Resume.`);
  if(recovering)reasons.push('Service recovery is in progress. Wait for its verification receipt.');
  if(!w.is_healthy&&!w.quarantine&&!recovering&&reasons.length)reasons.push('The last readiness check was also unavailable; resuming will recheck it.');
  const excluded=w.drained||!!w.quarantine||!w.is_healthy||recovering;
  const label=w.quarantine?'QUARANTINED · NOT ROUTING':locked?'MAINTENANCE LOCK · NOT ROUTING':held?'RESERVED · NOT ROUTING':w.drained?(busy?'PAUSING · ADMITTED WORK FINISHING':'PAUSED · NOT ROUTING'):recovering?'RECOVERING · NOT ROUTING':!w.is_healthy?'UNAVAILABLE · NOT ROUTING':'ROUTING ENABLED';
  if(!reasons.length)reasons.push(w.drained?'Gateway routing is paused.':!w.is_healthy?managementDetail(w):'New requests may use this server. Pause stops new admission; admitted requests finish.');
  if(w.quarantine)reasons.push('Verify & readmit checks model/context and generates a small test response. It does not restart DS4; failed checks keep it isolated.');
  return {level:w.quarantine||!w.is_healthy?'bad':excluded?'paused':'ok',label,detail:reasons.join(' '),excluded,
    action:excluded?'resume':'drain',button:w.quarantine?'Verify & readmit':excluded?'Resume routing':'Pause routing',
    blocked:held||locked||recovering||!!w.quarantine&&busy,
    title:locked?'Release the exact named maintenance lock in Settings first; review times never auto-release it.':held?'Release agent holds first.':recovering?'Wait for service recovery.':w.quarantine&&busy?'Wait for admitted work to settle before verification.':excluded?'Check readiness and return to routing. Does not start or restart DS4.':'Stop new gateway admission. Existing admitted work, model process and caches stay intact.'};
}
function managementDetail(w) {
  const m=w?.management_path,reason=m?.reason;
  const reasons={
    adapter_dns_failure:'The SSH management path cannot resolve its configured host alias.',
    adapter_host_key_failure:'SSH rejected the configured host identity. Review the operator-owned known-host entry; DSG will not bypass host-key checking.',
    adapter_auth_failure:'SSH authentication failed for the configured management path.',
    adapter_connect_timeout:'The SSH management path timed out before a verified connection.',
    adapter_connection_refused:'The configured machine refused the SSH connection.',
    adapter_route_unreachable:'The configured machine has no reachable network route from this host.',
    adapter_connection_reset:'The SSH connection was reset or closed remotely.',
    adapter_spawn_failed:'The local SSH client could not be started.',
    adapter_timeout:'The verified recovery inspection exceeded its bounded deadline.',
    adapter_output_limit:'The recovery adapter exceeded its bounded output contract.',
    adapter_unreachable:'The SSH management path exited before verification.',
    adapter_check_failed:'The management path answered, but the enrolled recovery helper did not return a valid check.'};
  const routes=Number.isSafeInteger(m?.route_count)&&m.route_count>1?` DSG is automatically cycling through ${m.route_count} enrolled SSH routes.`:'';
  if(reasons[reason])return reasons[reason]+routes;
  if(m?.transport==='ssh_tunnel'&&m.state==='ssh_process_active')return 'The local SSH tunnel process exists, but the DS4 readiness probe is not succeeding; login, forwarding and service health are not yet distinguished.';
  if(m?.transport==='ssh_tunnel'&&['connecting','retrying','ssh_error','pending'].includes(m.state))return 'The SSH tunnel is not verified; DSG is continuing its configured connection attempts.'+routes;
  if(m?.transport==='local')return 'The local DS4 endpoint is not passing its readiness check.';
  return 'The server is not passing readiness checks. Check its DS4 process or connection, then try again.';
}
function recoveryRecheckable(action){return !!(action?.restart_issued||action?.service_action_issued)&&['reconciliation_needed','failed'].includes(action.state);}
function recoveryIssuanceText(op){return !op.service_action_issued?'':op.service_action==='bootstrap'?(op.bootstrap_acknowledged===true?' · bootstrap acknowledged':' · bootstrap attempted · acknowledgement unknown'):` · ${op.service_action} issued`;}
function routingMarkup(w,{stale=false,controls=true,recovering=false,busy=workerBusy}={}) {
  const info=routingInfo(w,{stale,recovering});
  if(!controls||!info.action)return `<span class="worker-routing" data-level="${info.level}" aria-label="${esc(info.label)}"></span>`;
  const name=String(w.id).replace(/^spark/i,'Spark '),at=w?.quarantine?.at;
  const recorded=at&&Number.isFinite(Date.parse(at))?` Excluded ${new Date(at).toLocaleString()}; recorded by DSG.`:'';
  const tooltip=`${info.label} for ${name}. ${info.detail}${recorded} ${info.title}`;
  const icon=info.action==='drain'?'<path d="M5 4h4v16H5zM15 4h4v16h-4z"/>':'<path d="M6 4l14 8-14 8z"/>';
  return `<span class="worker-routing" data-level="${info.level}"><button class="routing-toggle" type="button" data-action="${info.action}" data-id="${esc(w.id)}" data-tooltip="${esc(tooltip)}" aria-label="${esc(tooltip)}" ${stale||busy||info.blocked||!workerControlsReady?'disabled':''}><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${icon}</svg></button></span>`;
}
function updateRoutingNode(current,fresh) {
  // Keep the button DOM stable during normal polling so keyboard focus, hover
  // tooltips and click targets do not disappear every two seconds.
  current.dataset.level=fresh.dataset.level;
  if(current.innerHTML!==fresh.innerHTML){const focused=current.contains(document.activeElement);current.innerHTML=fresh.innerHTML;if(focused)current.querySelector('button:not(:disabled)')?.focus({preventScroll:true});}
}
function renderDevices(devices,workers,now,stale,scales,controls) {
  const viewport={x:window.scrollX,y:window.scrollY};
  const container=$('devices'),existing=new Map([...container.querySelectorAll('.device')].map(el=>[el.dataset.workerId,el]));
  if(!devices.length){container.innerHTML=`<article class="device onboarding"><h2>Add your first DS4 server</h2><p>Register an already-running local endpoint or an endpoint reached through your existing SSH login. DSG checks model and context, then leaves routing paused until you enable it.</p>${controls?'<button type="button" class="button" data-add-first>Open server setup</button>':'<p class="muted">Enable local server controls in private DSG configuration to register from this dashboard.</p>'}</article>`;return;}
  if(!existing.size)container.replaceChildren();
  devices.forEach((d,i)=>{
    const template=document.createElement('template');template.innerHTML=device(d,workers.find(w=>w.id===d.id),now,stale,i+1,scales,controls);
    const fresh=template.content.firstElementChild;let current=existing.get(d.id);
    if(!current)current=fresh;
    else{
      const evidenceOpen=current.querySelector('.device-evidence')?.open;
      for(const selector of ['.device-identity','.server-verdict','.badge','.device-readings']){const before=current.querySelector(selector),after=fresh.querySelector(selector);if(before.innerHTML!==after.innerHTML)before.innerHTML=after.innerHTML;if(selector==='.device-readings'&&evidenceOpen)before.querySelector('.device-evidence')?.setAttribute('open','');if(before.className!==after.className)before.className=after.className;for(const name of ['data-level','title','hidden']){const value=after.getAttribute(name);if(value===null)before.removeAttribute(name);else before.setAttribute(name,value);}}
      updateRoutingNode(current.querySelector('.worker-routing'),fresh.querySelector('.worker-routing'));
    }
    if(container.children[i]!==current)container.insertBefore(current,container.children[i]||null);
    existing.delete(d.id);
  });
  for(const el of existing.values())el.remove();
  // WebKit can move the viewport when replacing its anchor inside a card.
  // This synchronous refresh must not move the reader; no user input can occur
  // between this snapshot and restoration. User-initiated tab scrolling is separate.
  if(window.scrollX!==viewport.x||window.scrollY!==viewport.y)window.scrollTo(viewport.x,viewport.y);
}
function refreshRoutingControls() {
  for(const el of $('devices').querySelectorAll('.device')){
    const w=visibleWorkers.find(w=>w.id===el.dataset.workerId),template=document.createElement('template');
    template.innerHTML=routingMarkup(w,{stale:workerUiStale,controls:workerControlsVisible,recovering:recoveryState?.workers?.some(r=>r.worker_id===w?.id&&r.state==='recovering')});
    updateRoutingNode(el.querySelector('.worker-routing'),template.content.firstElementChild);
  }
}
function serverVerdict(d,w,now,stale=false) {
  if(stale||!w)return {level:'unknown',label:'Status stale',detail:'Live gateway status is unavailable; values are historical.'};
  if(w.quarantine)return {level:'bad',label:'Quarantined',detail:'DSG isolated this server after a generation fault. Use the recovery/readmission controls only after reviewing the evidence.'};
  if(w.maintenance_locks?.length)return {level:'paused',label:'Maintenance',detail:`Named lock${w.maintenance_locks.length===1?'':'s'} ${w.maintenance_locks.map(lock=>lock.name).join(', ')} prevent all routing and automatic recovery. Review deadlines only warn; they never auto-release.`};
  if(!w.is_healthy)return {level:'bad',label:'Unavailable',detail:managementDetail(w)};
  if(w.drained)return {level:'paused',label:w.load?'Pausing':'Paused',detail:w.load?'No new work is admitted; an already admitted request is still finishing.':'No new gateway requests are admitted to this server.'};
  const waiting=Number.isSafeInteger(w.queued)?w.queued:0,oldest=Number.isFinite(w.oldest_queue_seconds)?w.oldest_queue_seconds:null;
  if(waiting>0)return {level:waiting>=3||oldest>=60?'warn':'busy',label:`Backed up · ${fmt(waiting)} waiting`,detail:`${fmt(waiting)} request${waiting===1?' is':'s are'} queued${oldest===null?'':`; oldest has waited ${fmt(oldest)} seconds`}.`};
  if(w.load)return {level:'busy',label:'Serving',detail:'One request is active and no request is waiting behind it.'};
  const eventAge=Number.isFinite(d?.last_event)?now-d.last_event:null;
  if(d?.telemetry_configured!==false&&(!d?.connected||eventAge>5*60000))return {level:'unknown',label:'Ready · telemetry stale',detail:'Routing is ready, but recent engine timing data is unavailable.'};
  return {level:'ok',label:'Ready · idle',detail:'Healthy, enabled and immediately free for a gateway request.'};
}
function device(d, w, now, stale, index = 1, scales={}, controls=false) {
  const state = phase(d,w,now,stale);
  const bad = stale || !w?.is_healthy;
  const verdict=serverVerdict(d,w,now,stale);
  const metric = (kind, title) => {
    const m = d[kind];
    const staleMetric=!Number.isFinite(m?.time)||now-m.time>60000;
    const explanation=kind==='decode'?'Generation speed measured by DS4, including thinking and answer tokens.':'Prompt-processing speed measured by DS4.';
    const measured=`${staleMetric?'Last':'Latest'} measurement: ${age(m?.time,now)}. Values are engine observations, not a promise of current speed.`;
    return `<div class="metric-block ${staleMetric?'metric-stale':''}"><span class="label" title="${explanation}">${title}</span><div class="rate ${kind}">${fmtWhole(m?.tps)}<em>t/s</em></div><div class="metric-note" title="${esc(measured)}">avg ${fmtWhole(m?.average)} · ${age(m?.time, now)}</div>${chart(d.series, kind, now,scales[kind])}<div class="chart-caption" title="Last 15 minutes; gaps collapsed to idle-coloured separators. Shared ${kind} speed scale, not a shared wall-clock axis.">15m · compressed · 0–${fmtWhole(scales[kind])} t/s</div></div>`;
  };
  const prompt = d.prompt ? `Last prompt: ${fmt(d.prompt.prompt)} tokens · ${fmt(d.prompt.cached)} reused · ${esc(d.prompt.cache)}` : 'No prompt start observed yet';
  const f=w?.predictions?.remaining??w?.predictions?.updated??w?.predictions?.admission;
  const duration=!stale&&w?.load&&Number.isFinite(w.active_seconds)?`<span class="remaining-estimate" title="Elapsed time of the active DSG request; not an estimate">${fmtWhole(Math.floor(w.active_seconds/60))}m active</span>`:'';
  const forecast=duration+(f?`<span class="remaining-estimate${stale||now-f.at>60000?' stale':''}" title="${esc(`${f.experimental?'Experimental':'Validated'} historical ${f.stage==='remaining'?'remaining':'total server-time'} estimate · ${fmt(f.seconds)} seconds · ${age(f.at,now)}. Stale or exceeded estimates are not current ETAs.`)}">${forecastLabel(f,now,stale)}</span>`:'');
  const backlog=w?.queued?`${fmt(w.queued)} waiting${Number.isFinite(w.oldest_queue_seconds)?` · oldest ${fmt(w.oldest_queue_seconds)}s`:''}`:'No requests waiting';
  const phaseRedundant=['unavailable','paused'].includes(state);
  const evidenceSummary=`${fmt(d.cache.reused)} prefix reuse · ${fmt(w?.assigned_sessions)} sessions${w?.queued?` · ${fmt(w.queued)} waiting`:''}`;
  return `<article class="device" data-worker-id="${esc(d.id)}"><div class="device-top"><div class="device-identity"><div class="device-name"><span class="device-number">${String(index).padStart(2,'0')}</span><span class="device-name-text">${esc(d.id.replace(/^spark/, 'Spark '))}</span></div>${forecast}</div><div class="device-status"><span class="server-verdict" data-level="${verdict.level}" title="${esc(verdict.detail)}">${esc(verdict.label)}</span><span class="badge ${bad ? 'bad' : w?.load ? 'busy' : ''}" title="Current generation phase" ${phaseRedundant?'hidden':''}>${esc(!stale&&w?.quarantine?'quarantined':state==='decode'?'answering':state)}</span>${routingMarkup(w,{stale,controls,recovering:recoveryState?.workers?.some(r=>r.worker_id===w?.id&&r.state==='recovering')})}</div></div><div class="device-readings">${timeline(d,now)}${thinkingIndicator(w,stale,now)}<div class="metrics">${metric('decode','DECODE')}${metric('prefill','PREFILL')}</div>${hardwareMarkup(d.hardware,now)}<details class="device-evidence"><summary><span>Cache + session evidence</span><span>${evidenceSummary}</span></summary><p class="prompt-note">${prompt}</p><div class="cache"><div><strong>${fmt(d.cache.reused)}</strong><span>Prefix reused</span></div><div><strong>${fmt(d.cache.cold)}</strong><span>Cold starts</span></div><div><strong>${fmt(d.cache.resident_misses)}</strong><span>Resident misses</span></div><div><strong>${fmt(d.cache.disk_restores)}</strong><span>Disk restores</span></div></div><p class="cache-note">Observed since ${d.cache_observed_since ? clock(d.cache_observed_since) : d.observed_since ? clock(d.observed_since) : 'connecting'} · RAM misses ≠ cold starts</p><div class="device-foot"><span>${backlog} · ${fmt(w?.assigned_sessions)} assigned sessions</span><span>${telemetryStatus(d)} · ${w?.load ? `${fmt(w.active_seconds)}s active` : 'last sample '+age(d.last_event,now)}</span></div></details></div></article>`;
}
const headlineSeverity=value=>['good','info','warning','critical'].includes(value)?value:'info';
function deterministicHealthAlerts(snapshot) {
  const gateway=snapshot?.gateway,workers=Array.isArray(gateway?.workers)?gateway.workers:[],recovery=Array.isArray(gateway?.recovery?.workers)?gateway.recovery.workers:[];
  const recoveryByWorker=new Map(recovery.map(worker=>[worker.worker_id,worker]));
  const fleet=`${fmt(gateway?.available)} of ${fmt(gateway?.total)} DS4 servers are available`;
  const alerts=[];
  for(const run of gateway?.client_watch?.runs??[])if(run.fresh&&run.process_alive&&run.diagnosis==='no_request_reached_dsg')alerts.push({severity:'warning',text:`${run.client} run ${run.watch_ref} reports waiting for a model, but no matching request reached DSG after ${fmt(run.state_seconds)}s. Recommendation: Inspect that client's provider transport; no DS4 fault or frozen process is proven.`});
  for(const run of gateway?.client_watch?.runs??[])if(run.fresh&&run.process_alive&&run.diagnosis==='client_reported_error')alerts.push({severity:'warning',text:`${run.client} run ${run.watch_ref} reports a failed turn with no automatic continuation remaining. Recommendation: Inspect the client before resubmitting; this is not proof that replay is safe or that DS4 failed.`});
  for(const worker of workers) {
    const name=String(worker?.id??'Unknown server').replace(/^spark/i,'Spark '),held=Array.isArray(worker?.holds)&&worker.holds.length>0;
    if(worker?.quarantine) {
      const waiting=Number.isSafeInteger(worker.recovery_waiting)&&worker.recovery_waiting>0?` ${fmt(worker.recovery_waiting)} request${worker.recovery_waiting===1?' is':'s are'} being held for this server.`:' ';
      const recoveryState=recoveryByWorker.get(worker.id),reason=recoveryState?.reason;
      const launchdAdvice={
        launchd_registration_absent:'The Mac service registration is missing. Ask the operator to inspect the established launcher; kickstart cannot restore a removed job, and DSG has no bootstrap authority.',
        launchd_gui_domain_unavailable:'The Mac GUI service domain is unavailable. Ask the operator to check the login/session state; this does not prove a DS4 or accelerator fault.',
        launchd_state_unverified:'Mac service inspection could not establish the state. Check local permissions and service-manager output before taking action; absence is not proven.',
        launchd_native_disabled:'macOS explicitly disables this service. Respect that stop instruction; ask the operator before changing native service policy. DSG will not enable it.',
        launchd_disable_state_unverified:'The Mac native disable setting could not be verified. Check the enrolled helper version and launchctl inspection; unknown policy is not permission to start.'
      }[reason];
      const recommendation=launchdAdvice??(reason==='service_identity_or_profile_unverified'
        ?'Review and deliberately re-enroll the changed DS4 service profile before recovery; simply enabling routing would bypass the safety boundary.'
        :reason==='profile_handback_confirmation_pending'
          ?'Leave the server idle while DSG confirms the same changed profile in a second inspection; no action has been authorized yet.'
          :reason==='profile_handback_disabled'
            ?'Review the changed profile, then enable verified profile hand-back or complete an operator-led enrollment.'
            :reason==='profile_handback_wait_for_admitted_work'
              ?'Wait for admitted work to finish; profile adoption and recovery cannot begin while a request is owned by this server.'
        :recoveryState?.eligible
          ?'Use the verified recovery control; DSG will restart only the enrolled service and test it before readmission.'
          :'Inspect the recovery blocker before readmission; do not simply enable routing.');
      alerts.push({severity:'critical',text:`${name} is quarantined after ${String(worker.quarantine.reason||'a generation fault').replaceAll('_',' ')}; ${fleet}.${waiting} Recommendation: ${recommendation}`});
      continue;
    }
    const overdue=(worker?.maintenance_locks??[]).filter(lock=>Number.isFinite(lock.review_at)&&lock.review_at<=Date.now());
    if(worker?.load>0&&Number.isFinite(worker.active_seconds)&&worker.active_seconds>=1800&&worker.queued>0){
      const d=snapshot.devices?.find(device=>device.id===worker.id),decode=d?.decode,now=snapshot.time??Date.now();
      const fresh=d?.connected&&Number.isFinite(decode?.time)&&now-decode.time>=0&&now-decode.time<=15000&&Number.isSafeInteger(decode.generated)&&decode.generated>=0;
      const progress=fresh?` Latest engine sample: ${fmt(decode.generated)} generated tokens${decode.thinking?' (thinking phase)':''}; ${fmtWhole(decode.tps)} t/s.`:' Fresh engine generation progress is unavailable.';
      alerts.push({severity:'warning',text:`${name}: one DSG request has held its slot for ${fmtWhole(Math.floor(worker.active_seconds/60))}m; ${fmt(worker.queued)} waiting.${progress} Recommendation: Review the long-running client request. Elapsed time alone does not prove a hang or authorize cancellation.`});
    }
    if(overdue.length)alerts.push({severity:'warning',text:`${name} remains protected by overdue maintenance lock${overdue.length===1?'':'s'} ${overdue.map(lock=>lock.name).join(', ')}. Recommendation: Confirm the external work is finished, then release the exact lock; DSG will keep routing paused until a separate checked Resume.`});
    // Operator pauses, maintenance locks and scoped agent holds are intentional capacity choices,
    // not faults. They stay explicit on the worker card without becoming alarms.
    if(worker?.drained||held)continue;
    if(worker?.is_healthy===false) {
      const waiting=Number.isSafeInteger(worker.recovery_waiting)&&worker.recovery_waiting>0?worker.recovery_waiting:0;
      alerts.push({severity:waiting>0?'critical':'warning',text:`${name} is enabled but unavailable; ${fleet}.${waiting?` ${fmt(waiting)} request${waiting===1?' is':'s are'} waiting for it.`:''} Recommendation: Inspect its readiness and verified management path before readmission.`});
    }
  }
  return alerts;
}
function renderAgentWatch(watch){
  const panel=$('agent-watch'),runs=watch?.runs??[];panel.hidden=!watch;
  if(!watch)return;
  const needsAttention=run=>run.fresh&&['no_request_reached_dsg','client_reported_error'].includes(run.diagnosis);
  const fresh=runs.filter(run=>run.fresh).length,attention=runs.filter(needsAttention).length;
  $('agent-watch-status').textContent=runs.length?`${fmt(runs.length)} enrolled · ${fmt(fresh)} fresh${attention?` · ${fmt(attention)} check`:''}`:'No enrolled clients reporting';
  const labels={local_tool_active:'local tool active',waiting_inside_dsg:'waiting inside DSG',model_response_active:'model response active',no_request_reached_dsg:'no request reached DSG',waiting_to_reach_dsg:'waiting to reach DSG',client_processing_after_dsg:'client processing after DSG',client_reported_error:'client reports a failed turn',heartbeat_stale_unknown:'heartbeat stale · state unknown',idle:'idle',done:'done',unknown:'state unknown'};
  $('agent-watch-items').innerHTML=runs.length?runs.slice(0,24).map(run=>`<li data-level="${needsAttention(run)?'attention':run.fresh?'current':'unknown'}"><time>${esc(age(Date.parse(run.last_seen_at),Date.now()))}</time><strong>${esc(run.client)} · ${esc(run.watch_ref)}</strong><span>${esc(labels[run.diagnosis]??'state unknown')}${run.request?` · DSG ${esc(run.request.state.replaceAll('_',' '))}`:''}</span></li>`).join(''):'<li class="muted">No enrolled clients reporting.</li>';
}
function healthHeadlines(snapshot, ticker) {
  if(!snapshot?.gateway || snapshot.gateway_error)return {level:'unknown',items:[{severity:'info',text:'Gateway status unavailable; recommendations withheld until fresh evidence returns.'}]};
  const safety=deterministicHealthAlerts(snapshot),genie=ticker?.state==='ready'&&ticker.entries?.length?ticker.entries.map(e=>({severity:headlineSeverity(e.severity),text:`${e.text}${e.recommendation?` Recommendation: ${e.recommendation}`:''}`})):[];
  if(safety.length||genie.length) {
    const items=[...safety,...genie],prefix=safety.length?'DSG safety alert'+(genie.length?' + Genie assessment':' · live gateway evidence'):'Genie assessment';
    return {level:items.some(e=>e.severity==='critical')?'critical':items.some(e=>e.severity==='warning')?'warn':items.some(e=>e.severity==='good')?'ok':'info',evidence_at:ticker?.evidence_at,
      label:`${prefix}${genie.length?` · evidence ${clock(ticker.evidence_at)}${ticker.refreshing?' · updating':ticker.review_error?' · latest refresh failed':''}`:''}`,items};
  }
  const message={off:'Gate Genie is off. Enable him below for generated health observations.',
    reviewing:'Gate Genie is reviewing fleet evidence. His observations and recommendations will appear here.',
    pending:'Waiting for a Genie assessment from the selected server.',
    stale:'The last assessment is over 10 minutes old or has no valid evidence time. Request a fresh review below.',
    changed:'Fleet health or membership changed since the last assessment. Request a fresh review before acting on old advice.',
    invalid:'Genie returned no valid ticker entries. Read his assessment below or request another review.',
    error:ticker?.provider_attempts?.length>1
      ?`The Genie review failed after both the dedicated provider and DSG pool fallback were tried (${ticker.provider_attempts.map(a=>`${String(a.provider).replaceAll('_',' ')}: ${String(a.reason||a.outcome).replaceAll('_',' ')}`).join('; ')}). The gateway is unaffected.`
      :'The Genie review failed. Check his status below; no replacement advice has been invented.',
    unavailable:'Genie status is unavailable. Waiting for a fresh assessment.'};
  return {level:'unknown',label:'Genie status',items:[{severity:'info',text:message[ticker?.state] || 'Connecting to Gate Genie…'}]};
}
let wireSnapshot=null,wireSignature=null,wireState=null,requestFilter='all';
function renderRequests(events) {
  const recent=events.filter(e=>e.event==='request_finished').reverse();
  const rows=recent.filter(e=>requestFilter==='problems'?!['complete','vision_guidance'].includes(e.outcome):requestFilter==='slow'?e.elapsed_ms>=300000||e.queue_ms>=60000:true).slice(0,12);
  $('requests').innerHTML = rows.length ? rows.map(e => `<tr><td>${e.time ? clock(e.time) : '—'}</td><td>${esc(e.node)}</td><td class="${e.outcome === 'complete' ? 'success' : e.outcome === 'vision_guidance' ? 'protected' : e.outcome === 'client_cancelled' ? 'cancelled' : 'failure'}">${esc(e.outcome?.replaceAll('_',' ') || 'unknown')}</td><td>${fmt(e.elapsed_ms / 1000)}s</td><td>${fmt(e.queue_ms)}ms</td><td>${fmt(e.usage?.cached_tokens)} / ${fmt(e.usage?.prompt_tokens)}</td><td>${fmt(e.usage?.completion_tokens)}</td><td class="mono" title="${esc(e.request_id)}">${esc(e.request_id?.slice(0,8))}</td></tr>`).join('') : `<tr><td colspan="8" class="muted">No ${requestFilter==='all'?'request completions in the observed log tail':requestFilter} requests match the current filter.</td></tr>`;
}
function renderHealthWire(snapshot) {
  wireSnapshot=snapshot;
  const wire=$('health-wire');
  if(wire.matches(':hover, :focus-within'))return;
  const news=healthHeadlines(snapshot,wireState),signature=JSON.stringify(news);
  if(signature===wireSignature)return;
  wireSignature=signature;wire.dataset.level=news.level;
  for(const id of ['health-wire-text','health-wire-copy']) {
    const group=$(id);group.replaceChildren(...news.items.map(entry=>{
      const item=document.createElement('span');item.className='health-wire-item';item.dataset.severity=headlineSeverity(entry.severity);
      const label=document.createElement('span');label.className='health-wire-severity';label.textContent={good:'Good',info:'Info',warning:'Warning',critical:'Critical'}[item.dataset.severity]+': ';
      const text=document.createElement('span');text.textContent=entry.text;item.append(label,text);return item;
    }));
  }
  // Measure one complete group, including the deliberate gaps, at 52px/s.
  // Polling preserves the animated track rather than restarting its animation.
  $('health-wire-track').style.animationDuration=`${Math.max(12,$('health-wire-text').getBoundingClientRect().width/52)}s`;
}
function render(s) {
  const g = s.gateway, now = s.time, stale = !!s.gateway_error;
  renderPredictor(g?.predictor,stale||!s.worker_management);
  $('calibration-status').textContent=stale?'Calibration safety status unavailable; no job is authorized.':g?.calibration?.execution_available===false?'Synthetic calibration skipped: no verified cache-preserving execution path. Idle does not prove warm caches are safe. Ordinary traffic collection and CPU training continue.':'Synthetic calibration is not configured; no job is authorized.';
  renderHealthWire(s);
  renderAgentWatch(g?.client_watch);
  const rejected=g?.continuity?.recent_rejections??[];
  $('patient-wait-status').hidden=stale||!g?.continuity?.waiting;
  $('patient-wait-status').textContent=`DSG is holding ${fmt(g?.continuity?.waiting)} undispatched requests for recovery/readiness · oldest wait ${fmt(g?.continuity?.oldest_wait_seconds)}s · ${Object.entries(g?.continuity?.waiting_reasons??{}).map(([reason,n])=>`${fmt(n)} ${reason.replaceAll('_',' ')}`).join(' · ')}. They resume automatically when eligible; pauses remain respected.`;
  $('continuity-status').textContent=stale?'Historical evidence: gateway unavailable.':!g?.continuity?'This gateway version does not expose continuity receipts.':`${rejected.length} recent rejected attempts in this gateway run. Not dispatched means no inference started for that attempt, not that the client resumed. Long waits are not proof of a stall.`;
  $('continuity-rejections').innerHTML=rejected.slice(0,8).map(r=>`<p><time>${esc(clock(r.time))}</time> · ${esc(r.node||'pool')} · ${esc(r.reason?.replaceAll('_',' '))} · ${r.retry_class==='wait_then_retry'?'compatible client may wait/retry':'operator investigation required'} · <code title="${esc(r.request_id)}">${esc(r.request_id?.slice(0,8))}</code></p>`).join('');
  $('connection').textContent = s.demo ? '◉ Demo telemetry' : stale ? 'Status unavailable' : '● Live telemetry';
  $('warning').hidden = !s.gateway_error && !s.telemetry_error;
  $('warning').textContent = [s.gateway_error,s.telemetry_error].filter(Boolean).join(' · ');
  $('model').textContent = s.demo ? `${g?.model || 'DS4'} · illustrative data · no real DS4 servers connected` : `${g?.model || 'DS4'} · one active gateway request per DS4 server · session-affinity routing`;
  const door=s.continuity_door,waiting=knownWaiting(g,door);
  $('available').textContent = g ? `${g.available} / ${g.total}` : '—'; $('active').textContent = fmt(g?.active); $('queued').textContent = g?fmt(waiting.total):'—';
  $('queued').title=door?.holding?`${fmt(waiting.core)} admitted in the gateway core + ${fmt(waiting.held)} held safely at the Continuity Door. Pi/Hermes work not yet sent to DSG is not visible here.`:'Requests known to DSG and not yet dispatched. Pi/Hermes work not yet sent to DSG is not visible here.';
  const cap=capacity(g,stale),scales=Object.fromEntries(['decode','prefill'].map(kind=>[kind,Math.ceil(Math.max(1,...s.devices.flatMap(d=>d.series.filter(p=>p.kind===kind && now-p.time<900000).map(p=>p.tps))))]));
  $('capacity-value').textContent=cap?.percent!=null?`${cap.percent}% occupied`:'Unknown';
  $('capacity-note').textContent=cap?`${cap.occupied} / ${cap.eligible} eligible slots occupied · ${cap.free} immediately free · ${fmt(waiting.total)} waiting in DSG${waiting.held?` (${fmt(waiting.core)} core + ${fmt(waiting.held)} Continuity Door)`:''}`:'Gateway status is unavailable';
  $('capacity-meter').value=cap?.percent||0;$('capacity-meter').hidden=cap?.percent==null;
  $('continuity-door-status').textContent=s.continuity_door_error?`${s.continuity_door_error}.`:!door?'Continuity Door is not enabled.':door.holding?`Continuity Door holding ${fmt(door.held)} new request${door.held===1?'':'s'} while the core is ${door.core_ready?'ready':'unavailable'}; existing streams remain connected.`:`Continuity Door ready · ${fmt(door.active)} active proxied stream${door.active===1?'':'s'} · no request-body spooling or replay.`;
  visibleWorkers=g?.workers??[];workerUiStale=stale;workerControlsVisible=s.worker_management===true;
  $('capacity-note').title=stale?'Live gateway status is unavailable.':!g?.total?'No DS4 servers are registered. Open Settings to add your first endpoint.':schedulingExplanation(g,visibleWorkers,cap).trim();
  const excluded=visibleWorkers.filter(w=>routingInfo(w).excluded);
  $('routing-summary').hidden=!excluded.length&&!stale&&!g?.draining;
  $('routing-summary').textContent=stale?'Routing status is stale. Controls are disabled until live status returns.':`${g?.draining?'The gateway is draining: all new admission is stopped. ':''}${excluded.length?`${excluded.length} server${excluded.length===1?' is':'s are'} not accepting new work: ${excluded.map(w=>w.id).join(', ')}. See the highlighted reason and routing control on each server card below.`:''}`;
  renderDevices(s.devices,visibleWorkers,now,stale,scales,workerControlsVisible);
  const ds=g?.dataset;
  $('embedding-detail').textContent=embeddingInfo(ds);
  $('cache-evidence-status').textContent=cacheEvidenceText(s,stale);
  const selector=$('cache-cost-worker'),selected=selector.value,options=(g?.workers||[]).map(w=>`<option value="${esc(w.id)}">${esc(w.id)}</option>`).join('');
  if(selector.innerHTML!==options){selector.innerHTML=options;if((g?.workers||[]).some(w=>w.id===selected))selector.value=selected;}
  $('dataset-status').textContent=stale?'Collector status stale':!ds?.enabled?'Collector not enabled':ds.error||'Collecting routing evidence';
  $('dataset-detail').textContent=ds?`${fmt(ds.written)} events saved this gateway run · ${fmt(ds.bytes/1048576)} MiB stored · ${fmt(ds.pending)} pending · ${fmt(ds.dropped)} dropped · ${fmt(ds.finished)} finishes (${fmt(ds.missing_usage)} missing usage, ${fmt(ds.truncated)} output-limited, ${fmt(ds.failed_or_cancelled)} failed/cancelled) · last write ${age(ds.last_write,now)}`:'Existing engine metrics are separate from the new request dataset.';
  $('worker-management').hidden = !s.worker_management;
  $('tab-settings').hidden=!s.worker_management;
  $('control-mode').closest('.read-only').hidden=!!s.worker_management;
  $('control-mode').hidden=!!s.worker_management;
  $('control-mode').textContent='[ read only ]';
  $('control-note').hidden=!!s.worker_management;
  $('control-note').textContent = 'No model controls.';
  if(s.worker_management) {
    if(globalThis.location?.hash==='#settings'&&currentWorkspace!=='settings')activateWorkspaceTab('settings');
    wireWorkerControls(); void loadWorkers();
  } else if(currentWorkspace==='settings')activateWorkspaceTab('fleet',{updateHash:true});
  renderRequests(s.events);
  renderGenieActionLedger();
  $('updated').textContent = `Gateway checked ${s.gateway_at ? clock(s.gateway_at) : '—'} · dashboard started ${clock(s.started)}`;
}
async function poll() {
  try { const r = await fetch('/api/status', { cache: 'no-store', signal: AbortSignal.timeout(5000) }); if (!r.ok) throw new Error(); render(await r.json()); }
  catch { workerUiStale=true;refreshRoutingControls();$('connection').textContent = 'Disconnected'; $('warning').hidden = false; $('warning').textContent = 'Dashboard connection lost. Values below are historical, not live.'; renderHealthWire({time:Date.now(),gateway_error:true}); }
  finally { setTimeout(poll, document.hidden ? 10000 : 2000); }
}
let controlsWired = false, workerBusy = false, workersLoading = false, csrfToken = null,recoveryState=null;
let workerControlsReady=false,workerControlsVisible=false,workerUiStale=true,visibleWorkers=[];
let contextDirty=false, contextExpected=null;
let queueDirty=false,queueExpected=null;
let visionProtectionEnabled=false;
function workerMessage(text, error = false) {
  $('worker-message').textContent = text; $('worker-message').classList.toggle('error',error);
  $('routing-message').textContent=text;$('routing-message').classList.toggle('error',error);
}
function workerRows(workers) {
  return workers.map(w=>{
    const busy=!!w.load || w.queued>0;
    const holds=w.holds??[],held=holds.length>0,locks=w.maintenance_locks??[],locked=locks.length>0;
    const info=routingInfo(w,{recovering:recoveryState?.workers?.some(r=>r.worker_id===w.id&&r.state==='recovering')});
    const routing=info.label;
    const id=esc(w.id);
    const ownership=`${w.operator_paused?'<br><small>Operator pause</small>':''}${holds.map(h=>`<br><small>Held by ${esc(h.owner_id)}${h.reason?`: ${esc(h.reason)}`:''}</small>`).join('')}${locks.map(lock=>`<br><small class="maintenance-lock${Number.isFinite(lock.review_at)&&lock.review_at<=Date.now()?' overdue':''}">Maintenance: ${esc(lock.name)}${lock.reason?` · ${esc(lock.reason)}`:''}${Number.isFinite(lock.review_at)?` · review ${lock.review_at<=Date.now()?'overdue':`in ${remaining(lock.review_at,Date.now())}`}`:' · no automatic expiry'}</small>`).join('')}`;
    const routes=w.ssh?`<button class="button" title="Edit only the host-key-verified SSH fallback aliases. The current inference stream and primary route are not interrupted; the new list applies on the next reconnect." data-action="fallbacks" data-id="${id}" ${workerBusy?'disabled':''}>Routes ${fmt(1+(w.ssh_fallbacks?.length??0))}</button>`:'';
    const lockActions=locks.map(lock=>`<button class="button" title="Release only ${esc(lock.name)}. The server stays paused until a separate checked Resume." data-action="unlock" data-id="${id}" data-lock-id="${esc(lock.id)}" ${workerBusy?'disabled':''}>Release ${esc(lock.name)}</button>`).join('');
    return `<tr><td>${id}</td><td>${fmt(w.context_length)}</td><td title="${esc(info.detail)}">${routing}${ownership}</td><td>${fmt(w.load)} / ${fmt(w.queued)}</td><td class="worker-actions"><button class="button" title="${esc(info.title)}" data-action="${info.action}" data-id="${id}" ${workerBusy||info.blocked?'disabled':''}>${info.button}</button><button class="button" title="Create a named durable maintenance lock. It immediately stops new admission and never auto-expires." data-action="lock" data-id="${id}" ${workerBusy?'disabled':''}>Maintenance lock</button>${lockActions}${held&&!w.operator_paused?`<button class="button" title="Keep an operator pause even after all agents release their holds." data-action="drain" data-id="${id}" ${workerBusy?'disabled':''}>Keep paused</button>`:''}${routes}<button class="button" title="Remove registration only after draining and releasing all holds and maintenance locks. Does not stop DS4." data-action="remove" data-id="${id}" ${workerBusy||!w.drained||busy||held||locked?'disabled':''}>Remove</button></td></tr>`;
  }).join('') || '<tr><td colspan="5">No workers registered.</td></tr>';
}
async function loadWorkers() {
  if(workersLoading||workerBusy)return;
  workersLoading=true;
  try {
    const r=await fetch('/api/workers',{cache:'no-store',signal:AbortSignal.timeout(5000)}), data=await r.json();
    if(!r.ok||!data.enabled)throw new Error(data.error||'Worker controls unavailable');
    csrfToken=data.csrf_token;workerControlsReady=true;
    // A transient startup/socket race must not leave a permanent red banner
    // after the authoritative control read succeeds. Preserve non-error action
    // receipts so the operator still sees what they just requested.
    if($('routing-message').classList.contains('error')||$('worker-message').classList.contains('error'))workerMessage('');
    renderRecovery(data.recovery);
    const rows=workerRows(data.workers);if($('worker-rows').innerHTML!==rows)$('worker-rows').innerHTML=rows;
    $('pool-context-form').hidden=!data.context_limit_control;
    $('pool-context-note').hidden=!data.context_limit_control;
    if(!contextDirty){contextExpected=data.minimum_context;$('pool-context-input').value=String(data.minimum_context);}
    $('queue-timeout-form').hidden=$('queue-timeout-note').hidden=!data.queue_timeout_control;
    if(data.queue_timeout_control){
      $('queue-timeout-current').textContent=`Current: ${fmt(data.queue_timeout_ms/3600000)} hours (${data.queue_timeout_source}).`;
      if(!queueDirty){queueExpected=data.queue_timeout_ms;$('queue-timeout-input').value=String(data.queue_timeout_ms/3600000);}
    }
    const protection=data.protections?.vision_jpeg;
    $('vision-protection-control').hidden=!protection;
    if(protection){
      visionProtectionEnabled=protection.enabled===true;
      $('vision-protection-status').textContent=`${visionProtectionEnabled?'ON':'OFF'}${!protection.available?' · guidance only (configure a supported local converter for automatic repair)':''} · ${fmt(protection.rescued)} repaired · ${fmt(protection.guided)} resend notices · ${fmt(protection.failed)} ambiguous/failed retries`;
      $('vision-protection-toggle').textContent=visionProtectionEnabled?'Disable':'Enable';
      $('vision-protection-toggle').disabled=workerBusy;
    }
    const offers=data.queued_relocation?.offers??[];
    $('relocation-controls').hidden=!data.queued_relocation;
    $('relocation-offers').replaceChildren(...(offers.length?offers.map(offer=>{
      const p=document.createElement('p'),button=document.createElement('button');
      p.append(document.createTextNode(`${offer.source} → ${offer.destination} · waiting ${fmt(offer.waiting_seconds)}s · `));
      button.type='button';button.className='button';button.dataset.relocation=JSON.stringify(offer);button.textContent='Move queued request';
      button.disabled=workerBusy;button.title='The request has not reached DS4. Preserve its client socket and deadline, but accept that the destination may not have its warm cache.';
      p.append(button);return p;
    }):[document.createTextNode(relocationEmpty(data.queued_relocation?.diagnostics))]));
  } catch(e) { workerControlsReady=false;workerMessage(e.message,true);$('worker-rows').querySelectorAll('button').forEach(b=>{b.disabled=true;});$('recovery-status').textContent='Recovery controls unavailable; last state is stale';$('recovery-toggle').disabled=true;$('recovery-handback-toggle').disabled=true; }
  finally { workersLoading=false;refreshRoutingControls(); }
}
async function workerAction(action, input) {
  if(workerBusy)return;
  if(!csrfToken||!workerControlsReady||workerUiStale){workerMessage('Live worker controls are unavailable; try again once connected.',true);return;}
  workerBusy=true;
  refreshRoutingControls();
  $('worker-form').querySelector('button').disabled=true;
  $('pool-context-form').querySelector('button').disabled=true;
  $('queue-timeout-form').querySelector('button').disabled=true;
  $('vision-protection-toggle').disabled=true;
  $('worker-rows').querySelectorAll('button').forEach(b=>{b.disabled=true;});
  $('relocation-offers').querySelectorAll('button').forEach(b=>{b.disabled=true;});
  const target=input.workers?.join(', ');
  workerMessage(action==='context'?'Checking enabled server capacities…':action==='add'?'Checking model and context…':action==='fallbacks'?'Saving verified management-route fallbacks…':action==='resume'?`${target}: checking readiness and any required generation proof…`:'Updating worker routing…');
  try {
    const r=await fetch(`/api/workers/${action}`,{method:'POST',headers:{'content-type':'application/json','x-dsg-csrf':csrfToken},body:JSON.stringify(input),signal:AbortSignal.timeout(35000)});
    const data=await r.json();if(!r.ok)throw new Error(data.error||'Worker control failed');
    workerMessage(action==='lock'?`${data.result.worker_id}: durable maintenance lock created. Automatic recovery and routing are vetoed until its exact release.`:action==='unlock'?`${data.result.worker_id}: maintenance lock released; routing remains paused until a separate checked Resume.`:action==='recover'?`Recovery accepted: ${data.id}. See executor receipts below.`:action==='recovery-policy'?`Automatic recovery ${data.automatic?'enabled':'disabled'}.`:action==='recovery-handback-policy'?`Verified profile hand-back ${data.profile_handback_automatic?'enabled':'disabled'}. Automatic recovery remains ${data.automatic?'on':'off'}.`:action==='protection'?`Image compatibility protection ${data.vision_jpeg?.enabled?'enabled':'disabled'}. Existing requests and DS4 settings are unchanged.`:action==='context'?`Pool limit saved: ${fmt(data.minimum_context)} tokens. Applied now; model servers and Pi unchanged.`:action==='fallbacks'?`Management fallbacks saved. Active inference was not interrupted; the list applies on the next reconnect.`:action==='add'?'Registered paused. Enable routing when ready.':action==='drain'?'Draining. Admitted requests will finish before removal.':action==='remove'?'Removed from this gateway. Model server left running.':action==='relocate'?`${data.source} → ${data.destination}: undispatched request handed over with its original client and deadline.`:'Routing enabled.');
    if(action==='context'){contextDirty=false;contextExpected=data.minimum_context;}
    if(action==='queue-timeout'){queueDirty=false;queueExpected=data.queue_timeout_ms;workerMessage(`Queue allowance saved: ${fmt(data.queue_timeout_ms/3600000)} hours for new requests. Existing waits and model servers unchanged.`);}
    if(action==='add')$('worker-form').reset();
    if(action==='resume')workerMessage(`${target}: routing enabled after checks passed. Model settings unchanged.`);
    if(action==='drain')workerMessage(`${target}: paused for new work. Admitted requests finish; Resume routing reverses this.`);
  } catch(e) { workerMessage(`${e.message}. Check the worker list before retrying.`,true); }
  finally { workerBusy=false;$('worker-form').querySelector('button').disabled=false;$('pool-context-form').querySelector('button').disabled=false;$('queue-timeout-form').querySelector('button').disabled=false;updateConnectionFields();refreshRoutingControls();void loadWorkers(); }
}
function updateConnectionFields() {
  const form=$('worker-form'), remote=form.elements.connection.value==='ssh';
  $('ssh-host-field').hidden=!remote;$('ssh-fallback-field').hidden=!remote;$('remote-port-field').hidden=!remote;
  form.elements.ssh.disabled=!remote;form.elements.ssh.required=remote;form.elements.ssh_fallbacks.disabled=!remote;form.elements.remote_port.disabled=!remote;
  $('endpoint-label').textContent=remote?'Local tunnel URL (free port)':'Local server URL';
  form.elements.url.placeholder=remote?'http://127.0.0.1:38003':'http://127.0.0.1:8000';
}
function wireWorkerControls() {
  if(controlsWired)return;controlsWired=true;
  const form=$('worker-form');form.elements.connection.addEventListener('change',updateConnectionFields);
  $('pool-context-input').addEventListener('input',()=>{contextDirty=true;});
  $('queue-timeout-input').addEventListener('input',()=>{queueDirty=true;});
  $('queue-timeout-form').addEventListener('submit',e=>{
    e.preventDefault();const hours=Number($('queue-timeout-input').value),ms=hours*3600000;
    if(!Number.isSafeInteger(hours)||hours<1||!Number.isSafeInteger(ms)){workerMessage('Enter a positive whole number of hours within the supported integer range.',true);return;}
    if(ms<queueExpected&&!window.confirm(`Reduce the queue waiting allowance to ${fmt(hours)} hours for new requests? They may expire sooner. Existing queued requests and active generations keep their current deadlines.`))return;
    void workerAction('queue-timeout',{queue_timeout_ms:ms,expected_queue_timeout_ms:queueExpected});
  });
  $('vision-protection-toggle').addEventListener('click',()=>void workerAction('protection',{id:'vision_jpeg',enabled:!visionProtectionEnabled}));
  $('pool-context-form').addEventListener('submit',e=>{
    e.preventDefault();const value=Number($('pool-context-input').value);
    if(!Number.isSafeInteger(value)||value<=0){workerMessage('Enter a positive whole token count.',true);return;}
    if(value<contextExpected&&!window.confirm(`Lower the advertised pool context from ${fmt(contextExpected)} to ${fmt(value)} tokens? This can change client compaction behavior. Model servers and existing requests are not resized.`))return;
    void workerAction('context',{context_length:value,expected_context_length:contextExpected});
  });
  form.addEventListener('submit',e=>{
    e.preventDefault();const worker={id:form.elements.id.value.trim(),url:form.elements.url.value.trim()};
    if(form.elements.connection.value==='ssh'){
      worker.ssh=form.elements.ssh.value.trim();worker.remote_port=Number(form.elements.remote_port.value);
      const fallbacks=[...new Set(form.elements.ssh_fallbacks.value.split(',').map(v=>v.trim()).filter(Boolean))];if(fallbacks.length)worker.ssh_fallbacks=fallbacks;
    }
    void workerAction('add',{worker});
  });
  const handleWorkerClick=e=>{
    const button=e.target.closest('button[data-action]');if(!button||button.disabled)return;
    const {action,id}=button.dataset;
    if(action==='lock'){
      const name=window.prompt(`Name this maintenance lock for ${id}. It will survive DSG restarts and never auto-expire.`,`maintenance-${id}`);if(name===null)return;
      const reason=window.prompt(`Why must ${id} stay out of DSG routing? Do not include secrets or conversation text.`,'External DS4 testing in progress');if(reason===null)return;
      const review=window.prompt('Review reminder in whole hours (optional). This only warns; it never releases the lock.','24');if(review===null)return;
      const review_after_hours=review.trim()===''?null:Number(review);
      if((review_after_hours!==null)&&(!Number.isSafeInteger(review_after_hours)||review_after_hours<1||review_after_hours>8760)){workerMessage('Review reminder must be blank or 1–8760 whole hours.',true);return;}
      void workerAction('lock',{worker_id:id,name:name.trim(),reason:reason.trim(),review_after_hours,request_id:crypto.randomUUID()});return;
    }
    if(action==='unlock'){
      const reason=window.prompt(`Release this exact maintenance lock on ${id}? The server will remain paused until a separate checked Resume.`,'External maintenance completed and verified');if(reason===null)return;
      void workerAction('unlock',{lock_id:button.dataset.lockId,reason:reason.trim(),request_id:crypto.randomUUID()});return;
    }
    if(action==='fallbacks'){
      const worker=visibleWorkers.find(candidate=>candidate.id===id),before=worker?.ssh_fallbacks??[];
      const answer=window.prompt(`Fallback SSH aliases for ${id}, comma-separated. Primary route ${worker?.ssh} is unchanged. Leave empty to clear.`,before.join(', '));
      if(answer===null)return;
      const fallbacks=[...new Set(answer.split(',').map(value=>value.trim()).filter(Boolean))];
      void workerAction('fallbacks',{id,expected_ssh_fallbacks:before,ssh_fallbacks:fallbacks});return;
    }
    if(action==='remove'&&!window.confirm(`Remove ${id} from the gateway? Its model server and caches will be left running.`))return;
    if(action==='resume'&&visibleWorkers.find(w=>w.id===id)?.quarantine&&!window.confirm(`Verify and readmit ${id}? DSG will check model/context and generate a small test response. Failed checks keep it quarantined. This does not restart DS4 or change its settings.`))return;
    void workerAction(action,action==='remove'?{id}:{workers:[id]});
  };
  $('worker-rows').addEventListener('click',handleWorkerClick);
  $('devices').addEventListener('click',handleWorkerClick);
  $('relocation-offers').addEventListener('click',e=>{
    const button=e.target.closest('button[data-relocation]');if(!button||button.disabled)return;
    const offer=JSON.parse(button.dataset.relocation);
    if(!window.confirm(`Move this undispatched request from ${offer.source} to ${offer.destination}? Its original client connection and deadline stay intact, but DSG cannot prove the destination has its warm cache.`))return;
    void workerAction('relocate',{request_id:offer.request_id,source:offer.source,destination:offer.destination,evidence_id:offer.evidence_id});
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
      summary.textContent = `${clock(report.time)} · ${report.source} · ${report.actions_taken?.length?'action requested; see executor receipts':'assessment, no actions'}${report.evidence_at?` · evidence ${clock(report.evidence_at)}`:''}`;
      const answer = document.createElement('p');
      answer.className = 'genie-answer';
      answer.textContent = report.text;
      if(report.actions_taken?.length)answer.textContent+='\n\nAction request results: '+report.actions_taken.map(a=>`${a.predictor?'predictor '+a.predictor:a.relocation?'relocation '+a.relocation:a.worker_id}: ${a.state??a.status??'pending'}${a.id?` (${a.id})`:''}`).join('; ');
      if(report.memory_used?.length)answer.textContent+='\n\nHistorical notebook references: '+report.memory_used.map(n=>`${n.id} r${n.revision}`).join(', ');
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
function genieActionRows(snapshot,genie,analytics) {
  const clean=value=>String(value??'').replaceAll('_',' ').replace(/\s+/g,' ').trim().slice(0,240);
  const rows=[];
  for(const report of genie?.provider_actions??genie?.reports??[])if(report.served_by==='pool_fallback'&&Number.isFinite(report.time))rows.push({
    id:`provider:${report.id}`,kind:'provider',at:report.time,level:'good',
    title:`Pool commandeered${report.served_on?` · ${clean(report.served_on)}`:''}`,
    detail:`Dedicated provider unavailable · review completed${report.served_on?' on the named DSG server':' on an unpinned DSG slot; exact server unproven'}`
  });
  for(const op of snapshot?.gateway?.recovery?.operations??[])if(op.actor==='genie'&&Number.isFinite(op.updated_at??op.created_at)){
    const state=clean(op.state),good=['recovered','verified paused'].includes(state),attention=['failed','reconciliation needed'].includes(state);
    rows.push({id:`recovery:${op.id}`,kind:'recovery',at:op.updated_at??op.created_at,level:attention?'attention':good?'good':'pending',
      title:`Recovery · ${clean(op.worker_id)}`,detail:`${clean(op.service_action)||'service check'} · ${state}${op.profile_adopted?' · verified profile hand-back':''}${op.proof?' · cache proof recorded':''}`});
  }
  for(const action of snapshot?.gateway?.predictor?.actions??[])if(action.actor==='genie'&&Number.isFinite(action.time)){
    const status=clean(action.status),good=['verified','complete','completed'].includes(status),attention=['failed','interrupted','rejected'].includes(status);
    rows.push({id:`predictor:${action.id??`${action.time}:${action.action}`}`,kind:'predictor',at:action.time,level:attention?'attention':good?'good':status==='running'?'pending':'neutral',
      title:`Predictor · ${clean(action.action)}`,detail:[status,clean(action.reason)].filter(Boolean).join(' · ')});
  }
  for(const move of analytics?.handovers?.rows??[])if(move.actor==='genie'&&Number.isFinite(move.at)){
    const state=clean(move.service_state),cache=Number.isFinite(move.cached_fraction)?` · ${Math.round(move.cached_fraction*100)}% prompt reused`:'';
    rows.push({id:`routing:${move.at}:${move.source}:${move.destination}`,kind:'routing',at:move.at,level:state==='complete'?'good':state==='pending'?'pending':'attention',
      title:`Queue move · ${clean(move.source)} → ${clean(move.destination)}`,detail:`after ${compactWait(move.waiting_before_move_ms/1000)??'an unknown wait'} · ${state}${cache}`});
  }
  return rows.sort((a,b)=>b.at-a.at||a.id.localeCompare(b.id)).slice(0,30);
}
let genieLedgerSignature='';
function renderGenieActionLedger() {
  const rows=genieActionRows(wireSnapshot,genieState,analyticsState),filter=$('genie-action-filter')?.value??'all';
  const visible=rows.filter(row=>filter==='all'?true:filter==='attention'?row.level==='attention':row.kind===filter),attention=rows.filter(row=>row.level==='attention').length;
  $('genie-action-summary').textContent=rows.length?`${visible.length} shown · latest ${rows.length} available / 30 · newest first${attention?` · ${attention} need attention`:''}`:'No evidenced Genie actions yet';
  const storageError=genieState?.provider_action_storage?.error;
  if(storageError)$('genie-action-summary').textContent+=' · pool history not saved';
  $('genie-action-summary').title=storageError?'Pool action storage needs attention; new receipts remain session-only. Inspect Genie status. Nothing was deleted.':'';
  const signature=JSON.stringify([filter,visible]);if(signature===genieLedgerSignature)return;genieLedgerSignature=signature;
  const items=visible.map(row=>{
    const item=document.createElement('li');item.dataset.level=row.level;
    const time=document.createElement('time');time.dateTime=new Date(row.at).toISOString();time.textContent=clock(row.at);
    const title=document.createElement('strong');title.textContent=row.title;
    const detail=document.createElement('span');detail.textContent=row.detail;detail.title=row.detail;
    item.append(time,title,detail);return item;
  });
  if(!items.length){const empty=document.createElement('li');empty.className='muted';empty.textContent=rows.length?'No actions match this filter.':'Waiting for action evidence.';items.push(empty);}
  const list=$('genie-action-items'),scrollTop=list.scrollTop;
  list.replaceChildren(...items);
  list.scrollTop=scrollTop;
}
const workspaceNames=['fleet','genie','analytics','activity','settings'];
let currentWorkspace='fleet';
function activateWorkspaceTab(requested,{focus=false,updateHash=false}={}) {
  const name=workspaceNames.includes(requested)?requested:'fleet';
  currentWorkspace=name;
  for(const button of document.querySelectorAll('[data-workspace-tab]')){
    const selected=button.dataset.workspaceTab===name;
    button.setAttribute('aria-selected',String(selected));button.tabIndex=selected?0:-1;
  }
  for(const panel of document.querySelectorAll('[data-workspace-view]'))panel.hidden=panel.dataset.workspaceView!==name;
  if(updateHash&&globalThis.history?.replaceState){
    const url=new URL(globalThis.location.href);url.hash=name==='fleet'?'':name;globalThis.history.replaceState(null,'',url);
  }
  if(focus)document.querySelector(`[data-workspace-tab="${name}"]`)?.focus({preventScroll:true});
  return name;
}
function setupWorkspaceTabs(){
  const list=document.querySelector('.workspace-tabs');
  activateWorkspaceTab(globalThis.location?.hash?.slice(1));
  list.addEventListener('click',event=>{const button=event.target.closest('[data-workspace-tab]');if(button)activateWorkspaceTab(button.dataset.workspaceTab,{updateHash:true});});
  list.addEventListener('keydown',event=>{
    const buttons=[...list.querySelectorAll('[data-workspace-tab]:not([hidden])')];
    const current=buttons.indexOf(event.target.closest('[data-workspace-tab]'));if(current<0)return;
    const next=event.key==='Home'?0:event.key==='End'?buttons.length-1:event.key==='ArrowRight'||event.key==='ArrowDown'?(current+1)%buttons.length:event.key==='ArrowLeft'||event.key==='ArrowUp'?(current+buttons.length-1)%buttons.length:null;
    if(next===null)return;event.preventDefault();activateWorkspaceTab(buttons[next].dataset.workspaceTab,{focus:true,updateHash:true});
  });
  globalThis.addEventListener?.('hashchange',()=>activateWorkspaceTab(globalThis.location.hash.slice(1)));
}
poll();
$('genie-action-filter').addEventListener('change',renderGenieActionLedger);
setupWorkspaceTabs();
$('request-filter').addEventListener('change',()=>{requestFilter=$('request-filter').value;renderRequests(wireSnapshot?.events??[]);});
function openServerSettings({focus=false}={}){activateWorkspaceTab('settings',{updateHash:true});const panel=$('worker-management');panel.scrollIntoView({behavior:'smooth',block:'start'});if(focus)panel.querySelector('input[name="id"]')?.focus({preventScroll:true});}
$('devices').addEventListener('click',event=>{if(!event.target.closest('[data-add-first]'))return;openServerSettings({focus:true});});
$('analytics-metric').addEventListener('change',renderAnalytics);
$('analytics-worker').addEventListener('change',renderAnalytics);
$('analytics-version').addEventListener('change',renderAnalytics);
$('fleet-speed-window').addEventListener('change',()=>{const value=$('fleet-speed-window').value;if(!fleetSpeedWindows.has(value))return;fleetSpeedWindow=value;try{globalThis.localStorage?.setItem('dsg-fleet-speed-window-v1',value);}catch{/* Selection still works for this page. */}renderFleetSpeed(analyticsState);});
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
$('health-wire').addEventListener('mouseleave',()=>{if(wireSnapshot)renderHealthWire(wireSnapshot);});
$('health-wire').addEventListener('focusout',()=>queueMicrotask(()=>{if(wireSnapshot)renderHealthWire(wireSnapshot);}));
let genieToken=null,memoryEditing=null,memoryBusy=false;
let hardeningSignature=null;
function renderHardeningNotes(notes=[],memory={}){
  const panel=$('genie-hardening'),items=$('genie-hardening-items');panel.hidden=!genieState?.configured;
  const durable=notes.filter(note=>note.durable).length;
  $('genie-hardening-status').textContent=notes.length?`${fmt(notes.length)} suggestion${notes.length===1?'':'s'} · ${durable} durable · newest first`:`No evidence-backed suggestions yet${memory.enabled?'':' · memory is off'}`;
  const signature=JSON.stringify(notes);
  if(signature===hardeningSignature)return;hardeningSignature=signature;
  items.replaceChildren(...notes.map(note=>{
    const article=document.createElement('article');article.className='genie-hardening-item';
    const title=document.createElement('strong');title.textContent=note.title;
    const meta=document.createElement('p');meta.className='genie-hardening-meta';meta.textContent=`${note.scope??'fleet'} · ${String(note.failure_class??'failure').replaceAll('_',' ')} · evidence ${clock(note.observed_at)} · continuity ${String(note.continuity??'unknown').replaceAll('_',' ')}${note.durable?` · private notebook r${note.revision}`:' · page-local until memory is enabled'}`;
    const evidence=document.createElement('p');evidence.className='genie-hardening-meta';evidence.textContent=`Observed class: ${String(note.reason??'unknown').replaceAll('_',' ')}`;
    const suggestion=document.createElement('p');suggestion.textContent=note.suggestion;
    article.append(title,meta,evidence,suggestion);return article;
  }));
}
function memoryText(note){
  const d=note.data,yes=v=>v===true?'yes':v===false?'no':'unknown';
  if(note.kind==='operator_note')return d.text;
  if(note.kind==='hardening_note')return `${d.title}\n${d.suggestion}\nObserved ${d.failure_class.replaceAll('_',' ')} / ${d.reason.replaceAll('_',' ')} at ${clock(d.observed_at)}. Developer suggestion only; no action or diagnosis is implied.`;
  if(note.kind==='incident')return `Recorded ${d.reason.replaceAll('_',' ')} at ${clock(d.recorded_at)}.\nRequest: ${d.request_id}\nHistorical incident; check current evidence before acting.`;
  if(note.kind==='recovery')return `Executor recorded: ${d.state.replaceAll('_',' ')} at ${clock(d.recorded_at)}.\nReceipt: ${d.operation_id}\nThis records a past action, not current health or a cure for the underlying fault.`;
  return `Gateway healthy: ${yes(d.gateway_healthy)} · paused: ${yes(d.paused)}\nContext: ${fmt(d.context_length)} tokens · agent holds: ${fmt(d.agent_hold_count)}\n${d.quarantine?'Recorded quarantine: '+d.quarantine.replaceAll('_',' ')+'\n':''}Process/cache continuity: unknown. Generation success is not inferred.\n`+(note.recent_transitions??[]).map(p=>`${clock(p.at)}: healthy ${yes(p.data.gateway_healthy)}, paused ${yes(p.data.paused)}, quarantine ${p.data.quarantine??'none observed'}`).join('\n');
}
function renderMemory(m){
  $('memory-status').textContent=m?.error?'· storage needs attention':m?.enabled?'· on':'· off';
  $('memory-toggle').textContent=m?.enabled?'Turn memory off':'Enable memory';$('memory-toggle').disabled=memoryBusy||(!m?.enabled&&!m?.available);
  $('memory-note-save').disabled=memoryBusy||!m?.enabled||!m?.available;
  $('memory-detail').textContent=m?.error||`${fmt(m?.note_count??0)} indexed notes · ${fmt((m?.bytes??0)/1024)} / ${fmt((m?.max_bytes??16777216)/1024)} KiB · ${m?.truncated?'retrieval truncated to 12 notes / 16 KiB':'bounded retrieval'} · off retains records. Old observations are history, not live health.`;
  const root=$('memory-notes'),existing=new Map([...root.children].map(n=>[n.dataset.noteId,n])),keep=new Set();
  for(const note of m?.notes??[]){
    let node=existing.get(note.id);keep.add(note.id);
    if(!node){node=document.createElement('details');node.dataset.noteId=note.id;node.append(document.createElement('summary'),document.createElement('p'));root.append(node);}
    if(node.dataset.revision!==String(note.revision)){
      node.dataset.revision=String(note.revision);node.children[0].textContent=`${note.data.worker??'Fleet'} · ${note.kind.replaceAll('_',' ')} · ${clock(note.at)} · r${note.revision}`;
      node.children[1].className='genie-answer';node.children[1].textContent=memoryText(note);
      for(const b of node.querySelectorAll('button'))b.remove();
      if(note.kind==='operator_note')for(const action of ['edit','archive']){const b=document.createElement('button');b.type='button';b.className='button';b.dataset.memoryAction=action;b.dataset.noteId=note.id;b.textContent=action==='edit'?'Edit':'Archive';node.append(b);}
    }
  }
  for(const node of [...root.children]){
    const current=keep.has(node.dataset.noteId);
    if(!current&&!node.open&&!node.contains(document.activeElement)){node.remove();continue;}
    for(const b of node.querySelectorAll('button'))b.disabled=!current||memoryBusy||!m?.enabled||!m?.available;
    node.title=current?'':'Retained while you read; not in the current notebook retrieval.';
  }
}
async function genieAction(input) {
  try {const r=await fetch('/api/genie',{method:'POST',headers:{'content-type':'application/json','x-dsg-csrf':genieToken},body:JSON.stringify(input),signal:AbortSignal.timeout(15000)});
    const data=await r.json();if(!r.ok)throw new Error(data.error||'Genie request failed');await loadGenie();return data;
  } catch(e){$('genie-status').textContent=e.name==='TimeoutError'?'Genie chat request timed out before it was accepted; no question receipt was created.':e.message;return null;}
}
async function loadGenie() {
  try {const r=await fetch('/api/genie',{signal:AbortSignal.timeout(5000)});if(!r.ok)throw new Error();const s=await r.json();genieToken=s.csrf_token;genieState=s;wireState={...s.ticker,provider_attempts:s.provider_attempts};
    if(wireSnapshot)renderHealthWire(wireSnapshot);
    const now=Date.now(),activeProvider=s.active_provider==='pool_fallback'?'DSG pool fallback':s.active_provider==='pool'?'DSG pool':'dedicated provider',providerProgress=s.busy&&s.provider_started_at?`${activeProvider} · ${age(s.provider_started_at,now)} elapsed${s.provider_deadline_at?` · deadline in ${remaining(s.provider_deadline_at,now)}`:''}`:null;
    const q=s.question,qtext=q?.state==='queued'?(s.review_kind==='action'?'Your question is queued behind an evidence-gated action review':'Your question is queued; a routine review is being yielded'):q?.state==='answering'?`Answering your question · ${providerProgress??'provider starting…'}`:q?.state==='answered'?`Question answered ${age(q.finished_at,now)}`:['failed','cancelled'].includes(q?.state)?`Question ${q.state}: ${q.error}`:null;
    const provider=s.last_served_by==='pool_fallback'?' · dedicated provider failed; last review borrowed a DSG pool slot':s.last_served_by==='pool'?' · last review used the DSG pool':s.last_served_by==='dedicated'?' · last review used the dedicated provider':'';
    const attempts=(s.provider_attempts||[]).slice(0,s.error&&s.fallback_available?2:1),attemptText=attempts.length?` · ${attempts.map(attempt=>`${attempt.provider.replaceAll('_',' ')} ${attempt.outcome}${attempt.reason?` (${attempt.reason.replaceAll('_',' ')})`:''}`).join(' · ')}`:'';
    $('genie-status').textContent=!s.configured?'Not configured':!s.enabled?'Off · enable Gate Genie before asking':qtext||(s.error?`${s.error}${attemptText}`:(s.busy?`Scheduled fleet review · ${providerProgress??'provider starting…'}`:`Enabled · last review ${age(s.last_check,now)}${provider}${attemptText}`));
    $('genie-mode').textContent=[s.action_supervision?'evidence-gated actions':'observation',s.predictor_supervision?'predictor supervision':''].filter(Boolean).join(' · ');
    $('genie-toggle').disabled=!s.configured;$('genie-toggle').textContent=s.enabled?'Turn off':'Enable';
    $('genie-source').disabled=!s.fallback_available||s.busy;$('genie-source').value=s.source||'primary';
    $('genie-review').disabled=$('genie-send').disabled=!s.enabled||q?.state==='queued'||q?.state==='answering';
    renderHardeningNotes(s.hardening_notes||[],s.memory||{});
    renderGenieReports(s.reports || []);
    renderMemory(s.memory);
    renderGenieActionLedger();
  } catch{$('genie-status').textContent='Genie status unavailable';wireState={state:'unavailable'};if(wireSnapshot)renderHealthWire(wireSnapshot);}
}
$('genie-toggle').addEventListener('click',()=>genieAction({action:'enable',enabled:!genieState?.enabled}));
$('genie-source').addEventListener('change',()=>genieAction({action:'source',source:$('genie-source').value}));
$('genie-review').addEventListener('click',async()=>{if($('genie-review').disabled)return;$('genie-status').textContent='Submitting a fleet review…';$('genie-review').disabled=true;await genieAction({action:'ask'});});
$('genie-chat').addEventListener('submit',async e=>{
  e.preventDefault();const question=$('genie-question').value.trim();
  if(!question){$('genie-status').textContent='Type a question first, or use Review now for the standard fleet review.';$('genie-question').focus();return;}
  $('genie-status').textContent='Submitting your question…';$('genie-send').disabled=true;
  const result=await genieAction({action:'ask',question});
  if(result?.accepted){$('genie-question').value='';$('genie-status').textContent=result.question?.state==='queued'?'Question accepted and queued behind the current review.':'Question accepted; Gate Genie is answering.';}
});
$('memory-toggle').addEventListener('click',async()=>{if(memoryBusy)return;memoryBusy=true;renderMemory(genieState?.memory);try{await genieAction({action:'memory',enabled:!genieState?.memory?.enabled});}finally{memoryBusy=false;renderMemory(genieState?.memory);}});
$('memory-note-cancel').addEventListener('click',()=>{memoryEditing=null;$('memory-note-text').value='';$('memory-note-cancel').hidden=true;});
$('memory-note-form').addEventListener('submit',async e=>{
  e.preventDefault();if(memoryBusy)return;memoryBusy=true;renderMemory(genieState?.memory);
  try{const note={worker:memoryEditing?.data.worker??null,text:$('memory-note-text').value,state:'active',...(memoryEditing?{id:memoryEditing.id,expected_revision:memoryEditing.revision}:{})};
    const result=await genieAction({action:'memory-note',note});if(result?.memory_receipt){$('memory-message').textContent=`Saved ${result.memory_receipt.id} r${result.memory_receipt.revision}. No permissions changed.`;memoryEditing=null;$('memory-note-text').value='';$('memory-note-cancel').hidden=true;}else $('memory-message').textContent='Note was not saved; inspect the error above.';
  }finally{memoryBusy=false;renderMemory(genieState?.memory);}
});
$('memory-notes').addEventListener('click',async e=>{
  const b=e.target.closest('button[data-memory-action]');if(!b||memoryBusy)return;const n=genieState?.memory?.notes?.find(n=>n.id===b.dataset.noteId);if(!n)return;
  if(b.dataset.memoryAction==='edit'){memoryEditing=n;$('memory-note-text').value=n.data.text;$('memory-note-cancel').hidden=false;$('memory-note-text').focus();return;}
  memoryBusy=true;try{const result=await genieAction({action:'memory-note',note:{id:n.id,expected_revision:n.revision,...n.data,state:'archived'}});$('memory-message').textContent=result?.memory_receipt?'Archived in retrieval; journal history retained.':'Archive was not saved.';}finally{memoryBusy=false;renderMemory(genieState?.memory);}
});
void loadGenie();setInterval(loadGenie,5000);

function renderRecovery(state) {
  recoveryState=state;
  $('recovery-status').textContent=!state?.configured?'Not configured. Endpoint registration alone grants no restart authority.':`${state.automatic?'Automatic recovery ON · GG + known-fatal watcher':'Automatic recovery OFF · operator recovery available'} · verified profile hand-back ${state.profile_handback_automatic?'ON':'OFF'}`;
  $('recovery-toggle').textContent=state?.automatic?'Disable automatic recovery':'Enable automatic recovery';
  $('recovery-toggle').disabled=!state?.configured||workerBusy;
  $('recovery-handback-toggle').textContent=state?.profile_handback_automatic?'Disable verified profile hand-back':'Enable verified profile hand-back';
  $('recovery-handback-toggle').disabled=!state?.configured||workerBusy;
  $('recovery-workers').innerHTML=(state?.workers||[]).map(w=>`<p><strong>${esc(w.worker_id)}</strong> · ${esc(w.state)} · ${esc(w.eligible?(w.profile_handback?.candidate?'verified hand-back eligible':'recovery eligible'):(w.reason||'checking').replaceAll('_',' '))}${w.profile_handback?.adopted?' · adopted profile active':''} <button type="button" class="button" data-recover="${esc(w.worker_id)}" ${!w.eligible||workerBusy?'disabled':''}>${w.profile_handback?.candidate?'Verify hand-back':'Recover'}</button>${recoveryRecheckable(w.last_action)?` <button type="button" class="button" data-recheck="${esc(w.last_action.id)}" ${workerBusy?'disabled':''}>Recheck only</button>`:''}</p>`).join('');
  // Plain text receipts, not another auto-collapsing disclosure panel.
  $('recovery-actions').replaceChildren(...(state?.operations||[]).slice(0,8).map(op=>{
    const p=document.createElement('p');p.textContent=`${clock(op.updated_at)} · ${op.worker_id} · ${op.actor}${recoveryIssuanceText(op)} · ${op.state.replaceAll('_',' ')}${op.error?` · ${op.error.replaceAll('_',' ')}`:''}${op.proof?` · ${op.proof.samples.map(s=>`${s.label}: ${s.cached_tokens}/${s.prompt_tokens} cached`).join(' · ')}`:''} · ${op.id}`;return p;
  }));
}
let predictorState=null,predictorControlBusy=false,predictorUnavailable=true,milestoneSignature=null,recipeSignature=null;
function renderMilestones(milestones,unavailable){
  const signature=JSON.stringify(milestones);
  $('learning-milestones').hidden=!milestones.length;
  // Keep the reading position, focused button and selected text across polls.
  if(signature!==milestoneSignature){
    milestoneSignature=signature;
    $('learning-milestone-items').replaceChildren(...milestones.map(m=>{
      const article=document.createElement('article');article.className='learning-milestone';
      const title=document.createElement('strong');title.textContent=`${m.kind}: a challenger earned its place.`;
      const facts=document.createElement('p'),s=m.evidence.baseline,c=m.evidence.champion;
      const gain=s.baseline_mae_s>0?100*(1-s.mae_s/s.baseline_mae_s):null;
      facts.textContent=`Verified at ${clock(m.time)} · model ${m.model_id.slice(0,8)} · ${fmt(gain)}% lower mean absolute prediction error than ${m.baseline_id}: ${fmt(s.mae_s)}s vs ${fmt(s.baseline_mae_s)}s over ${s.requests} requests / ${predictionSessionLabel(s)} (${(m.evidence.workers||[]).join(', ')}).${c?` Matched incumbent ${m.comparator_id.slice(0,8)}: ${fmt(c.mae_s)}s vs ${fmt(c.baseline_mae_s)}s over ${c.requests} requests; ${c.fallback_points}/${c.forecast_points} incumbent forecast points used its baseline fallback.`:''} This is prediction accuracy, not a measured routing speedup.`;
      article.append(title,facts);
      if(m.commentary){const comment=document.createElement('p');comment.textContent=`Genie commentary: ${m.commentary.text}`;article.append(comment);}
      const button=document.createElement('button');button.type='button';button.className='button';button.dataset.milestone=m.id;button.textContent='Dismiss announcement';article.append(button);
      return article;
    }));
  }
  for(const button of $('learning-milestone-items').querySelectorAll('button'))button.disabled=unavailable||predictorControlBusy;
}
function renderPredictor(state,unavailable=false){
  predictorState=state;predictorUnavailable=unavailable||!state?.configured;
  const recipes=state?.training_recipes??[],signature=JSON.stringify(recipes),selector=$('predictor-recipe');
  if(recipes.length&&signature!==recipeSignature){
    recipeSignature=signature;const chosen=selector.value;
    selector.replaceChildren(...recipes.map(r=>{const option=document.createElement('option');option.value=r.id;option.textContent=r.label;option.title=r.description;return option;}));
    selector.value=recipes.some(r=>r.id===chosen)?chosen:state.default_recipe;
  }
  selector.disabled=predictorUnavailable||predictorControlBusy||!!state?.busy||!recipes.length;
  // During a telemetry outage keep already-seen notices visible, but read-only.
  if(state)renderMilestones(state.milestones||[],predictorUnavailable);
  else for(const b of $('learning-milestone-items').querySelectorAll('button'))b.disabled=true;
  const active=(state?.models||[]).filter(m=>m.active_model_id).length;
  $('predictor-baseline').textContent=`Default: ${state?.baseline?.name||'Measured history baseline'} (${state?.baseline?.id||'causal-history-v1'}). Fixed recipe, continuously updated observations; no evidence means unknown. ${state?.reset_at?'Last reset: '+clock(state.reset_at)+'. ':''}${active?'Validated tuned forecasts are active where supported.':'No tuned forecast is active; ordinary routing remains in use.'}`;
  const rejected=state?.candidate_rejections?` · ${fmt(state.candidate_rejections)} incompatible artifact${state.candidate_rejections===1?'':'s'} ignored`:'';
  $('predictor-status').textContent=unavailable?'Predictor controls unavailable or stale':!state?.configured?'Optional predictor runtime not configured':state.error||`${state.busy?'Training candidate':'Collecting and scoring forecasts'} · ${active} validated models · ${fmt(state.new_requests)} new completed requests since training${state.placement?' · new-session placement armed (evidence gates still apply)':''}${rejected}`;
  $('predictor-status').title=state?.candidate_rejections?`Loaded ${fmt(state.candidate_artifacts_loaded)} candidate artifacts. Rejected categories: ${Object.entries(state.candidate_rejection_summary||{}).map(([reason,count])=>`${reason.replaceAll('_',' ')} ${fmt(count)}`).join(', ')||'unclassified'}. Rejected artifacts never influence forecasts or routing.`:'';
  for(const b of $('predictor-controls').querySelectorAll('button')){
    const action=b.dataset.predictor;
    b.disabled=unavailable||!state?.configured||predictorControlBusy||(action==='train'&&state.busy)||(action==='rollback'&&!active);
    if(['automatic_training','automatic_promotion','placement'].includes(action)){const label={automatic_training:'Auto training',automatic_promotion:'Auto validation',placement:'New-session placement'}[action];b.textContent=`${label}: ${state?.[action]?'on':'off'}`;b.setAttribute('aria-pressed',String(!!state?.[action]));}
  }
  $('predictor-models').innerHTML=`<table><thead><tr><th>Forecast</th><th>Candidate</th><th>Backtest MAE</th><th>Future MAE / baseline</th><th>Future evidence</th><th>Selection</th></tr></thead><tbody>${(state?.models||[]).map(m=>`<tr><td>${esc(m.kind)}${m.active_model_id?' · active '+esc(m.active_model_id.slice(0,8)):''}</td><td>${esc(m.status.replaceAll('_',' '))}${m.candidate_model_id?' · '+esc(m.candidate_model_id.slice(0,8)):''}</td><td>${fmt(m.holdout?.mae_s)}s</td><td>${fmt(m.future?.mae_s)}s / ${fmt(m.future?.baseline_mae_s)}s</td><td>${fmt(m.future?.requests||0)} requests · ${esc(predictionSessionLabel(m.future))}</td><td>${m.selected?esc(`${m.selected.rounds} trees · ${m.selected.transform} · ${m.selected.family.join(' + ')}`):'Not enough evidence'}</td></tr>`).join('')}</tbody></table>`;
  $('predictor-actions').replaceChildren(...(state?.actions||[]).slice(0,5).map(a=>{const p=document.createElement('p');p.textContent=`${clock(a.time)} · ${a.actor} · ${a.action} · ${a.status}${a.recipe_id?' · '+a.recipe_id:''}: ${a.reason}`;return p;}));
}
$('predictor-controls').addEventListener('click',async event=>{
  const button=event.target.closest('button[data-predictor]');if(!button||button.disabled||!csrfToken)return;
  const action=button.dataset.predictor,input=['train','rollback','reset_baseline'].includes(action)?{action}:{action,enabled:!predictorState?.[action]};
  if(action==='train'&&predictorState?.training_recipes?.length)input.recipe_id=$('predictor-recipe').value;
  if(action==='reset_baseline'&&!window.confirm('Restore the baseline for all forecasts? Existing candidates cannot immediately undo this. Collection continues; training, auto-validation and placement switches stay as set. Servers, sessions and caches are unchanged.'))return;
  if(action==='placement'&&input.enabled&&!window.confirm('Arm placement for new sessions only? It remains inactive until backtest, unseen-session and future-live gates pass. Existing sessions will not move.'))return;
  predictorControlBusy=true;renderPredictor(predictorState);
  try{const r=await fetch('/api/workers/predictor',{method:'POST',headers:{'content-type':'application/json','x-dsg-csrf':csrfToken},body:JSON.stringify(input)}),v=await r.json();if(!r.ok)throw new Error(v.error||'Action rejected');$('predictor-status').textContent=`${action} accepted; awaiting authoritative status`;}
  catch(e){$('predictor-status').textContent=e.message;}finally{predictorControlBusy=false;}
});
$('learning-milestone-items').addEventListener('click',async event=>{
  const button=event.target.closest('button[data-milestone]');if(!button||button.disabled||!csrfToken||predictorUnavailable)return;
  predictorControlBusy=true;renderMilestones(predictorState?.milestones||[],predictorUnavailable);
  try{const response=await fetch('/api/workers/predictor',{method:'POST',headers:{'content-type':'application/json','x-dsg-csrf':csrfToken},body:JSON.stringify({action:'acknowledge_milestone',milestone_id:button.dataset.milestone})});const result=await response.json();if(!response.ok)throw new Error(result.error||'Dismissal failed');}
  catch(error){$('predictor-status').textContent=error.message;}finally{predictorControlBusy=false;}
});
$('recovery-toggle').addEventListener('click',()=>{
  if(!recoveryState?.configured)return;
  if(!recoveryState.automatic&&!window.confirm('Allow GG and the known-fatal watcher to restart registered DS4 services after identity and fault checks? RAM-resident caches are lost; server settings and disk caches are preserved.'))return;
  void workerAction('recovery-policy',{enabled:!recoveryState.automatic});
});
$('recovery-handback-toggle').addEventListener('click',()=>{
  if(!recoveryState?.configured)return;
  if(!recoveryState.profile_handback_automatic&&!window.confirm('Enable verified profile hand-back? With automatic recovery also on, DSG may adopt a stable changed profile on the same enrolled machine/service after all fixed ownership, fatal/replacement and verification gates pass. Pauses and agent holds still win.'))return;
  void workerAction('recovery-handback-policy',{enabled:!recoveryState.profile_handback_automatic});
});
$('recovery-workers').addEventListener('click',event=>{
  const recheck=event.target.closest('button[data-recheck]');if(recheck&&!recheck.disabled){void workerAction('recovery-recheck',{action_id:recheck.dataset.recheck});return;}
  const button=event.target.closest('button[data-recover]');if(!button||button.disabled)return;
  const worker=recoveryState?.workers.find(w=>w.worker_id===button.dataset.recover);
  if(worker?.eligible)void workerAction('recover',{worker_id:worker.worker_id,evidence_id:worker.evidence_id,action_id:crypto.randomUUID()});
});
