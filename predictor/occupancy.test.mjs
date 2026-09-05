import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {replayOccupancy} from './occupancy.mjs';
import {deliveryFeatures,replayDeliveryOccupancy} from './occupancy-delivery.mjs';
import {featureBuilderHash} from '../ds4-gateway/prediction-feature-registry.mjs';
import {createHash} from 'node:crypto';
import {prepare,prepareArgs,selectOccupancyCohort} from './prepare.mjs';
import {replay} from '../ds4-gateway/prediction-features-v4.mjs';
import {validateCandidate} from '../ds4-gateway/xgb-runtime.mjs';
const inventory={schema:1,workers:{a:{matching_profiles:['p'],hardware_family:'spark',accelerator_family:'cuda',ram_gib:128}}};
const origin=100000;
test('occupancy artifacts cannot be loaded as production completion models',()=>{
  assert.throws(()=>validateCandidate({schema:2,created_at:'2026-09-04T00:00:00Z',feature_schema:'dsg-occupancy-v1',models:{}}),/feature schema/i);
  assert.throws(()=>validateCandidate({schema:2,created_at:'2026-09-04T00:00:00Z',feature_schema:'dsg-occupancy-v2',models:{}}),/feature schema/i);
});
test('delivery-aware inputs preserve raw rates without treating them as engine timing',()=>{
  const original={prior_generation_tps:32900,worker_generation_tps:30,history_generation_estimate_s:2,prior_service_s:75.64,prior_ttft_s:75.61,prior_output_tokens:987};
  const copy=structuredClone(original),f=deliveryFeatures(original);
  assert.deepEqual(original,copy);assert.equal(f.prior_stream_delivery_tps,32900);assert.equal(f.worker_stream_delivery_tps,30);assert.equal(f.history_delivery_estimate_s,2);
  assert.ok(Math.abs(f.prior_stream_window_s-.03)<1e-10);assert.ok(Math.abs(f.prior_service_output_tps-987/75.64)<1e-10);
  assert.ok(f.prior_stream_window_fraction<.001);
  for(const name of ['prior_generation_tps','worker_generation_tps','history_generation_estimate_s'])assert.ok(!(name in f));
  for(const patch of [{prior_service_s:null},{prior_service_s:NaN},{prior_ttft_s:-1},{prior_ttft_s:80}])assert.equal(deliveryFeatures({...original,...patch}).prior_stream_window_s,null);
  assert.equal(deliveryFeatures({...original,prior_service_s:0,prior_ttft_s:0}).prior_stream_window_fraction,null);
  assert.equal(deliveryFeatures({...original,prior_output_tokens:-1}).prior_service_output_tps,null);
});
test('delivery-aware replay preserves V1 labels and only uses earlier completed history',()=>{
  const events=fixture();events.at(-1).finish_reason='stop';events.at(-1).usage={completion_tokens:100,prompt_tokens:1000};events.at(-1).generation={first_semantic_ms:7199990};
  events.push(row('decision',7200100,{request_id:'next',session:'session',candidates:[{node:'a',profile:'p',context_length:262144}]}),
    row('dispatch',7200101,{request_id:'next'}),row('finish',7201101,{request_id:'next',outcome:'complete',finish_reason:'stop',service_ms:1000}));
  const original=replayOccupancy(events,inventory),v2=replayDeliveryOccupancy(events,inventory);
  assert.equal(v2.schema,'dsg-occupancy-v2');assert.equal(v2.feature_schema,'dsg-delivery-aware-v1');assert.equal(v2.routing_enabled,false);
  assert.deepEqual(v2.rows.map(({features,...row})=>row),original.rows.map(({features,...row})=>row));
  assert.ok(v2.rows.filter(r=>r.request_id==='request').every(r=>r.features.prior_stream_delivery_tps===null));
  const next=v2.rows.find(r=>r.request_id==='next');assert.ok(next.features.prior_stream_delivery_tps>9999);assert.equal(next.features.prior_service_output_tps,100/7200);
  assert.deepEqual(Object.keys(next.features).sort(),[...v2.feature_names].sort());assert.deepEqual(replayOccupancy(events,inventory),original);
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
test('declared occupancy cohort preserves raw snapshots and older causal history',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dsg-cohort-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const source=path.join(root,'source');fs.mkdirSync(source);
  const old=fixture();old.at(-1).finish_reason='stop';old.at(-1).usage={prompt_tokens:100,completion_tokens:10,cached_tokens:0};
  const recent=old.map(event=>({...event,request_id:'new',event_id:'new-'+event.event_id,time:new Date(Date.parse(event.time)+8000000).toISOString(),
    ...(event.available_at?{available_at:event.available_at+8000000}:{})}));
  // Preserve the full snapshot bytes, including a partial trailing live line.
  const raw=[...old,...recent].map(event=>JSON.stringify(event)+'\n').join('')+'{"partial":';
  const file='routing-2026-09-04.jsonl';fs.writeFileSync(path.join(source,file),raw);
  const profiles=path.join(root,'profiles.json');fs.writeFileSync(profiles,JSON.stringify(inventory));
  const all=path.join(root,'all'),selected=path.join(root,'selected'),since=new Date(origin+8000000).toISOString();
  prepare(source,profiles,all,'dsg-occupancy-v1');
  const result=prepare(source,profiles,selected,'dsg-occupancy-v1',{cohortSince:since});
  const original=JSON.parse(fs.readFileSync(path.join(all,'prepared.json'))),cohort=JSON.parse(fs.readFileSync(path.join(selected,'prepared.json')));
  assert.deepEqual(cohort.rows,original.rows.filter(r=>r.request_id==='new'));
  assert.ok(cohort.rows.length>0);assert.equal(cohort.rows.find(r=>r.stage==='admission').features.history_count,1);
  assert.equal(original.snapshot.cohort,undefined);assert.equal(cohort.routing_enabled,false);
  assert.equal(result.snapshot.cohort.source_requests,2);assert.equal(result.snapshot.cohort.selected_requests,1);
  assert.equal(result.snapshot.cohort.excluded_requests,1);assert.equal(result.snapshot.cohort.excluded_points,original.rows.length-cohort.rows.length);
  assert.match(result.snapshot.cohort.selector_sha256,/^[a-f0-9]{64}$/);
  assert.deepEqual(cohort.snapshot.hashes,original.snapshot.hashes);
  assert.equal(fs.readFileSync(path.join(selected,'snapshots',file),'utf8'),raw);
  assert.equal(fs.readFileSync(path.join(source,file),'utf8'),raw);
  const delivery=path.join(root,'delivery');prepare(source,profiles,delivery,'dsg-occupancy-v2',{cohortSince:since});
  const newer=JSON.parse(fs.readFileSync(path.join(delivery,'prepared.json')));
  assert.deepEqual(newer.snapshot.hashes,cohort.snapshot.hashes);assert.equal(newer.rows.length,cohort.rows.length);
  const legacyHash=createHash('sha256').update(Buffer.concat([Buffer.from(featureBuilderHash('dsg-latency-v4')),fs.readFileSync(new URL('./occupancy.mjs',import.meta.url))])).digest('hex');
  assert.equal(original.snapshot.feature_builder_sha256,legacyHash);assert.notEqual(newer.snapshot.feature_builder_sha256,legacyHash);
  assert.ok(newer.rows.every(r=>!Object.hasOwn(r.features,'history_generation_estimate_s')));
  assert.equal(fs.statSync(path.join(selected,'prepared.json')).mode&0o777,0o600);
  assert.throws(()=>prepare(source,profiles,selected,'dsg-occupancy-v1',{cohortSince:since}),/already exists/);
  const empty=path.join(root,'empty');const resultEmpty=prepare(source,profiles,empty,'dsg-occupancy-v1',{cohortSince:'2020-01-01T00:00:00Z'});
  assert.equal(resultEmpty.rows,0);assert.equal(resultEmpty.snapshot.cohort.selected_requests,0);
  assert.equal(fs.readFileSync(path.join(empty,'snapshots',file),'utf8'),raw);
});
test('cohort selection uses earliest admission per run/request, never later progress or outcomes',()=>{
  const since='2020-01-01T00:00:00Z',cut=Date.parse(since);
  const point=(run,id,time,kind='admission')=>({run_id:run,request_id:id,decision_time:time,kind});
  const data={schema:'dsg-occupancy-v1',rows:[point('a','old',cut-1),point('a','old',cut+1,'remaining'),point('b','old',cut),point('a','new',cut+1)]};
  const receipt=selectOccupancyCohort(data,since);
  assert.equal(receipt.source_points,4);assert.equal(receipt.selected_points,2);assert.equal(receipt.selected_requests,2);
  assert.deepEqual(data.rows.map(r=>[r.run_id,r.request_id]),[['b','old'],['a','new']]);
});
test('cohort selection rejects malformed dates and never silently changes ordinary preparation',()=>{
  for(const since of ['2026-02-30T00:00:00Z','2026-01-01','2026-01-01T00:00:00+00:00','2999-01-01T00:00:00Z','bad','',0]){
    assert.throws(()=>prepare('/missing','/missing','/missing','dsg-occupancy-v1',{cohortSince:since}),/Cohort start/);
  }
  assert.throws(()=>prepare('/missing','/missing','/missing','dsg-latency-v4',{cohortSince:'2020-01-01T00:00:00Z'}),/offline occupancy/);
  assert.throws(()=>selectOccupancyCohort({schema:'dsg-occupancy-v1',rows:[{decision_time:NaN}]},'2020-01-01T00:00:00Z'),/admission time/);
  const data={schema:'dsg-latency-v4',rows:[{unchanged:true}]},before=structuredClone(data);
  assert.equal(selectOccupancyCohort(data,null),null);assert.deepEqual(data,before);
  const base=['--data','input','--profiles','profiles','--output','output'];
  assert.equal(prepareArgs(base).at(-1).cohortSince,null);
  for(const suffix of [['--cohort-since'],['--cohort-since',''],['--cohort-since','2020-01-01T00:00:00Z','--cohort-since','2021-01-01T00:00:00Z'],['--cohort-sinc','2020-01-01T00:00:00Z']])assert.throws(()=>prepareArgs([...base,...suffix]),/option/);
});
