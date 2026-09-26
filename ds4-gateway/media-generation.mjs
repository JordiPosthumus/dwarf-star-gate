import assert from 'node:assert/strict';
import {openAsBlob} from 'node:fs';
import {watchMediaProgress} from './media-progress.mjs';
import {validateVideoCatalog} from './media-validation.mjs';

export async function mediaEngineIdle(backend,kind){
  if(kind==='ace-step'){
    const {data}=await backend.request('/v1/stats');
    const counts=[data?.jobs?.queued,data?.jobs?.running,data?.queue_size];
    assert.ok(counts.every(n=>Number.isSafeInteger(n)&&n>=0),'ACE-Step queue observation unavailable');
    return counts.every(n=>n===0);
  }
  const q=await backend.request('/queue');
  assert.ok(Array.isArray(q?.queue_running)&&Array.isArray(q?.queue_pending),'Media queue observation unavailable');
  return q.queue_running.length+q.queue_pending.length===0;
}

// One native slot, with immutable job identities. Coordinators own the service
// lifecycle; this loop cannot start/stop engines or release a pair reservation.
export async function runMediaGeneration(plan,io){
  const {jobs,backend,save,delay,maintenance}=io,ids=plan.job_ids??[plan.operation_id];
  let activeId=ids[0],native;
  const progress=(phase,detail)=>io.progress(phase,detail,{active_job_id:activeId,batch_index:ids.indexOf(activeId)+1,batch_size:ids.length,
    native_progress:['generating','observing_media'].includes(phase)?native?.snapshot()??null:null});
  try{
    for(const id of ids){
      activeId=id;io.onJob?.(id);const job=jobs.get(id);
      if(io.shouldContinue&&!(await io.shouldContinue()))break;
      if(id!==ids[0]&&io.continueBatch){
        let proceed=false;
        try{proceed=await io.continueBatch(job);}catch(e){save('batch-check-unavailable.json',{error:e.message});}
        if(!proceed){save('batch-yield.json',{remaining_job_ids:ids.slice(ids.indexOf(id)),reason:'Batch continuation deferred. Restore the LLM and release unstarted jobs.'});break;}
      }
      for(const input of job.payload.input_files===undefined?[]:jobs.inputs.forJob(job.payload.input_files)){
        progress('transferring_inputs',`Sending reference file ${input.name} to the selected engine.`);
        await backend.uploadInput(await openAsBlob(jobs.inputs.file(input.id),{type:input.content_type}),input.name);
      }
      if(plan.engine.kind==='comfyui')validateVideoCatalog(job.payload,await backend.request('/object_info'));
      assert.ok(await mediaEngineIdle(backend,plan.engine.kind),'Media engine already has native work');
      assert.equal((await maintenance('transition')).owned,true);
      // A sibling may fail while this lane was transferring inputs. Only work
      // already submitted continues; no new job starts after the shared veto.
      if(io.shouldContinue&&!(await io.shouldContinue()))break;
      native=(io.watchProgress??watchMediaProgress)(backend,job.id,job.payload.prompt);
      progress('generating','Submitting the saved media job once.');
      await jobs.dispatch(job.id,backend,plan.worker_id);
      for(;;){
        let observed;
        try{observed=await jobs.observe(job.id,backend);}
        catch{progress('observing_media','Native progress is temporarily unavailable; observing the original job without repeating it.');await delay(3000);continue;}
        progress('generating',`Native job: ${observed.state}.`);
        if(['completed','failed'].includes(observed.state)){if(observed.state==='failed')throw Error(observed.detail??'Native media generation failed; inspect the saved native task receipt');break;}
        await delay(3000);
      }
      native?.close();native=null;
      progress('retaining_results','Saving generated files before releasing the media engine.');
      await jobs.collect(job.id,backend);
    }
  }catch(e){
    if(jobs.get(activeId).state==='queued')jobs.update(activeId,{state:'failed',detail:e.message});
    throw e;
  }finally{native?.close();}
  return {completed_job_ids:ids.filter(id=>jobs.get(id).state==='completed'),unstarted_job_ids:ids.filter(id=>jobs.get(id).state==='queued')};
}
