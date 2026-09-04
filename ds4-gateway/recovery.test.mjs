import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Recovery} from './recovery.mjs';
import {classifySshFailure,recoveryConfig,systemdCall} from './recovery-transport.mjs';
import {verifyRecovery} from './recovery-verify.mjs';
import {Genie,briefing,parseGenieReview} from './genie.mjs';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createGateway} from './gateway.mjs';
import {workerControl} from './worker-client.mjs';
import {createDashboard} from './dashboard.mjs';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';

const config={id:'one',url:'http://127.0.0.1:39001',ssh:'test-host',adapter:'systemd-user',helper:'/opt/dsg/adapter.py',config:'/opt/dsg/private.json',machine:'a'.repeat(64),profile:'b'.repeat(64),exclusive:true};
function rig(options={}) {
  let time=1788390000000,instance='1'.repeat(32),restarts=0,proofs=0;
  const n={...config,healthy:false,drained:false,active:null,queue:[],contextLength:262144,quarantine:{at:new Date(time-1000).toISOString(),reason:'accelerator_checkpoint_failure',request_id:randomUUID()}};
  const store={data:{sessions:{}},save(next){this.data=structuredClone(next);}};
  const sample=()=>({version:1,machine:config.machine,profile:config.profile,active:true,listener:true,instance,started_at:time-100000,
    fault:instance==='1'.repeat(32)?{reason:'fatal_accelerator_error',at:time-1000}:null});
  const deps={store,nodes:[n],model:'deepseek-v4-flash',stopping:()=>false,now:()=>time,
    call:async(_c,r)=>{if(r.action==='restart'){restarts++;instance='2'.repeat(32);return {state:'issued'};}return sample();},
    verify:async()=>{proofs++;return {samples:[],verified_at:new Date(time).toISOString()};},
    reinstate:(node,expected,state)=>{assert.deepEqual(node.quarantine,expected);store.save({...store.data,recovery:state});node.quarantine=null;node.healthy=true;},...options};
  const recovery=new Recovery({workers:[config]},deps);
  return {recovery,n,store,deps,sample,get restarts(){return restarts;},get proofs(){return proofs;},advance(ms){time+=ms;},replace(){instance='2'.repeat(32);},
    async ready(){await recovery.tick();},input(){const s=recovery.workerStatus(n);return {worker_id:n.id,evidence_id:s.evidence_id,action_id:randomUUID()};}};
}
test('recovery defaults off; registered endpoints alone convey no recovery authority',()=>{
  const r=rig();assert.equal(r.recovery.status().automatic,false);assert.throws(()=>r.recovery.request(r.input(),'genie'),/off/);
  for(const patch of [{adapter:'launchd'},{helper:'/tmp/x;evil'},{machine:'unknown'},{shell:'reboot'}])assert.throws(()=>recoveryConfig({workers:[{...config,...patch}]}));
  assert.throws(()=>recoveryConfig({workers:[config,{...config,id:'two',url:'http://127.0.0.1:39002'}]}),/physical/);
});
test('SSH management failures become bounded reason classes without exposing transport text',()=>{
  const cases=[
    ['ssh: Could not resolve hostname worker.example: nodename nor servname provided','adapter_dns_failure'],
    ['Host key verification failed.','adapter_host_key_failure'],
    ['user@secret: Permission denied (publickey).','adapter_auth_failure'],
    ['ssh: connect to host 192.0.2.8 port 22: Operation timed out','adapter_connect_timeout'],
    ['ssh: connect to host 192.0.2.8 port 22: Connection refused','adapter_connection_refused'],
    ['ssh: connect to host 192.0.2.8 port 22: No route to host','adapter_route_unreachable'],
    ['Connection reset by peer','adapter_connection_reset']];
  for(const [message,reason] of cases)assert.equal(classifySshFailure(message),reason);
  assert.equal(classifySshFailure('ordinary warning'),null);
  assert.equal(classifySshFailure('',null,255),'adapter_unreachable');
  assert.equal(classifySshFailure('',null,1),'adapter_check_failed');
  assert.equal(classifySshFailure('','ENOENT'),'adapter_spawn_failed');
});
test('recovery inspection tries bounded SSH aliases in order and returns no route names',async()=>{
  const calls=[];
  const spawnFn=(_file,args)=>{
    const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();child.kill=()=>{};
    const target=args.at(-2);calls.push(target);
    setImmediate(()=>{
      if(target==='primary'){child.stderr.write('Could not resolve hostname private-primary');child.emit('exit',255,null);}
      else {child.stdout.write(JSON.stringify({version:1,active:true}));child.emit('exit',0,null);}
    });
    return child;
  };
  const result=await systemdCall({...config,ssh:'primary',ssh_fallbacks:['backup']},{action:'inspect'},{spawnFn,timeoutMs:1000});
  assert.deepEqual(calls,['primary','backup']);assert.deepEqual(result,{version:1,active:true});
  assert.ok(!JSON.stringify(result).includes('primary'));assert.ok(!JSON.stringify(result).includes('backup'));
});
test('recovery status preserves only an allowlisted management failure reason',async()=>{
  const r=rig({call:async()=>{throw new Error('adapter_dns_failure');}});await r.ready();
  assert.equal(r.recovery.workerStatus(r.n).reason,'adapter_dns_failure');
  r.recovery.call=async()=>{throw new Error('worker.example leaked detail');};await r.ready();
  assert.equal(r.recovery.workerStatus(r.n).reason,'adapter_check_failed');
  assert.ok(!JSON.stringify(r.recovery.status()).includes('worker.example'));
});
test('fatal recovery persists before restart, verifies real checks before reinstatement, and is idempotent',async()=>{
  const r=rig();await r.ready();const input=r.input();let intent=false;
  const call=r.recovery.call;r.recovery.call=async(c,v)=>{if(v.action==='restart')intent=r.store.data.recovery.operations[0].restart_issued;return call(c,v);};
  const receipt=r.recovery.request(input);assert.equal(receipt.state,'queued');assert.equal(r.n.healthy,false);
  await r.recovery.task;assert.equal(intent,true);assert.equal(r.restarts,1);assert.equal(r.proofs,1);assert.equal(r.n.healthy,true);
  assert.equal(r.recovery.status().operations[0].state,'recovered');
  assert.equal(r.recovery.request(input).id,receipt.id);assert.equal(r.restarts,1);
  assert.throws(()=>r.recovery.request({...input,worker_id:'other'}),/conflict/);
});
test('healthy long reasoning, queues, operator pause, missing fatal evidence and stale identity cannot restart',async()=>{
  const cases=[n=>n.quarantine=null,n=>n.active={thinking:'xhigh'},n=>n.queue.push({}),n=>n.drained=true,n=>n.ssh='different-host'];
  for(const mutate of cases){const r=rig();await r.ready();mutate(r.n);assert.throws(()=>r.recovery.request(r.input()));assert.equal(r.restarts,0);}
  for(const patch of [{fault:null},{machine:'c'.repeat(64)},{profile:'c'.repeat(64)},{listener:false},{active:false}]){
    const r=rig();r.recovery.call=async()=>({...r.sample(),...patch});await r.ready();assert.throws(()=>r.recovery.request(r.input()));assert.equal(r.restarts,0);
  }
  const r=rig();await r.ready();assert.throws(()=>r.recovery.request({...r.input(),evidence_id:'invented'}),/evidence/);
  r.advance(90001);assert.throws(()=>r.recovery.request(r.input()),/inspection/);
});
test('one fleet recovery; cooldown and same-instance attempt guard prevent restart loops',async()=>{
  const r=rig();await r.ready();r.recovery.request(r.input());assert.throws(()=>r.recovery.request(r.input()),/progress/);await r.recovery.task;
  r.n.quarantine={at:new Date(r.deps.now()).toISOString(),reason:'accelerator_checkpoint_failure',request_id:randomUUID()};
  r.recovery.call=async()=>({...r.sample(),fault:{at:r.deps.now(),reason:'fatal_accelerator_error'}});await r.ready();
  assert.equal(r.recovery.workerStatus(r.n).reason,'recovery_cooldown');assert.equal(r.restarts,1);
});
test('operator pause during verification wins and survives subsequent stage updates',async()=>{
  const r=rig();await r.ready();r.recovery.verify=async()=>{r.n.drained=true;r.recovery.operatorPause([r.n.id]);return {samples:[]};};
  r.recovery.request(r.input());await r.recovery.task;
  assert.equal(r.recovery.status().operations[0].state,'verified_paused');assert.equal(r.recovery.status().operations[0].operator_override,true);
  assert.ok(r.n.quarantine);assert.equal(r.n.healthy,false);
});
test('verification failure never clears quarantine',async()=>{
  const r=rig({verify:async()=>{throw new Error('verification_warm_cache_not_proven');}});await r.ready();r.recovery.request(r.input());await r.recovery.task;
  assert.equal(r.recovery.status().operations[0].state,'failed');assert.ok(r.n.quarantine);assert.equal(r.n.healthy,false);
});
test('lost restart acknowledgment reconciles new instance without a second restart',async()=>{
  const r=rig();const call=r.recovery.call;r.recovery.call=async(c,v)=>{const result=await call(c,v);if(v.action==='restart')throw new Error('adapter_timeout');return result;};
  await r.ready();r.recovery.request(r.input());await r.recovery.task;assert.equal(r.restarts,1);assert.equal(r.recovery.status().operations[0].state,'recovered');
});
test('profile drift between proposal and execution fails without touching service',async()=>{
  const r=rig();await r.ready();r.recovery.call=async()=>({...r.sample(),profile:'c'.repeat(64)});
  r.recovery.request(r.input());await r.recovery.task;assert.equal(r.restarts,0);assert.equal(r.recovery.status().operations[0].state,'failed');
});
test('automatic detector uses same runner; disabling stops new automatic requests',async()=>{
  const r=rig();r.recovery.setAutomatic(true);await r.ready();await r.recovery.task;
  assert.equal(r.restarts,1);assert.equal(r.recovery.status().operations[0].actor,'detector');
  r.recovery.setAutomatic(false);assert.throws(()=>r.recovery.request(r.input(),'genie'),/off/);
});
test('healthy replacement already started after the fault is verified without a redundant restart',async()=>{
  const r=rig();r.replace();r.recovery.call=async()=>({...r.sample(),started_at:r.deps.now()+1});await r.ready();r.recovery.request(r.input());await r.recovery.task;
  assert.equal(r.restarts,0);assert.equal(r.proofs,1);assert.equal(r.recovery.status().operations[0].state,'recovered');
});
test('controller restart resumes verification, never repeats an issued restart',async()=>{
  const r=rig();await r.ready();r.recovery.request(r.input());await r.recovery.task;
  const op=r.store.data.recovery.operations[0];op.state='restarting';r.n.quarantine=op.quarantine;r.n.healthy=false;
  const resumed=new Recovery({workers:[config]},r.deps);assert.equal(r.n.recovering,true);await resumed.tick();await resumed.task;
  assert.equal(r.restarts,1);assert.equal(resumed.status().operations[0].state,'recovered');
});
test('operator canary requires pause, remains paused afterward and is not available to Genie',async()=>{
  const r=rig();r.n.quarantine=null;await r.ready();assert.throws(()=>r.recovery.request(r.input(),'operator',{canary:true}),/drain/);
  r.n.drained=true;r.recovery.request(r.input(),'operator',{canary:true});await r.recovery.task;
  assert.equal(r.restarts,1);assert.equal(r.n.drained,true);assert.equal(r.recovery.status().operations[0].state,'verified_paused');
});
test('current recovery worker status follows resume and later faults without rewriting historical receipts',async()=>{
  const r=rig();r.n.quarantine=null;await r.ready();r.n.drained=true;
  r.recovery.request(r.input(),'operator',{canary:true});await r.recovery.task;
  const receipt=structuredClone(r.recovery.status().operations[0]);
  assert.equal(r.recovery.workerStatus(r.n).state,'paused');
  r.n.drained=false;r.n.healthy=true;
  assert.equal(r.recovery.workerStatus(r.n).state,'monitoring');
  assert.equal(r.recovery.workerStatus(r.n).last_action.state,'verified_paused');
  r.n.healthy=false;assert.equal(r.recovery.workerStatus(r.n).state,'unavailable');
  r.n.quarantine={reason:'accelerator_checkpoint_failure'};
  assert.equal(r.recovery.workerStatus(r.n).state,'quarantined');
  r.n.recovering=true;assert.equal(r.recovery.workerStatus(r.n).state,'recovering');
  assert.deepEqual(r.recovery.status().operations[0],receipt);
});
test('generation/cache verifier checks exact outputs, usage, context and both cold-to-warm prefixes',async()=>{
  let count=0;const bodies=[];
  const fake=async(url,options)=>{
    if(url.pathname==='/v1/models')return Response.json({data:[{id:'ds4',context_length:262144}]});
    const body=JSON.parse(options.body);bodies.push(body);const labels=['CHECK_A_OK','CHECK_B_OK','WARM_A_OK','WARM_B_OK'];
    const i=count++;return Response.json({choices:[{finish_reason:'stop',message:{content:labels[i]}}],usage:{prompt_tokens:2200+i*10,prompt_tokens_details:{cached_tokens:i<2?0:2190}}});
  };
  const proof=await verifyRecovery('http://127.0.0.1:39001','ds4',262144,{fetchImpl:fake});
  assert.equal(proof.samples.length,4);assert.equal(bodies[0].max_tokens,32);assert.equal(bodies[0].thinking.type,'disabled');
  count=0;await assert.rejects(verifyRecovery('http://127.0.0.1:39001','ds4',131072,{fetchImpl:fake}),/context/);
  for(const mutate of [r=>r.usage.prompt_tokens_details.cached_tokens=0,r=>r.choices[0].finish_reason='length',r=>r.choices[0].message.content='WRONG']){
    count=0;await assert.rejects(verifyRecovery('http://127.0.0.1:39001','ds4',262144,{fetchImpl:async(u,o)=>{
      const response=await fake(u,o);if(u.pathname==='/v1/models')return response;const data=await response.json();mutate(data);return Response.json(data);
    }}));
  }
});
test('Genie can request offered recovery; invented evidence, shell fields and disabled policy are rejected',async()=>{
  const offer={worker_id:'one',evidence_id:'a'.repeat(64)},snapshot={time:Date.now(),devices:[],events:[],gateway:{workers:[],recovery:{automatic:true,workers:[{...offer,eligible:true}]}}};
  const answer={assessment:'Request recovery of the evidenced fatal worker.',ticker:[{severity:'warning',text:'Worker one has a fatal fault.',recommendation:'Verify recovery.',evidence_refs:['fleet']}],recovery_requests:[offer]};
  const evidence=briefing(snapshot);assert.equal(parseGenieReview(JSON.stringify(answer),evidence).recovery_requests.length,1);
  for(const request of [{...offer,command:'reboot'},{...offer,evidence_id:'invented'},{...offer,worker_id:'other'}])assert.equal(parseGenieReview(JSON.stringify({...answer,recovery_requests:[request]}),evidence).recovery_requests.length,0);
  let sent;const g=new Genie({url:'http://127.0.0.1:39000/v1'},()=>snapshot,{fetchImpl:async()=>Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(answer)}}]}),recover:async input=>{sent=input;return {id:input.action_id,worker_id:input.worker_id,state:'queued'};}});
  g.setEnabled(true);await g.ask();assert.equal(sent.worker_id,'one');assert.equal(g.status().reports[0].actions_taken[0].state,'queued');
  snapshot.gateway.recovery.automatic=false;sent=null;await g.ask();assert.equal(sent,null);g.close();
});
test('full HTTP quarantine → local recovery → two cold/warm checks → durable reinstatement; no LAN action route',async t=>{
  let broken=true,instance='1'.repeat(32),restarts=0,calls=0;
  const backend=http.createServer((req,res)=>{
    res.setHeader('content-type','application/json');
    if(req.url==='/v1/models')return res.end(JSON.stringify({data:[{id:'ds4',context_length:262144}]}));
    let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{
      if(broken){res.statusCode=500;return res.end(JSON.stringify({error:{message:'cuda resumed prefill failed while extending checkpoint'}}));}
      const input=JSON.parse(raw),last=input.messages.at(-1).content,match=last.match(/(?:CHECK|WARM)_[AB]_OK/);calls++;
      res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:match?.[0]}}],usage:{prompt_tokens:2200,prompt_tokens_details:{cached_tokens:last.includes('WARM_')?2190:0}}}));
    });
  });
  await new Promise(r=>backend.listen(0,'127.0.0.1',r));
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dsg-recovery-test-')),url=`http://127.0.0.1:${backend.address().port}`,socket=path.join(dir,'control.sock');
  const gateway=createGateway({host:'127.0.0.1',port:0,model:'ds4',api_key:'none',context_length:262144,nodes:[{id:'one',url}],state_file:path.join(dir,'state.json'),control_socket:socket});
  const address=await gateway.start();t.after(async()=>{await gateway.close();backend.closeAllConnections();await new Promise(r=>backend.close(r));fs.rmSync(dir,{recursive:true,force:true});});
  // In-process fake adapter; no SSH process or real model service is involved.
  gateway.nodes[0].ssh=config.ssh;gateway.recovery.configs=recoveryConfig({workers:[{...config,url}]});
  gateway.recovery.call=async(_c,input)=>{
    if(input.action==='restart'){restarts++;broken=false;instance='2'.repeat(32);return {state:'issued'};}
    return {version:1,machine:config.machine,profile:config.profile,active:true,listener:true,instance,started_at:Date.now()-600000,fault:broken?{reason:'fatal_accelerator_error',at:Date.now()}:null};
  };
  const base=`http://127.0.0.1:${address.port}`,headers={authorization:'Bearer none','content-type':'application/json'};
  const failed=await fetch(base+'/v1/chat/completions',{method:'POST',headers,body:'{}'});await failed.text();assert.equal(failed.status,500);
  await gateway.recovery.tick();let registry=await workerControl(socket,'/workers');const offer=registry.recovery.workers[0];assert.equal(offer.eligible,true);
  const publicMutation=await fetch(base+'/recover-worker',{method:'POST',headers,body:JSON.stringify({worker_id:'one',evidence_id:offer.evidence_id})});assert.ok(publicMutation.status>=400);await publicMutation.text();
  const action=await workerControl(socket,'/recover-worker',{worker_id:'one',evidence_id:offer.evidence_id});await gateway.recovery.task;
  registry=await workerControl(socket,'/workers');assert.equal(registry.workers[0].quarantine,null);assert.equal(registry.workers[0].is_healthy,true);
  assert.equal(restarts,1);assert.equal(calls,4);assert.equal(registry.recovery.operations[0].id,action.id);assert.equal(registry.recovery.operations[0].state,'recovered');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'state.json'))).recovery.operations[0].proof.samples.length,4);
});
test('dashboard recovery policy and action controls require CSRF; canary has no browser route',async t=>{
  const calls=[],server=createDashboard(()=>({}),undefined,{read:async()=>({}),act:async(action,input)=>{calls.push({action,input});return {accepted:true};}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close();});
  const base=`http://127.0.0.1:${server.address().port}`,token=(await(await fetch(base+'/api/workers')).json()).csrf_token;
  for(const action of ['recover','recovery-policy','recovery-recheck']) {
    let res=await fetch(`${base}/api/workers/${action}`,{method:'POST',headers:{'content-type':'application/json'},body:'{}'});assert.equal(res.status,403);await res.text();
    res=await fetch(`${base}/api/workers/${action}`,{method:'POST',headers:{origin:base,'content-type':'application/json','x-dsg-csrf':token},body:'{}'});assert.equal(res.status,200);await res.text();
  }
  assert.equal(calls.length,3);const res=await fetch(base+'/api/workers/recovery-canary',{method:'POST'});assert.equal(res.status,405);await res.text();
});
