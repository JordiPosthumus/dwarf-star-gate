import assert from 'node:assert/strict';
import {isDeepStrictEqual} from 'node:util';
import {createHash} from 'node:crypto';

// A failed observation does not mean an already-started model failed. Keep
// observing the same return; start/stop and generation are never retried here.
export async function waitForMediaLlm(plan,{recoveryInspect,progress,delay,save}){
  for(;;){
    let current;
    try{current=await recoveryInspect();}
    catch(e){
      save('llm-inspection-retry.json',{error:e.message});
      progress('restoring_llm',`LLM readiness check unavailable (${e.message}); checking again without restarting it.`);
      await delay(5000);continue;
    }
    assert.equal(current.profile,plan.recovery.profile);
    if(current.listener&&!current.fault)return current;
    progress('restoring_llm','Original LLM is loading with unchanged settings.');
    await delay(5000);
  }
}

// Testable lifecycle, shared by the detached product runner. Native generation
// is submitted once. Waiting observes the same job without a cancellation limit.
export async function runMediaCycle(plan,io){
  const {jobs,save,progress,maintenance,inspect,start,stop,recoveryInspect,verify,connect,delay}=io;
  let before,connection,stopped=false,mediaStarted=false,ready=false,error;
  const unchanged=(a,b)=>{
    for(const key of ['Id','Image','Config','HostConfig']){
      // Docker normalizes the unset OOM-killer flag from false to null on the
      // first start. Both leave OOM killing enabled; true must still differ.
      const value=x=>key==='HostConfig'?{...x[key],OomKillDisable:x[key].OomKillDisable??false}:x[key];
      if(!isDeepStrictEqual(value(a),value(b)))throw new Error(`Container ${key} changed`);
    }
    const mounts=x=>[...x.Mounts].sort((a,b)=>a.Destination.localeCompare(b.Destination));
    if(!isDeepStrictEqual(mounts(a),mounts(b)))throw new Error('Container mounts changed');
  };
  const mediaIdle=async()=>{
    if(plan.engine.kind==='ace-step'){
      const {data}=await connection.backend.request('/v1/stats');
      const counts=[data?.jobs?.queued,data?.jobs?.running,data?.queue_size];
      assert.ok(counts.every(n=>Number.isSafeInteger(n)&&n>=0),'ACE-Step queue observation unavailable');
      return counts.every(n=>n===0);
    }
    const q=await connection.backend.request('/queue');
    return q.queue_running.length+q.queue_pending.length===0;
  };
  try{
    assert.ok(['comfyui','ace-step'].includes(plan.engine.kind),'Unsupported media engine');
    const initial=await recoveryInspect();assert.equal(initial.profile,plan.recovery.profile);assert.equal(initial.listener,true);assert.equal(initial.fault,null);
    before={llm:await inspect(plan.llm_container),media:await inspect(plan.engine.container)};
    const instance=createHash('sha256').update(JSON.stringify([before.llm.Id,before.llm.State.StartedAt])).digest('hex').slice(0,32);
    assert.equal(initial.instance,instance,'Media enrollment and recovery must identify the same LLM container');
    assert.equal(before.llm.State.Running,true);assert.equal(before.media.State.Running,false);assert.equal(before.media.Image,plan.engine.image);save('containers-before.json',before);
    progress('waiting_idle','Waiting for this worker’s admitted and direct LLM work to finish.');
    await maintenance('prepare');assert.equal((await maintenance('transition')).owned,true);
    unchanged(await inspect(plan.llm_container),before.llm);unchanged(await inspect(plan.engine.container),before.media);
    save('stop-llm-intent.json',{container:plan.llm_container});stopped=true;await stop(plan.llm_container);
    assert.equal((await inspect(plan.llm_container)).State.Running,false);
    progress('starting_media','LLM drained and stopped; starting its enrolled media engine.');
    connection=await connect();save('start-media-intent.json',{container:plan.engine.container});mediaStarted=true;await start(plan.engine.container);
    for(let i=0;i<120;i++){
      try{
        const health=await connection.backend.request(plan.engine.kind==='ace-step'?'/health':'/system_stats');
        if(plan.engine.kind==='ace-step')assert.ok(health?.data?.status==='ok'&&health.data.models_initialized===true,'ACE-Step model is still loading');
        ready=true;break;
      }
      catch{if(!(await inspect(plan.engine.container)).State.Running)throw new Error('Media container exited before readiness');await delay(3000);}
    }
    assert.ok(ready,'Media readiness not established; no generation submitted');
    const job=jobs.get(plan.operation_id);
    if(plan.engine.kind==='comfyui'){
      const catalog=await connection.backend.request('/object_info');
      assert.ok(job.payload.prompt&&Object.keys(job.payload.prompt).length,'Supply a native ComfyUI workflow');
      for(const node of Object.values(job.payload.prompt))assert.ok(catalog[node.class_type],`Missing native node ${node.class_type}`);
    }
    assert.ok(await mediaIdle(),'Media engine already has native work');assert.equal((await maintenance('transition')).owned,true);
    progress('generating','Submitting the saved media job once.');
    await jobs.dispatch(job.id,connection.backend,plan.worker_id);
    for(;;){
      let observed;
      try{observed=await jobs.observe(job.id,connection.backend);}
      catch{progress('observing_media','Native progress is temporarily unavailable; observing the original job without repeating it.');await delay(3000);continue;}
      progress('generating',`Native job: ${observed.state}.`);
      if(['completed','failed'].includes(observed.state)){assert.equal(observed.state,'completed','Native media generation failed');break;}
      await delay(3000);
    }
    progress('retaining_results','Saving generated files before releasing the media engine.');
    await jobs.collect(job.id,connection.backend);
  }catch(e){error=e;if(jobs.get(plan.operation_id).state==='queued')jobs.update(plan.operation_id,{state:'failed',detail:e.message});save('failure.json',{error:e.message});}
  finally{
    try{
      if(stopped){
        assert.equal((await maintenance('owned')).owned,true);
        if(mediaStarted&&(await inspect(plan.engine.container)).State.Running){
          // Do not interrupt an accepted generation, including other direct work.
          if(jobs.get(plan.operation_id).native_id||ready){
            while(!await mediaIdle()){progress('waiting_media_idle','Waiting for direct media work before restoring the LLM.');await delay(3000);}
          }
          await stop(plan.engine.container);
        }
        // A stopped media engine's changed settings remain an error, but must
        // not strand an unchanged LLM offline after successful generation.
        try{unchanged(await inspect(plan.engine.container),before.media);}catch(e){error=e;save('media-settings-changed.json',{error:e.message});}
        unchanged(await inspect(plan.llm_container),before.llm);
        save('restore-llm-intent.json',{container:plan.llm_container});await start(plan.llm_container);
        progress('restoring_llm','Original LLM is loading with unchanged settings.');
        await waitForMediaLlm(plan,io);
        progress('checking_llm','Checking real responses and cold-to-warm cache reuse.');
        save('llm-proof.json',await verify());
        const result=await maintenance('finish');save('readmission.json',result);assert.equal(result.state,'readmitted');
        progress(error?'failed_returned':'returned',error?`Media failed: ${error.message}. Original LLM returned to the gateway.`:'Generated files retained; original LLM verified and returned to the gateway.');
      }else if(io.hasMaintenanceIntent()){
        assert.equal((await maintenance('owned')).owned,true);
        save('llm-proof.json',await verify());const result=await maintenance('finish');assert.equal(result.state,'readmitted');save('readmission.json',result);
        progress('failed_returned',error?.message??'Media did not start; original LLM returned.');
      }else progress('failed_unchanged',error?.message??'Media did not start.');
    }catch(e){error=e;save('restoration-needs-attention.json',{error:e.message});progress('needs_attention',`LLM return needs attention: ${e.message}`);}
    connection?.close();
  }
  if(error)throw error;
  return {native_generation_verified:true,llm_return_verified:true};
}
