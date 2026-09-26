import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createOmlxEnrollment,restoreOmlxEnrollments} from './recovery-omlx-enrollment.mjs';
import {Recovery} from './recovery.mjs';
import {createRecoveryTools} from './genie-recovery.mjs';
import http from 'node:http';
import {createGateway} from './gateway.mjs';
import {workerControl} from './worker-client.mjs';

function fixture(t,{cleanup=true}={}){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'omlx-enroll-'));if(cleanup)t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const worker={id:'custom-local',url:'http://127.0.0.1:8013/v1',backend:'openai',api_key_file:'/fixture/inference-key',model_aliases:{PoolModel:'fixture'},contextLength:400000,max_concurrent_requests:1,healthy:true,drained:false,active:null,queue:[]};
  const config={model:'PoolModel',state_file:path.join(directory,'state.json'),control_socket:path.join(directory,'control.sock'),genie_chat:{python:'/usr/bin/python3',inspection:{workers:{'custom-local':{kind:'omlx-local',root:'/fixture/omlx',url:worker.url,api_key_file:'/fixture/inspection-key'}}}},
    omlx_recovery_setup:{workers:{'custom-local':{exclusive:true,launcher:'/fixture/omlx/start.sh',profile_files:['/fixture/guard.sh']}}},machine_groups:{'custom-local':['one-machine']}};
  const store={filename:config.state_file,data:{recovery:{version:1,automatic:true,operations:[]}},save(value){fs.writeFileSync(this.filename,JSON.stringify(value));this.data=structuredClone(value);}};store.save(store.data);
  const recovery=new Recovery({}, {store,nodes:[worker],model:'PoolModel',stopping:()=>false,reinstate(){assert.fail('routing changed');},fleetConfig:config});
  let enabled=true;const calls=[];
  const result={machine:'a'.repeat(64),profile:'b'.repeat(64),evidence_sha256:'c'.repeat(64),instance:'d'.repeat(32),config_sha256:'e'.repeat(64),context_length:400000,concurrency:1};
  const options={config,store,recovery,isEnabled:()=>enabled,materialize:async input=>{calls.push(input);return result;}};
  return {directory,config,store,recovery,worker,calls,result,options,enabled:v=>enabled=v,request:()=>({worker_id:worker.id,action_id:randomUUID()}),create:()=>createOmlxEnrollment(options)};
}
test('native local enrollment retains backups, exact inputs and legacy services across reconstruction',async t=>{
  const f=fixture(t),s=f.create(),input=f.request();assert.equal(s.request(input).state,'queued');await s.idle();
  const row=f.store.data.omlx_recovery_enrollments[input.action_id];assert.equal(row.state,'enrolled');
  assert.ok(fs.existsSync(row.backup));assert.ok(fs.existsSync(row.intent_backup));assert.equal(f.worker.drained,false);
  assert.equal(row.entry.verification,'glm53_omlx');assert.equal(row.entry.start_stopped,undefined);
  assert.equal(f.recovery.state.operations.length,0);assert.equal(s.request(input).state,'enrolled');assert.equal(f.calls.length,1);
  assert.deepEqual(f.calls[0].expected.target,f.config.genie_chat.inspection.workers[f.worker.id]);assert.equal(f.calls[0].expected.concurrency,1);
  const fresh={};restoreOmlxEnrollments(fresh,f.store.data.omlx_recovery_enrollments,[f.worker]);assert.deepEqual(fresh.recovery.workers,[row.entry]);
  assert.ok(!JSON.stringify(s.status()).includes('/fixture'));assert.equal(s.status().operations[0].entry,undefined);
});
test('explicit policy, exact inspection endpoint, ownership and healthy unpaused worker gate capture',async t=>{
  for(const change of [f=>f.enabled(false),f=>f.worker.drained=true,f=>f.worker.active={},f=>f.worker.url='http://127.0.0.1:9999/v1',
    f=>f.config.omlx_recovery_setup.workers[f.worker.id].launcher='relative',f=>f.recovery.configs.set(f.worker.id,{}),
    f=>f.config.machine_groups[f.worker.id]=['a','b'],f=>f.config.omlx_recovery_setup.workers[f.worker.id].start_stopped=true]){
    const f=fixture(t),s=f.create();change(f);assert.throws(()=>s.request(f.request()));assert.equal(f.calls.length,0);assert.equal(s.status().operations.length,0);
  }
});
test('late policy, credential or capacity changes cannot install captured authority',async t=>{
  for(const change of [f=>f.enabled(false),f=>f.worker.api_key_file='/different/key',f=>f.worker.contextLength=8192,f=>f.worker.drained=true]){
    const f=fixture(t);f.options.materialize=async()=>{change(f);return f.result;};const s=f.create();s.request(f.request());await s.idle();
    assert.equal(s.status().operations[0].state,'failed');assert.equal(f.recovery.config(f.worker.id),undefined);
  }
});
test('late inference or maintenance ownership retains the action across restart and commits only after release',async t=>{
  for(const kind of ['inference','hold']){
    const f=fixture(t),input=f.request();let captures=0;
    f.options.materialize=async()=>{captures++;if(captures===1){if(kind==='inference')f.worker.active={};else f.store.data.agent_control={holds:[{id:'owner',worker_id:f.worker.id}],maintenance_locks:[]};}return f.result;};
    const first=f.create();first.request(input);await first.idle();
    assert.equal(first.status().operations[0].state,'queued');assert.match(first.status().operations[0].reason,/admitted_work|maintenance_hold/);
    assert.equal(f.recovery.config(f.worker.id),undefined);first.close();
    const next=f.create();next.tick();await next.idle();assert.equal(captures,1,'owner activity cannot be bypassed');
    f.worker.active=null;f.store.data.agent_control={holds:[],maintenance_locks:[]};next.tick();await next.idle();
    assert.equal(captures,2);assert.equal(next.status().operations[0].state,'enrolled');assert.equal(next.status().operations[0].reason,undefined);
    assert.equal(next.status().operations[0].action_id,input.action_id);assert.equal(next.status().operations.length,1);
    assert.equal(f.worker.drained,false);assert.equal(f.recovery.state.operations.length,0);
  }
});
test('graceful replacement preserves queued identity and resumes only the same read-only capture',async t=>{
  const f=fixture(t);let finish;f.options.materialize=()=>new Promise(resolve=>finish=resolve);
  const before=f.create(),input=f.request();before.request(input);before.close();finish(f.result);await before.idle();
  assert.equal(before.status().operations[0].state,'queued');assert.equal(f.recovery.config(f.worker.id),undefined);
  f.options.materialize=async()=>f.result;const after=f.create();after.tick();await after.idle();
  assert.equal(after.status().operations[0].action_id,input.action_id);assert.equal(after.status().operations[0].state,'enrolled');
  assert.throws(()=>after.request(f.request()),/already_requested/);assert.throws(()=>after.request({...input,worker_id:'other'}),/conflict/);
});
test('native or metadata persistence failure preserves old configuration without leaking diagnostics',async t=>{
  const f=fixture(t);f.options.materialize=async()=>{throw Error('private native details');};const s=f.create();s.request(f.request());await s.idle();
  assert.equal(s.status().operations[0].error,'omlx_enrollment_unverified');assert.equal(f.recovery.config(f.worker.id),undefined);
  const g=fixture(t);g.options.materialize=async()=>{g.store.save=()=>{throw Error('disk full');};return g.result;};const next=g.create();next.request(g.request());await next.idle();
  assert.equal(next.status().operations[0].state,'queued');assert.equal(g.recovery.config(g.worker.id),undefined);
});
test('restore rejects collisions, changed adapter and invented stopped-start authority',async t=>{
  const f=fixture(t),s=f.create();s.request(f.request());await s.idle();const saved=f.store.data.omlx_recovery_enrollments;
  assert.throws(()=>restoreOmlxEnrollments({recovery:{workers:[Object.values(saved)[0].entry]}},saved,[f.worker]),/one registered/);
  for(const change of [{adapter:'docker'},{start_stopped:true},{verification:'qwen_omlx'}]){
    const bad=structuredClone(saved);Object.assign(Object.values(bad)[0].entry,change);assert.throws(()=>restoreOmlxEnrollments({},bad,[f.worker]),/journal_invalid/);
  }
});
test('Genie local enrollment accepts only the worker and its durable action ID under all capability gates',async()=>{
  let enabled=true,changes=true,inspection=true,testing=false;const calls=[];
  const q=createRecoveryTools({read:async()=>({version:1,recovery:{workers:[],operations:[]}}),enrollOmlx:async input=>{calls.push(input);return {...input,state:'queued'};},isEnabled:()=>enabled,isChangesEnabled:()=>changes,isInspectionEnabled:()=>inspection,isTesting:()=>testing});
  const input={action:'enroll-omlx',action_id:randomUUID(),worker_id:'custom'};
  assert.equal((await q.tool(input)).state,'queued');await assert.rejects(q.tool({...input,launcher:'/untrusted'}),/Specify/);
  for(const toggle of [()=>enabled=false,()=>{enabled=true;changes=false;},()=>{changes=true;inspection=false;},()=>{inspection=true;testing=true;}]){toggle();await assert.rejects(q.tool(input),/suspended/);}
  assert.equal(calls.length,1);
});
test('real core socket durably queues one local enrollment and refuses absent native files without actions',async t=>{
  const f=fixture(t,{cleanup:false}),server=http.createServer((_req,res)=>res.end(JSON.stringify({data:[{id:'fixture',max_model_len:400000}]})));let gateway;
  t.after(async()=>{try{await gateway?.close();}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));fs.rmSync(f.directory,{recursive:true,force:true});}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url=`http://127.0.0.1:${server.address().port}/v1`;
  const config={...f.config,host:'127.0.0.1',port:0,api_key:'none',context_length:400000,probe_timeout_ms:1000,health_interval_ms:60000,
    nodes:[{id:'custom-local',url,backend:'openai',model_aliases:{PoolModel:'fixture'},max_concurrent_requests:1}]};config.genie_chat.inspection.workers['custom-local'].url=url;
  fs.unlinkSync(config.state_file);gateway=createGateway(config);await gateway.start();const input=f.request();
  await assert.rejects(workerControl(config.control_socket,'/enroll-omlx-recovery',input),/policy_disabled/);
  await workerControl(config.control_socket,'/recovery-policy',{enabled:true});assert.equal((await workerControl(config.control_socket,'/enroll-omlx-recovery',input)).state,'queued');
  let row;const deadline=Date.now()+30000;
  do{row=(await workerControl(config.control_socket,'/workers')).recovery.omlx_enrollment.operations.find(r=>r.action_id===input.action_id);if(row?.state!=='queued')break;await new Promise(resolve=>setTimeout(resolve,50));}while(Date.now()<deadline);
  assert.equal(row.state,'failed');assert.equal(gateway.recovery.config('custom-local'),undefined);
  assert.equal((await workerControl(config.control_socket,'/enroll-omlx-recovery',input)).state,'failed');
  assert.equal((await workerControl(config.control_socket,'/workers')).recovery.omlx_enrollment.operations.length,1);
});

async function demandFixture(t){
  const f=fixture(t),first=f.create(),input=f.request();first.request(input);await first.idle();first.close();
  const prior=f.store.data.omlx_recovery_enrollments[input.action_id].entry;
  fs.mkdirSync(path.dirname(prior.config),{recursive:true,mode:0o700});fs.writeFileSync(prior.config,JSON.stringify({fixture:'retained original wrapper',start_stopped:false})+'\n',{mode:0o600});
  f.config.omlx_recovery_setup.workers[f.worker.id].start_on_demand=true;
  f.options.materialize=async observed=>{f.calls.push(observed);return {...f.result,previous_config_sha256:observed.expected.enable_demand.sha256};};
  return {...f,prior,firstInput:input,original:fs.readFileSync(prior.config)};
}

test('same fixed Genie enrollment tool extends explicit demand authority with exact delta and preserves reconstruction order',async t=>{
  const f=await demandFixture(t),s=f.create(),input=f.request();
  assert.deepEqual(s.status().demand_start_offers,[{worker_id:f.worker.id,eligible:true,reason:null}]);
  const accepted=s.request(input);assert.equal(accepted.demand_start,true);await s.idle();
  const row=f.store.data.omlx_recovery_enrollments[input.action_id];assert.equal(row.state,'enrolled');
  assert.deepEqual(row.entry,{...row.snapshot.previous_entry,config:row.entry.config,start_stopped:true,service_profile:f.prior.profile});
  assert.notEqual(row.entry.config,f.prior.config);assert.deepEqual(fs.readFileSync(f.prior.config),f.original);assert.ok(fs.existsSync(row.backup));
  assert.equal(f.recovery.config(f.worker.id).start_stopped,true);assert.equal(f.recovery.state.operations.length,0);
  assert.equal(s.request(input).state,'enrolled');assert.throws(()=>s.request(f.request()),/already_requested/);
  const restored={};restoreOmlxEnrollments(restored,Object.fromEntries(Object.entries(f.store.data.omlx_recovery_enrollments).reverse()),[f.worker]);
  assert.deepEqual(restored.recovery.workers,[row.entry]);
  for(const change of [{profile:'f'.repeat(64)},{python:'/other/python'},{url:'http://127.0.0.1:9999/v1'},{helper:'/different/helper'}]){
    const bad=structuredClone(f.store.data.omlx_recovery_enrollments);Object.assign(bad[input.action_id].entry,change);
    assert.throws(()=>restoreOmlxEnrollments({},bad,[f.worker]),/delta_invalid/);
  }
  assert.equal(s.status().demand_start_offers.length,0);assert.ok(!JSON.stringify(s.status()).includes(f.directory));
});

test('demand enrollment requires explicit policy and preserves existing bindings on mismatches or active ownership',async t=>{
  for(const change of [f=>f.config.omlx_recovery_setup.workers[f.worker.id].start_on_demand=false,
    f=>f.worker.active={id:'active'},f=>f.worker.drained=true,f=>f.worker.healthy=false,
    f=>f.store.data.agent_control={holds:[{worker_id:f.worker.id}],maintenance_locks:[]},
    f=>fs.chmodSync(f.prior.config,0o644),f=>f.store.data.recovery.adopted_profiles={[f.worker.id]:{}},
    f=>f.recovery.configs.set(f.worker.id,{...f.recovery.config(f.worker.id),helper:'/different/helper'})]){
    const f=await demandFixture(t),s=f.create(),before=structuredClone(f.config.recovery);change(f);
    assert.throws(()=>s.request(f.request()));assert.deepEqual(f.config.recovery,before);assert.deepEqual(fs.readFileSync(f.prior.config),f.original);
  }
});

test('late wrapper/profile changes and capability withdrawal cannot install demand authority',async t=>{
  for(const change of ['wrapper','profile','permission']){
    const f=await demandFixture(t),s=f.create(),before=structuredClone(f.config.recovery);
    f.options.materialize=async observed=>({...f.result,previous_config_sha256:observed.expected.enable_demand.sha256});
    // Create a fresh service after replacing the injected native materializer.
    const next=createOmlxEnrollment({...f.options,materialize:async observed=>{
      if(change==='wrapper')fs.appendFileSync(f.prior.config,' ');
      if(change==='permission')f.enabled(false);
      return {...f.result,...(change==='profile'?{profile:'f'.repeat(64)}:{}),previous_config_sha256:observed.expected.enable_demand.sha256};
    }});
    const input=f.request();next.request(input);await next.idle();assert.equal(next.request(input).state,'failed');assert.deepEqual(f.config.recovery,before);
    assert.notEqual(f.recovery.config(f.worker.id).start_stopped,true);s.close();next.close();
  }
});

test('pending demand enrollment survives controller replacement under the same capture identity',async t=>{
  const f=await demandFixture(t);let release;
  const first=createOmlxEnrollment({...f.options,materialize:observed=>new Promise(resolve=>release=()=>resolve({...f.result,previous_config_sha256:observed.expected.enable_demand.sha256}))});
  const input=f.request();first.request(input);first.close();release();await first.idle();
  assert.equal(f.store.data.omlx_recovery_enrollments[input.action_id].state,'queued');assert.notEqual(f.recovery.config(f.worker.id).start_stopped,true);
  const next=f.create();next.tick();await next.idle();assert.equal(next.request(input).state,'enrolled');
  assert.equal(f.calls.at(-1).destination,path.join(f.directory,'genie','recovery-omlx-enrollment',input.action_id));
  assert.equal(Object.values(f.store.data.omlx_recovery_enrollments).filter(row=>row.demand_start).length,1);
});

test('demand binding invalidates prior qualification and requires a new native proof before start eligibility',async t=>{
  const {omlxCertified}=await import('./recovery-omlx-controller.mjs');
  const f=await demandFixture(t),r=f.recovery;
  r.nodes.push({id:'spare',healthy:true,drained:false,queue:[],active:null});f.config.machine_groups.spare=['spare-machine'];
  f.config.omlx_recovery_setup.workers[f.worker.id].qualify_restart=true;r.isOmlxQualificationEnabled=()=>true;
  let epoch='c'.repeat(32),proofs=0;
  r.call=async(c,input)=>input.action==='inspect'?{version:1,machine:c.machine,profile:c.profile,active:true,listener:true,instance:epoch,started_at:Date.now()-60000,fault:null}:
    {action_id:input.action_id,state:'completed',new_instance:epoch=epoch==='c'.repeat(32)?'d'.repeat(32):'e'.repeat(32)};
  r.verify=async()=>{proofs++;return {check:'glm53_omlx_two_conversations_cold_to_warm',context_length:400000,verified_at:new Date().toISOString(),samples:['cold-A','cold-B','warm-A','warm-B'].map((label,i)=>({label,prompt_tokens:20000+i*100,cached_tokens:i<2?0:14336,elapsed_ms:10}))};};
  r.reinstate=(n,expected,state)=>{f.store.save({...f.store.data,recovery:state});n.healthy=true;};
  async function qualify(){await r.inspect(f.worker.id);const offer=r.workerStatus(f.worker).omlx_qualification;assert.equal(offer.eligible,true);r.requestOmlxQualification({worker_id:f.worker.id,evidence_id:offer.evidence_id,action_id:randomUUID()});await r.task;}
  await qualify();assert.equal(omlxCertified(r,f.worker,r.config(f.worker.id)),true);assert.equal(proofs,1);
  const s=f.create();s.request(f.request());await s.idle();assert.equal(r.config(f.worker.id).start_stopped,true);
  assert.equal(omlxCertified(r,f.worker,r.config(f.worker.id)),false);await qualify();assert.equal(proofs,2);assert.equal(omlxCertified(r,f.worker,r.config(f.worker.id)),true);
  const restored={...f.config};delete restored.recovery;restoreOmlxEnrollments(restored,f.store.data.omlx_recovery_enrollments,r.nodes);
  const after=new Recovery(restored.recovery,{store:f.store,nodes:r.nodes,model:'PoolModel',stopping:()=>false,reinstate:r.reinstate,fleetConfig:restored,isOmlxQualificationEnabled:()=>true});
  assert.equal(omlxCertified(after,f.worker,after.config(f.worker.id)),true,'new binding and qualification must survive restoring both enrollment stages');
  await after.close();await r.close();
});
