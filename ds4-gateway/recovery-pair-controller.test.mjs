import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {Recovery} from './recovery.mjs';
import {pairRequest,pairBinding,pairCertified} from './recovery-pair-controller.mjs';
import {recoveryConfig,recoveryCall} from './recovery-transport.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {createGateway} from './gateway.mjs';
import {workerControl} from './worker-client.mjs';

const config={id:'custom-pair',url:'http://127.0.0.1:38001',ssh:'fixture-head',remote_port:8000,adapter:'docker-pair',transport:'local',
  python:'/fixture/python',helper:'/fixture/recovery-pair.py',config:'/fixture/pair.json',machine:'a'.repeat(64),profile:'b'.repeat(64),
  pair_config_sha256:'c'.repeat(64),verification:'glm53_vllm',exclusive:true};
const proof=()=>({check:'glm53_vllm_two_conversations_cold_to_warm',context_length:400000,verified_at:new Date().toISOString(),
  samples:['cold-A','cold-B','warm-A','warm-B'].map((label,i)=>({label,prompt_tokens:20000+i*100,cached_tokens:i<2?0:14336,elapsed_ms:10}))});
function fixture(){
  const now=Date.now(),store={data:{},save(value){this.data=structuredClone(value);}};
  const node={...config,healthy:false,drained:false,active:null,queue:[],max_concurrent_requests:2,contextLength:400000,
    quarantine:{at:new Date(now-1000).toISOString(),reason:'fatal_accelerator_error'}};
  const alias={id:'member-alias',healthy:false,drained:true,active:null,queue:[]},other={id:'other',healthy:true,drained:false,active:null,queue:[]};
  let epoch='d'.repeat(64),complete=false,verifyCount=0,hook=null;
  const calls=[];
  const sample=()=>({version:1,machine:config.machine,profile:config.profile,service_profile:config.profile,active:true,listener:true,
    instance:epoch.slice(0,32),pair_epoch:epoch,started_at:now-100000,context_length:400000,concurrency:2,
    fault:epoch==='d'.repeat(64)?{reason:'fatal_accelerator_error',at:now-1000}:null});
  const deps={store,nodes:[node,alias,other],model:'fixture-model',stopping:()=>false,
    fleetConfig:{machine_groups:{'custom-pair':['host-a','host-b'],'member-alias':['host-b'],other:['host-c']}},
    call:async(c,input)=>{if(input.action==='inspect')return sample();calls.push(structuredClone(input));if(hook)hook(input);
      if(!complete)return {action_id:input.action_id,state:'running'};
      epoch='e'.repeat(64);return {action_id:input.action_id,state:'completed',final_epoch:epoch};},
    verify:async()=>{verifyCount++;return proof();},
    reinstate:(n,expected,state)=>{assert.deepEqual(n.quarantine,expected);store.save({...store.data,recovery:state});n.quarantine=null;n.healthy=true;}};
  let recovery=new Recovery({workers:[config]},deps);
  const certification={id:randomUUID(),worker_id:node.id,actor:'operator',canary:true,was_paused:true,service_action:'restart',state:'verified_paused',
    service_action_issued:true,pair_dispatched:true,pair_transaction_completed:true,pair_reserved:false,pair_epoch:'8'.repeat(64),pair_final_epoch:'9'.repeat(64),
    new_instance:'9'.repeat(32),instance:'8'.repeat(32),pair_enrollment:pairBinding(recovery,recovery.config(node.id)),context_length:400000,pair_concurrency:2,
    created_at:now-3600000,updated_at:now-3600000,proof:proof()};
  store.data.recovery={...recovery.state,operations:[certification]};
  return {node,alias,other,store,deps,calls,sample,get recovery(){return recovery;},get verifyCount(){return verifyCount;},
    complete(){complete=true;},hook(value){hook=value;},changeEpoch(){epoch='f'.repeat(64);},
    async ready(){await recovery.tick();},async resume(){await recovery.tick();await recovery.task;},
    async request(options={}){const row=recovery.workerStatus(node);const result=recovery.request({worker_id:node.id,evidence_id:row.evidence_id,action_id:randomUUID()},'operator',options);await recovery.task;return result.id;},
    async reconstruct(){await recovery.close();recovery=new Recovery({workers:[config]},deps);return recovery;}};
}

test('paired enrollment is explicit, pinned, local and requires GLM verification',()=>{
  assert.equal(recoveryConfig({workers:[config]}).get(config.id).adapter,'docker-pair');
  for(const patch of [{transport:'ssh'},{verification:'qwen_vllm'},{pair_config_sha256:undefined},{python:'relative'}])
    assert.throws(()=>recoveryConfig({workers:[{...config,...patch}]}));
});

test('automatic pair recovery requires a completed exact native restart canary and a valid GLM proof',async()=>{
  const f=fixture();await f.ready();const cert=structuredClone(f.recovery.state.operations[0]);
  for(const patch of [{pair_transaction_completed:false},{pair_dispatched:false},{operator_override:true},{was_paused:false},
    {service_action:'start'},{pair_final_epoch:cert.pair_epoch},{pair_enrollment:'f'.repeat(64)},{pair_concurrency:1},
    {new_instance:'0'.repeat(32)},{proof:{...proof(),check:'qwen_vllm_two_conversations_cold_to_warm'}}]){
    f.store.data.recovery.operations=[{...cert,...patch}];
    assert.equal(f.recovery.workerStatus(f.node).reason,'pair_restart_canary_required');
    assert.throws(()=>f.recovery.request({worker_id:f.node.id,action_id:randomUUID()}),/canary_required/);
  }
  f.store.data.recovery.operations=[];f.node.drained=true;f.complete();await f.request({canary:true});
  assert.equal(pairCertified(f.recovery,f.node,f.recovery.config(f.node.id)),true);
  assert.equal(f.recovery.state.operations.at(-1).state,'verified_paused');await f.recovery.close();
});

test('controller resumes the same detached pair request after restart and admits only after native GLM proof',async()=>{
  const f=fixture();await f.ready();const id=await f.request();
  assert.equal(f.recovery.state.operations.at(-1).state,'reconciling');assert.equal(f.alias.recovering,true);assert.equal(f.node.recovering,true);
  assert.equal(f.verifyCount,0);assert.equal(f.calls.length,1);
  await f.reconstruct();assert.equal(f.alias.recovering,true);f.complete();await f.resume();
  const op=f.recovery.state.operations.at(-1);assert.equal(op.id,id);assert.equal(op.state,'recovered');assert.equal(op.pair_reserved,false);
  assert.deepEqual(f.calls[1],f.calls[0],'same durable action, epoch, profile and fault evidence');
  assert.equal(f.verifyCount,1);assert.equal(f.node.healthy,true);assert.equal(f.node.recovering,false);assert.equal(f.alias.recovering,false);assert.equal(f.alias.drained,true);
  await f.recovery.close();
});

test('native permits bind every request field and honor same-pair ownership, pauses and household availability',async()=>{
  const f=fixture();await f.ready();let checked=false;
  f.hook(input=>{
    checked=true;assert.equal(f.recovery.pairPermit(input).allowed,true);
    for(const [key,value] of [['epoch','f'.repeat(64)],['profile','f'.repeat(64)],['canary',true],['fault_after',0],['action_id',randomUUID()]])
      assert.equal(f.recovery.pairPermit({...input,[key]:value}).allowed,false);
    f.alias.slots=[{active:null},{active:{id:'second'}}];assert.equal(f.recovery.pairPermit(input).allowed,false);f.alias.slots=[];
    f.other.healthy=false;assert.equal(f.recovery.pairPermit(input).reason,'pair_other_llm_required');f.other.healthy=true;
    f.recovery.operatorPause([f.alias.id]);assert.equal(f.recovery.pairPermit(input).reason,'pair_operator_decision_changed');
  });
  await f.request();assert.equal(checked,true);f.hook(null);f.complete();await f.resume();
  assert.equal(f.calls.length,1,'operator pause prevents another runner dispatch');assert.equal(f.recovery.state.operations.at(-1).state,'waiting_for_ownership');
  await f.recovery.close();
});

test('temporary ownership holds retain the same operation and recover after they clear',async()=>{
  const f=fixture();await f.ready();await f.request();
  f.store.data.agent_control={holds:[{id:randomUUID(),worker_id:f.alias.id}],maintenance_locks:[]};
  await f.resume();assert.equal(f.calls.length,1);assert.equal(f.recovery.state.operations.at(-1).state,'waiting_for_ownership');
  f.store.data.agent_control.holds=[];f.complete();await f.resume();assert.equal(f.recovery.state.operations.at(-1).state,'recovered');assert.equal(f.calls.length,2);
  await f.recovery.close();
});

test('missing native observations never launch a runner; identity failures require reconciliation',async()=>{
  for(const error of ['adapter_connect_timeout','pair_identity_or_journal_unverified']){
    const f=fixture();await f.ready();const original=f.recovery.call;
    f.recovery.call=async()=>{throw Error(error);};await f.request();
    assert.equal(f.calls.length,0);assert.equal(f.recovery.state.operations.at(-1).state,error.startsWith('pair_')?'reconciliation_needed':'reconciling');
    assert.equal(f.alias.recovering,true);
    if(error.startsWith('adapter_')){f.recovery.call=original;f.complete();await f.resume();assert.equal(f.recovery.state.operations.at(-1).state,'recovered');}
    await f.recovery.close();
  }
});

test('a late maintenance hold retains proof and automatically re-verifies before readmission',async()=>{
  const f=fixture();await f.ready();f.complete();const real=f.deps.verify;
  f.recovery.verify=async()=>{const p=await real();f.store.data.agent_control={holds:[],maintenance_locks:[{id:randomUUID(),worker_id:f.alias.id}]};return p;};
  await f.request();let op=f.recovery.state.operations.at(-1);assert.equal(op.state,'waiting_for_ownership');assert.ok(op.proof);assert.equal(f.node.recovering,true);
  f.store.data.agent_control.maintenance_locks=[];f.recovery.verify=real;await f.resume();
  op=f.recovery.state.operations.at(-1);assert.equal(op.state,'recovered');assert.equal(f.verifyCount,2);await f.recovery.close();
});

test('wrong GLM proof or a peer-epoch change never readmits and keeps physical reservation',async()=>{
  for(const change of ['proof','epoch']){
    const f=fixture();await f.ready();f.complete();f.recovery.verify=async()=>{if(change==='epoch'){f.changeEpoch();return proof();}return {...proof(),check:'qwen_vllm_two_conversations_cold_to_warm'};};
    await f.request();assert.equal(f.recovery.state.operations.at(-1).state,'reconciliation_needed');assert.equal(f.node.healthy,false);assert.equal(f.alias.recovering,true);
    assert.equal(f.recovery.pairPermit(pairRequest(f.recovery.state.operations.at(-1))).allowed,false,'failed operations cannot authorize detached native steps');
    await f.reconstruct();assert.equal(f.alias.recovering,true);await f.recovery.close();
  }
});

test('canary preserves preexisting pause; pair recovery needs another physical LLM',async()=>{
  const f=fixture();await f.ready();f.other.healthy=false;assert.equal(f.recovery.workerStatus(f.node).reason,'pair_other_llm_required');
  f.other.healthy=true;f.node.drained=true;f.complete();await f.request({canary:true});
  assert.equal(f.recovery.state.operations.at(-1).state,'verified_paused');assert.equal(f.node.drained,true);assert.equal(f.node.healthy,false);assert.equal(f.alias.recovering,false);
  await f.recovery.close();
});

test('local pair transport accepts Linux and macOS, pins private file bytes and head binding before spawn',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pair-transport-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const helper=path.join(dir,'helper.py'),file=path.join(dir,'private.json');fs.writeFileSync(helper,'# fixture helper\n',{mode:0o600});
  const contents=JSON.stringify({schema:1,enrollment:{worker_id:config.id,port:8000,members:[{ssh:config.ssh}]}});fs.writeFileSync(file,contents,{mode:0o600});
  const c={...config,python:fs.realpathSync('/usr/bin/python3'),helper,config:file,pair_config_sha256:createHash('sha256').update(contents).digest('hex')};
  let spawns=0;
  const spawnFn=(program,args,options)=>{
    spawns++;assert.equal(program,c.python);assert.deepEqual(args,['-I',helper,file]);assert.equal(options.shell,false);
    const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();child.kill=()=>{};
    setImmediate(()=>{child.stdout.end('{"version":1}');child.emit('close',0);});return child;
  };
  for(const platform of ['linux','darwin'])assert.deepEqual(await recoveryCall(c,{action:'inspect'},{platform,spawnFn}),{version:1});
  for(const patch of [{pair_config_sha256:'f'.repeat(64)},{ssh:'different'},{remote_port:8001}])
    await assert.rejects(recoveryCall({...c,...patch},{action:'inspect'},{platform:'linux',spawnFn}),/identity.*unverified/);
  fs.appendFileSync(file,' ');await assert.rejects(recoveryCall(c,{action:'inspect'},{platform:'linux',spawnFn}),/identity.*unverified/);
  assert.equal(spawns,2);
});

test('direct HTTP pair keeps its serving route and uses the separately pinned native SSH binding',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pair-direct-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const helper=path.join(dir,'helper.py'),file=path.join(dir,'private.json');fs.writeFileSync(helper,'# fixture helper\n',{mode:0o600});
  const contents=JSON.stringify({schema:1,enrollment:{worker_id:config.id,port:8888,members:[{ssh:'native-head'}]}});fs.writeFileSync(file,contents,{mode:0o600});
  const {ssh,remote_port,...base}=config;
  const c=recoveryConfig({workers:[{...base,backend:'openai',url:'http://192.0.2.10:8888/v1',python:fs.realpathSync('/usr/bin/python3'),helper,config:file,
    pair_config_sha256:createHash('sha256').update(contents).digest('hex')}]}).get(config.id);
  assert.equal(c.ssh,undefined);assert.equal(c.url,'http://192.0.2.10:8888/v1');
  let spawns=0;
  const spawnFn=()=>{spawns++;const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();child.kill=()=>{};
    setImmediate(()=>{child.stdout.end('{"version":1}');child.emit('close',0);});return child;};
  assert.deepEqual(await recoveryCall(c,{action:'inspect'},{platform:'linux',spawnFn}),{version:1});
  await assert.rejects(recoveryCall({...c,url:'http://192.0.2.10:8889/v1'},{action:'inspect'},{platform:'linux',spawnFn}),/identity.*unverified/);
  fs.appendFileSync(file,' ');await assert.rejects(recoveryCall(c,{action:'inspect'},{platform:'linux',spawnFn}),/identity.*unverified/);
  assert.equal(spawns,1);
});

test('real private gateway socket grants only the active exact pair request; LAN never exposes permits',async t=>{
  const servers=[];
  for(let i=0;i<2;i++){
    const server=http.createServer((_req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{id:'fixture-model',context_length:400000,max_model_len:400000}]}));});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));servers.push(server);
  }
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pair-control-')),socket=path.join(dir,'gateway.sock');
  const url=i=>`http://127.0.0.1:${servers[i].address().port}`;
  const gateway=createGateway({host:'127.0.0.1',port:0,model:'fixture-model',api_key:'none',context_length:400000,
    machine_groups:{'custom-pair':['host-a','host-b'],other:['host-c']},
    nodes:[{id:'custom-pair',url:url(0),max_concurrent_requests:2},{id:'other',url:url(1)}],state_file:path.join(dir,'state.json'),control_socket:socket});
  const address=await gateway.start();
  t.after(async()=>{await gateway.close();for(const server of servers){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}fs.rmSync(dir,{recursive:true,force:true});});
  const node=gateway.nodes[0],{ssh,remote_port,...pairConfig}=config,c={...pairConfig,url:url(0)};
  gateway.recovery.configs=recoveryConfig({workers:[c]});
  node.quarantine={at:new Date().toISOString(),reason:'fatal_accelerator_error'};node.healthy=false;
  let epoch='d'.repeat(64),permit;
  gateway.recovery.call=async(_c,input)=>{
    if(input.action==='inspect')return {version:1,machine:c.machine,profile:c.profile,active:true,listener:true,instance:epoch.slice(0,32),pair_epoch:epoch,
      started_at:Date.now()-600000,context_length:400000,concurrency:2,fault:epoch==='d'.repeat(64)?{reason:'fatal_accelerator_error',at:Date.now()}:null};
    permit=await workerControl(socket,'/recovery-pair-permit',input);assert.equal(permit.allowed,true);
    assert.equal((await workerControl(socket,'/recovery-pair-permit',{...input,canary:!input.canary})).allowed,false);
    epoch='e'.repeat(64);return {state:'completed',action_id:input.action_id,final_epoch:epoch};
  };
  gateway.recovery.verify=async()=>proof();await gateway.recovery.tick();
  const status=gateway.recovery.workerStatus(node);assert.equal(status.reason,'pair_restart_canary_required');
  await workerControl(socket,'/drain-workers',{workers:[node.id]});
  const accepted=await workerControl(socket,'/recovery-canary',{worker_id:node.id});await gateway.recovery.task;
  assert.equal(gateway.recovery.state.operations.at(-1).state,'verified_paused');assert.equal(permit.action_id,accepted.id);
  assert.equal(pairCertified(gateway.recovery,node,gateway.recovery.config(node.id)),true);
  assert.equal((await workerControl(socket,'/recovery-pair-permit',pairRequest(gateway.recovery.state.operations.at(-1)))).allowed,false);
  const response=await fetch(`http://127.0.0.1:${address.port}/recovery-pair-permit`,{method:'POST',headers:{authorization:'Bearer none'},body:'{}'});
  assert.ok(response.status>=400);await response.text();
});
