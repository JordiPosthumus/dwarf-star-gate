import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {Recovery} from './recovery.mjs';
import {omlxRequest,omlxNativeRequestHash,omlxCertified} from './recovery-omlx-controller.mjs';

const proof=()=>({check:'glm53_omlx_two_conversations_cold_to_warm',context_length:400000,verified_at:new Date().toISOString(),
  samples:['cold-A','cold-B','warm-A','warm-B'].map((label,i)=>({label,prompt_tokens:20000+i*100,cached_tokens:i<2?0:14336,elapsed_ms:10}))});
async function fixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'omlx-demand-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const config={id:'local',url:'http://127.0.0.1:38001',adapter:'omlx',transport:'local',python:'/fixture/python',helper:'/fixture/recovery-omlx.py',
    config:'/fixture/omlx.json',machine:'a'.repeat(64),profile:'b'.repeat(64),service_profile:'b'.repeat(64),start_stopped:true,verification:'glm53_omlx',exclusive:true};
  const node={...config,healthy:true,drained:false,active:null,queue:[],contextLength:400000,max_concurrent_requests:1,quarantine:null};
  const alias={id:'alias',healthy:false,drained:true,queue:[],active:null},other={id:'other',healthy:true,drained:false,queue:[],active:null};
  const store={filename:path.join(dir,'state.json'),data:{},save(v){this.data=structuredClone(v);fs.writeFileSync(this.filename,JSON.stringify(v));}};
  let now=Date.now(),stopped=false,epoch='c'.repeat(32),demand=null,finish=true,receipt=null,hook=()=>{},verifications=0;
  const calls=[];
  const policy={exclusive:true,qualify_restart:true,start_on_demand:true};
  const sample=()=>({version:1,machine:config.machine,profile:config.profile,service_profile:config.profile,loaded:true,stopped,
    active:!stopped,listener:!stopped,pid:stopped?0:1234,instance:stopped?'':epoch,started_at:now-60000,stopped_epoch:'e'.repeat(64),fault:null});
  let recovery;
  const deps={store,nodes:[node,alias,other],model:'fixture',stopping:()=>false,now:()=>now,isOmlxQualificationEnabled:()=>true,omlxDemand:()=>demand,
    fleetConfig:{control_socket:path.join(dir,'control.sock'),machine_groups:{local:['one'],alias:['one'],other:['two']},omlx_recovery_setup:{workers:{local:policy}}},
    call:async(c,input)=>{
      if(input.action==='inspect')return sample();
      calls.push(structuredClone(input));hook(input);
      if(input.action==='transaction-status')return receipt??{state:'not_found',action_id:input.action_id};
      assert.ok(['transaction','start-transaction'].includes(input.action),'no legacy start or stop command');
      if(finish){stopped=false;epoch=input.action==='transaction'?'d'.repeat(32):'f'.repeat(32);}
      const op=recovery.state.operations.at(-1);
      receipt={state:finish?'completed':'waiting_for_ownership',phase:finish?'completed':'stopped',action_id:input.action_id,
        request_hash:omlxNativeRequestHash(recovery,op),...(finish?{new_instance:epoch}:{})};
      return receipt;
    },
    verify:async()=>{verifications++;assert.equal(node.recovering,true);return proof();},
    reinstate:(n,expected,state)=>{assert.deepEqual(n.quarantine,expected);if(n.queue.length)assert.equal(recovery.omlxReadmissionOwnsQueue(n,state),true);store.save({...store.data,recovery:state});n.healthy=true;n.quarantine=null;}};
  recovery=new Recovery({workers:[config]},deps);store.save({recovery:{...recovery.state,automatic:true}});
  t.after(async()=>recovery.close());
  await recovery.inspect(node.id);
  const offer=recovery.workerStatus(node).omlx_qualification;
  recovery.requestOmlxQualification({worker_id:node.id,evidence_id:offer.evidence_id,action_id:randomUUID()});await recovery.task;
  assert.equal(recovery.state.operations[0].state,'recovered');
  assert.equal(omlxCertified(recovery,node,recovery.config(node.id)),true);
  calls.length=0;receipt=null;verifications=0;stopped=true;node.healthy=false;
  await recovery.inspect(node.id);now+=15001;await recovery.inspect(node.id);
  return {node,alias,other,store,config,policy,deps,calls,sample,get recovery(){return recovery;},get verifications(){return verifications;},
    demand(v=randomUUID()){demand=v;},finish(v){finish=v;},hook(v){hook=v;},receipt(v){receipt=v;},
    launchObserved(){stopped=false;epoch='f'.repeat(32);receipt={...receipt,state:'running',phase:'launch_observed',new_instance:epoch};},
    request(){const offer=recovery.workerStatus(node);return recovery.request({worker_id:node.id,evidence_id:offer.evidence_id,action_id:randomUUID()},'detector');},
    async tick(){await recovery.tick();await recovery.task;},async reconstruct(){await recovery.close();recovery=new Recovery({workers:[config]},deps);}};
}

test('stopped GLM stays stopped without demand; live demand starts once and verifies before readmission',async t=>{
  const f=await fixture(t);assert.equal(f.recovery.workerStatus(f.node).reason,'omlx_waiting_for_demand');await f.tick();assert.equal(f.calls.length,0);
  f.other.healthy=false;f.demand();await f.tick();
  const op=f.recovery.state.operations.at(-1);assert.equal(op.omlx_demand_start,true);assert.equal(op.state,'recovered');assert.equal(op.actor,'detector');
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].action,'start-transaction');assert.equal(f.verifications,1);
  assert.equal(f.alias.drained,true);assert.equal(f.alias.recovering,false);assert.equal(f.node.healthy,true);
  assert.equal(fs.statSync(op.qualification_backup).mode&0o077,0);await f.reconstruct();assert.equal(f.recovery.state.operations.at(-1).state,'recovered');
});

test('policy, prior qualification, native identity, ownership and operator pause each fence demand starts',async t=>{
  for(const change of [f=>f.policy.start_on_demand=false,f=>f.policy.exclusive=false,f=>f.recovery.isOmlxQualificationEnabled=()=>false,
    f=>f.store.data.recovery.automatic=false,f=>f.store.data.recovery.operations=[],f=>f.node.drained=true,
    f=>f.alias.healthy=true,f=>f.alias.active={id:'direct'},f=>f.alias.queue.push({id:'old'}),f=>f.node.contextLength=8192,
    f=>f.store.data.agent_control={holds:[{worker_id:f.alias.id}],maintenance_locks:[]},
    f=>f.recovery.observations.get(f.node.id).value.listener=true,f=>f.recovery.observations.get(f.node.id).value.pid=1234,
    f=>f.recovery.configs.set(f.node.id,{...f.recovery.config(f.node.id),start_stopped:false})]){
    const f=await fixture(t);f.demand();change(f);assert.equal(f.recovery.workerStatus(f.node).eligible,false);
    assert.throws(()=>f.request());assert.equal(f.calls.length,0);
  }
});

test('withdrawal before dispatch releases reservation without consuming stopped epoch',async t=>{
  const f=await fixture(t);f.demand();const execute=f.recovery.execute.bind(f.recovery);
  f.recovery.execute=async(...args)=>{f.demand(null);return execute(...args);};
  f.request();await f.recovery.task;const prior=f.recovery.state.operations.at(-1);
  assert.equal(prior.state,'failed');assert.equal(prior.omlx_reserved,false);assert.equal(f.calls.length,0);assert.equal(f.alias.recovering,false);
  f.recovery.execute=execute;f.demand();await f.tick();assert.equal(f.recovery.state.operations.at(-1).state,'recovered');assert.equal(f.calls.length,1);
});

test('after dispatch, lost demand only observes native status and retains exact operation across reconstruction',async t=>{
  const f=await fixture(t);f.demand();f.finish(false);f.request();await f.recovery.task;const accepted=f.recovery.state.operations.at(-1);
  f.demand(null);await f.reconstruct();await f.tick();
  assert.equal(f.calls.length,2);assert.equal(f.calls[1].action,'transaction-status');
  assert.equal(f.recovery.state.operations.at(-1).state,'waiting_for_ownership');assert.equal(f.alias.recovering,true);assert.equal(f.verifications,0);
  f.demand();f.finish(true);await f.tick();
  assert.equal(f.recovery.state.operations.at(-1).id,accepted.id);assert.equal(f.recovery.state.operations.at(-1).state,'recovered');
  assert.deepEqual(f.calls.filter(c=>c.action==='start-transaction')[0],f.calls.filter(c=>c.action==='start-transaction')[1]);
});

test('saved completion is observed after permission revocation; proof waits for restored permission without another launch',async t=>{
  const f=await fixture(t);f.demand();f.hook(input=>{if(input.action==='start-transaction'){f.policy.start_on_demand=false;f.demand(null);}});
  f.request();await f.recovery.task;assert.equal(f.verifications,0);assert.equal(f.recovery.state.operations.at(-1).state,'waiting_for_ownership');
  await f.reconstruct();await f.tick();assert.equal(f.calls.at(-1).action,'transaction-status');assert.equal(f.verifications,0);
  f.policy.start_on_demand=true;await f.tick();assert.equal(f.recovery.state.operations.at(-1).state,'recovered');assert.equal(f.verifications,1);
  assert.equal(f.calls.filter(c=>c.action==='start-transaction').length,1);
});

test('native post-launch observation can finish without the original client remaining connected',async t=>{
  const f=await fixture(t);f.demand();f.finish(false);f.request();await f.recovery.task;
  f.launchObserved();f.demand(null);f.finish(true);await f.tick();assert.equal(f.recovery.state.operations.at(-1).state,'recovered');assert.equal(f.verifications,1);
});

test('missing receipts, changed hashes and uncertain native outcomes never imply a second launch',async t=>{
  for(const type of ['missing','hash','uncertain','phase']){
    const f=await fixture(t);f.demand();f.finish(false);f.request();await f.recovery.task;const op=f.recovery.state.operations.at(-1);
    f.demand(null);f.receipt(type==='missing'?null:{state:type==='uncertain'?'uncertain':'completed',phase:type==='phase'?'stopped':type==='uncertain'?'launch_intent':'completed',
      action_id:op.id,new_instance:'f'.repeat(32),request_hash:type==='hash'?'0'.repeat(64):omlxNativeRequestHash(f.recovery,op)});
    await f.tick();assert.equal(f.calls.filter(c=>c.action==='start-transaction').length,1);assert.equal(f.node.healthy,false);assert.equal(f.alias.recovering,true);
    assert.equal(f.verifications,0);assert.equal(f.recovery.state.operations.at(-1).state,type==='missing'?'waiting_for_ownership':'reconciliation_needed');
  }
});

test('request binding hash matches the native Python protocol for Unicode and escaped socket paths',async t=>{
  const f=await fixture(t);f.demand();f.finish(false);f.request();await f.recovery.task;const op=f.recovery.state.operations.at(-1);
  f.deps.fleetConfig.control_socket='/tmp/\u00e9/\ud83c\udfac/\u007f/"sock\\name';
  const request={...omlxRequest(op),gateway_socket:f.deps.fleetConfig.control_socket};
  const expected=execFileSync('python3',['-c','import json,sys,hashlib;print(hashlib.sha256(json.dumps(json.load(sys.stdin),sort_keys=True).encode()).hexdigest())'],{input:JSON.stringify(request),encoding:'utf8'}).trim();
  assert.equal(omlxNativeRequestHash(f.recovery,op),expected);
});

test('real gateway demand waits through verified native start; disconnected clients grant no start authority',{timeout:20000},async t=>{
  const {createServer}=await import('node:http');
  const {createGateway}=await import('./gateway.mjs');
  const {recoveryConfig}=await import('./recovery-transport.mjs');
  const servers=[],requests=[];let stopped=false,epoch='c'.repeat(32),now=Date.now(),receipt;
  for(let i=0;i<2;i++){
    const server=createServer((req,res)=>{
      res.setHeader('content-type','application/json');
      if(req.method==='GET'){res.statusCode=i===0&&stopped?503:200;res.end(JSON.stringify({data:[{id:'fixture',max_model_len:400000}]}));return;}
      let raw='';req.on('data',chunk=>raw+=chunk);req.on('end',()=>{requests.push(JSON.parse(raw));res.end(JSON.stringify({choices:[{message:{role:'assistant',content:'fixture reply'},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1}}));});
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));servers.push(server);
  }
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'demand-http-')),url=i=>`http://127.0.0.1:${servers[i].address().port}`;
  const gateway=createGateway({host:'127.0.0.1',port:0,api_key:'none',model:'fixture',context_length:400000,
    nodes:[{id:'local',url:url(0)},{id:'other',url:url(1)}],machine_groups:{local:['one'],other:['two']},
    model_routes:{local:['local'],other:['other']},state_file:path.join(dir,'state.json'),control_socket:path.join(dir,'core.sock')});
  const address=await gateway.start();t.after(async()=>{await gateway.close();for(const s of servers){s.closeAllConnections();await new Promise(r=>s.close(r));}fs.rmSync(dir,{recursive:true,force:true});});
  const node=gateway.nodes[0],r=gateway.recovery;
  const c={id:'local',url:url(0),adapter:'omlx',transport:'local',python:'/fixture/python',helper:'/fixture/recovery-omlx.py',config:'/fixture/omlx.json',
    machine:'a'.repeat(64),profile:'b'.repeat(64),service_profile:'b'.repeat(64),start_stopped:true,verification:'glm53_omlx',exclusive:true};
  r.configs=recoveryConfig({workers:[c]});r.now=()=>now;r.fleetConfig.omlx_recovery_setup={workers:{local:{exclusive:true,qualify_restart:true,start_on_demand:true}}};r.setAutomatic(true);
  const calls=[];let verified=0;
  r.call=async(_c,input)=>{
    if(input.action==='inspect')return {version:1,machine:c.machine,profile:c.profile,service_profile:c.profile,loaded:true,stopped,active:!stopped,listener:!stopped,
      pid:stopped?0:1234,instance:stopped?'':epoch,started_at:now-60000,stopped_epoch:'e'.repeat(64),fault:null};
    calls.push(input);
    if(input.action==='transaction-status')return receipt;
    const {gateway_socket,...request}=input;assert.equal(gateway_socket,r.fleetConfig.control_socket);assert.equal(r.omlxPermit(request).allowed,true);
    stopped=false;epoch=input.action==='transaction'?'d'.repeat(32):'f'.repeat(32);
    receipt={state:'completed',phase:'completed',action_id:input.action_id,new_instance:epoch,request_hash:omlxNativeRequestHash(r,r.state.operations.at(-1))};return receipt;
  };
  r.verify=async()=>{assert.equal(requests.length,0,'inference must stay undispatched until proof');verified++;return proof();};
  await r.inspect(node.id);const offer=r.workerStatus(node).omlx_qualification;assert.equal(offer.eligible,true);
  r.requestOmlxQualification({worker_id:node.id,evidence_id:offer.evidence_id,action_id:randomUUID()});await r.task;calls.length=0;verified=0;
  stopped=true;node.healthy=false;await r.inspect(node.id);now+=15001;await r.inspect(node.id);
  const until=async predicate=>{const end=Date.now()+5000;while(!predicate()){if(Date.now()>end)throw Error('fixture condition unavailable');await new Promise(resolve=>setTimeout(resolve,10));}};
  const send=signal=>fetch(`http://127.0.0.1:${address.port}/v1/chat/completions`,{method:'POST',signal,headers:{authorization:'Bearer none','content-type':'application/json','x-dsg-model':'local'},body:JSON.stringify({model:'fixture',messages:[{role:'user',content:'keep queued body exactly once'}]})});
  const cancel=new AbortController(),aborted=send(cancel.signal).catch(error=>error.name);await until(()=>gateway.stats().continuity.waiting===1);
  assert.match(r.omlxDemand(node),/^[a-f0-9-]{36}$/);assert.equal(r.omlxDemand(gateway.nodes[1]),null,'explicit M3 demand must not authorize another worker');
  cancel.abort();assert.equal(await aborted,'AbortError');await until(()=>gateway.stats().continuity.waiting===0);await r.tick();await r.task;
  assert.equal(calls.length,0);assert.equal(r.omlxDemand(node),null);
  const responsePromise=send();await until(()=>gateway.stats().continuity.waiting===1);await r.tick();await r.task;
  assert.equal(r.state.operations.at(-1).state,'recovered');assert.equal(verified,1);
  const response=await responsePromise;assert.equal(response.status,200);await response.text();assert.equal(requests.length,1);
  assert.equal(requests[0].messages[0].content,'keep queued body exactly once');assert.equal(calls.filter(c=>c.action==='start-transaction').length,1);
});

test('lost start acknowledgement recovers from the saved completion without another dispatch',async t=>{
  const f=await fixture(t);f.demand();const native=f.recovery.call;
  f.recovery.call=async(c,input)=>{const result=await native(c,input);if(input.action==='start-transaction')throw Error('adapter_timeout');return result;};
  f.request();await f.recovery.task;assert.equal(f.recovery.state.operations.at(-1).state,'reconciling');assert.equal(f.verifications,0);
  f.demand(null);await f.reconstruct();await f.tick();assert.equal(f.recovery.state.operations.at(-1).state,'recovered');
  assert.equal(f.calls.filter(c=>c.action==='start-transaction').length,1);assert.equal(f.verifications,1);
});

test('demand permits reject changed tokens and reconstruction rejects malformed start journals',async t=>{
  const f=await fixture(t);f.demand();f.finish(false);f.request();await f.recovery.task;const op=f.recovery.state.operations.at(-1),input=omlxRequest(op);
  for(const change of [{demand_id:randomUUID()},{stopped_epoch:'0'.repeat(64)},{profile:'0'.repeat(64)},{canary:true},{instance:'f'.repeat(32)}])assert.equal(f.recovery.omlxPermit({...input,...change}).allowed,false);
  assert.equal(f.recovery.omlxPermit(input).allowed,true);
  f.store.data.recovery.operations.at(-1).service_action='restart';await assert.rejects(()=>f.reconstruct(),/Invalid oMLX/);
});
