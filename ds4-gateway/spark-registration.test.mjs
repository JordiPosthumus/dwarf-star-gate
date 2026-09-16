import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createSparkRegistration} from './spark-registration.mjs';
const proof={state:'qualified_serving',port:8001,contract:{context_length:262144},configuration_evidence:{runtime:{name:'vllm'},model:{name:'qwen3.8-flash-next'}},checks_passed:['prefix_cache','context_boundary'],verified_at:new Date().toISOString()};
function fixture(t,control){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sg-registration-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return {dir,service:createSparkRegistration({directory:path.join(dir,'registration'),recordsDirectory:path.join(dir,'records'),control,port:async()=>38888})};}
test('new worker is recorded, added paused and conditionally admitted once',async t=>{
  const calls=[];const {dir,service}=fixture(t,async(route,input)=>{
    calls.push({route,input});if(route==='/workers')return {workers:[]};
    if(route==='/add-worker'){assert.equal(fs.existsSync(path.join(dir,'records/observed/new-spark.json')),true);return {workers:[{...input.worker,drained:true,is_healthy:true,last_operator_action:null}]};}
    assert.equal(route,'/resume-workers');assert.deepEqual(input.expected_operator_actions,{'new-spark':null});return {workers:[{id:'new-spark',is_healthy:true,drained:false}]};
  });
  const result=await service.register('new-spark',{ssh:'new-spark'},proof);assert.equal(result.state,'registered_serving');
  assert.deepEqual(calls.map(c=>c.route),['/workers','/add-worker','/resume-workers']);
  assert.equal(calls[1].input.worker.max_concurrent_requests,1);assert.equal(calls[1].input.worker.context_length,262144);
  await service.register('new-spark',{ssh:'new-spark'},proof);assert.equal(calls.length,3);
});
test('existing workers are never edited or resumed by setup',async t=>{
  const {service}=fixture(t,async route=>{assert.equal(route,'/workers');return {workers:[{id:'existing'}]};});
  await assert.rejects(service.register('existing',{ssh:'host'},proof),/already exists/);
});
test('uncertain add outcome is retained and never automatically replayed',async t=>{
  let adds=0;const {dir,service}=fixture(t,async route=>{if(route==='/workers')return {workers:[]};assert.equal(route,'/add-worker');adds++;throw Error('connection lost');});
  await assert.rejects(service.register('new-spark',{ssh:'host'},proof),/connection lost/);
  const record=fs.readFileSync(path.join(dir,'records/observed/new-spark.json'),'utf8');
  assert.equal((await service.register('new-spark',{ssh:'host'},proof)).state,'needs_attention');assert.equal(adds,1);
  assert.equal(fs.readFileSync(path.join(dir,'records/observed/new-spark.json'),'utf8'),record);
});
test('qualified recovery/media accompany registration, and older cores cannot silently drop them',async t=>{
 const ready={...proof,container:'a'.repeat(64),recovery_restart:'passed',checks_passed:['context_boundary','fault_counters','model_context','prefix_cache','reasoning_eos','text','tools','vision'],recovery:{helper:'/srv/setup/recovery/helper.py',config:'/srv/setup/recovery/config.json',machine:'b'.repeat(64),profile:'c'.repeat(64)},configuration_evidence:{...proof.configuration_evidence,native_result_sha256:'d'.repeat(64)}};
 const media={music:{kind:'ace-step',container:'e'.repeat(64),image:'sha256:'+'f'.repeat(64),port:8002}};let version=0,added;
 const {dir,service}=fixture(t,async(route,input)=>{
  if(route==='/workers')return {workers:[],spark_services_version:version};
  if(route==='/add-worker'){added=input;return {workers:[{id:'new-spark',drained:true}]};}
  return {workers:[{id:'new-spark',is_healthy:true,drained:false}]};
 });
 await assert.rejects(service.register('new-spark',{ssh:'new-spark'},ready,media),/running gateway/);assert.equal(service.read('new-spark'),null);
 version=1;const row=await service.register('new-spark',{ssh:'new-spark'},ready,media);
 assert.deepEqual(added.services.media,media);assert.equal(added.services.recovery.helper,ready.recovery.helper);assert.deepEqual(row.services,{recovery:true,media:['music']});
 const record=JSON.parse(fs.readFileSync(path.join(dir,'records/observed/new-spark.json')));assert.equal(record.restoration.drill.status,'unproven');assert.equal(record.recovery_qualification.kind,'same_container_restart');
});
