import assert from 'node:assert/strict';
import {isDeepStrictEqual} from 'node:util';
import {createHash} from 'node:crypto';
import {mediaContainerSignature} from './spark-media-cycle.mjs';
import {waitForMediaLlm} from './media-cycle.mjs';
import {runMediaGeneration,mediaEngineIdle} from './media-generation.mjs';

// One coordinator owns the entire pair, all native job identities and one return.
// Each member has one generation slot. No per-lane task can restore the LLM.
export async function runParallelMediaCycle(plan,io){
  const {jobs,save,maintenance,delay}=io,ids=plan.job_ids;
  const definitions=plan.media_lanes;
  assert.ok(io.pair&&plan.llm_pair&&Array.isArray(definitions)&&definitions.length===2,'Parallel media requires one enrolled pair');
  assert.deepEqual(definitions.map(l=>l.member),[0,1]);
  const assigned=definitions.flatMap(l=>l.job_ids);
  assert.ok(Array.isArray(ids)&&ids.length>=2&&new Set(assigned).size===assigned.length&&assigned.length===ids.length&&ids.every(id=>assigned.includes(id)),'Every job must belong to exactly one member');
  const lanes=definitions.map(l=>({...l,io:io.forMember(l),phase:'starting',active_job_id:l.job_ids[0],started:false,connection:null}));
  let stopped=false,generationStarted=false,error,head;
  const rows=()=>lanes.map(l=>({member:l.member,job_ids:l.job_ids,phase:l.phase,active_job_id:l.active_job_id,detail:l.detail??'',native_progress:l.native_progress??null}));
  const progress=(phase,detail)=>io.progress(phase,detail,{parallel_members:true,batch_size:ids.length,lanes:rows()});
  const same=(a,b)=>assert.ok(isDeepStrictEqual(mediaContainerSignature(a),mediaContainerSignature(b)),'Media container configuration changed');
  // The native maintenance helper has a single operation journal. Serialize its
  // reads/checkpoints too, so parallel lanes cannot race that journal.
  let checkpoint=Promise.resolve();
  const owned=action=>{const next=checkpoint.then(()=>maintenance(action));checkpoint=next.catch(()=>{});return next;};
  const laneProgress=(lane,phase,detail,context={})=>{
    Object.assign(lane,{phase,detail,...context});progress('generating','Parallel member jobs are being observed under one pair reservation.');
  };
  try{
    await io.prepareCommands?.();
    await io.pair.capture();
    const initial=await io.recoveryInspect();assert.equal(initial.profile,plan.recovery.profile);assert.equal(initial.listener,true);assert.equal(initial.fault,null);
    head=await io.inspect(plan.llm_container);assert.match(head.Id,/^[a-f0-9]{64}$/);assert.equal(head.State.Running,true);
    const instance=createHash('sha256').update(JSON.stringify([head.Id,head.State.StartedAt])).digest('hex').slice(0,32);
    assert.equal(initial.instance,instance,'Pair and enrolled endpoint identity must match');
    // Inspect both engines before draining either physical host.
    for(const lane of lanes){
      assert.ok(['comfyui','ace-step'].includes(lane.engine.kind));
      lane.before=await lane.io.inspect(lane.engine.container);
      assert.equal(lane.before.Id,lane.engine.container);assert.equal(lane.before.Image,lane.engine.image);assert.equal(lane.before.State.Running,false);
    }
    save('parallel-engines-before.json',{members:lanes.map(l=>({member:l.member,container:l.before}))});
    progress('waiting_idle','Waiting for admitted and direct work on the whole GLM pair.');
    await owned('prepare');assert.equal((await owned('transition')).owned,true);
    await io.pair.check();for(const lane of lanes)same(await lane.io.inspect(lane.engine.container),lane.before);
    save('stop-llm-intent.json',{container:head.Id});stopped=true;await io.pair.stop(head.Id);
    progress('starting_media','Pair drained; starting its two separately enrolled media engines.');
    const startup=await Promise.allSettled(lanes.map(async lane=>{
      lane.connection=await lane.io.connect();
      save(`member-${lane.member}-start-media-intent.json`,{container:lane.engine.container});lane.started=true;
      await lane.io.start(lane.engine.container);
      for(let attempt=0;attempt<120;attempt++){
        try{
          const health=await lane.connection.backend.request(lane.engine.kind==='ace-step'?'/health':'/system_stats');
          if(lane.engine.kind==='ace-step')assert.ok(health?.data?.status==='ok'&&health.data.models_initialized===true);
          lane.phase='ready';return;
        }catch(e){
          if(!(await lane.io.inspect(lane.engine.container)).State.Running)throw Error(`Member ${lane.member} exited before readiness; no generation submitted`);
          lane.detail=e.message;progress('starting_media',`Waiting for member ${lane.member} media readiness.`);await delay(3000);
        }
      }
      throw Error(`Member ${lane.member} readiness was not established; no generation submitted`);
    }));
    const failedStart=startup.find(r=>r.status==='rejected');if(failedStart)throw failedStart.reason;
    // Wait for every accepted native job even if its sibling fails. A failure
    // only vetoes new submissions. Unknown native state never becomes retry.
    generationStarted=true;
    const results=await Promise.allSettled(lanes.map(async lane=>{
      try{
        const result=await runMediaGeneration({...plan,engine:lane.engine,job_ids:lane.job_ids},{...io,backend:lane.connection.backend,maintenance:owned,
          shouldContinue:()=>!error,save:(name,value)=>save(`member-${lane.member}-${name}`,value),
          progress:(phase,detail,context)=>laneProgress(lane,phase,detail,context)});
        lane.phase='settled';lane.native_progress=null;progress('generating','Waiting for all member jobs before returning the pair.');return result;
      }catch(e){error??=e;lane.phase='failed';lane.detail=e.message;lane.native_progress=null;progress('generating','One member failed; preserving accepted work on the other member.');throw e;}
    }));
    const failed=results.find(r=>r.status==='rejected');if(failed)throw failed.reason;
  }catch(e){
    error??=e;if(!generationStarted&&jobs.get(plan.operation_id).state==='queued')jobs.update(plan.operation_id,{state:'failed',detail:e.message});
    save('failure.json',{error:e.message});
  }finally{
    try{
      if(stopped){
        assert.equal((await owned('owned')).owned,true);
        // Check EVERY engine before stopping ANY. Lost native observations keep
        // ownership and require attention; they never prove that work ended.
        for(const lane of lanes){
          if(lane.started&&(await lane.io.inspect(lane.engine.container)).State.Running){
            while(!await mediaEngineIdle(lane.connection.backend,lane.engine.kind)){
              progress('waiting_media_idle',`Waiting for member ${lane.member} native work before restoring the pair.`);await delay(3000);
            }
          }
        }
        for(const lane of lanes)if(lane.started&&(await lane.io.inspect(lane.engine.container)).State.Running){
          assert.ok(await mediaEngineIdle(lane.connection.backend,lane.engine.kind),'Native work arrived before media stop');
          save(`member-${lane.member}-stop-media-intent.json`,{container:lane.engine.container});await lane.io.stop(lane.engine.container);
          assert.equal((await lane.io.inspect(lane.engine.container)).State.Running,false);
        }
        for(const lane of lanes)try{same(await lane.io.inspect(lane.engine.container),lane.before);}catch(e){error??=e;save(`member-${lane.member}-settings-changed.json`,{error:e.message});}
        await io.pair.check();save('restore-llm-intent.json',{container:head.Id});await io.pair.restore(head.Id);
        progress('restoring_llm','Both media members released; restoring the exact original GLM pair once.');
        await waitForMediaLlm(plan,{...io,progress});
        progress('checking_llm','Verifying the original pair configuration and native serving response.');
        save('llm-proof.json',await io.verify());
        const receipt=await owned('finish');save('readmission.json',receipt);assert.equal(receipt.state,'readmitted');
        progress(error?'failed_returned':'returned',error?`Media failure: ${error.message}. Original pair verified and returned.`:'All member outputs retained; original pair verified and returned.');
      }else if(io.hasMaintenanceIntent()){
        assert.equal((await owned('owned')).owned,true);save('llm-proof.json',await io.verify());
        const receipt=await owned('finish');assert.equal(receipt.state,'readmitted');save('readmission.json',receipt);progress('failed_returned',error?.message??'Media did not start.');
      }else progress('failed_unchanged',error?.message??'Media did not start.');
    }catch(e){error=e;save('restoration-needs-attention.json',{error:e.message});progress('needs_attention',`Pair return needs attention: ${e.message}`);}
    for(const lane of lanes)lane.connection?.close();
  }
  if(error)throw error;
  return {native_generation_verified:ids.every(id=>jobs.get(id).state==='completed'),llm_return_verified:true,
    completed_job_ids:ids.filter(id=>jobs.get(id).state==='completed'),unstarted_job_ids:ids.filter(id=>jobs.get(id).state==='queued')};
}
