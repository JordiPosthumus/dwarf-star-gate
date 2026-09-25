import assert from 'node:assert/strict';
import {isDeepStrictEqual} from 'node:util';
import {createHash} from 'node:crypto';
import {mediaContainerSignature} from './spark-media-cycle.mjs';

// Existing-worker setup borrows the same maintenance controls and native media
// qualifier as normal media work. The caller supplies the enrolled connections;
// neither model text nor this lifecycle supplies shell commands or LLM settings.
export async function runMediaSetup(plan,io){
 const {save,progress,maintenance,inspect,start,stop,recoveryInspect,verify,delay}=io;
 let original,stopped=false,preparation,proof,error,returned=false;
 const unchanged=async()=>assert.ok(isDeepStrictEqual(mediaContainerSignature(await inspect(plan.llm_container)),mediaContainerSignature(original)),'Original LLM configuration changed');
 try{
  assert.ok(Array.isArray(plan.engines)&&plan.engines.length&&new Set(plan.engines).size===plan.engines.length&&plan.engines.every(e=>['h3','ace-step'].includes(e)),'Choose supported media engines');
  await io.pair?.capture();
  original=await inspect(plan.llm_container);
  assert.match(original.Id,/^[a-f0-9]{64}$/,'Docker inspection must identify the full original container ID');
  // Names are valid installation references. Pin this operation to the
  // inspected ID so a later name reassignment cannot redirect stop or return.
  save('llm-resolution.json',{configured:plan.llm_container,container:original.Id});
  plan={...plan,llm_container:original.Id};
  const recovery=await recoveryInspect();
  assert.equal(original.State.Running,true);assert.equal(recovery.profile,plan.recovery.profile);
  assert.equal(recovery.listener,true);assert.equal(recovery.fault,null);
  assert.equal(recovery.instance,createHash('sha256').update(JSON.stringify([original.Id,original.State.StartedAt])).digest('hex').slice(0,32),'Recovery and setup must identify the same original LLM');
  save('llm-before.json',original);
  progress('waiting_idle','Waiting for admitted and direct LLM work before preparing media.');
  await maintenance('prepare');assert.equal((await maintenance('transition')).owned,true);
  await unchanged();await io.pair?.check();save('stop-llm-intent.json',{container:plan.llm_container});stopped=true;
  if(io.pair)await io.pair.stop(plan.llm_container);else await stop(plan.llm_container);assert.equal((await inspect(plan.llm_container)).State.Running,false);
  progress('preparing_media',plan.reuse?'Checking the exact retained media preparation before fresh qualification.':'Building and downloading only the selected media engines.');
  save('prepare-intent.json',{engines:plan.engines,target:plan.target});
  let acknowledgement;
  try{acknowledgement=await io.prepare(plan.llm_container);save('prepare-acknowledgement.json',acknowledgement);}
  catch(e){save('prepare-uncertain.json',{error:e.message});}
  if(acknowledgement?.state==='refused')throw Error(acknowledgement.error??'Preparation preflight refused; no work was launched');
  // A lost acknowledgement is not a failed install. Observe the same target,
  // never launch another build or restore over a process still using the host.
  for(;;){
   let state;
   try{state=await io.readPreparation();save('preparation.json',state);}
   catch{progress('observing_preparation','Setup status is unavailable; observing the original operation.');await delay(3000);continue;}
   if(state.process_running===false&&state.state==='prepared_stopped')break;
   if(state.process_running===false&&state.state==='needs_attention')throw Error(state.error??'Media preparation failed; files are retained.');
   progress('preparing_media',`${state.progress?.engine??'Selected media'}: ${state.progress?.phase??state.state}.`);await delay(3000);
  }
  assert.equal((await maintenance('transition')).owned,true);
  preparation=await io.preparedMedia();
  assert.equal(preparation.llm_container,plan.llm_container);
  assert.deepEqual(Object.keys(preparation.engines).sort(),[...plan.engines].sort(),'Prepared engine selection changed');
  save('prepared-media.json',preparation);
  progress('qualifying_media','Generating, retaining and checking a sample from each selected engine.');
  proof=await io.qualify(preparation);
  assert.equal(proof.state,'qualified_stopped');save('media-proof.json',proof);
 }catch(e){error=e;save('failure.json',{error:e.message});}
 finally{
  try{
   if(stopped){
    assert.equal((await maintenance('owned')).owned,true);
    for(const engine of Object.values(preparation?.engines??{}))assert.equal((await inspect(engine.container)).State.Running,false,'Media qualification has not released its engine');
    await unchanged();save('restore-llm-intent.json',{container:plan.llm_container});
    if(io.pair)await io.pair.restore(plan.llm_container);else if(!(await inspect(plan.llm_container)).State.Running)await start(plan.llm_container);
    progress('restoring_llm','Loading the original LLM with unchanged settings.');
    for(;;){
     let state;try{state=await recoveryInspect();}catch{await delay(5000);continue;}
     assert.equal(state.profile,plan.recovery.profile);assert.equal(state.fault,null);
     if(state.listener)break;await delay(5000);
    }
    progress('checking_llm',io.pair?'Verifying both original GLM containers and a native readiness response.':'Checking real responses and cold-to-warm cache reuse.');
    save('llm-proof.json',await verify());
    const result=await maintenance('finish');save('readmission.json',result);assert.equal(result.state,'readmitted');returned=true;
    progress(error?'failed_returned':'qualified_returned',error?`Setup failed; original LLM returned: ${error.message}`:'Selected media qualified; original LLM verified and returned.');
   }else if(io.hasMaintenanceIntent()){
    assert.equal((await maintenance('owned')).owned,true);await unchanged();save('llm-proof.json',await verify());
    const result=await maintenance('finish');save('readmission.json',result);assert.equal(result.state,'readmitted');returned=true;
    progress('failed_returned',error?.message??'Setup did not start; original LLM returned.');
   }else progress('failed_unchanged',error?.message??'Setup did not start.');
  }catch(e){error=e;save('restoration-needs-attention.json',{error:e.message});progress('needs_attention',`LLM return needs attention: ${e.message}`);}
 }
 if(error)throw error;
 assert.ok(returned&&proof,'Media setup and original LLM return must both finish');
 return {state:'qualified_returned',preparation,proof,scope:'Selected media qualification and original-LLM return. Saving media enrollment is a separate final step.'};
}
