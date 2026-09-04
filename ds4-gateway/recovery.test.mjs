import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Recovery} from './recovery.mjs';
import {AgentControl} from './agent-control.mjs';
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
  const r=rig();assert.equal(r.recovery.status().automatic,false);assert.equal(r.recovery.status().profile_handback_automatic,true);assert.throws(()=>r.recovery.request(r.input(),'genie'),/off/);
  for(const patch of [{adapter:'unknown'},{helper:'/tmp/x;evil'},{machine:'unknown'},{shell:'reboot'}])assert.throws(()=>recoveryConfig({workers:[{...config,...patch}]}));
  for(const patch of [{start_stopped:true},{start_stopped:'yes',service_profile:'c'.repeat(64)},{service_profile:'c'.repeat(64)}])assert.throws(()=>recoveryConfig({workers:[{...config,...patch}]}));
  assert.throws(()=>recoveryConfig({workers:[config,{...config,id:'two',url:'http://127.0.0.1:39002'}]}),/physical/);
  const launchd={...config,id:'mac',url:'http://127.0.0.1:39002',adapter:'launchd',machine:'c'.repeat(64)};
  assert.equal(recoveryConfig({workers:[launchd]}).get('mac').adapter,'launchd');
  const mixed=new Recovery({workers:[config,launchd]},{...r.deps,nodes:[r.n,{...r.n,...launchd,id:'mac'}]});
  assert.equal(mixed.status().adapter,'mixed');assert.equal(mixed.workerStatus(mixed.nodes[1]).adapter,'launchd');mixed.close();
});
test('malformed durable profile adoption state and operations fail closed',()=>{
  const r=rig();r.recovery.setAutomatic(true);
  r.store.data.recovery.adopted_profiles={one:{config_profile:'bad'}};
  assert.throws(()=>new Recovery({workers:[config]},r.deps),/Invalid adopted recovery profile/);
  r.store.data.recovery.adopted_profiles={};
  r.store.data.recovery.operations=[{id:randomUUID(),worker_id:'one',state:'queued',service_action:'adopt_restart',adopt_profile:'bad'}];
  assert.throws(()=>new Recovery({workers:[config]},r.deps),/Invalid recovery operation/);
});
test('launchd absence diagnostics reach Genie but never authorize recovery or override a pause',async()=>{
  for(const [registration,loaded,reason] of [['absent',false,'launchd_registration_absent'],['gui_domain_unavailable',null,'launchd_gui_domain_unavailable'],['unverified',null,'launchd_state_unverified']]){
    const r=rig(),local={...config,adapter:'launchd',start_stopped:true,service_profile:'c'.repeat(64)};
    r.recovery.configs.set('one',local);
    const sample={version:1,machine:local.machine,service_profile:local.service_profile,registration,loaded,active:false,stopped:false,pid:0,instance:'',listener:null};
    const actions=[];r.recovery.call=async(_config,request)=>{actions.push(request.action);return sample;};
    r.recovery.setAutomatic(true);r.n.drained=true;
    await r.recovery.tick();
    const status=r.recovery.workerStatus(r.n);
    assert.equal(status.reason,reason);assert.equal(status.state,'paused');assert.equal(status.eligible,false);assert.equal(status.evidence_id,null);
    assert.throws(()=>r.recovery.request(r.input(),'genie'),new RegExp(reason));
    assert.throws(()=>r.recovery.request(r.input(),'operator',{canary:true}),new RegExp(reason));
    const data=briefing({devices:[],gateway:{workers:[{id:'one'}],recovery:r.recovery.status()}});
    assert.equal(data.workers[0].recovery_evidence.reason,reason);
    assert.deepEqual(data.recovery.offers,[]);
    r.n.drained=false;await r.recovery.tick();
    assert.equal(r.recovery.workerStatus(r.n).eligible,false);
    assert.ok(actions.every(action=>action==='inspect'));assert.equal(r.store.data.recovery.operations.length,0);
    for(const change of [{machine:'d'.repeat(64)},{service_profile:'d'.repeat(64)},{registration:'private raw stderr'}, {active:true}]){
      assert.equal(r.recovery.reason(r.n,{...sample,...change}),'service_identity_or_profile_unverified');
    }
    r.recovery.close();
  }
});
function localEnrollment(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dsg-local-recovery-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const helper=path.join(dir,'private helper.py'),filename=path.join(dir,'private config.json');
  fs.writeFileSync(helper,'import json,sys\nr=json.load(sys.stdin)\nprint(json.dumps({"version":1,"action":r["action"]}))\n',{mode:0o600});
  fs.writeFileSync(filename,JSON.stringify({port:39001}),{mode:0o600});
  const {ssh,...base}=config;
  return {...base,adapter:'launchd',transport:'local',python:fs.realpathSync('/usr/bin/python3'),helper,config:filename};
}
function fakeProcess(){const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();child.kill=()=>{};return child;}
test('local launchd enrollment is explicit, private and disjoint from remote recovery',t=>{
  const local=localEnrollment(t);
  assert.equal(recoveryConfig({workers:[local]}).get('one').transport,'local');
  for(const patch of [{transport:undefined},{transport:'auto'},{adapter:'systemd-user'},{ssh:'remote'},{remote_port:8000},{ssh_fallbacks:[]},{python:undefined},{python:'python3'},{exclusive:false}])assert.throws(()=>recoveryConfig({workers:[{...local,...patch}]}));
  assert.throws(()=>recoveryConfig({workers:[{...config,python:local.python}]}));
});
test('local recovery spawns the enrolled interpreter and literal paths without a shell',async t=>{
  const local=localEnrollment(t),request={action:'inspect'},calls=[];
  const result=await systemdCall(local,request,{platform:'darwin',spawnFn:(file,args,opts)=>{
    calls.push({file,args,opts});const child=fakeProcess();let input='';child.stdin.on('data',c=>input+=c);
    setImmediate(()=>{assert.deepEqual(JSON.parse(input),request);child.stdout.write('{"version":1}');child.emit('close',0);});return child;
  }});
  assert.deepEqual(result,{version:1});assert.equal(calls.length,1);
  assert.equal(calls[0].file,local.python);assert.deepEqual(calls[0].args,['-I',local.helper,local.config]);assert.equal(calls[0].opts.shell,false);
});
test('real local helper receives JSON on stdin and returns a complete bounded result',async t=>{
  const local=localEnrollment(t);
  // Synthetic script only: this does not import the real recovery helper or
  // invoke launchctl. Platform override lets Linux CI exercise the subprocess.
  assert.deepEqual(await systemdCall(local,{action:'inspect'},{platform:'darwin'}),{version:1,action:'inspect'});
});
test('local enrollment preserves worker binding, operator pause and evidence-gated recovery',async t=>{
  const local=localEnrollment(t),r=rig();delete r.n.ssh;
  r.recovery.configs=recoveryConfig({workers:[local]});await r.ready();
  assert.equal(r.recovery.workerStatus(r.n).transport,'local');
  assert.equal(r.recovery.workerStatus(r.n).eligible,true);
  r.n.ssh='different-remote';assert.equal(r.recovery.workerStatus(r.n).reason,'manual_recovery_required');delete r.n.ssh;
  r.n.drained=true;assert.equal(r.recovery.workerStatus(r.n).reason,'operator_paused');r.n.drained=false;
  assert.throws(()=>r.recovery.request({...r.input(),evidence_id:'invented'}),/evidence/);
  r.recovery.request(r.input());await r.recovery.task;
  assert.equal(r.restarts,1);assert.equal(r.proofs,1);assert.equal(r.n.quarantine,null);
});
test('local recovery refuses wrong platform, public config, symlinks, unsafe helper and wrong port before spawn',async t=>{
  const local=localEnrollment(t);let spawned=0;
  const opts={platform:'darwin',spawnFn:()=>{spawned++;throw new Error('must not spawn');}};
  await assert.rejects(systemdCall(local,{action:'inspect'},{...opts,platform:'linux'}),/adapter_local_unavailable/);
  await assert.rejects(systemdCall(local,{action:'inspect'},{...opts,uid:0}),/adapter_local_unavailable/);
  fs.chmodSync(local.config,0o644);
  await assert.rejects(systemdCall(local,{action:'inspect'},opts),/adapter_local_identity_unverified/);fs.chmodSync(local.config,0o600);
  fs.chmodSync(local.helper,0o666);
  await assert.rejects(systemdCall(local,{action:'inspect'},opts),/adapter_local_identity_unverified/);fs.chmodSync(local.helper,0o600);
  const symlink=path.join(path.dirname(local.config),'link.json');fs.symlinkSync(local.config,symlink);
  await assert.rejects(systemdCall({...local,config:symlink},{action:'inspect'},opts),/adapter_local_identity_unverified/);
  fs.writeFileSync(local.config,'{"port":8001}');
  await assert.rejects(systemdCall(local,{action:'inspect'},opts),/adapter_local_identity_unverified/);
  fs.writeFileSync(local.config,'x'.repeat(65537));
  await assert.rejects(systemdCall(local,{action:'inspect'},opts),/adapter_local_identity_unverified/);
  assert.equal(spawned,0);
});
test('recovery transport waits for trailing stdout after process exit',async()=>{
  const result=await systemdCall(config,{action:'inspect'},{spawnFn:()=>{
    const child=fakeProcess();setImmediate(()=>{child.emit('exit',0);setImmediate(()=>{child.stdout.write('{"version":1,"active":true}');child.emit('close',0);});});return child;
  }});
  assert.deepEqual(result,{version:1,active:true});
});
test('local recovery does not retry ambiguous failures or expose private subprocess diagnostics',async t=>{
  const local=localEnrollment(t);let spawns=0,kills=0;
  for(const scenario of ['bad-json','error','overflow','timeout','throw']){
    const before=spawns;
    await assert.rejects(systemdCall(local,{action:'start'},{platform:'darwin',timeoutMs:20,spawnFn:()=>{
      spawns++;if(scenario==='throw')throw new Error('SECRET launcher path');
      const child=fakeProcess();child.kill=()=>{kills++;};setImmediate(()=>{
        child.stderr.write('SECRET path: Permission denied');
        if(scenario==='bad-json'){child.stdout.write('SECRET');child.emit('close',0);}
        if(scenario==='error')child.emit('error',new Error('SECRET'));
        if(scenario==='overflow')child.stdout.write('x'.repeat(65537));
      });return child;
    }}),error=>/^adapter_(check_failed|spawn_failed|output_limit|timeout)$/.test(error.message));
    assert.equal(spawns,before+1);
  }
  assert.equal(kills,2);
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
      if(target==='primary'){child.stderr.write('Could not resolve hostname private-primary');child.emit('close',255,null);}
      else {child.stdout.write(JSON.stringify({version:1,active:true}));child.emit('close',0,null);}
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
test('recovery status exposes durable identity drift while admitted work is still draining',async()=>{
  for(const admitted of ['active','queued']) {
    const r=rig();r.recovery.call=async()=>({...r.sample(),profile:'c'.repeat(64)});await r.ready();
    if(admitted==='active')r.n.active={thinking:'xhigh'};else r.n.queue.push({id:'waiting'});
    const status=r.recovery.workerStatus(r.n);
    assert.equal(status.reason,'profile_handback_wait_for_admitted_work');
    assert.equal(status.eligible,false);assert.equal(r.restarts,0);
  }
});
test('verified profile hand-back adopts a stable same-machine DS4 profile, restarts a fatal instance and survives controller restart',async()=>{
  const r=rig(),changed='c'.repeat(64);let instance='1'.repeat(32),fault=true,restarts=0;
  const observed=()=>({...r.sample(),profile:changed,instance,started_at:r.deps.now()-100000,fault:fault?{reason:'fatal_accelerator_error',at:r.deps.now()-1000}:null});
  r.recovery.call=async(_config,input)=>{if(input.action==='restart'){assert.equal(input.profile,changed);restarts++;instance='2'.repeat(32);fault=false;return {state:'issued'};}return observed();};
  await r.ready();assert.equal(r.recovery.workerStatus(r.n).reason,'profile_handback_confirmation_pending');
  r.advance(11000);await r.ready();let status=r.recovery.workerStatus(r.n);assert.equal(status.eligible,true);assert.equal(status.profile_handback.stable,true);
  const receipt=r.recovery.request(r.input(),'operator');assert.equal(receipt.service_action,'adopt_restart');await r.recovery.task;
  assert.equal(restarts,1);assert.equal(r.n.quarantine,null);assert.equal(r.n.healthy,true);assert.equal(r.recovery.config(r.n.id).profile,changed);
  status=r.recovery.workerStatus(r.n);assert.equal(status.profile_handback.adopted,true);assert.equal(status.last_action.profile_adopted,true);
  assert.ok(!JSON.stringify(r.recovery.status()).includes(changed),'public status does not expose profile fingerprints');
  const resumed=new Recovery({workers:[config]},{...r.deps,call:async()=>observed()});
  assert.equal(resumed.config(r.n.id).profile,changed);assert.equal(resumed.status().profile_handback_automatic,true);await resumed.close();
  const noStaleStart=new Recovery({workers:[{...config,start_stopped:true,service_profile:'f'.repeat(64)}]},{...r.deps,call:async()=>observed()});
  assert.equal(noStaleStart.config(r.n.id).start_stopped,false);assert.equal(noStaleStart.config(r.n.id).service_profile,undefined);await noStaleStart.close();
});
test('profile hand-back can verify an already replaced instance, while pause and policy opt-out remain authoritative',async()=>{
  const changed='d'.repeat(64),r=rig(),newer=()=>({...r.sample(),profile:changed,instance:'2'.repeat(32),started_at:r.deps.now()+2000,fault:null});
  r.recovery.call=async()=>newer();await r.ready();r.advance(11000);await r.ready();
  r.recovery.setProfileHandbackAutomatic(false);assert.equal(r.recovery.workerStatus(r.n).reason,'profile_handback_disabled');
  r.recovery.setProfileHandbackAutomatic(true);r.n.drained=true;assert.equal(r.recovery.workerStatus(r.n).reason,'operator_paused');r.n.drained=false;
  r.recovery.setAutomatic(true);await r.ready();await r.recovery.task;
  const receipt=r.recovery.status().operations[0];assert.equal(receipt.actor,'detector');assert.equal(receipt.service_action,'adopt_verify');
  assert.equal(r.restarts,0);assert.equal(r.n.healthy,true);assert.equal(r.recovery.config(r.n.id).profile,changed);
});
test('an agent maintenance hold blocks the detector until its owner explicitly hands back the verified candidate',async()=>{
  const changed='e'.repeat(64),r=rig(),newer=()=>({...r.sample(),profile:changed,instance:'2'.repeat(32),started_at:r.deps.now()+2000,fault:null});
  r.recovery.call=async()=>newer();r.recovery.setAutomatic(true);
  let scheduled=null;
  const agents=new AgentControl({store:r.store,nodes:[r.n],canResume:async()=>{},onPause:ids=>r.recovery.operatorPause(ids),
    canHandback:n=>r.recovery.profileHandbackOffer(n,{ignorePause:true}),onHandback:()=>{scheduled=r.recovery.tick();}});
  const grant=agents.grant({agent_id:'maintainer',workers:['one']});assert.ok(grant.token);
  const held=await agents.act('maintainer','drain',{worker_id:'one',reason:'upgrade test',request_id:randomUUID()});
  await r.recovery.tick();r.advance(11000);await r.recovery.tick();
  assert.equal(r.recovery.workerStatus(r.n).reason,'operator_paused');assert.equal(r.recovery.status().operations.length,0);
  const released=await agents.act('maintainer','resume',{hold_id:held.result.hold_id,request_id:randomUUID()});
  assert.equal(released.result.state,'handback_released');assert.equal(released.result.routing_resumed,false);assert.ok(r.n.quarantine);
  await scheduled;await r.recovery.task;
  assert.equal(r.recovery.status().operations[0].actor,'detector');assert.equal(r.recovery.status().operations[0].service_action,'adopt_verify');
  assert.equal(r.restarts,0);assert.equal(r.n.quarantine,null);assert.equal(r.n.healthy,true);assert.equal(r.recovery.config(r.n.id).profile,changed);
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
test('automatic stopped-service recovery waits for stable exact identity, starts once, verifies, and reinstates',async()=>{
  let time=1788390000000,started=false,starts=0,proofs=0;
  const enrolled={...config,start_stopped:true,service_profile:'c'.repeat(64)};
  const n={...enrolled,healthy:false,drained:false,active:null,queue:[],contextLength:262144,quarantine:null};
  const store={data:{sessions:{}},save(next){this.data=structuredClone(next);}};
  const stopped=()=>({version:1,machine:enrolled.machine,service_profile:enrolled.service_profile,loaded:true,stopped:true,stopped_epoch:'d'.repeat(64),instance:'',active:false,listener:false});
  const active=()=>({version:1,machine:enrolled.machine,service_profile:enrolled.service_profile,loaded:true,stopped:false,stopped_epoch:null,instance:'2'.repeat(32),profile:enrolled.profile,started_at:time,active:true,listener:true,fault:null});
  const recovery=new Recovery({workers:[enrolled]},{store,nodes:[n],model:'deepseek-v4-flash',stopping:()=>false,now:()=>time,
    call:async(_c,input)=>{if(input.action==='start'){starts++;started=true;return {state:'issued'};}return started?active():stopped();},
    verify:async()=>{proofs++;return {samples:[],verified_at:new Date(time).toISOString()};},
    reinstate:(node,expected,state)=>{assert.equal(expected,null);store.save({...store.data,recovery:state});node.quarantine=null;node.healthy=true;}});
  recovery.setAutomatic(true);await recovery.tick();
  assert.equal(recovery.workerStatus(n).reason,'stopped_service_confirmation_pending');assert.equal(starts,0);
  time+=16000;await recovery.tick();await recovery.task;
  const op=recovery.status().operations[0];
  assert.equal(starts,1);assert.equal(proofs,1);assert.equal(n.healthy,true);assert.equal(op.state,'recovered');
  assert.equal(op.service_action,'start');assert.equal(op.service_action_issued,true);assert.equal(op.restart_issued,undefined);
  const publicStatus=JSON.stringify(recovery.status());
  for(const secret of [enrolled.machine,enrolled.profile,enrolled.service_profile,'d'.repeat(64)])assert.ok(!publicStatus.includes(secret));
  store.data.recovery.operations[0].state='starting';delete store.data.recovery.operations[0].new_instance;delete store.data.recovery.operations[0].proof;n.healthy=false;
  const resumed=new Recovery({workers:[enrolled]},{store,nodes:[n],model:'deepseek-v4-flash',stopping:()=>false,now:()=>time,
    call:recovery.call,verify:recovery.verify,reinstate:(node,expected,state)=>{assert.equal(expected,null);store.save({...store.data,recovery:state});node.quarantine=null;node.healthy=true;}});
  await resumed.tick();await resumed.task;
  assert.equal(starts,1,'controller reconciliation must never issue a second start');assert.equal(proofs,2);assert.equal(resumed.status().operations[0].state,'recovered');
});
test('stopped-service recovery never overrides pause, admitted work, static-profile drift, or explicit opt-out',async()=>{
  const service_profile='c'.repeat(64),base={version:1,machine:config.machine,service_profile,loaded:true,stopped:true,stopped_epoch:'d'.repeat(64),instance:'',active:false,listener:false};
  for(const mutate of [n=>n.drained=true,n=>n.active={},n=>n.queue.push({})]) {
    const enrolled={...config,start_stopped:true,service_profile},r=rig();r.recovery.configs=recoveryConfig({workers:[enrolled]});r.recovery.call=async()=>base;await r.ready();r.advance(16000);await r.ready();mutate(r.n);
    assert.throws(()=>r.recovery.request(r.input()));assert.equal(r.restarts,0);
  }
  const opted=rig();opted.recovery.call=async()=>base;await opted.ready();assert.equal(opted.recovery.workerStatus(opted.n).reason,'stopped_service_start_not_enrolled');
  const drift=rig();drift.recovery.configs=recoveryConfig({workers:[{...config,start_stopped:true,service_profile}]});drift.recovery.call=async()=>({...base,service_profile:'e'.repeat(64)});await drift.ready();
  assert.equal(drift.recovery.workerStatus(drift.n).reason,'service_identity_or_profile_unverified');assert.equal(drift.restarts,0);
});
test('healthy replacement already started after the fault is verified without a redundant restart',async()=>{
  const r=rig();r.replace();r.recovery.call=async()=>({...r.sample(),started_at:r.deps.now()+1});await r.ready();r.recovery.request(r.input());await r.recovery.task;
  assert.equal(r.restarts,0);assert.equal(r.proofs,1);assert.equal(r.recovery.status().operations[0].state,'recovered');
});
test('a new exact service instance is automatically verified after repeated stream failures without granting restart power',async()=>{
  const stale=rig();stale.n.quarantine.reason='repeated_inference_failures';await stale.ready();
  assert.equal(stale.recovery.workerStatus(stale.n).reason,'no_supported_quarantine');assert.equal(stale.restarts,0);
  const r=rig();r.n.quarantine.reason='repeated_inference_failures';r.replace();r.recovery.call=async()=>({...r.sample(),started_at:r.deps.now()+1});r.recovery.setAutomatic(true);
  await r.ready();await r.recovery.task;
  assert.equal(r.restarts,0);assert.equal(r.proofs,1);assert.equal(r.n.quarantine,null);assert.equal(r.n.healthy,true);
  assert.equal(r.recovery.status().operations[0].actor,'detector');assert.equal(r.recovery.status().operations[0].restart_issued,undefined);
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
test('operator canary can prove an enrolled stopped-service start while routing stays paused',async()=>{
  let time=1788390000000,started=false,starts=0;
  const enrolled={...config,start_stopped:true,service_profile:'c'.repeat(64)};
  const n={...enrolled,healthy:false,drained:true,active:null,queue:[],contextLength:262144,quarantine:null};
  const store={data:{sessions:{}},save(next){this.data=structuredClone(next);}};
  const stopped={version:1,machine:enrolled.machine,service_profile:enrolled.service_profile,loaded:true,stopped:true,stopped_epoch:'d'.repeat(64),instance:'',active:false,listener:false};
  const active=()=>({version:1,machine:enrolled.machine,service_profile:enrolled.service_profile,loaded:true,stopped:false,stopped_epoch:null,instance:'2'.repeat(32),profile:enrolled.profile,started_at:time,active:true,listener:true,fault:null});
  const recovery=new Recovery({workers:[enrolled]},{store,nodes:[n],model:'deepseek-v4-flash',stopping:()=>false,now:()=>time,
    call:async(_c,input)=>{if(input.action==='start'){starts++;started=true;return {state:'issued'};}return started?active():stopped;},
    verify:async()=>({samples:[],verified_at:new Date(time).toISOString()}),reinstate:()=>{throw new Error('paused canary must not reinstate routing');}});
  await recovery.inspect(n.id);time+=16000;await recovery.inspect(n.id);
  recovery.request({worker_id:n.id,action_id:randomUUID()},'operator',{canary:true});await recovery.task;
  assert.equal(starts,1);assert.equal(n.drained,true);assert.equal(n.healthy,false);
  assert.equal(recovery.status().operations[0].service_action,'start');assert.equal(recovery.status().operations[0].state,'verified_paused');
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
  let policy=await workerControl(socket,'/recovery-handback-policy',{enabled:false});assert.equal(policy.profile_handback_automatic,false);
  policy=await workerControl(socket,'/recovery-handback-policy',{enabled:true});assert.equal(policy.profile_handback_automatic,true);
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
  for(const action of ['recover','recovery-policy','recovery-handback-policy','recovery-recheck']) {
    let res=await fetch(`${base}/api/workers/${action}`,{method:'POST',headers:{'content-type':'application/json'},body:'{}'});assert.equal(res.status,403);await res.text();
    res=await fetch(`${base}/api/workers/${action}`,{method:'POST',headers:{origin:base,'content-type':'application/json','x-dsg-csrf':token},body:'{}'});assert.equal(res.status,200);await res.text();
  }
  assert.equal(calls.length,4);assert.deepEqual(calls[2],{action:'recovery-handback-policy',input:{}});const res=await fetch(base+'/api/workers/recovery-canary',{method:'POST'});assert.equal(res.status,405);await res.text();
});
