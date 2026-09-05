import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Recovery} from './recovery.mjs';
import {recoveryConfig} from './recovery-transport.mjs';
import {bootstrapProofValid} from './recovery-bootstrap.mjs';
import {AgentControl} from './agent-control.mjs';
import {briefing} from './genie.mjs';

const c={id:'mac',url:'http://127.0.0.1:39001',ssh:'fixture-host',adapter:'launchd',helper:'/opt/dsg/helper.py',config:'/opt/dsg/private.json',
  machine:'a'.repeat(64),profile:'b'.repeat(64),service_profile:'c'.repeat(64),exclusive:true,
  bootstrap_removed:true,bootstrap_callers:['loginwindow'],retained_definition_sha256:'d'.repeat(64)};
const boot='12345678-1234-1234-1234-123456789abc';
function proof(time){return {check:'two_conversations_cold_to_warm',context_length:262144,verified_at:new Date(time).toISOString(),
  samples:['cold-A','cold-B','warm-A','warm-B'].map((label,i)=>({label,prompt_tokens:i<2?2200:2220,cached_tokens:i<2?0:2200,elapsed_ms:10}))};}
function rig(){
  let time=1788566400000,epoch=1,loaded=true,caller='launchctl',removedAt=0,bootstraps=0,captures=0,proofs=0;
  const hooks={},node={...c,healthy:true,drained:true,active:null,queue:[],contextLength:262144,quarantine:null};
  const store={data:{},save(next){this.data=structuredClone(next);hooks.saved?.(next);}};
  const sample=()=>({version:1,machine:c.machine,service_profile:c.service_profile,boot_uuid:boot,native_disabled:false,removal_capture_version:1,
    bootstrap:{version:1,definition_sha256:c.retained_definition_sha256,callers:c.bootstrap_callers},fault:null,
    ...(loaded?{loaded:true,registration:'loaded',stopped:false,active:true,listener:true,profile:c.profile,pid:epoch+120,instance:String(epoch).padStart(32,'0'),started_at:time-100000}
      :{loaded:false,registration:'absent',stopped:false,active:false,listener:false,pid:0,instance:''})});
  const deps={store,nodes:[node],model:'deepseek-v4-flash',stopping:()=>false,now:()=>time,
    call:async(_config,input)=>{
      if(input.action==='inspect')return hooks.inspect?.(sample())??sample();
      if(input.action==='inspect_removal'){
        captures++;assert.equal(input.prior.enrollment,undefined);assert.equal(input.prior.boot_uuid,boot);
        const value={version:1,source:'native_launchd',authority:'none',checked_at:time,status:'exact_removal_observed',source_complete:true,
          records:1,observations:[{at:removedAt,caller}],observations_omitted:0,native_stop_caller_observed:caller==='launchctl'};
        return hooks.removal?.(value,captures)??value;
      }
      assert.equal(input.action,'bootstrap');assert.equal(input.prior.enrollment,undefined);assert.equal(input.definition_sha256,c.retained_definition_sha256);
      const current=store.data.recovery.operations.at(-1);assert.equal(current.state,'bootstrapping');assert.equal(current.service_action_issued,true);
      bootstraps++;loaded=true;epoch++;
      const receipt={state:'issued',operation:'bootstrap',instance:input.prior.instance,definition_sha256:input.definition_sha256};
      return hooks.bootstrap?.(receipt,input)??receipt;
    },
    verify:async()=>{proofs++;return hooks.verify?.(proof(time))??proof(time);},
    reinstate(n,expected,next){assert.deepEqual(n.quarantine,expected);store.save({...store.data,recovery:next});n.quarantine=null;n.healthy=true;}};
  const recovery=new Recovery({workers:[c]},deps);
  return {recovery,store,node,deps,hooks,sample,get bootstraps(){return bootstraps;},get captures(){return captures;},get proofs(){return proofs;},
    advance(ms){time+=ms;},restore(){loaded=true;epoch++;},
    async remove(by='launchctl'){time+=1000;removedAt=time;caller=by;loaded=false;node.healthy=false;node.quarantine={reason:'worker_unavailable',at:new Date(time).toISOString()};await recovery.inspect(node.id);},
    input(){return {worker_id:node.id,action_id:randomUUID(),evidence_id:recovery.workerStatus(node).evidence_id};},
    async ready(){await recovery.inspect(node.id);},
    async canary(){recovery.request({worker_id:node.id,action_id:randomUUID()},'operator',{canary:true});await recovery.task;return recovery.state.operations.at(-1);}};
}

test('bootstrap enrollment is launchd-only, exact and does not implicitly permit stopped starts',()=>{
  assert.equal(recoveryConfig({workers:[c]}).get('mac').start_stopped,undefined);
  for(const update of [{bootstrap_removed:'yes'},{adapter:'systemd-user'},{service_profile:undefined},{retained_definition_sha256:'bad'},
    {bootstrap_callers:undefined},{bootstrap_callers:['launchctl']},{bootstrap_callers:['loginwindow','loginwindow']},{bootstrap_removed:false}]){
    assert.throws(()=>recoveryConfig({workers:[{...c,...update}]}));
  }
});
test('bootout request evidence permits only an explicitly drained operator canary',async()=>{
  const r=rig();await r.ready();r.hooks.removal=value=>({...value,status:'exact_stop_request_observed'});await r.remove();
  assert.equal(r.recovery.workerStatus(r.node).eligible,false);
  r.node.drained=false;assert.throws(()=>r.recovery.request(r.input(),'operator'),/caller_not_enrolled/);
  assert.throws(()=>r.recovery.request(r.input(),'operator',{canary:true}),/drain_before_canary/);
  r.node.drained=true;const op=await r.canary();assert.equal(op.state,'verified_paused');assert.equal(r.bootstraps,1);
  r.node.drained=false;r.advance(31*60000);await r.remove();
  assert.equal(r.recovery.workerStatus(r.node).reason,'launchd_bootstrap_caller_not_enrolled');
  assert.equal(r.recovery.workerStatus(r.node).eligible,false);assert.equal(r.bootstraps,1);
  r.node.drained=true;r.hooks.removal=value=>({...value,status:'exact_stop_request_observed',observations:[...value.observations,{at:value.checked_at-1,caller:'launchctl'}],records:2});
  await r.recovery.inspect(c.id,{freshRemoval:true});
  assert.throws(()=>r.recovery.request({worker_id:c.id},'operator',{canary:true}),/removal_unverified/);
  await r.recovery.close();
});
test('acknowledged removed-job canary certifies exact enrollment, stays paused, then enables detector recovery',async()=>{
  const r=rig();await r.ready();await r.remove();
  assert.equal(r.recovery.workerStatus(r.node).eligible,false);
  assert.throws(()=>r.recovery.request(r.input(),'genie',{canary:true}));
  const op=await r.canary();assert.equal(op.state,'verified_paused');assert.equal(op.bootstrap_acknowledged,true);
  assert.equal(r.bootstraps,1);assert.equal(r.proofs,1);assert.equal(r.node.drained,true);assert.ok(r.node.quarantine);
  assert.equal(r.recovery.workerStatus(r.node).bootstrap.certified,true);
  const publicText=JSON.stringify(r.recovery.status());for(const hidden of [boot,c.profile,c.retained_definition_sha256,'bootstrap_prior','bootstrap_enrollment'])assert.ok(!publicText.includes(hidden));
  r.node.drained=false;r.advance(31*60000);await r.remove('loginwindow');
  assert.equal(r.recovery.workerStatus(r.node).eligible,true);
  r.recovery.setAutomatic(true);await r.recovery.tick();await r.recovery.task;
  const repaired=r.recovery.state.operations.at(-1);assert.equal(repaired.actor,'detector');assert.equal(repaired.service_action,'bootstrap');assert.equal(repaired.state,'recovered');
  assert.equal(r.bootstraps,2);assert.equal(r.node.healthy,true);assert.equal(r.node.quarantine,null);
  await r.recovery.close();
});
test('fresh native evidence, matching helper authority and complete prior identity are mandatory',async()=>{
  const cases=[
    ['helper pin',s=>({...s,bootstrap:{...s.bootstrap,definition_sha256:'e'.repeat(64)}})],
    ['helper callers',s=>({...s,bootstrap:{...s.bootstrap,callers:['runningboardd']}})],
    ['no helper capability',s=>({...s,bootstrap:undefined})],['changed boot',s=>({...s,boot_uuid:'87654321-1234-1234-1234-123456789abc'})],
    ['port occupied',s=>({...s,listener:true})],['native disabled',s=>({...s,native_disabled:true})],['unknown native policy',s=>({...s,native_disabled:null})]
  ];
  for(const [name,modify] of cases){
    const r=rig();await r.ready();r.hooks.inspect=modify;await r.remove();
    assert.throws(()=>r.recovery.request({worker_id:r.node.id},'operator',{canary:true}),undefined,name);
    assert.equal(r.bootstraps,0);await r.recovery.close();
  }
  const r=rig();await r.ready();await r.remove();r.advance(61000);
  assert.throws(()=>r.recovery.request({worker_id:r.node.id},'operator',{canary:true}),/removal_unverified/);
  await r.ready();assert.equal(r.captures,2);await r.recovery.close();
});
test('ordinary requests need the removed-job certificate, correct caller, no pause and cooldown',async()=>{
  const r=rig();await r.ready();await r.remove('loginwindow');r.node.drained=false;
  assert.equal(r.recovery.workerStatus(r.node).reason,'launchd_bootstrap_canary_required');
  assert.throws(()=>r.recovery.request(r.input()),/canary_required/);
  r.node.drained=true;await r.canary();r.node.drained=false;await r.remove('loginwindow');
  assert.equal(r.recovery.workerStatus(r.node).reason,'recovery_cooldown');r.advance(31*60000);await r.ready();
  assert.equal(r.recovery.workerStatus(r.node).eligible,true);r.node.drained=true;assert.equal(r.recovery.workerStatus(r.node).reason,'operator_paused');
  r.node.drained=false;await r.remove('launchctl');await r.recovery.inspect(c.id,{freshRemoval:true});assert.equal(r.recovery.workerStatus(r.node).reason,'launchd_bootstrap_caller_not_enrolled');
  r.recovery.configs.set(c.id,{...c,helper:'/opt/dsg/changed.py'});assert.equal(r.recovery.bootstrapCertified(r.node,r.recovery.config(c.id)),false);
  assert.equal(r.recovery.priorIdentity(c.id),null);await r.recovery.close();
});
test('agent holds and maintenance locks block even operator canaries',async()=>{
  for(const kind of ['agent','maintenance']){
    const r=rig();await r.ready();await r.remove();
    const agents=new AgentControl({store:r.store,nodes:[r.node],canResume:async()=>{},onPause:ids=>r.recovery.operatorPause(ids)});
    if(kind==='agent'){agents.grant({agent_id:'maintainer',workers:[c.id]});await agents.act('maintainer','drain',{worker_id:c.id,reason:'fixture maintenance',request_id:randomUUID()});}
    else agents.maintenanceLock({worker_id:c.id,name:'fixture maintenance',reason:'fixture work',request_id:randomUUID(),review_after_hours:null});
    assert.throws(()=>r.recovery.request({worker_id:c.id},'operator',{canary:true}),/maintenance_hold_active/);
    assert.equal(r.bootstraps,0);await r.recovery.close();
  }
});
test('holds, new admitted work and native changes during fresh pre-command inspection veto issuance',async()=>{
  for(const kind of ['hold','pause','work','native','machine']){
    const r=rig();await r.ready();await r.remove();
    r.hooks.removal=(value,count)=>{if(count===2){
      if(kind==='hold')r.store.data.agent_control={holds:[{worker_id:c.id}],maintenance_locks:[]};
      if(kind==='pause')r.recovery.operatorPause([c.id]);
      if(kind==='work')r.node.queue.push({});
      if(kind==='native')r.hooks.inspect=s=>({...s,native_disabled:true});
    }return value;};
    // A native change is independently checked by the helper at command time;
    // model it in the initial fresh inspection, before removal capture instead.
    if(kind==='native')r.hooks.inspect=s=>({...s,native_disabled:true});
    if(kind==='machine')r.hooks.inspect=s=>({...s,machine:'e'.repeat(64)});
    const result=await r.canary();assert.ok(['failed','reconciliation_needed'].includes(result.state),kind);assert.equal(r.bootstraps,0,kind);
    await r.recovery.close();
  }
});
test('a hold arriving after durable issuance intent still prevents the helper call',async()=>{
  const r=rig();await r.ready();await r.remove();r.hooks.saved=next=>{if(next.recovery?.operations.at(-1)?.state==='bootstrapping')r.store.data.agent_control={holds:[{worker_id:c.id}],maintenance_locks:[]};};
  const op=await r.canary();assert.equal(op.state,'reconciliation_needed');assert.equal(r.bootstraps,0);assert.equal(r.proofs,0);await r.recovery.close();
});
test('lost acknowledgement can verify a replacement but cannot certify automatic bootstrap',async()=>{
  const r=rig();await r.ready();await r.remove();r.hooks.bootstrap=()=>{throw new Error('private uncertain acknowledgement');};
  const op=await r.canary();assert.equal(op.state,'verified_paused');assert.equal(r.bootstraps,1);assert.equal(r.recovery.workerStatus(r.node).bootstrap.certified,false);
  r.node.drained=false;r.advance(31*60000);await r.remove('loginwindow');assert.equal(r.recovery.workerStatus(r.node).reason,'launchd_bootstrap_canary_required');await r.recovery.close();
});
test('verification requires real cold/warm proof; native identity or maintenance change never readmits',async()=>{
  for(const kind of ['empty proof','bad warm','native disabled','boot changed','hold','context changed','enrollment changed']){
    const r=rig();await r.ready();await r.remove();r.hooks.verify=value=>{
      if(kind==='empty proof')return {samples:[]};
      if(kind==='bad warm')return {...value,samples:value.samples.map(s=>({...s,cached_tokens:0}))};
      if(kind==='native disabled')r.hooks.inspect=s=>({...s,native_disabled:true});
      if(kind==='boot changed')r.hooks.inspect=s=>({...s,boot_uuid:'87654321-1234-1234-1234-123456789abc'});
      if(kind==='hold')r.store.data.agent_control={holds:[{worker_id:c.id}],maintenance_locks:[]};
      if(kind==='context changed')r.node.contextLength=131072;
      if(kind==='enrollment changed')r.recovery.configs.set(c.id,{...c,retained_definition_sha256:'e'.repeat(64)});
      return value;
    };
    const op=await r.canary();assert.equal(op.state,'failed',kind);assert.equal(r.recovery.workerStatus(r.node).bootstrap.certified,false,kind);assert.ok(r.node.quarantine);await r.recovery.close();
  }
});
test('restart reconciliation only observes and validates; malformed or rebound bootstrap operations fail closed',async()=>{
  const r=rig();await r.ready();await r.remove();const op=await r.canary();await r.recovery.close();
  const saved=structuredClone(r.store.data);
  for(const change of [{service_action_issued:false},{was_paused:false},{bootstrap_acknowledged:false},{operator_override:true}]){
    r.store.data=structuredClone(saved);Object.assign(r.store.data.recovery.operations[0],change);
    assert.equal(r.recovery.bootstrapCertified(r.node,c),false);
  }
  for(const change of [{bootstrap_prior:null},{bootstrap_enrollment:'bad'},{bootstrap_definition_sha256:'bad'},{canary:true,actor:'genie'},{bootstrap_acknowledged:'yes'}]){
    r.store.data=structuredClone(saved);Object.assign(r.store.data.recovery.operations[0],change);
    assert.throws(()=>new Recovery({workers:[c]},r.deps),/Invalid recovery operation/);
  }
  r.store.data=structuredClone(saved);Object.assign(r.store.data.recovery.operations[0],{state:'reconciling',bootstrap_acknowledged:false});
  const restored=new Recovery({workers:[c]},r.deps);await restored.tick();await restored.task;
  assert.equal(r.bootstraps,1);assert.equal(restored.state.operations[0].state,'verified_paused');assert.equal(restored.workerStatus(r.node).bootstrap.certified,false);await restored.close();
  r.store.data=structuredClone(saved);r.store.data.recovery.operations[0].state='reconciling';
  const rebound=new Recovery({workers:[{...c,retained_definition_sha256:'e'.repeat(64)}]},r.deps);await rebound.tick();await rebound.task;
  assert.equal(rebound.state.operations[0].state,'failed');assert.equal(rebound.state.operations[0].error,'bootstrap_enrollment_changed');assert.equal(r.bootstraps,1);await rebound.close();
  assert.equal(bootstrapProofValid(op.proof,262144),true);assert.equal(bootstrapProofValid(op.proof,131072),false);
});
test('an external replacement does not earn a bootstrap certificate, and Genie sees no private enrollment',async()=>{
  const r=rig();await r.ready();await r.remove();r.restore();
  const op=await r.canary();assert.equal(op.state,'verified_paused');assert.equal(r.bootstraps,0);
  assert.equal(r.recovery.workerStatus(r.node).bootstrap.certified,false);
  const state=r.recovery.status();state.workers[0].bootstrap.private_path='/PRIVATE/enrollment';
  const value=briefing({gateway:{workers:[{id:c.id}],recovery:state},devices:[]});
  assert.deepEqual(value.workers[0].recovery_evidence.bootstrap,{enrolled:true,certified:false});
  const text=JSON.stringify(value);for(const hidden of ['/PRIVATE/enrollment',c.profile,c.retained_definition_sha256,boot])assert.ok(!text.includes(hidden));
  await r.recovery.close();
});
test('automatic policy revoked during fresh inspection cannot issue a previously accepted bootstrap',async()=>{
  const r=rig();await r.ready();await r.remove();await r.canary();r.node.drained=false;r.advance(31*60000);await r.remove('loginwindow');
  r.recovery.setAutomatic(true);r.hooks.removal=value=>{r.recovery.setAutomatic(false);return value;};
  r.recovery.request(r.input(),'genie');await r.recovery.task;
  assert.equal(r.recovery.state.operations.at(-1).state,'failed');assert.equal(r.bootstraps,1);assert.ok(r.node.quarantine);await r.recovery.close();
});
