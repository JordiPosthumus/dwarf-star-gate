import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {AgentControl} from './agent-control.mjs';
import {readAgentCredential} from './agent-client.mjs';

function rig(paused=false,overrides={}) {
  const nodes=['worker-a','worker-b'].map(id=>({id,healthy:true,drained:paused,active:null,queue:[],quarantine:null}));
  const store={data:{drained:Object.fromEntries(nodes.map(n=>[n.id,paused])),unrelated:{preserve:true}},save(data){this.data=structuredClone(data);}};
  const logs=[];let probes=0,pauseCalls=0;
  const options={store,nodes,canResume:async()=>{probes++;},onPause:()=>{pauseCalls++;},log:(...x)=>logs.push(x),...overrides};
  const api=new AgentControl(options);
  const a=api.grant({agent_id:'test-a',workers:['worker-a']}),b=api.grant({agent_id:'test-b',workers:['worker-a','worker-b']});
  const drain=(actor='test-a',worker_id='worker-a',request_id=randomUUID())=>api.act(actor,'drain',{worker_id,reason:'DS4 test',request_id});
  const release=(hold_id,actor='test-a',request_id=randomUUID())=>api.act(actor,'resume',{hold_id,request_id});
  return {api,options,store,nodes,logs,a,b,drain,release,probes:()=>probes,pauseCalls:()=>pauseCalls};
}
test('grant token is one-time output; hashes and secrets never enter status or logs',()=>{
  const r=rig();assert.equal(r.api.authenticate(`Bearer ${r.a.token}`),'test-a');
  assert.equal(r.api.authenticate('Bearer invalid'),null);assert.equal(r.api.authenticate(r.a.token),null);
  const output=JSON.stringify([r.api.status('test-a'),r.api.adminStatus(),r.logs]);
  assert.ok(!output.includes(r.a.token));assert.ok(!output.includes('token_hash'));
  assert.ok(!JSON.stringify(r.store.data).includes(r.a.token));
  assert.throws(()=>r.api.grant({agent_id:'test-a',workers:['worker-a']}),{code:'agent_exists'});
  assert.throws(()=>r.api.grant({agent_id:'new',workers:['missing']}),{code:'invalid_grant'});
});
test('scoped drain records ownership, preserves existing work and releases after fresh probe',async()=>{
  const r=rig();r.nodes[0].active={id:'active'};r.nodes[0].queue.push({id:'waiting'});
  const d=await r.drain();assert.equal(r.nodes[0].drained,true);assert.equal(r.nodes[0].queue.length,1);assert.equal(r.pauseCalls(),1);
  assert.equal(r.api.status('test-a').workers[0].gateway_drained,false);
  r.nodes[0].active=null;r.nodes[0].queue=[];
  assert.equal(r.api.status('test-a').workers[0].gateway_drained,true);
  const out=await r.release(d.result.hold_id);assert.equal(out.result.routing_resumed,true);assert.equal(r.nodes[0].drained,false);assert.equal(r.probes(),1);
  assert.deepEqual(r.store.data.unrelated,{preserve:true});
});
test('multiple owners cannot release each other; only last release enables',async()=>{
  const r=rig(),a=await r.drain(),b=await r.drain('test-b');
  await assert.rejects(r.release(b.result.hold_id),{code:'not_hold_owner'});
  await assert.rejects(r.drain('test-a','worker-b'),{code:'forbidden_worker'});
  assert.equal((await r.release(a.result.hold_id)).result.routing_resumed,false);assert.equal(r.nodes[0].drained,true);assert.equal(r.probes(),0);
  assert.equal((await r.release(b.result.hold_id,'test-b')).result.routing_resumed,true);assert.equal(r.probes(),1);
});
test('legacy operator pause is retained; release never probes or overrides it',async()=>{
  const r=rig(true),d=await r.drain();const out=await r.release(d.result.hold_id);
  assert.equal(out.result.operator_paused,true);assert.equal(out.result.routing_resumed,false);assert.equal(r.probes(),0);assert.equal(r.nodes[0].drained,true);
});
test('operator pause added during hold wins, and operator enable/remove cannot steal a hold',async()=>{
  const r=rig(),d=await r.drain();
  assert.throws(()=>r.api.manualUpdate(['worker-a'],false),{code:'agent_hold_present'});
  assert.throws(()=>r.api.forgetWorker('worker-a'),{code:'agent_hold_present'});
  r.store.save({...r.store.data,...r.api.manualUpdate(['worker-a'],true)});
  await r.release(d.result.hold_id);assert.equal(r.nodes[0].drained,true);assert.equal(r.probes(),0);
});
test('named maintenance lock is a durable hard veto and exact release leaves routing paused',async()=>{
  const r=rig(),request_id=randomUUID();
  const input={worker_id:'worker-a',name:'spark speed test',reason:'Another agent is validating a patched DS4 build',review_after_hours:2,request_id};
  const locked=r.api.maintenanceLock(input,'dashboard');
  assert.equal(locked.result.state,'maintenance_locked');assert.equal(r.nodes[0].drained,true);assert.equal(r.pauseCalls(),1);
  const status=r.api.pauseStatus('worker-a',{includeReason:true});
  assert.equal(status.operator_paused,false);assert.equal(status.maintenance_locks[0].name,input.name);assert.equal(status.maintenance_locks[0].reason,input.reason);
  assert.equal(status.maintenance_locks[0].review_at-status.maintenance_locks[0].created_at,2*3600000);
  assert.throws(()=>r.api.manualUpdate(['worker-a'],false),{code:'maintenance_lock_present'});
  assert.throws(()=>r.api.forgetWorker('worker-a'),{code:'maintenance_lock_present'});
  assert.deepEqual(r.api.maintenanceLock(input,'workers_cli'),locked,'idempotency is keyed to the immutable action, not the caller path');
  assert.throws(()=>r.api.maintenanceLock({...input,name:'changed'},'dashboard'),{code:'request_id_conflict'});
  const restored=new AgentControl(r.options);assert.deepEqual(restored.maintenanceReceipt({request_id}),locked);
  const releaseInput={lock_id:locked.result.lock_id,reason:'Patched build validation complete',request_id:randomUUID()};
  const released=restored.maintenanceRelease(releaseInput,'dashboard');
  assert.equal(released.result.state,'maintenance_released_paused');assert.equal(released.result.routing_resumed,false);
  assert.equal(r.nodes[0].drained,true);assert.equal(restored.manualPaused('worker-a'),true);assert.equal(restored.maintenanceLocks('worker-a').length,0);
  assert.deepEqual(restored.maintenanceRelease(releaseInput,'workers_cli'),released);
  assert.throws(()=>restored.maintenanceRelease({...releaseInput,reason:'different'},'dashboard'),{code:'request_id_conflict'});
  assert.throws(()=>restored.maintenanceRelease({...releaseInput,request_id:randomUUID()},'dashboard'),{code:'unknown_lock'});
  assert.deepEqual(restored.manualUpdate(['worker-a'],false).drained['worker-a'],false,'checked Resume is separately available after release');
});
test('maintenance review time is advisory and never expires or resumes routing',()=>{
  let now=1000;const r=rig(false,{now:()=>now});
  const locked=r.api.maintenanceLock({worker_id:'worker-a',name:'overnight maintenance',reason:'Keep out of routing until inspected',review_after_hours:1,request_id:randomUUID()},'workers_cli');
  now+=2*3600000;
  const restored=new AgentControl(r.options),lock=restored.maintenanceLocks('worker-a')[0];
  assert.ok(now>lock.review_at);assert.equal(lock.id,locked.result.lock_id);assert.equal(r.nodes[0].drained,true);
  assert.throws(()=>restored.manualUpdate(['worker-a'],false),{code:'maintenance_lock_present'});
});
test('legacy schema-one ownership loads without locks and persists the extension on first use',()=>{
  const r=rig();delete r.store.data.agent_control.maintenance_locks;delete r.store.data.agent_control.maintenance_operations;
  const restored=new AgentControl(r.options);assert.deepEqual(restored.maintenanceLocks('worker-a'),[]);
  restored.maintenanceLock({worker_id:'worker-a',name:'migration-test',reason:'exercise legacy state',review_after_hours:null,request_id:randomUUID()},'workers_cli');
  assert.ok(Array.isArray(r.store.data.agent_control.maintenance_locks));assert.ok(Array.isArray(r.store.data.agent_control.maintenance_operations));
});
test('failed maintenance save leaves lock ownership and live routing unchanged',()=>{
  const r=rig(),before=JSON.stringify(r.store.data);r.store.save=()=>{throw new Error('disk full');};
  assert.throws(()=>r.api.maintenanceLock({worker_id:'worker-a',name:'test',reason:'must not partially apply',review_after_hours:null,request_id:randomUUID()},'dashboard'),/disk full/);
  assert.equal(JSON.stringify(r.store.data),before);assert.equal(r.nodes[0].drained,false);assert.equal(r.pauseCalls(),0);
});
test('agent release cannot route through an operator maintenance lock',async()=>{
  const r=rig(),hold=await r.drain();
  r.api.maintenanceLock({worker_id:'worker-a',name:'operator test',reason:'Independent maintenance still owns this server',review_after_hours:null,request_id:randomUUID()},'dashboard');
  const released=await r.release(hold.result.hold_id);
  assert.equal(released.result.routing_resumed,false);assert.equal(released.result.maintenance_locks.length,1);assert.equal(r.nodes[0].drained,true);assert.equal(r.probes(),0);
});
test('revocation retains holds; operator escape clears ownership but keeps a manual pause',async()=>{
  const r=rig(),d=await r.drain();r.api.revoke({agent_id:'test-a'});
  assert.equal(r.api.authenticate(`Bearer ${r.a.token}`),null);
  await assert.rejects(r.release(d.result.hold_id),{code:'unauthorized'});
  assert.equal(r.api.holds('worker-a').length,1);
  assert.equal(r.api.clearHold({hold_id:d.result.hold_id}).routing_resumed,false);
  assert.equal(r.api.manualPaused('worker-a'),true);assert.equal(r.nodes[0].drained,true);
});
test('exact idempotency receipts survive reconstruction; replay does not re-pause',async()=>{
  const r=rig(),request_id=randomUUID(),d=await r.drain('test-a','worker-a',request_id);
  assert.deepEqual(await r.drain('test-a','worker-a',request_id),d);assert.equal(r.api.holds('worker-a').length,1);
  await assert.rejects(r.drain('test-b','worker-a',request_id),{code:'request_id_conflict'});
  await assert.rejects(r.api.act('test-a','drain',{worker_id:'worker-a',reason:'Changed',request_id}),{code:'request_id_conflict'});
  await r.release(d.result.hold_id);
  const restored=new AgentControl(r.options);
  assert.deepEqual(restored.receipt('test-a',{request_id}),d);
  assert.deepEqual(await restored.act('test-a','drain',{worker_id:'worker-a',reason:'DS4 test',request_id}),d);
  assert.equal(r.nodes[0].drained,false);assert.equal(r.pauseCalls(),1);
  assert.throws(()=>restored.receipt('test-b',{request_id}),{code:'receipt_not_found'});
});
test('failed save leaves ownership and live routing unchanged',async()=>{
  const r=rig(),before=JSON.stringify(r.store.data);r.store.save=()=>{throw new Error('disk full');};
  await assert.rejects(r.drain(),/disk full/);assert.equal(JSON.stringify(r.store.data),before);assert.equal(r.nodes[0].drained,false);assert.equal(r.pauseCalls(),0);
});
test('failed readiness and quarantine keep hold; no implicit recovery powers',async()=>{
  const r=rig(),d=await r.drain();r.api.canResume=async()=>{throw new Error('unready');};
  await assert.rejects(r.release(d.result.hold_id),/unready/);assert.equal(r.api.holds('worker-a').length,1);
  for(const field of ['quarantine','recovering']){r.nodes[0][field]={};await assert.rejects(r.release(d.result.hold_id),{code:'recovery_required'});r.nodes[0][field]=null;}
  assert.equal(r.nodes[0].drained,true);
});
test('final agent hold can become an explicit verified hand-back without clearing quarantine itself',async()=>{
  let offered=0,scheduled=0;
  const r=rig(false,{canHandback:async node=>{assert.ok(node.quarantine);offered++;return {evidence_id:'private'};},onHandback:()=>{scheduled++;}}),d=await r.drain();
  r.nodes[0].quarantine={reason:'accelerator_checkpoint_failure'};r.nodes[0].healthy=false;
  const out=await r.release(d.result.hold_id);
  assert.equal(out.result.state,'handback_released');assert.equal(out.result.recovery_pending,true);assert.equal(out.result.routing_resumed,false);
  assert.equal(r.api.holds('worker-a').length,0);assert.equal(r.nodes[0].drained,false);assert.ok(r.nodes[0].quarantine);
  assert.equal(offered,1);assert.equal(scheduled,1);
});
test('invalid action schemas cannot add authority or mutate state',async()=>{
  const r=rig(),before=JSON.stringify(r.store.data);
  for(const body of [{worker_id:'worker-a',reason:'x'}, {worker_id:'worker-a',reason:'x',request_id:randomUUID(),force:true}, {worker_id:'worker-a',reason:'x\ny',request_id:randomUUID()}, {worker_id:'worker-a',reason:'',request_id:randomUUID()}])await assert.rejects(r.api.act('test-a','drain',body));
  assert.equal(JSON.stringify(r.store.data),before);
});
test('invalid maintenance actions fail closed without changing routing',()=>{
  const r=rig(),before=JSON.stringify(r.store.data),valid={worker_id:'worker-a',name:'test',reason:'reason',review_after_hours:null,request_id:randomUUID()};
  for(const input of [{...valid,force:true},{...valid,name:'x\ny'},{...valid,reason:''},{...valid,review_after_hours:0},{...valid,worker_id:'missing'}])assert.throws(()=>r.api.maintenanceLock(input,'dashboard'));
  assert.equal(JSON.stringify(r.store.data),before);assert.equal(r.nodes[0].drained,false);
});
test('invalid saved ownership fails closed; removed worker loses grants',async()=>{
  const r=rig(),d=await r.drain();r.nodes[0].drained=false;
  assert.throws(()=>new AgentControl(r.options),/conflicts/);r.nodes[0].drained=true;
  r.api.clearHold({hold_id:d.result.hold_id});
  const next=r.api.forgetWorker('worker-a');assert.ok(next.agents.every(a=>!a.workers.includes('worker-a')));
  r.store.data.agent_control.holds=[{id:'invalid'}];assert.throws(()=>new AgentControl(r.options),/Invalid agent holds/);
});
test('credential files require owner-only regular files, not symlinks or public permissions',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dsg-agent-credential-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const r=rig(),file=path.join(dir,'agent.json');
  fs.writeFileSync(file,JSON.stringify({schema:1,token:r.a.token,control_socket:path.join(dir,'control.sock')}),{mode:0o600});
  assert.equal(readAgentCredential(file).token,r.a.token);
  fs.chmodSync(file,0o644);assert.throws(()=>readAgentCredential(file));fs.chmodSync(file,0o600);
  fs.symlinkSync(file,path.join(dir,'link'));assert.throws(()=>readAgentCredential(path.join(dir,'link')));
  assert.throws(()=>readAgentCredential('relative'));assert.throws(()=>readAgentCredential(dir));
});
