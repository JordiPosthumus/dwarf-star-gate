import assert from 'node:assert/strict';
import {verifyAceGeneration} from './ace-generation-proof.mjs';
import {verifyRecovery,glmRecoveryProofValid} from './recovery-verify.mjs';

// A fixed synthetic song exercises the owner's AceFarm defaults. It is not an
// album track, a voice-identity check, or permission to replace model settings.
export const aceQualificationPayload=()=>({
 prompt:'Male vocal, dark rhythm and blues, deep 808 bass, dark synthesizers.',
 lyrics:'[Verse]\nWe keep the lights on through the night\nEach promise measured, each step right\n[Chorus]\nCarry the song and bring it home\nKeep the signal steady as we roam',
 seed:11,use_random_seed:false,batch_size:1,thinking:false,
 inference_steps:80,guidance_scale:3,sampler_mode:'heun',dcw_enabled:false,
 audio_duration:-1,audio_format:'flac',infer_method:'ode',
});
const descriptor={schema:1,source:'acestep.inference.audio.params',per_audio:true,query_paths:['cache','store']};
export function assertAceSourceProof(proof,engine){
 assert.ok(proof?.state==='verified'&&proof.container===engine.container&&proof.image===engine.image&&proof.container_state_unchanged===true,'Exact candidate source proof required');
 assert.match(proof.receipt_sha256,/^[a-f0-9]{64}$/);
 assert.deepEqual(proof.generation_receipt,descriptor,'Native generation receipt support required before drain');
}

// Invoked only by a saved candidate plan. Ordinary media jobs retain their
// existing contract. All failures propagate through runMediaCycle's restoration.
export function createAceQualification(plan,{read,save,pair,verifyPrepared,verifyAudio=verifyAceGeneration,verifyCache=verifyRecovery}){
 const qualification=plan.ace_qualification;
 assert.ok(qualification?.schema===1&&plan.command_journal_version===1&&pair&&plan.llm_pair&&!plan.media_lanes&&!plan.job_ids,'Qualification requires one journaled paired-GLM music job');
 let source,audio,llm;
 return {
  async preflight(){
   assert.equal(typeof verifyPrepared,'function','Native prepared candidate recheck required');
   assert.deepEqual(await verifyPrepared(),qualification.prepared_result,'Prepared original/candidate native state changed');
   const receipt=read('media-recipe-contracts.json');
   source=receipt.proofs?.['media-'+plan.llm_pair.media_member];
   assertAceSourceProof(source,plan.engine);
   assert.deepEqual(source,qualification.source_proof,'Prepared candidate source changed');
  },
  async verifyOutputs({jobs,backend}){
   const job=jobs.get(plan.operation_id);
   assert.deepEqual(job.payload,aceQualificationPayload(),'Fixed qualification recipe changed');
   audio=await verifyAudio(job,{engine:plan.engine,sourceProof:source,backend,results:jobs.results});
   save('ace-audio-proof.json',audio);
  },
  async verifyReturn(){
   const original=await pair.verify();
   assert.equal(original.configuration_unchanged,true);
   assert.equal(original.context_length,plan.context_length,'Original context differs from qualification plan');
   const cache=await verifyCache(plan.recovery.url,plan.llm_pair.model,original.context_length,{kind:'glm53_vllm',endpoint:plan.endpoint,
    onSample:sample=>save('ace-cache-'+sample.label+'.json',sample)});
   assert.ok(glmRecoveryProofValid(cache,original.context_length),'GLM cold-to-warm cache return is unverified');
   await pair.check();
   llm={...original,cache,scope:'Exact original pair settings and readiness, plus two interleaved cold-to-warm histories. Does not exercise maximum context, output or concurrent-request boundaries.'};
   return llm;
  },
  completion(){
   assert.ok(audio?.state==='audio_verified'&&llm&&glmRecoveryProofValid(llm.cache,plan.context_length),'Audio and LLM-return qualification must both pass');
   return {schema:1,state:'qualified_returned',candidate_operation_id:qualification.candidate_operation_id,job_id:plan.operation_id,
    container:plan.engine.container,image:plan.engine.image,source_receipt_sha256:source.receipt_sha256,
    audio_proof:'ace-audio-proof.json',llm_proof:'llm-proof.json',enrollment_changed:false,
    scope:'Dated native recipe/audio and original GLM return evidence. No enrollment promotion, model-weight/voice identity, or maximum-capacity qualification.'};
  },
 };
}
