import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {once} from 'node:events';
import {AnalyticsReader,HandoverEvidence,PredictionEvidence} from './analytics.mjs';
import {createDashboard} from './dashboard.mjs';

let seq=0;
function row(kind,extra={}) {
  return {schema:1,run_id:'run-a',request_id:'req-a',event_id:`event-${++seq}`,time:new Date(100000+seq).toISOString(),node:'worker-a',kind,...extra};
}
function forecast(extra={}) {return row('routing_shadow',{shadow_schema:1,reason:'admission',source:'worker-a',confidence:'unvalidated',basis:'prior_session_prompt_bucket_mixed_cache',waiting_ms:3,
  candidates:[{node:'worker-a',eligible:true,wait_ms:2000,service_ms:4000},{node:'worker-b',eligible:true,wait_ms:0,service_ms:1000}],...extra});}
function lifecycle(extra={}) {return [row('decision',extra),forecast(extra),row('dispatch',{queue_ms:2500,...extra}),row('finish',{outcome:'complete',finish_reason:'tool_calls',service_ms:6000,...extra})];}
function fixture(t,options={}) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dsg-analytics-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  return {dir,file:path.join(dir,'routing-2000-01-01.jsonl'),reader:new AnalyticsReader(dir,{enabled:true,...options})};
}
const serialize=rows=>rows.map(r=>JSON.stringify(r)+'\n').join('');
test('versioned embedding and progress streams are ignored, not reported as broken analytics joins',()=>{
  const e=new PredictionEvidence();for(const r of lifecycle())e.accept(r);
  for(const kind of ['embedding','request_features','progress','waiting','queue_relocation'])e.accept(row(kind));
  e.accept(row('queued_cancel',{node:null,request_id:'never-admitted'}));
  assert.equal(e.snapshot().rows.length,1);assert.equal(e.snapshot().rejected_events,0);
  e.accept(row('unknown'));assert.equal(e.snapshot().rejected_events,1);
});
test('applied handovers join only observed destination outcomes and never create a no-move label',()=>{
  const h=new HandoverEvidence(),move=row('queue_relocation',{node:'worker-b',source:'worker-a',destination:'worker-b',actor:'scheduler',relocation_schema:1,waiting_ms:4000,dispatch_state:'not_dispatched',body_replayed:false,deadline_preserved:true,cache_locality:'unknown'});
  h.accept(move);h.accept(move);h.accept(row('dispatch',{node:'worker-b',queue_ms:5500}));h.accept(row('finish',{node:'worker-b',outcome:'complete',finish_reason:'tool_calls',service_ms:9000,usage:{prompt_tokens:100,cached_tokens:80}}));
  const s=h.snapshot(),r=s.rows[0];assert.equal(s.total,1);assert.equal(s.completed,1);assert.equal(s.counterfactual,'unknown');assert.equal(s.rejected_events,0);
  assert.deepEqual({...r,at:undefined},{source:'worker-a',destination:'worker-b',actor:'scheduler',at:undefined,waiting_before_move_ms:4000,post_move_wait_ms:1500,service_ms:9000,service_state:'complete',cached_fraction:.8});
  assert.ok(!JSON.stringify(s).includes('req-a'));
  const genie=new HandoverEvidence();genie.accept({...move,event_id:'genie-move',request_id:'genie-request',actor:'genie'});assert.equal(genie.snapshot().rows[0].actor,'genie');
  const rounded=new HandoverEvidence();rounded.accept({...move,event_id:'rounded-move',request_id:'rounded-request',waiting_ms:962.029});rounded.accept(row('dispatch',{request_id:'rounded-request',node:'worker-b',queue_ms:962}));assert.equal(rounded.snapshot().rows[0].post_move_wait_ms,0);
});
test('handover joins fail closed on wrong destinations, invalid order and incomplete results',()=>{
  const move=extra=>row('queue_relocation',{node:'worker-b',source:'worker-a',destination:'worker-b',actor:'operator',relocation_schema:1,waiting_ms:100,dispatch_state:'not_dispatched',body_replayed:false,deadline_preserved:true,cache_locality:'unknown',...extra});
  const wrong=new HandoverEvidence();wrong.accept(move());wrong.accept(row('dispatch',{node:'worker-c',queue_ms:200}));assert.equal(wrong.snapshot().total,0);assert.equal(wrong.snapshot().rejected_events,1);
  const early=new HandoverEvidence();early.accept(move({request_id:'early'}));early.accept(row('finish',{request_id:'early',node:'worker-b',outcome:'complete',finish_reason:'stop',service_ms:1}));assert.equal(early.snapshot().total,0);assert.equal(early.snapshot().rejected_events,1);
  const pending=new HandoverEvidence();pending.accept(move({request_id:'pending'}));pending.accept(row('dispatch',{request_id:'pending',node:'worker-b',queue_ms:200}));assert.equal(pending.snapshot().pending,1);
  const failed=new HandoverEvidence();failed.accept(move({request_id:'failed'}));failed.accept(row('dispatch',{request_id:'failed',node:'worker-b',queue_ms:200}));failed.accept(row('finish',{request_id:'failed',node:'worker-b',outcome:'upstream_error',service_ms:300}));assert.equal(failed.snapshot().excluded,1);
});
test('admission forecasts join by run/request and actual worker; future revisions and alternatives are not labels',()=>{
  const e=new PredictionEvidence();e.accept(row('decision'));e.accept(forecast());
  e.accept(forecast({reason:'worker_free',waiting_ms:2000,candidates:[{node:'worker-a',eligible:true,wait_ms:500}]}));
  e.accept(row('dispatch',{queue_ms:2500}));e.accept(forecast({waiting_ms:2500}));e.accept(row('finish',{outcome:'complete',finish_reason:'stop',service_ms:6000}));
  const r=e.snapshot().rows[0];assert.equal(r.predicted_queue_ms,2003);assert.equal(r.queue_ms,2500);assert.equal(r.predicted_service_ms,4000);assert.equal(r.service_ms,6000);
  assert.equal(e.snapshot().rows.length,1);assert.equal(e.snapshot().rejected_events,1);
});
test('duplicates do not multiply observations and process runs cannot cross-join',()=>{
  const e=new PredictionEvidence(),rows=lifecycle();for(const r of rows){e.accept(r);e.accept(r);}
  e.accept(row('decision',{run_id:'run-b'}));e.accept(row('dispatch',{run_id:'run-b',queue_ms:5000}));
  assert.equal(e.snapshot().rows.length,2);assert.equal(e.snapshot().rows[1].predicted_queue_ms,null);
  e.accept(row('dispatch',{run_id:'run-b',queue_ms:2}));assert.equal(e.snapshot().rows.length,1);
});
test('no hindsight predictions, no coerced zero, and no cross-worker pairing',()=>{
  const e=new PredictionEvidence();e.accept(row('decision'));e.accept(row('dispatch',{queue_ms:2000}));e.accept(forecast());
  assert.equal(e.snapshot().rows[0].predicted_queue_ms,null);
  const other=new PredictionEvidence();other.accept(row('decision'));other.accept(forecast({candidates:[{node:'worker-a',eligible:true,wait_ms:null,service_ms:'3'}]}));other.accept(row('dispatch',{node:'worker-b',queue_ms:3}));
  assert.equal(other.snapshot().rows.length,0);other.accept(row('dispatch',{queue_ms:4000}));assert.equal(other.snapshot().rows[0].predicted_queue_ms,null);
});
test('cancelled queues are not zero waits; failed/limited finishes retain real waits but not service labels; Genie excluded',()=>{
  const e=new PredictionEvidence();e.accept(row('decision'));e.accept(forecast());e.accept(row('queued_cancel'));
  for(const [id,outcome,reason] of [['failed','upstream_http_error',null],['limited','complete','length'],['observer','complete','stop']]){
    for(const r of lifecycle({request_id:id,...(id==='observer'?{traffic_class:'genie'}:{})}))e.accept(r.kind==='finish'?{...r,outcome,finish_reason:reason}:r);
  }
  const s=e.snapshot();assert.equal(s.not_dispatched,1);assert.equal(s.rows.length,2);
  for(const r of s.rows){assert.equal(r.queue_ms,2500);assert.equal(r.service_ms,null);assert.equal(r.service_state,'excluded');}
});
test('evidence is bounded, exposes only selected metadata and rejects malformed records',()=>{
  const e=new PredictionEvidence({maxRequests:3,maxEvents:6,maxResults:2});
  for(let i=0;i<8;i++)for(const r of lifecycle({request_id:`request-${i}`,prompt:'NEVER_EXPORT',session:'NEVER_EXPORT',url:'NEVER_EXPORT',error:'NEVER_EXPORT'}))e.accept(r);
  e.accept({kind:'decision',prompt:'NEVER_EXPORT'});
  assert.equal(e.requests.size,3);assert.equal(e.seen.size,6);assert.equal(e.snapshot().rows.length,2);assert.ok(e.evicted>0);
  assert.ok(!JSON.stringify(e.snapshot()).includes('NEVER_EXPORT'));
});
test('reader resumes partial lines and reads old daily records before new-day dispatches',t=>{
  const {file,dir,reader}=fixture(t,{readBytes:200});const rows=lifecycle(),head=serialize(rows.slice(0,2));
  fs.writeFileSync(file,head);fs.writeFileSync(path.join(dir,'routing-2000-01-02.jsonl'),serialize(rows.slice(2)));
  reader.poll();assert.equal(reader.snapshot().status,'catching_up');
  for(let i=0;i<15&&reader.snapshot().status!=='ready';i++)reader.poll();
  assert.equal(reader.snapshot().rows[0].predicted_queue_ms,2003);
  const next=lifecycle({request_id:'next'}),text=serialize(next);fs.appendFileSync(path.join(dir,'routing-2000-01-02.jsonl'),text.slice(0,-1));
  for(let i=0;i<10;i++)reader.poll();assert.equal(reader.snapshot().rows[1].service_state,'pending');
  fs.appendFileSync(path.join(dir,'routing-2000-01-02.jsonl'),'\n');reader.poll();assert.equal(reader.snapshot().rows[1].service_state,'complete');
  const count=reader.snapshot().rows.length;reader.poll();assert.equal(reader.snapshot().rows.length,count);
});
test('reader detects replacement and copy-truncate/regrow without mixing old data',t=>{
  const {file,dir,reader}=fixture(t);fs.writeFileSync(file,serialize(lifecycle()));reader.poll();assert.equal(reader.snapshot().rows.length,1);
  fs.renameSync(file,path.join(dir,'old.txt'));fs.writeFileSync(file,serialize(lifecycle({request_id:'new'})));reader.poll();assert.equal(reader.snapshot().status,'rescanning');
  reader.poll();assert.equal(reader.snapshot().rows.length,1);
  fs.writeFileSync(file,serialize([...lifecycle({request_id:'newer'}),...lifecycle({request_id:'newest'})]));reader.poll();assert.equal(reader.snapshot().status,'rescanning');
  reader.poll();assert.equal(reader.snapshot().rows.length,2);assert.equal(reader.snapshot().rescans,2);
});
test('oversized/partial/symlink/missing files remain bounded and fail closed, with recovery',t=>{
  const {file,dir,reader}=fixture(t,{readBytes:8192,tailBytes:131072});reader.poll();assert.equal(reader.snapshot().status,'waiting');
  fs.writeFileSync(file,'x'.repeat(70000)+'\n'+serialize(lifecycle()));for(let i=0;i<12;i++)reader.poll();
  assert.equal(reader.snapshot().rows.length,1);assert.equal(reader.snapshot().malformed_lines,1);
  assert.ok(reader.cursors.get(path.basename(file)).fragment.length<=65536);
  fs.renameSync(file,path.join(dir,'private.txt'));fs.symlinkSync('private.txt',file);reader.poll();assert.equal(reader.snapshot().status,'unavailable');
  fs.unlinkSync(file);fs.writeFileSync(file,serialize(lifecycle()));reader.poll();reader.poll();assert.equal(reader.snapshot().status,'ready');
  const disabled=new AnalyticsReader('/does-not-exist');disabled.poll();assert.equal(disabled.snapshot().status,'disabled');
});
test('tail limit and malformed lines are visible instead of implying complete history',t=>{
  const {file,reader}=fixture(t,{tailBytes:4096});fs.writeFileSync(file,'x'.repeat(5000)+'\ninvalid json\n'+serialize(lifecycle()));reader.poll();
  assert.equal(reader.snapshot().partial_history,true);assert.equal(reader.snapshot().rows.length,1);assert.equal(reader.snapshot().malformed_lines,1);
});
test('a third daily file rebuilds the recent window instead of retaining a retired day',t=>{
  const {dir,file,reader}=fixture(t);fs.writeFileSync(file,serialize(lifecycle()));reader.poll();
  fs.writeFileSync(path.join(dir,'routing-2000-01-02.jsonl'),serialize(lifecycle({request_id:'day-two'})));reader.poll();assert.equal(reader.snapshot().rows.length,2);
  fs.writeFileSync(path.join(dir,'routing-2000-01-03.jsonl'),serialize(lifecycle({request_id:'day-three'})));reader.poll();assert.equal(reader.snapshot().status,'rescanning');
  reader.poll();assert.equal(reader.snapshot().rows.length,2);
  assert.ok(!reader.cursors.has(path.basename(file)));
});
function ui() {
  const source=fs.readFileSync(new URL('./ui/ui.js',import.meta.url),'utf8').replace(/^import .*;\n/,'').split('\npoll();')[0];
  const elements=new Map(),get=id=>{if(!elements.has(id))elements.set(id,{value:id==='analytics-metric'?'queue':'',innerHTML:'',textContent:''});return elements.get(id);};
  const ctx=vm.createContext({document:{getElementById:get}});vm.runInContext(source,ctx);return {ctx,get,call:expr=>vm.runInContext(expr,ctx)};
}
test('UI accuracy denominator includes missing forecasts, excludes trivial waits, and distinguishes incomplete service',()=>{
  const {ctx,call}=ui();ctx.sample={rows:[{node:'a',queue_ms:2000,predicted_queue_ms:1000,service_state:'complete',service_ms:4000,predicted_service_ms:5000},
    {node:'a',queue_ms:4000,predicted_queue_ms:null,service_state:'excluded'},{node:'b',queue_ms:0,predicted_queue_ms:0,service_state:'pending'}]};
  const m=call('analyticsMetrics(sample)');assert.equal(m.pairs.length,1);assert.equal(m.coverage,50);assert.equal(m.mae,1000);assert.equal(m.immediate,1);
  assert.equal(call('analyticsMetrics(sample,"service").excluded'),1);assert.equal(call('analyticsMetrics(sample,"queue","b").mae'),null);
  assert.match(call('predictionChart([])'),/No matched predictions/);
  assert.match(call('predictionChart(analyticsMetrics(sample).pairs)'),/above the diagonal/);
  assert.doesNotMatch(call('predictionChart([{node:"<script>bad</script>",actual:1000,predicted:2000}])'),/<script>/);
});
test('collection and cache UI distinguish missing metadata, sparse evidence and unmeasured costs',()=>{
  const {call}=ui();assert.match(call('embeddingInfo({})'),/off/);
  assert.match(call('embeddingInfo({embedding_collection:{enabled:true}})'),/unknown revision/);
  assert.match(call('cacheCostText({disk_load:{estimated_ms:null,status:"insufficient_evidence",samples:2},prefill:{estimated_ms:null}})'),/2\/3 required matching samples/);
  assert.match(call('cacheCostText({})'),/not total acquisition/);
});
test('UI polling preserves expansion and selected filter; stale results and tiny samples are explicit',()=>{
  const {ctx,get,call}=ui();get('analytics').open=false;get('analytics-metric').value='queue';
  ctx.sample={status:'ready',rows:[{node:'worker-a',queue_ms:2000,predicted_queue_ms:1000}],handovers:{total:2,completed:1,pending:1,excluded:0,rejected_events:0}};
  call('analyticsState=sample;renderAnalytics()');get('analytics-worker').value='worker-a';call('renderAnalytics()');
  assert.equal(get('analytics-worker').value,'worker-a');assert.equal(get('analytics').open,false);
  assert.match(get('analytics-status').textContent,/unvalidated/);assert.match(get('analytics-stats').innerHTML,/1,000s|1s/);
  assert.match(get('analytics-detail').textContent,/Applied handovers: 2 observed.*no invented no-move result/);
  ctx.sample.status='unavailable';call('renderAnalytics()');assert.match(get('analytics-status').textContent,/historical/);
});
test('model plots default to the latest real forecast while historical versions remain selectable',()=>{
  const {ctx,get,call}=ui(),old='a'.repeat(64),latest='b'.repeat(64),point=(id,at,value)=>({id,stage:'admission',last_forecast_at:at,rows:[{node:'worker-a',at,service_state:'complete',service_ms:value,predicted_service_ms:value-1000}]});
  get('analytics-metric').value='xgb-admission';ctx.sample={status:'ready',rows:[],model_series:[point(old,1000,5000),point(latest,2000,6000)]};call('analyticsState=sample;renderAnalytics()');
  assert.equal(get('analytics-version').value,'');assert.match(get('analytics-version').innerHTML,/Current \/ latest · b{12}/);assert.match(get('analytics-status').textContent,/model b{12}/);
  get('analytics-version').value=old;call('renderAnalytics()');assert.match(get('analytics-status').textContent,/model a{12}/);assert.match(get('analytics-version').innerHTML,/History · a{12}/);
  const newest='c'.repeat(64);ctx.sample.model_series.push(point(newest,3000,7000));get('analytics-version').value='';call('renderAnalytics()');assert.match(get('analytics-status').textContent,/model c{12}/);
});
test('analytics follows fleet, Genie and recovery controls but precedes the request log',()=>{
  const html=fs.readFileSync(new URL('./ui/index.html',import.meta.url),'utf8');
  let previous=-1;
  for(const id of ['devices','genie-reports','recovery-actions','analytics','requests']) {
    const marker=`id="${id}"`,position=html.indexOf(marker);
    assert.ok(position>previous,`${id} must follow the previous section`);
    assert.equal(html.indexOf(marker,position+marker.length),-1,`${id} must not be duplicated`);
    previous=position;
  }
});
test('analytics is same-origin read-only, reports no dataset path and is separate from diagnostic exports',async t=>{
  const server=createDashboard(()=>({version:1}),undefined,null,null,()=>({enabled:true,status:'ready',rows:[]}));
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});
  const url=`http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(url+'/api/analytics')).status,200);
  assert.equal((await fetch(url+'/api/analytics',{method:'POST'})).status,405);
  assert.equal((await fetch(url+'/api/analytics',{headers:{origin:'https://example.invalid'}})).status,403);
  assert.deepEqual(await(await fetch(url+'/api/diagnostics')).json(),{version:1});
  const html=await(await fetch(url)).text();assert.match(html,/id="analytics"/);assert.match(html,/No model versions or forecast stages are mixed/);assert.match(html,/id="predictor-controls"/);
});
