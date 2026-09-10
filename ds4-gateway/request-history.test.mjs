import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {once} from 'node:events';
import {RequestHistoryReader,HandoverEvidence} from './request-history.mjs';
import {createDashboard} from './dashboard.mjs';
import {CacheContinuityEvidence} from './cache-continuity-evidence.mjs';

let seq=0;
function row(kind,extra={}) {
  return {schema:1,run_id:'run-a',request_id:'req-a',event_id:`event-${++seq}`,time:new Date(100000+seq).toISOString(),node:'worker-a',kind,...extra};
}
function fixture(t,options={}) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dsg-analytics-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  return {dir,file:path.join(dir,'routing-2000-01-01.jsonl'),reader:new RequestHistoryReader(dir,{enabled:true,...options})};
}
const serialize=rows=>rows.map(r=>JSON.stringify(r)+'\n').join('');
function cachePair(){
  return [1,2].flatMap(i=>[
    row('decision',{request_id:`cache-${i}`,time:new Date(i*10000).toISOString(),session:'b'.repeat(64),affinity:i===1?'new':'existing',client_metadata:{schema:1,status:'ready',turn_index:i,compaction_count:0},candidates:[{node:'worker-a',profile:'a'.repeat(64),observation_epoch:1}]}),
    row('finish',{request_id:`cache-${i}`,time:new Date(i*10000+1000).toISOString(),outcome:'complete',finish_reason:'stop',route:'/v1/chat/completions',usage:{prompt_tokens:1000,cached_tokens:0}}),
  ]);
}
function ui() {
  const source=fs.readFileSync(new URL('./ui/ui.js',import.meta.url),'utf8').replace(/^import .*;\n/,'').split('\npoll();')[0];
  const elements=new Map(),get=id=>{if(!elements.has(id)){const attributes=new Map(),values=new Map();elements.set(id,{value:id==='analytics-metric'?'queue':'',innerHTML:'',textContent:'',dataset:{},style:{setProperty:(name,value)=>values.set(name,value),values},setAttribute:(name,value)=>attributes.set(name,value),attributes});}return elements.get(id);};
  const ctx=vm.createContext({document:{getElementById:get},structuredClone});vm.runInContext(source,ctx);return {ctx,get,call:expr=>vm.runInContext(expr,ctx)};
}
test('cache dashboard projection is private, bounded and evaluated at most every 15 seconds',()=>{
  const evidence=new CacheContinuityEvidence(),rows=cachePair();
  for(const r of rows)evidence.accept({...r,prompt:'NEVER_EXPORT',vectors:['NEVER_EXPORT']});
  const first=evidence.snapshot(30000);
  assert.equal(first.workers['worker-a'].high_suspicion_low_reuse,1);
  const stored=JSON.stringify(evidence.events);assert.ok(!stored.includes('NEVER_EXPORT'));
  const shown=JSON.stringify(first);for(const value of ['b'.repeat(64),'a'.repeat(64),'cache-1','event-','NEVER_EXPORT'])assert.ok(!shown.includes(value));
  evidence.accept(row('finish',{request_id:'other'}));
  assert.equal(evidence.snapshot(31000).checked_at,30000);
  assert.equal(evidence.snapshot(45000).checked_at,45000);
  assert.deepEqual(evidence.snapshot(45000,{status:'catching_up'}).workers,{});
  assert.deepEqual(evidence.snapshot(45000,{enabled:false}).workers,{});
  const bounded=new CacheContinuityEvidence({maxEvents:2});rows.forEach(r=>bounded.accept(r));
  assert.equal(bounded.snapshot(50000).status,'event_limit');assert.equal(bounded.events.length,2);
  const bytes=new CacheContinuityEvidence({maxBytes:1024});
  rows.forEach(r=>bytes.accept(r));
  assert.equal(bytes.snapshot(50000).status,'event_limit');assert.ok(bytes.bytes<=1024);
  const invalid=new CacheContinuityEvidence();invalid.accept({...rows[0],node:{prompt:'NEVER_EXPORT'}});
  assert.equal(invalid.snapshot(50000).status,'invalid_evidence');assert.equal(invalid.events.length,0);
});
test('malformed or skipped source rows withhold cache claims without breaking prediction analytics',t=>{
  const f=fixture(t);fs.writeFileSync(f.file,serialize(cachePair())+'not json\n');f.reader.poll(30000);
  assert.equal(f.reader.snapshot().status,'ready');assert.equal(f.reader.cacheSnapshot(30000).status,'source_gap');
  assert.deepEqual(f.reader.cacheSnapshot(30000).workers,{});
  fs.writeFileSync(f.file,serialize(cachePair()));f.reader.poll(40000);
  assert.equal(f.reader.cacheSnapshot(40000).status,'rescanning');f.reader.poll(50000);
  assert.equal(f.reader.cacheSnapshot(50000).workers['worker-a'].high_suspicion_low_reuse,1);
});
test('conflicting request positions withhold cache findings without disabling the analytics reader',t=>{
  const f=fixture(t),rows=cachePair(),conflict={...rows[0],event_id:'conflicting-position',session:'c'.repeat(64)};
  fs.writeFileSync(f.file,serialize([...rows,conflict]));f.reader.poll(30000);
  assert.equal(f.reader.snapshot().status,'ready');
  const cache=f.reader.cacheSnapshot(30000);assert.equal(cache.status,'invalid_evidence');assert.deepEqual(cache.workers,{});
  const shown=JSON.stringify(cache);assert.ok(!shown.includes('cache-1'));assert.ok(!shown.includes('c'.repeat(64)));
  fs.writeFileSync(f.file,serialize(rows));f.reader.poll(40000);f.reader.poll(50000);
  assert.equal(f.reader.cacheSnapshot(50000).workers['worker-a'].high_suspicion_low_reuse,1,'a clean rebuild restores valid findings');
});
test('cache source tail gaps cannot stitch a pair across omitted daily content',t=>{
  const f=fixture(t,{tailBytes:1500}),rows=cachePair();
  fs.writeFileSync(f.file,serialize(rows.slice(0,2)));
  fs.writeFileSync(path.join(f.dir,'routing-2000-01-02.jsonl'),'x'.repeat(2000)+'\n'+serialize(rows.slice(2)));
  f.reader.poll(30000);const result=f.reader.cacheSnapshot(30000);
  assert.equal(result.partial_history,true);assert.equal(result.workers['worker-a'].assessed_pairs,0);
  assert.equal(result.workers['worker-a'].abstention_reasons.no_prior_session_request,1);
});
test('an unfinished older daily line is a cache continuity gap, not an ignorable middle request',t=>{
  const f=fixture(t),rows=cachePair();
  fs.writeFileSync(f.file,serialize(rows.slice(0,2))+'{"kind":"decision"');
  fs.writeFileSync(path.join(f.dir,'routing-2000-01-02.jsonl'),serialize(rows.slice(2)));
  f.reader.poll(30000);assert.equal(f.reader.cacheSnapshot(30000).status,'source_gap');
  assert.deepEqual(f.reader.cacheSnapshot(30000).workers,{});
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
test('collection and cache UI distinguish missing metadata, sparse evidence and unmeasured costs',()=>{
  const {call}=ui();
  assert.match(call('cacheCostText({disk_load:{estimated_ms:null,status:"insufficient_evidence",samples:2},prefill:{estimated_ms:null}})'),/2\/3 required matching samples/);
  assert.match(call('cacheCostText({})'),/not total acquisition/);
  const evidence=call(`cacheEvidenceText({devices:[
    {telemetry_configured:true,backend_epoch:"${'a'.repeat(64)}"},{telemetry_configured:true,backend_epoch:null},{telemetry_configured:false,backend_epoch:"${'b'.repeat(64)}"}],
    attribution:{counts:{corroborated:3,candidate:2,abstained:4},quality:{schema:1,resolved_starts:7,pending_starts:2,corroboration_rate_pct:42.9,counts:{corroborated:3,candidate:2,abstained:4},reason_counts:{backend_epoch_unavailable:2,usage_conflict:1}}}})`);
  assert.match(evidence,/1 \/ 2 telemetry-enabled servers/);assert.match(evidence,/3 \/ 7 resolved starts corroborated \(42.9%\), 2 pending, 4 abstained/);
  assert.match(evidence,/2 backend epoch unavailable/);assert.match(evidence,/not protocol proof or a cache-hit verdict/);
  assert.match(call('cacheEvidenceText({},true)'),/unavailable/);
});
test('fleet pulse defaults to 12h, keeps missing energy unknown and exposes calibrated activity',()=>{
  const {ctx,get,call}=ui(),phase=(mean,tokens,activity)=>({mean_tps:mean,tokens_observed:tokens,active_seconds:100,samples:9,observed_workers:3,worker_count:3,activity_lower_bound_pct:activity});
  ctx.sample={fleet_speed:{schema:1,status:'ready',calibration:{decode:{max_tps:40},prefill:{max_tps:1000}},windows:{'12h':{decode:phase(20,21600,12.5),prefill:phase(680,null,4.2),energy:{status:'awaiting_power_data',estimated_kwh:null,coverage_pct:null}}}}};
  call('renderFleetSpeed(sample)');assert.equal(get('fleet-speed-window').value,'12h');assert.equal(get('fleet-decode-speed').textContent,'20');assert.equal(get('fleet-prefill-speed').textContent,'680');
  assert.equal(get('fleet-speed-decode').style.values.get('--speed-fill'),'50');assert.equal(get('fleet-speed-decode').style.values.get('--activity-fill'),'12.5');
  assert.match(get('fleet-speed-value').textContent,/21.6k tok · energy awaiting power data/);assert.match(get('fleet-speed-summary').title,/does not invent an energy estimate/);
  ctx.sample.fleet_speed.windows['12h'].energy={status:'insufficient_power_coverage',estimated_kwh:null,measured_kwh:0.0378,coverage_pct:1.7};call('renderFleetSpeed(sample)');
  assert.match(get('fleet-speed-summary').attributes.get('aria-label'),/Measured energy subtotal 0.038 kilowatt hours. Fleet estimate unavailable/);
  ctx.sample.fleet_speed.windows['12h'].energy={status:'estimated_from_measured_power',estimated_kwh:3.1,measured_kwh:3.1,coverage_pct:100};call('renderFleetSpeed(sample)');
  assert.match(get('fleet-speed-value').textContent,/21.6k tok · ≈3.1 kWh · .* tok\/kWh/);assert.match(get('fleet-speed-summary').attributes.get('aria-label'),/Estimated energy 3.1 kilowatt hours/);
});

import {GenerationEvidence} from './generation-evidence.mjs';
test('output-shape warnings are bounded, private, expire, and exclude failed or unobserved responses',()=>{
 const h=new GenerationEvidence(),now=Date.now(),row={schema:1,kind:'finish',run_id:'run',request_id:'request',node:'spark',outcome:'complete',finish_reason:'stop',route:'/v1/chat/completions',time:new Date(now).toISOString(),generation:{observation_complete:true,output_present:false,thinking_characters:40,answer_characters:0,tool_characters:0},prompt:'PRIVATE'};
 h.accept(row);h.accept(row);assert.equal(h.snapshot(now).rows.length,1);assert.equal(h.snapshot(now).rows[0].kind,'reasoning_only_final');assert.ok(!JSON.stringify(h.snapshot(now)).includes('PRIVATE'));assert.equal(h.snapshot(now+3600001).rows.length,0);
 for(const delta of [{outcome:'upstream_error'},{finish_reason:'length'},{generation:{observation_complete:true,output_present:false,thinking_characters:null,answer_characters:0,tool_characters:0}},{generation:{observation_complete:true,output_present:false,thinking_characters:1,answer_characters:10,tool_characters:0}},{finish_reason:'tool_calls'},{route:'/v1/responses'}])h.accept({...row,...delta,request_id:'excluded'});
 assert.equal(h.snapshot(now).rows.length,1);h.accept({...row,request_id:'empty',generation:{observation_complete:true,output_present:false,thinking_characters:0,answer_characters:0,tool_characters:0}});assert.equal(h.snapshot(now).rows.length,2);assert.equal(h.snapshot(now).automatic_action,false);
});
