import {test} from 'node:test';
import assert from 'node:assert/strict';
import {replayOccupancy} from './occupancy.mjs';
import {replay} from '../ds4-gateway/prediction-features-v4.mjs';
import {validateCandidate} from '../ds4-gateway/xgb-runtime.mjs';
const inventory={schema:1,workers:{a:{matching_profiles:['p'],hardware_family:'spark',accelerator_family:'cuda',ram_gib:128}}};
const origin=100000;
test('occupancy artifacts cannot be loaded as production completion models',()=>{
  assert.throws(()=>validateCandidate({schema:2,created_at:'2026-09-04T00:00:00Z',feature_schema:'dsg-occupancy-v1',models:{}}),/feature schema/i);
});
const row=(kind,t,extra={})=>({schema:1,run_id:'run',request_id:'request',event_id:kind+t,kind,node:'a',time:new Date(origin+t).toISOString(),...extra});
const fixture=()=>[row('decision',0,{session:'session',candidates:[{node:'a',profile:'p',context_length:262144,active:0,queued:0}]}),
  row('dispatch',1),row('request_features',2,{status:'ready',available_at:origin+2,max_output_tokens:30000}),
  row('progress',30001,{active_elapsed_ms:30000}),row('finish',7200001,{outcome:'complete',finish_reason:'length',service_ms:7200000})];
test('occupancy includes capped terminal time without changing completion priors or leaking the cap into admission',()=>{
  const events=fixture(),result=replayOccupancy(events,inventory);
  assert.equal(replay(events,inventory).rows.length,0);
  assert.equal(result.schema,'dsg-occupancy-v1');assert.equal(result.routing_enabled,false);
  assert.equal(result.rows.find(r=>r.stage==='admission').features.request_max_output_tokens,null);
  assert.equal(result.rows.find(r=>r.stage==='upload').features.request_max_output_tokens,30000);
  assert.equal(result.rows.find(r=>r.stage==='remaining').target_s,7170);
  assert.ok(result.rows.every(r=>r.terminal_class==='output_limited'&&!('terminal_class' in r.features)));
});
test('normal occupancy preserves existing feature snapshots and target values',()=>{
  const events=fixture();events.at(-1).finish_reason='stop';
  const actual=replayOccupancy(events,inventory).rows.map(({terminal_class,target_contract,...r})=>r);
  assert.deepEqual(actual,replay(events,inventory).rows);
});
test('offline occupancy keeps early long-duration progress beyond the live rolling window',()=>{
  const events=fixture();events.splice(3,1,...Array.from({length:100},(_,i)=>row('progress',30001+i*30000,{active_elapsed_ms:30000+i*30000})));
  const rows=replayOccupancy(events,inventory).rows,progress=rows.filter(r=>r.kind==='remaining');
  assert.equal(progress.length,100);assert.equal(progress[0].target_s,7170);
  assert.equal(progress.at(-1).target_s,4200);
  assert.ok(rows.some(r=>r.stage==='admission'));assert.ok(rows.some(r=>r.stage==='upload'));
});
test('cancellations, unknown endings, relocations, mismatched profiles and ambiguous finishes abstain',()=>{
  for(const change of [e=>e.at(-1).outcome='client_cancelled',e=>e.at(-1).finish_reason=null,e=>e[0].candidates[0].profile='other',e=>e.splice(2,0,row('queue_relocation',1)),e=>e.push({...e.at(-1),event_id:'conflict',service_ms:1})]){
    const events=fixture();change(events);assert.equal(replayOccupancy(events,inventory).rows.length,0);
  }
  const events=fixture();assert.equal(replayOccupancy([...events,events.at(-1)],inventory).rows.length,replayOccupancy(events,inventory).rows.length);
});
