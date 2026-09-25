import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createPairEnrollment,restorePairEnrollments} from './recovery-pair-enrollment.mjs';
import {Recovery} from './recovery.mjs';
import {createRecoveryTools} from './genie-recovery.mjs';
import http from 'node:http';
import {createGateway} from './gateway.mjs';
import {workerControl} from './worker-client.mjs';

function fixture(t,{cleanup=true}={}){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'pair-enroll-'));if(cleanup)t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const worker={id:'custom-pair',url:'http://192.0.2.1:8888/v1',backend:'openai',contextLength:400000,max_concurrent_requests:2,healthy:true,drained:false,active:null,queue:[]};
  const config={state_file:path.join(directory,'state.json'),control_socket:path.join(directory,'control.sock'),genie_chat:{python:'/usr/bin/python3',inspection:{workers:{'custom-pair':{ssh:['head'],container:'head-container'}}}},
    pair_recovery_setup:{workers:{'custom-pair':{exclusive:true}}},machine_groups:{'custom-pair':['host-a','host-b']},
    media_jobs:{pairs:{'custom-pair':{kind:'glm53-docker-pair',model:'fixture',worker_binding:{id:worker.id,url:worker.url},members:[{ssh:'head',container:'head-container',recipe_root:'/fixture/recipe'},{ssh:'rank',container:'rank-container'}]}}}};
  const store={filename:config.state_file,data:{recovery:{version:1,automatic:true,operations:[]}},save(value){fs.writeFileSync(this.filename,JSON.stringify(value));this.data=structuredClone(value);}};store.save(store.data);
  const recovery=new Recovery({}, {store,nodes:[worker],model:'fixture',stopping:()=>false,reinstate(){assert.fail('routing changed');},fleetConfig:config});
  let enabled=true;const calls=[];
  const result={machine:'a'.repeat(64),profile:'b'.repeat(64),evidence_sha256:'c'.repeat(64),epoch:'d'.repeat(64),pair_config_sha256:'e'.repeat(64),context_length:400000,concurrency:2};
  const options={config,store,recovery,isEnabled:()=>enabled,materialize:async input=>{calls.push(input);return result;}};
  return {directory,config,store,recovery,worker,calls,result,options,enabled:v=>enabled=v,request:()=>({worker_id:worker.id,capture_id:randomUUID(),action_id:randomUUID()}),create:()=>createPairEnrollment(options)};
}
test('native binding is persisted with backup and survives reconstruction without routing or automatic certification',async t=>{
  const f=fixture(t),service=f.create(),request=f.request();assert.equal(service.request(request).state,'queued');await service.idle();
  const row=f.store.data.pair_recovery_enrollments[request.action_id];assert.equal(row.state,'enrolled');assert.ok(fs.existsSync(row.backup));
  assert.equal(f.recovery.config(f.worker.id).adapter,'docker-pair');assert.equal(f.recovery.config(f.worker.id).start_stopped,undefined);
  assert.equal(f.worker.drained,false);assert.equal(f.worker.healthy,true);assert.deepEqual(f.recovery.state.operations,[]);
  assert.equal(service.request(request).state,'enrolled');assert.equal(f.calls.length,1);
  const fresh={};restorePairEnrollments(fresh,f.store.data.pair_recovery_enrollments,[f.worker]);assert.deepEqual(fresh.recovery.workers,[row.entry]);
  assert.equal(f.calls[0].expected.binding.port,8888);assert.equal(f.calls[0].expected.binding.concurrency,2);
  assert.equal(service.status().operations[0].entry,undefined);
});
test('explicit policy, capabilities, existing bindings, ownership and registered routes gate enrollment',async t=>{
  const f=fixture(t),s=f.create();f.enabled(false);assert.throws(()=>s.request(f.request()),/policy_disabled/);f.enabled(true);
  delete f.config.pair_recovery_setup.workers[f.worker.id];assert.throws(()=>s.request(f.request()),/policy_disabled/);
  f.config.pair_recovery_setup.workers[f.worker.id]={exclusive:true};f.worker.active={id:'active'};assert.throws(()=>s.request(f.request()),/admitted_work/);f.worker.active=null;
  f.recovery.configs.set(f.worker.id,{});assert.throws(()=>s.request(f.request()),/existing_recovery/);f.recovery.configs.clear();
  f.worker.url='http://192.0.2.2:8888/v1';assert.throws(()=>s.request(f.request()),/healthy_pair/);assert.equal(f.calls.length,0);
});
test('late ownership, capacity and policy changes preserve the existing enrollment and serving state',async t=>{
  for(const change of [f=>{f.worker.active={id:'late'};},f=>{f.worker.contextLength=8192;},f=>f.enabled(false)]){
    const f=fixture(t);f.options.materialize=async()=>{change(f);return f.result;};const s=f.create();s.request(f.request());await s.idle();
    assert.equal(s.status().operations[0].state,'failed');assert.equal(f.recovery.config(f.worker.id),undefined);assert.equal(f.worker.drained,false);
  }
});
test('queued identity survives core restart; identical requests never create duplicate authority',async t=>{
  const f=fixture(t);f.options.materialize=()=>new Promise(()=>{});const first=f.create(),request=f.request();first.request(request);first.close();
  assert.throws(()=>first.request({...request,capture_id:randomUUID()}),/conflict/);
  f.options.materialize=async()=>f.result;const second=f.create();assert.equal(second.request(request).state,'queued');second.tick();await second.idle();
  assert.equal(second.status().operations[0].state,'enrolled');assert.equal(Object.keys(f.store.data.pair_recovery_enrollments).length,1);
  assert.throws(()=>second.request(f.request()),/already_requested/);
});
test('failed native verification and failed durable commit cannot install authority',async t=>{
  const f=fixture(t);f.options.materialize=async()=>{throw Error('private remote details');};let s=f.create();s.request(f.request());await s.idle();assert.equal(s.status().operations[0].error,'pair_enrollment_unverified');
  const g=fixture(t);g.options.materialize=async()=>{g.store.save=()=>{throw Error('disk full');};return g.result;};s=g.create();s.request(g.request());await s.idle();
  assert.equal(g.recovery.config(g.worker.id),undefined);assert.equal(s.status().operations[0].state,'queued');
});
test('restore preserves static services and refuses conflicting or corrupt enrolled authority',async t=>{
  const f=fixture(t),s=f.create();s.request(f.request());await s.idle();const saved=f.store.data.pair_recovery_enrollments;
  const fresh={recovery:{workers:[structuredClone(Object.values(saved)[0].entry)]}};assert.throws(()=>restorePairEnrollments(fresh,saved,[f.worker]),/one registered/);
  const corrupt=structuredClone(saved);Object.values(corrupt)[0].entry.id='another';assert.throws(()=>restorePairEnrollments({},corrupt,[f.worker]),/journal_invalid/);
});
test('Genie receives only fixed enrollment inputs and respects independent mutation capabilities',async()=>{
  let enabled=true,changes=true,inspection=true,testing=false;const calls=[];
  const q=createRecoveryTools({read:async()=>({version:1,recovery:{workers:[],operations:[]}}),recover:()=>assert.fail('restart requested'),enroll:async input=>{calls.push(input);return {...input,state:'queued'};},isEnabled:()=>enabled,isChangesEnabled:()=>changes,isInspectionEnabled:()=>inspection,isTesting:()=>testing});
  const input={action:'enroll-pair',action_id:randomUUID(),capture_id:randomUUID(),worker_id:'custom'};
  assert.equal((await q.tool(input)).state,'queued');assert.equal(calls.length,1);
  for(const toggle of [()=>enabled=false,()=>{enabled=true;changes=false;},()=>{changes=true;inspection=false;},()=>{inspection=true;testing=true;}]){toggle();await assert.rejects(q.tool(input),/unavailable/);}
  testing=false;await assert.rejects(q.tool({...input,helper:'/untrusted'}),/Specify/);assert.equal(calls.length,1);
});
test('real private core protocol queues one enrollment and reports missing evidence without granting recovery',async t=>{
  const f=fixture(t,{cleanup:false}),server=http.createServer((_req,res)=>res.end(JSON.stringify({data:[{id:'fixture',max_model_len:400000}]})));let gateway;
  t.after(async()=>{try{await gateway?.close();}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));fs.rmSync(f.directory,{recursive:true,force:true});}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url=`http://127.0.0.1:${server.address().port}/v1`;
  const config={...f.config,host:'127.0.0.1',port:0,api_key:'none',model:'fixture',context_length:400000,probe_timeout_ms:1000,health_interval_ms:60000,
    nodes:[{id:'custom-pair',url,backend:'openai',max_concurrent_requests:2}]};config.media_jobs.enabled=false;config.media_jobs.pairs['custom-pair'].worker_binding.url=url;
  // The fixture store is separate from the gateway-owned metadata.
  fs.unlinkSync(config.state_file);gateway=createGateway(config);await gateway.start();
  const input=f.request();await assert.rejects(workerControl(config.control_socket,'/enroll-pair-recovery',input),/policy_disabled/);
  await workerControl(config.control_socket,'/recovery-policy',{enabled:true});
  const accepted=await workerControl(config.control_socket,'/enroll-pair-recovery',input);assert.equal(accepted.state,'queued');
  let row;for(let i=0;i<100;i++){row=(await workerControl(config.control_socket,'/workers')).recovery.pair_enrollment.operations[0];if(row.state!=='queued')break;await new Promise(resolve=>setTimeout(resolve,20));}
  assert.equal(row.state,'failed');assert.equal(gateway.recovery.config('custom-pair'),undefined);
  assert.equal((await workerControl(config.control_socket,'/enroll-pair-recovery',input)).state,'failed');
  assert.equal((await workerControl(config.control_socket,'/workers')).recovery.pair_enrollment.operations.length,1);
  assert.equal(fs.existsSync(path.join(path.dirname(config.state_file),'genie','recovery-pair-preparation',input.capture_id)),false);
});
