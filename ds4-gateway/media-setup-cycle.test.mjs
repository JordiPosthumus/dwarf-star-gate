import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {runMediaSetup} from './media-setup-cycle.mjs';

function fixture(){
 const llmId='a'.repeat(64),llm={Id:llmId,Image:'original',Config:{Cmd:['original','--context','262144']},HostConfig:{},Mounts:[],State:{Running:true,StartedAt:'original-instance'}},media={Id:'ace',State:{Running:false}};
 const calls=[],receipts={};let intent=false;
 const plan={worker_id:'one',operation_id:'setup-one',llm_container:llmId,recovery:{profile:'original-profile'},engines:['ace-step'],target:{directory:'/fixture/selected-media'}};
 const preparation={llm_container:llmId,engines:{'ace-step':{container:'ace'}}};
 const io={save:(name,value)=>receipts[name]=structuredClone(value),progress:(state)=>calls.push('phase:'+state),delay:async()=>calls.push('wait'),
  maintenance:async action=>{calls.push(action);if(action==='prepare')intent=true;return action==='finish'?{state:'readmitted'}:{owned:true};},hasMaintenanceIntent:()=>intent,
  inspect:async id=>structuredClone(id===llmId?llm:media),stop:async id=>{assert.equal(id,llmId);calls.push('stop:llm');llm.State.Running=false;},start:async id=>{assert.equal(id,llmId);calls.push('start:llm');llm.State.Running=true;},
  recoveryInspect:async()=>({profile:'original-profile',listener:true,fault:null,instance:createHash('sha256').update(JSON.stringify([llm.Id,llm.State.StartedAt])).digest('hex').slice(0,32)}),verify:async()=>{calls.push('verify');return {native:'fixture'};},
  prepare:async id=>{assert.equal(id,llmId);calls.push('prepare:selected');assert.equal(llm.State.Running,false);return {state:'accepted'};},
  readPreparation:async()=>({state:'prepared_stopped',process_running:false}),preparedMedia:async()=>preparation,
  qualify:async p=>{calls.push('qualify:music');assert.equal(p,preparation);assert.equal(llm.State.Running,false);return {state:'qualified_stopped',engines:{'ace-step':{native:'fixture'}}};},
 };
 return {plan,io,calls,receipts,llm,media,preparation};
}

test('existing-worker music setup drains, prepares selected media, qualifies and verifies original LLM return',async()=>{
 const f=fixture(),before=structuredClone(f.llm);const result=await runMediaSetup(f.plan,f.io);
 assert.equal(result.state,'qualified_returned');assert.deepEqual(f.llm,before);
 assert.deepEqual(f.calls.filter(c=>!c.startsWith('phase:')),['prepare','transition','stop:llm','prepare:selected','transition','qualify:music','owned','start:llm','verify','finish']);
 assert.ok(f.receipts['media-proof.json']);assert.ok(f.receipts['llm-proof.json']);assert.equal(f.receipts['readmission.json'].state,'readmitted');
});
test('configured container name resolves once; preparation, stop and return use its full ID',async()=>{
 const f=fixture(),inspect=f.io.inspect;
 f.plan.llm_container='qwen-serving';let nameReads=0;
 f.io.inspect=async id=>{
  if(id==='qwen-serving'){assert.equal(++nameReads,1,'Never resolve the name again after it may have been reassigned');return structuredClone(f.llm);}
  return inspect(id);
 };
 const result=await runMediaSetup(f.plan,f.io);
 assert.equal(result.state,'qualified_returned');assert.equal(nameReads,1);
 assert.deepEqual(f.receipts['llm-resolution.json'],{configured:'qwen-serving',container:f.llm.Id});
 assert.equal(f.receipts['stop-llm-intent.json'].container,f.llm.Id);
 assert.equal(f.receipts['restore-llm-intent.json'].container,f.llm.Id);
 assert.equal(f.plan.llm_container,'qwen-serving','Installation configuration is not rewritten');
});
test('lost start acknowledgement and missing status observe the same accepted setup without replay or early restoration',async()=>{
 const f=fixture();let reads=0;
 f.io.prepare=async()=>{f.calls.push('prepare:selected');throw Error('ack lost');};
 f.io.readPreparation=async()=>{assert.equal(f.llm.State.Running,false);reads++;if(reads===1)throw Error('SSH unavailable');return reads===2?{state:'running',process_running:true}:{state:'prepared_stopped',process_running:false};};
 await runMediaSetup(f.plan,f.io);assert.equal(reads,3);assert.equal(f.calls.filter(c=>c==='prepare:selected').length,1);assert.ok(f.receipts['prepare-uncertain.json']);
});
test('terminal preparation or native qualification failure still returns the unchanged original LLM',async()=>{
 for(const stage of ['prepare','qualify']){
  const f=fixture();if(stage==='prepare')f.io.readPreparation=async()=>({state:'needs_attention',process_running:false,error:'disk full'});else f.io.qualify=async()=>{throw Error('media decode failed');};
  await assert.rejects(runMediaSetup(f.plan,f.io),stage==='prepare'?/disk full/:/decode failed/);
  assert.equal(f.llm.State.Running,true);assert.ok(f.calls.includes('verify'));assert.ok(f.calls.includes('finish'));assert.equal(f.calls.at(-1),'phase:failed_returned');
 }
});
test('definitive preflight refusal returns the LLM without waiting for a nonexistent installer',async()=>{
 const f=fixture();f.io.prepare=async()=>({state:'refused',error:'unsupported platform'});f.io.readPreparation=async()=>{assert.fail('No installation was launched');};
 await assert.rejects(runMediaSetup(f.plan,f.io),/unsupported platform/);assert.equal(f.llm.State.Running,true);assert.ok(f.calls.includes('finish'));
});
test('stale retained-media preflight leaves the current LLM serving without taking a hold',async()=>{
 const f=fixture();f.io.preflight=async id=>{assert.equal(id,f.llm.Id);assert.equal(f.llm.State.Running,true);throw Error('retained image changed');};
 await assert.rejects(runMediaSetup(f.plan,f.io),/retained image changed/);
 assert.deepEqual(f.calls,['phase:failed_unchanged']);assert.equal(f.llm.State.Running,true);assert.equal(f.receipts['stop-llm-intent.json'],undefined);
});
test('changed original settings or a still-running media engine prevents unsafe return',async()=>{
 for(const change of ['settings','media']){
  const f=fixture();f.io.qualify=async()=>{if(change==='settings')f.llm.Config.Cmd=['someone-else'];else f.media.State.Running=true;throw Error('qualification failed');};
  await assert.rejects(runMediaSetup(f.plan,f.io));assert.ok(!f.calls.includes('start:llm'));assert.ok(!f.calls.includes('finish'));assert.equal(f.calls.at(-1),'phase:needs_attention');
 }
});
test('LLM cache-proof failure leaves admission paused and explicitly needs attention',async()=>{
 const f=fixture();f.io.verify=async()=>{throw Error('cache proof failed');};
 await assert.rejects(runMediaSetup(f.plan,f.io),/cache proof/);assert.equal(f.llm.State.Running,true);assert.ok(!f.calls.includes('finish'));assert.equal(f.calls.at(-1),'phase:needs_attention');
});
test('minimum-serving-floor refusal never stops the LLM and releases owned maintenance after verification',async()=>{
 const f=fixture(),maintenance=f.io.maintenance;f.io.maintenance=async action=>{if(action==='transition')throw Error('another LLM is required');return maintenance(action);};
 await assert.rejects(runMediaSetup(f.plan,f.io),/another LLM/);assert.ok(!f.calls.includes('stop:llm'));assert.ok(f.calls.includes('verify'));assert.ok(f.calls.includes('finish'));
});
test('unmatched recovery instance or invalid selection never acquires maintenance or changes a server',async()=>{
 for(const which of ['instance','selection']){
  const f=fixture();if(which==='instance'){const original=f.io.recoveryInspect;f.io.recoveryInspect=async()=>({...await original(),instance:'different'});}else f.plan.engines=['qwen38-repaired'];
  await assert.rejects(runMediaSetup(f.plan,f.io));assert.deepEqual(f.calls,['phase:failed_unchanged']);assert.equal(f.llm.State.Running,true);
 }
});
