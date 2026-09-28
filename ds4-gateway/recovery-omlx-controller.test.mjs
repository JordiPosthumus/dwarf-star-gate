import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Recovery} from './recovery.mjs';
import {omlxCertified,omlxRequest} from './recovery-omlx-controller.mjs';
import http from 'node:http';
import {createGateway} from './gateway.mjs';
import {workerControl} from './worker-client.mjs';
import {recoveryConfig} from './recovery-transport.mjs';

const config={id:'local-custom',url:'http://127.0.0.1:38001',adapter:'omlx',transport:'local',
  python:'/fixture/python',helper:'/fixture/recovery-omlx.py',config:'/fixture/omlx.json',machine:'a'.repeat(64),profile:'b'.repeat(64),
  verification:'glm53_omlx',exclusive:true};
const proof=()=>({check:'glm53_omlx_two_conversations_cold_to_warm',context_length:400000,verified_at:new Date().toISOString(),
  samples:['cold-A','cold-B','warm-A','warm-B'].map((label,i)=>({label,prompt_tokens:20000+i*100,cached_tokens:i<2?0:14336,elapsed_ms:10}))});
function fixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'omlx-controller-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const now=Date.now(),store={filename:path.join(dir,'state.json'),data:{},save(value){this.data=structuredClone(value);fs.writeFileSync(this.filename,JSON.stringify(value));}};
  const node={...config,healthy:true,drained:false,active:null,queue:[],max_concurrent_requests:1,contextLength:400000,quarantine:null};
  const alias={id:'alias',healthy:false,drained:true,active:null,queue:[]},other={id:'other',healthy:true,drained:false,active:null,queue:[]};
  let epoch='c'.repeat(32),complete=false,hook=null,verifications=0;
  const calls=[];
  const sample=()=>({version:1,machine:config.machine,profile:config.profile,service_profile:config.profile,active:true,listener:true,
    instance:epoch,started_at:now-600000,fault:null});
  const deps={store,nodes:[node,alias,other],model:'fixture',stopping:()=>false,isOmlxQualificationEnabled:()=>true,
    fleetConfig:{control_socket:path.join(dir,'control.sock'),machine_groups:{'local-custom':['one'],alias:['one'],other:['two']},
      omlx_recovery_setup:{workers:{'local-custom':{exclusive:true,qualify_restart:true}}}},
    call:async(c,input)=>{if(input.action==='inspect')return sample();calls.push(structuredClone(input));if(hook)hook(input);
      if(!complete)return {action_id:input.action_id,state:'running'};
      epoch='d'.repeat(32);return {action_id:input.action_id,state:'completed',new_instance:epoch};},
    verify:async(url,model,context,options)=>{assert.equal(options.kind,'glm53_omlx');verifications++;return proof();},
    reinstate:(n,expected,state)=>{assert.deepEqual(n.quarantine,expected);if(n.queue.length)assert.equal(recovery.omlxReadmissionOwnsQueue(n,state),true);
      store.save({...store.data,recovery:state});n.quarantine=null;n.healthy=true;}};
  let recovery=new Recovery({workers:[config]},deps);store.save({recovery:{...recovery.state,automatic:true}});
  t.after(async()=>recovery.close());
  return {node,alias,other,store,deps,calls,sample,dir,get recovery(){return recovery;},get verifications(){return verifications;},
    complete(){complete=true;},hook(fn){hook=fn;},changeEpoch(){epoch='e'.repeat(32);},
    async ready(){await recovery.tick();},async resume(){await recovery.tick();await recovery.task;},
    qualify(){const offer=recovery.workerStatus(node).omlx_qualification;return recovery.requestOmlxQualification({worker_id:node.id,evidence_id:offer.evidence_id,action_id:randomUUID()});},
    async reconstruct(){await recovery.close();recovery=new Recovery({workers:[config]},deps);}};
}

test('Genie qualification uses distinct GLM/oMLX proof, keeps launcher enrollment and certifies across reconstruction',async t=>{
  const f=fixture(t);await f.ready();const offer=f.recovery.workerStatus(f.node).omlx_qualification;
  assert.equal(offer.eligible,true);assert.match(offer.evidence_id,/^[a-f0-9]{64}$/);
  f.complete();const accepted=f.qualify();assert.equal(accepted.actor,'genie');assert.equal(accepted.omlx_qualification,true);await f.recovery.task;
  const op=f.recovery.state.operations.at(-1);assert.equal(op.state,'recovered');assert.equal(op.omlx_reserved,false);
  assert.equal(f.verifications,1);assert.equal(omlxCertified(f.recovery,f.node,f.recovery.config(f.node.id)),true);
  assert.equal(f.node.drained,false);assert.equal(f.alias.drained,true);assert.equal(f.node.recovering,false);assert.equal(f.alias.recovering,false);
  assert.equal(fs.statSync(op.qualification_backup).mode&0o077,0);assert.equal(f.recovery.config(f.node.id).start_stopped,undefined);
  const checklist=f.recovery.enrollmentChecklist(f.node);assert.equal(checklist.historical_canary.actor,'genie');assert.equal(checklist.historical_canary.enrolled_identity_fields_match,true);
  await f.reconstruct();assert.equal(f.recovery.workerStatus(f.node).omlx_qualification.certified,true);
});

test('existing active or waiting work, ownership holds, missing policy and absent spare LLM prevent qualification',async t=>{
  for(const change of [f=>f.node.queue.push({id:'old'}),f=>f.alias.queue.push({id:'old'}),f=>f.alias.slots=[{active:null},{active:{id:'active'}}],
    f=>f.node.drained=true,f=>f.other.healthy=false,f=>f.recovery.isOmlxQualificationEnabled=()=>false,
    f=>f.store.data.recovery.automatic=false,f=>f.deps.fleetConfig.omlx_recovery_setup.workers[f.node.id].qualify_restart=false,
    f=>f.deps.fleetConfig.omlx_recovery_setup.workers[f.node.id].exclusive=false,
    f=>f.store.data.agent_control={holds:[{worker_id:f.alias.id}],maintenance_locks:[]},f=>f.deps.fleetConfig.machine_groups[f.node.id]=['one','two']]){
    const f=fixture(t);await f.ready();change(f);assert.equal(f.recovery.workerStatus(f.node).omlx_qualification.eligible,false);
    assert.throws(()=>f.qualify());assert.equal(f.calls.length,0);
  }
});

test('later queued inference stays behind the exact physical reservation and does not deadlock recovery',async t=>{
  const f=fixture(t);await f.ready();const accepted=f.qualify();await f.recovery.task;
  f.node.queue.push({id:'later-genie-inference'});f.alias.queue.push({id:'later-alias-inference'});
  const op=f.recovery.state.operations.at(-1),input=omlxRequest(op);
  assert.equal(f.recovery.omlxPermit(input).allowed,true);
  assert.equal(f.recovery.ownershipReason(f.node,{operationId:op.id}),'wait_for_admitted_work','ordinary ownership still treats the queue as admitted work');
  await f.reconstruct();assert.equal(f.recovery.omlxPermit(input).allowed,true);f.complete();await f.resume();
  assert.equal(f.recovery.state.operations.at(-1).id,accepted.id);assert.equal(f.recovery.state.operations.at(-1).state,'recovered');
  assert.equal(f.node.queue[0].id,'later-genie-inference');assert.equal(f.alias.queue[0].id,'later-alias-inference');assert.deepEqual(f.calls[0],f.calls[1]);
});

test('queue exception cannot hide active slots, foreign reservations, direct work or maintenance holds',async t=>{
  const f=fixture(t);await f.ready();f.qualify();await f.recovery.task;
  const input=omlxRequest(f.recovery.state.operations.at(-1));f.node.queue.push({id:'later'});
  f.alias.slots=[{active:{id:'direct'}}];assert.equal(f.recovery.omlxPermit(input).allowed,false);f.alias.slots=[];
  f.alias.recoveryOperationId=randomUUID();assert.equal(f.recovery.omlxPermit(input).reason,'omlx_reservation_changed');f.alias.recoveryOperationId=input.action_id;
  f.store.data.agent_control={holds:[],maintenance_locks:[{worker_id:f.alias.id}]};assert.equal(f.recovery.omlxPermit(input).allowed,false);
  f.store.data.agent_control.maintenance_locks=[];
  const ownership=f.recovery.ownershipReason;f.recovery.ownershipReason=()=> 'native_work_reserved';assert.equal(f.recovery.omlxPermit(input).allowed,false);f.recovery.ownershipReason=ownership;
  assert.equal(f.recovery.omlxPermit(input).allowed,true);
  for(const patch of [{profile:'f'.repeat(64)},{instance:'f'.repeat(32)},{canary:false},{action_id:randomUUID()},{command:'bad'}])assert.equal(f.recovery.omlxPermit({...input,...patch}).allowed,false);
});

test('revoking policy during inspection prevents native dispatch and resumes the same operation after permission returns',async t=>{
  const f=fixture(t);await f.ready();const original=f.recovery.call;
  f.recovery.call=async(c,input)=>{if(input.action==='inspect')f.deps.fleetConfig.omlx_recovery_setup.workers[f.node.id].qualify_restart=false;return original(c,input);};
  const accepted=f.qualify();await f.recovery.task;assert.equal(f.calls.length,0);assert.equal(f.recovery.state.operations.at(-1).state,'waiting_for_ownership');
  f.recovery.call=original;f.deps.fleetConfig.omlx_recovery_setup.workers[f.node.id].qualify_restart=true;f.complete();await f.resume();
  assert.equal(f.recovery.state.operations.at(-1).id,accepted.id);assert.equal(f.recovery.state.operations.at(-1).state,'recovered');
});

test('late owner pause is retained and cannot count as automatic restart certification',async t=>{
  const f=fixture(t);await f.ready();f.complete();f.recovery.verify=async()=>{f.recovery.operatorPause([f.alias.id]);f.node.drained=true;return proof();};
  f.qualify();await f.recovery.task;assert.equal(f.recovery.state.operations.at(-1).state,'verified_paused');assert.equal(f.node.drained,true);
  assert.equal(f.node.recovering,false);assert.equal(omlxCertified(f.recovery,f.node,f.recovery.config(f.node.id)),false);
});

test('late holds retain proof and reservation and reverify under the same action after release',async t=>{
  const f=fixture(t);await f.ready();f.complete();const original=f.recovery.verify;
  f.recovery.verify=async(...args)=>{const result=await original(...args);f.store.data.agent_control={holds:[{worker_id:f.alias.id}],maintenance_locks:[]};return result;};
  f.qualify();await f.recovery.task;assert.equal(f.recovery.state.operations.at(-1).state,'waiting_for_ownership');assert.ok(f.recovery.state.operations.at(-1).proof);
  f.store.data.agent_control.holds=[];f.recovery.verify=original;await f.resume();assert.equal(f.recovery.state.operations.at(-1).state,'recovered');assert.equal(f.verifications,2);
});

test('wrong cache proof, changed epoch, native uncertainty and damaged identity retain reservation without readmission',async t=>{
  for(const type of ['proof','epoch','uncertain','identity']){
    const f=fixture(t);await f.ready();f.complete();const original=f.recovery.call;
    if(type==='proof')f.recovery.verify=async()=>({...proof(),check:'glm53_vllm_two_conversations_cold_to_warm'});
    if(type==='epoch')f.recovery.verify=async()=>{f.changeEpoch();return proof();};
    if(type==='uncertain')f.recovery.call=async(c,input)=>input.action==='inspect'?original(c,input):{action_id:input.action_id,state:'uncertain',reason:'omlx_transaction_launch_guard_changed'};
    if(type==='identity')f.recovery.call=async(c,input)=>{if(input.action!=='inspect')throw Error('omlx_transaction_journal_unverified');return original(c,input);};
    f.qualify();await f.recovery.task;const op=f.recovery.state.operations.at(-1);assert.equal(op.state,'reconciliation_needed',type);
    assert.equal(f.node.healthy,false);assert.equal(f.node.recovering,true);assert.equal(f.recovery.omlxPermit(omlxRequest(op)).allowed,false);
    await f.reconstruct();assert.equal(f.alias.recovering,true);
  }
});

test('reconstruction during proof resumes observation and verification, not a new action',async t=>{
  const f=fixture(t);await f.ready();f.qualify();await f.recovery.task;
  const op=f.recovery.state.operations.at(-1);f.store.data.recovery.operations[0]={...op,state:'verifying'};
  await f.reconstruct();f.complete();await f.resume();assert.equal(f.recovery.state.operations.at(-1).state,'recovered');
  assert.equal(f.recovery.state.operations.at(-1).id,op.id);assert.deepEqual(f.calls[0],f.calls[1]);
});

test('stale evidence, invented extra fields and failed metadata backup cannot reserve or dispatch',async t=>{
  const f=fixture(t);await f.ready();const offer=f.recovery.workerStatus(f.node).omlx_qualification;
  const input={worker_id:f.node.id,evidence_id:offer.evidence_id,action_id:randomUUID()};
  assert.throws(()=>f.recovery.requestOmlxQualification({...input,evidence_id:'f'.repeat(64)}),/evidence_changed/);
  assert.throws(()=>f.recovery.requestOmlxQualification({...input,gateway_socket:'/tmp/other'}),/request_invalid/);
  fs.unlinkSync(f.store.filename);assert.throws(()=>f.recovery.requestOmlxQualification(input),/ENOENT/);
  assert.equal(f.calls.length,0);assert.equal(f.node.recovering,undefined);assert.equal(f.recovery.state.operations.length,0);
});

test('private socket qualification and permits preserve a real waiting HTTP request until native proof readmission',{timeout:20000},async t=>{
  const servers=[],requests=[];
  for(let i=0;i<2;i++){
    const server=http.createServer((req,res)=>{
      res.setHeader('content-type','application/json');
      if(req.method==='GET'){res.end(JSON.stringify({data:[{id:'fixture',max_model_len:400000}]}));return;}
      let raw='';req.on('data',chunk=>raw+=chunk);req.on('end',()=>{requests.push({worker:i,body:JSON.parse(raw)});
        res.end(JSON.stringify({choices:[{message:{role:'assistant',content:'fixture reply'},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1}}));});
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));servers.push(server);
  }
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'omlx-ctl-')),socket=path.join(dir,'core.sock');
  const url=i=>`http://127.0.0.1:${servers[i].address().port}`;
  const gateway=createGateway({host:'127.0.0.1',port:0,api_key:'none',model:'fixture',context_length:400000,
    nodes:[{id:'local-custom',url:url(0)},{id:'other',url:url(1)}],machine_groups:{'local-custom':['one'],other:['two']},
    model_routes:{local:['local-custom']},state_file:path.join(dir,'state.json'),control_socket:socket});
  const address=await gateway.start();
  t.after(async()=>{await gateway.close();for(const server of servers){server.closeAllConnections();await new Promise(r=>server.close(r));}fs.rmSync(dir,{recursive:true,force:true});});
  const node=gateway.nodes[0],c={...config,url:url(0)};gateway.recovery.configs=recoveryConfig({workers:[c]});
  gateway.recovery.fleetConfig.omlx_recovery_setup={workers:{[node.id]:{exclusive:true,qualify_restart:true}}};
  gateway.store.save({...gateway.store.data,recovery:{...gateway.recovery.state,automatic:true}});
  let epoch='c'.repeat(32),complete=false,permit;
  gateway.recovery.call=async(_c,input)=>{
    if(input.action==='inspect')return {version:1,machine:c.machine,profile:c.profile,instance:epoch,active:true,listener:true,started_at:Date.now()-600000,fault:null};
    const {gateway_socket,...request}=input;assert.equal(gateway_socket,socket);
    permit=await workerControl(socket,'/recovery-omlx-permit',request);assert.equal(permit.allowed,true);
    if(!complete)return {state:'running',action_id:input.action_id};
    epoch='d'.repeat(32);return {state:'completed',action_id:input.action_id,new_instance:epoch};
  };
  gateway.recovery.verify=async()=>{assert.equal(requests.length,0,'waiting inference cannot dispatch during verification');return proof();};
  await gateway.recovery.inspect(node.id);
  const offer=gateway.recovery.workerStatus(node).omlx_qualification;assert.equal(offer.eligible,true);
  const accepted=await workerControl(socket,'/qualify-omlx-recovery',{worker_id:node.id,action_id:randomUUID(),evidence_id:offer.evidence_id});await gateway.recovery.task;
  assert.equal(accepted.omlx_qualification,true);assert.equal(permit.action_id,accepted.id);
  const responsePromise=fetch(`http://127.0.0.1:${address.port}/v1/chat/completions`,{method:'POST',headers:{authorization:'Bearer none','content-type':'application/json','x-dsg-model':'local','x-ds4-session-id':'genie-waiting'},body:JSON.stringify({model:'fixture',messages:[{role:'user',content:'preserve this request'}]})});
  const until=async predicate=>{const limit=Date.now()+5000;while(!predicate()){if(Date.now()>limit)throw Error('fixture waiting state unavailable');await new Promise(r=>setTimeout(r,10));}};
  await until(()=>node.queue.length||gateway.stats().continuity.waiting);
  assert.equal(requests.length,0);complete=true;await gateway.recovery.tick();await gateway.recovery.task;
  assert.equal(gateway.recovery.state.operations.at(-1).state,'recovered');
  const response=await responsePromise;assert.equal(response.status,200);assert.equal(response.headers.get('x-ds4-node'),node.id);await response.text();
  assert.equal(requests.length,1);assert.equal(requests[0].body.messages[0].content,'preserve this request');
  assert.equal((await workerControl(socket,'/recovery-omlx-permit',omlxRequest(gateway.recovery.state.operations.at(-1)))).allowed,false);
  for(const route of ['/qualify-omlx-recovery','/recovery-omlx-permit']){
    const denied=await fetch(`http://127.0.0.1:${address.port}${route}`,{method:'POST',headers:{authorization:'Bearer none'},body:'{}'});assert.ok(denied.status>=400);await denied.text();
  }
});
