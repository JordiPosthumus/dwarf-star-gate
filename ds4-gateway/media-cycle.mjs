import assert from 'node:assert/strict';
import {isDeepStrictEqual} from 'node:util';
import {createHash} from 'node:crypto';

// Testable lifecycle, shared by the detached product runner. Native generation
// is submitted once. Waiting observes the same job without a cancellation limit.
export async function runMediaCycle(plan,io){
  const {jobs,save,progress,maintenance,inspect,start,stop,recoveryInspect,verify,connect,delay}=io;
  let before,connection,stopped=false,mediaStarted=false,mediaTerminal=false,error;
  const unchanged=(a,b)=>{
    for(const key of ['Id','Image','Config','HostConfig'])if(!isDeepStrictEqual(a[key],b[key]))throw new Error(`Container ${key} changed`);
    const mounts=x=>[...x.Mounts].sort((a,b)=>a.Destination.localeCompare(b.Destination));
    if(!isDeepStrictEqual(mounts(a),mounts(b)))throw new Error('Container mounts changed');
  };
  const mediaIdle=async()=>{
    const q=await connection.backend.request('/queue');
    return q.queue_running.length+q.queue_pending.length===0;
  };
  try{
    if(plan.engine.kind!=='comfyui')throw new Error('This media lifecycle currently qualifies ComfyUI engines only.');
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
    let ready=false;
    for(let i=0;i<120;i++){
      try{await connection.backend.request('/system_stats');ready=true;break;}
      catch{if(!(await inspect(plan.engine.container)).State.Running)throw new Error('Media container exited before readiness');await delay(3000);}
    }
    assert.ok(ready,'Media readiness not established; no generation submitted');
    const catalog=await connection.backend.request('/object_info'),job=jobs.get(plan.operation_id);
    assert.ok(job.payload.prompt&&Object.keys(job.payload.prompt).length,'Supply a native ComfyUI workflow');
    for(const node of Object.values(job.payload.prompt))assert.ok(catalog[node.class_type],`Missing native node ${node.class_type}`);
    assert.ok(await mediaIdle(),'Media engine already has native work');assert.equal((await maintenance('transition')).owned,true);
    progress('generating','Submitting the saved media job once.');
    await jobs.dispatch(job.id,connection.backend,plan.worker_id);
    for(;;){
      let observed;
      try{observed=await jobs.observe(job.id,connection.backend);}
      catch{progress('observing_media','Native progress is temporarily unavailable; observing the original job without repeating it.');await delay(3000);continue;}
      progress('generating',`Native job: ${observed.state}.`);
      if(['completed','failed'].includes(observed.state)){mediaTerminal=true;assert.equal(observed.state,'completed','Native media generation failed');break;}
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
          if(jobs.get(plan.operation_id).native_id){
            if(!mediaTerminal)assert.ok(await mediaIdle(),'Native work may still be active; inspect the saved operation');
            while(!await mediaIdle()){progress('waiting_media_idle','Waiting for direct media work before restoring the LLM.');await delay(3000);}
          }
          await stop(plan.engine.container);
        }
        unchanged(await inspect(plan.engine.container),before.media);unchanged(await inspect(plan.llm_container),before.llm);
        save('restore-llm-intent.json',{container:plan.llm_container});await start(plan.llm_container);
        progress('restoring_llm','Original LLM is loading with unchanged settings.');
        for(;;){const current=await recoveryInspect();assert.equal(current.profile,plan.recovery.profile);if(current.listener&&!current.fault)break;await delay(5000);}
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
