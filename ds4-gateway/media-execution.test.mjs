import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {Readable} from 'node:stream';
import {MediaJobs} from './media-jobs.mjs';
import {createMediaExecution,saveMediaReceipt} from './media-execution.mjs';
import {runMediaCycle,mediaBatchCanContinue} from './media-cycle.mjs';

function fixture(t,kind='video'){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'sg-media-execution-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const jobs=new MediaJobs(path.join(directory,'queue.json'));
  const job=jobs.enqueue(kind,kind==='video'?{prompt:{one:{class_type:'Fixture'}}}:{prompt:'instrumental',audio_duration:10},{key:'fixture'}).job;
  const engine={kind:'comfyui',container:'b'.repeat(64),image:'sha256:'+'c'.repeat(64),port:8188};
  const config={model:'fixture',context_length:262144,control_socket:'/fixture.sock',media_jobs:{workers:{one:{engines:{video:engine}}}},genie_chat:{python:'/python',inspection:{workers:{one:{container:'a'.repeat(64),ssh:['fixture-host']}}}},recovery:{workers:[{id:'one',ssh:'fixture-host',adapter:'docker',verification:'qwen_vllm',profile:'profile'}]}};
  return {directory,jobs,job,config,engine};
}
test('placement off rejects new execution but preserves the accepted operation',async t=>{
 const r=fixture(t);let allowed=false,launches=0;
 const service=createMediaExecution(r.config,r.jobs,{isEnabled:()=>true,isAllowed:()=>allowed,launchRunner:async()=>{launches++;return {pid:123};}});
 const input={job_id:r.job.id,worker_id:'one'};
 await assert.rejects(service.start(input),/placement is off/);assert.equal(launches,0);assert.deepEqual(service.status().workers[0].kinds,[]);
 allowed=true;await service.start(input);allowed=false;const existing=await service.start(input);assert.equal(existing.execution.phase,'starting');assert.equal(launches,1);
});
test('one execution per job survives core restart and exposes private-runner progress',async t=>{
  const r=fixture(t);let launches=0,enabled=true;
  const options={isEnabled:()=>enabled,launchRunner:async folder=>{launches++;saveMediaReceipt(folder,'progress.json',{phase:'generating',detail:'Native job running'});return {pid:123};}};
  const service=createMediaExecution(r.config,r.jobs,options),input={job_id:r.job.id,worker_id:'one'};
  const receipt=await service.start(input);assert.equal(receipt.payload,undefined);assert.equal(receipt.execution.phase,'generating');
  assert.equal(r.jobs.queued().length,0);
  const restartedJobs=new MediaJobs(r.jobs.filename),restarted=createMediaExecution(r.config,restartedJobs,options);
  await restarted.start(input);assert.equal(launches,1);
  const second=r.jobs.enqueue('video',{prompt:{}},{key:'second'}).job;
  await assert.rejects(service.start({job_id:second.id,worker_id:'one'}),/already has a media operation/);
  enabled=false;await assert.rejects(service.start(input),/switched off/);
  assert.equal(service.status().jobs[0].execution.phase,'generating','switch off leaves accepted work observable');
  const folder=r.jobs.executionFolder(r.job.id),native=new MediaJobs(path.join(folder,'media-jobs.json'),{resultsDirectory:r.jobs.results.directory});
  native.update(r.job.id,{state:'completed',outputs:{state:'ready',files:[]}});saveMediaReceipt(folder,'progress.json',{phase:'returned'});
  assert.equal(restartedJobs.get(r.job.id).state,'completed');assert.equal(service.status().workers[0].busy,false);
});
test('uncertain process launch is retained and never replayed',async t=>{
  const r=fixture(t);let calls=0;
  const service=createMediaExecution(r.config,r.jobs,{isEnabled:()=>true,launchRunner:async()=>{calls++;throw new Error('lost spawn acknowledgement');}});
  const input={job_id:r.job.id,worker_id:'one'};
  await assert.rejects(service.start(input));assert.equal(r.jobs.get(r.job.id).execution.phase,'launch_uncertain');
  await service.start(input);assert.equal(calls,1);
});
test('batch reservation is atomic, shares progress across core restart and never relaunches',async t=>{
  const r=fixture(t),second=r.jobs.enqueue('video',{prompt:{two:{class_type:'Fixture'}}},{key:'batch-second'}).job;let launches=0;
  const options={isEnabled:()=>true,launchRunner:async()=>{launches++;throw Error('acknowledgement lost');}};
  const service=createMediaExecution(r.config,r.jobs,options),input={job_id:r.job.id,worker_id:'one',following_job_ids:[second.id]};
  await assert.rejects(service.start({...input,following_job_ids:[second.id,second.id]}),/only once/);
  await assert.rejects(service.start({...input,following_job_ids:[second.id,'00000000-0000-4000-8000-000000000000']}),/Unknown/);
  assert.equal(r.jobs.queued().length,2);assert.equal(launches,0);
  await assert.rejects(service.start(input),/acknowledgement/);assert.equal(r.jobs.queued().length,0);
  const restored=new MediaJobs(r.jobs.filename),again=createMediaExecution(r.config,restored,options);
  assert.equal(restored.get(second.id).execution.phase,'launch_uncertain');
  await again.start(input);await again.start({job_id:second.id,worker_id:'one'});assert.equal(launches,1);
  await assert.rejects(again.start({...input,following_job_ids:[]}),/different batch/);
  const folder=r.jobs.executionFolder(r.job.id),native=new MediaJobs(path.join(folder,'media-jobs.json'));
  native.update(r.job.id,{state:'completed',outputs:{state:'ready',files:[]}});
  saveMediaReceipt(folder,'progress.json',{phase:'restoring_llm',active_job_id:second.id});
  assert.equal(restored.get(r.job.id).state,'completed');assert.equal(restored.get(second.id).execution.phase,'restoring_llm');assert.equal(restored.queued().length,0);
  saveMediaReceipt(folder,'progress.json',{phase:'returned'});
  assert.equal(restored.get(r.job.id).state,'completed');assert.equal(restored.get(second.id).execution,undefined);
  assert.deepEqual(restored.queued().map(j=>j.id),[second.id]);assert.equal(again.status().workers[0].busy,false);
  // Reassignment persists a new owner instead of continuing to read the old batch.
  const newService=createMediaExecution(r.config,restored,{isEnabled:()=>true,launchRunner:async()=>({pid:456})});
  await newService.start({job_id:second.id,worker_id:'one'});assert.equal(restored.get(second.id).execution.operation_id,undefined);
});
test('batch selection rejects mixed engines and priorities without reserving any jobs',async t=>{
  const r=fixture(t),music=r.jobs.enqueue('music',{prompt:'music'},{key:'music'}).job,high=r.jobs.enqueue('video',{prompt:{}},{key:'high',priority:'high'}).job;
  const service=createMediaExecution(r.config,r.jobs,{isEnabled:()=>true,launchRunner:()=>{throw Error('must not launch');}});
  for(const id of [music.id,high.id])await assert.rejects(service.start({job_id:r.job.id,worker_id:'one',following_job_ids:[id]}),/same engine and priority/);
  assert.equal(r.jobs.queued().length,3);
});
test('removed or retargeted workers cannot borrow engines from their old enrollment',async t=>{
  const r=fixture(t);let launched=false;
  const service=createMediaExecution(r.config,r.jobs,{isEnabled:()=>true,matchesWorker:()=>false,launchRunner:async()=>{launched=true;}});
  await assert.rejects(service.start({job_id:r.job.id,worker_id:'one'}),/no longer matches/);
  assert.equal(launched,false);assert.equal(r.jobs.get(r.job.id).state,'queued');assert.equal(r.jobs.get(r.job.id).execution,undefined);
});

function cycleFixture(t,kind='video'){
  const r=fixture(t,kind),containers=new Map();
  const container=(Id,Image,Running)=>({Id,Image,Config:{untouched:true},HostConfig:{untouched:true},Mounts:[],State:{Running,StartedAt:'2026-01-01T00:00:00Z'}});
  containers.set('a'.repeat(64),container('a'.repeat(64),'original-image',true));containers.set(r.engine.container,container(r.engine.container,r.engine.image,false));
  const llm=containers.get('a'.repeat(64)),instance=createHash('sha256').update(JSON.stringify([llm.Id,llm.State.StartedAt])).digest('hex').slice(0,32);
  const plan={operation_id:r.job.id,worker_id:'one',llm_container:llm.Id,engine:r.engine,recovery:{profile:'profile'}};
  const events=[];let held=false,submitted=0;
  const backend={kind:'comfyui',request:async route=>route==='/object_info'?{Fixture:{}}:route==='/queue'?{queue_running:[],queue_pending:[]}:{},submit:async(_payload,requestId)=>{submitted++;return {native_id:requestId};},observe:async()=>({state:'completed',result:{}})};
  r.jobs.collect=async id=>{events.push('collect');return r.jobs.update(id,{outputs:{state:'ready',files:[]}});};
  const io={jobs:r.jobs,save:()=>{},progress:(phase)=>events.push(phase),delay:async()=>{},hasMaintenanceIntent:()=>held,
    maintenance:async action=>{events.push(action);if(action==='prepare')held=true;return action==='finish'?{state:'readmitted'}:{owned:true};},
    inspect:async id=>structuredClone(containers.get(id)),stop:async id=>{events.push('stop:'+id);containers.get(id).State.Running=false;},start:async id=>{events.push('start:'+id);containers.get(id).State.Running=true;},
    recoveryInspect:async()=>({profile:'profile',listener:true,fault:null,instance}),verify:async()=>{events.push('verify');return {verified:true};},connect:async()=>({backend,close:()=>events.push('close')})};
  return {...r,plan,io,events,containers,backend,submissions:()=>submitted};
}
test('native cycle drains, generates once, retains files, verifies LLM and readmits in order',async t=>{
  const r=cycleFixture(t);await runMediaCycle(r.plan,r.io);
  assert.equal(r.submissions(),1);assert.equal(r.jobs.get(r.job.id).state,'completed');
  const ordered=['prepare','stop:'+r.plan.llm_container,'start:'+r.engine.container,'collect','stop:'+r.engine.container,'start:'+r.plan.llm_container,'verify','finish','returned'];
  let previous=-1;for(const item of ordered){const index=r.events.indexOf(item);assert.ok(index>previous,item);previous=index;}
  assert.equal(r.containers.get(r.plan.llm_container).State.Running,true);
});
test('two selected media jobs submit and retain separately with one engine start and one LLM return',async t=>{
  const r=cycleFixture(t),second=r.jobs.enqueue('video',{prompt:{one:{class_type:'Fixture'}}},{key:'second'}).job;
  r.plan.job_ids=[r.job.id,second.id];let checkpoints=0;r.io.continueBatch=async job=>{assert.equal(job.id,second.id);checkpoints++;return true;};
  const result=await runMediaCycle(r.plan,r.io);
  assert.equal(r.submissions(),2);assert.equal(checkpoints,1);assert.deepEqual(result.completed_job_ids,r.plan.job_ids);
  for(const event of ['prepare','start:'+r.engine.container,'stop:'+r.engine.container,'start:'+r.plan.llm_container,'verify','finish'])assert.equal(r.events.filter(e=>e===event).length,1,event);
  assert.equal(r.events.filter(e=>e==='collect').length,2);
  assert.equal(r.jobs.get(second.id).state,'completed');
  assert.equal(r.jobs.get(second.id).native_id,second.id);assert.equal(r.jobs.get(r.job.id).native_id,r.job.id);
});
test('between-job priority yield or unavailable checkpoint leaves unstarted work queued and restores the LLM',async t=>{
  for(const unavailable of [false,true]){
    const r=cycleFixture(t),second=r.jobs.enqueue('video',{prompt:{one:{class_type:'Fixture'}}},{key:'second'}).job;
    r.plan.job_ids=[r.job.id,second.id];r.io.continueBatch=async next=>{if(unavailable)throw Error('core unavailable');return mediaBatchCanContinue(next,{jobs:[{state:'queued',priority:'high'}]});};
    const result=await runMediaCycle(r.plan,r.io);
    assert.equal(r.submissions(),1);assert.equal(r.jobs.get(second.id).state,'queued');assert.deepEqual(result.unstarted_job_ids,[second.id]);
    assert.equal(result.native_generation_verified,false);assert.equal(result.llm_return_verified,true);assert.ok(r.events.includes('returned'));
  }
});
test('a same-priority arrival does not break the selected batch; higher queued work does',()=>{
  assert.equal(mediaBatchCanContinue({priority:'normal'},{jobs:[{state:'queued',priority:'normal'}]}),true);
  assert.equal(mediaBatchCanContinue({priority:'idle-only'},{jobs:[{state:'queued',priority:'normal'}]}),false);
  assert.equal(mediaBatchCanContinue({priority:'normal'},{jobs:[{state:'queued',priority:'high',execution:{phase:'starting'}}]}),true);
  assert.equal(mediaBatchCanContinue({priority:'normal'},{jobs:[{state:'completed',priority:'high'}]}),true);
});
test('a later failed job preserves earlier results, leaves following jobs unsubmitted and returns the LLM',async t=>{
  const r=cycleFixture(t),second=r.jobs.enqueue('video',{prompt:{one:{class_type:'Fixture'}}},{key:'second'}).job,third=r.jobs.enqueue('video',{prompt:{one:{class_type:'Fixture'}}},{key:'third'}).job;
  r.plan.job_ids=[r.job.id,second.id,third.id];r.io.continueBatch=async()=>true;
  r.backend.observe=async()=>({state:r.submissions()===2?'failed':'completed',result:{}});
  await assert.rejects(runMediaCycle(r.plan,r.io),/generation failed/);
  assert.equal(r.submissions(),2);assert.equal(r.jobs.get(r.job.id).outputs.state,'ready');assert.equal(r.jobs.get(second.id).state,'failed');assert.equal(r.jobs.get(third.id).state,'queued');
  assert.ok(r.events.includes('failed_returned'));assert.equal(r.containers.get(r.plan.llm_container).State.Running,true);
});
test('reference input transfer precedes generation and a transfer failure still returns the LLM',async t=>{
 for(const failTransfer of [false,true]){
  const r=cycleFixture(t),stream=Readable.from([Buffer.from('wave-data')]);stream.headers={'content-type':'audio/wav','content-length':'9'};
  const input=await r.jobs.inputs.receive(stream);r.jobs.update(r.job.id,{payload:{...r.job.payload,input_files:[input.id]}});
  r.backend.uploadInput=async(blob,name)=>{r.events.push('upload');assert.equal(name,input.name);assert.equal(await blob.text(),'wave-data');if(failTransfer)throw Error('Input transfer failed');};
  const submit=r.backend.submit;r.backend.submit=async(payload,requestId)=>{r.events.push('submit');assert.equal(payload.input_files,undefined);return submit(payload,requestId);};
  if(failTransfer){await assert.rejects(runMediaCycle(r.plan,r.io),/Input transfer failed/);assert.equal(r.submissions(),0);assert.ok(r.events.includes('failed_returned'));}
  else{await runMediaCycle(r.plan,r.io);assert.ok(r.events.indexOf('upload')<r.events.indexOf('submit'));assert.equal(r.submissions(),1);}
  assert.equal(r.containers.get(r.plan.llm_container).State.Running,true);assert.ok(r.events.includes('finish'));
 }
});
test('failed media startup returns the unchanged LLM without submitting generation',async t=>{
  const r=cycleFixture(t),start=r.io.start;r.io.start=async id=>{if(id===r.engine.container)throw new Error('media service failed');return start(id);};
  await assert.rejects(runMediaCycle(r.plan,r.io),/media service failed/);
  assert.equal(r.submissions(),0);assert.equal(r.jobs.get(r.job.id).state,'failed');
  assert.ok(r.events.includes('failed_returned'));assert.ok(r.events.includes('finish'));assert.equal(r.containers.get(r.plan.llm_container).State.Running,true);
});
test('failed LLM verification remains visible and does not claim readmission',async t=>{
  const r=cycleFixture(t);r.io.verify=async()=>{throw new Error('cache check failed');};
  await assert.rejects(runMediaCycle(r.plan,r.io),/cache check failed/);
  assert.ok(r.events.includes('needs_attention'));assert.ok(!r.events.includes('finish'));
});
test('transient return inspections do not repeat generation or the LLM start',async t=>{
  const r=cycleFixture(t),inspect=r.io.recoveryInspect,receipts={},details=[];let reads=0;
  r.io.save=(name,value)=>{receipts[name]=value;};
  r.io.progress=(phase,detail)=>{r.events.push(phase);details.push(detail);};
  r.io.recoveryInspect=async()=>{
    reads++;
    if(reads===2||reads===3)throw Error('adapter_check_failed');
    return {...await inspect(),listener:reads!==4};
  };
  await runMediaCycle(r.plan,r.io);
  assert.equal(reads,5);assert.equal(r.submissions(),1);
  assert.equal(r.events.filter(e=>e==='start:'+r.plan.llm_container).length,1);
  assert.equal(r.events.filter(e=>e==='finish').length,1);
  assert.ok(r.events.indexOf('verify')<r.events.indexOf('finish'));
  assert.equal(receipts['llm-inspection-retry.json'].error,'adapter_check_failed');
  assert.ok(details.some(d=>d.includes('without restarting')));
});
test('changed return profile remains an error rather than a retry or readmission',async t=>{
  const r=cycleFixture(t),inspect=r.io.recoveryInspect;let reads=0;
  r.io.recoveryInspect=async()=>({...await inspect(),profile:++reads===1?'profile':'changed'});
  await assert.rejects(runMediaCycle(r.plan,r.io));
  assert.equal(reads,2);assert.ok(r.events.includes('needs_attention'));
  assert.ok(!r.events.includes('finish'));assert.equal(r.submissions(),1);
});
test('mismatched LLM identity causes no stop or maintenance action',async t=>{
  const r=cycleFixture(t);r.io.recoveryInspect=async()=>({profile:'profile',listener:true,fault:null,instance:'another-container'});
  await assert.rejects(runMediaCycle(r.plan,r.io),/same LLM container/);
  assert.equal(r.events.filter(e=>e==='prepare'||e.startsWith('stop:')).length,0);
  assert.ok(r.events.includes('failed_unchanged'));
});

test('music waits for initialized models, generates once and restores the LLM',async t=>{
  const r=cycleFixture(t,'music');r.engine.kind=r.backend.kind='ace-step';
  let healthChecks=0;
  r.backend.request=async route=>{
    if(route==='/health')return {data:{status:'ok',models_initialized:++healthChecks>1}};
    assert.equal(route,'/v1/stats');return {data:{jobs:{queued:0,running:0},queue_size:0}};
  };
  await runMediaCycle(r.plan,r.io);
  assert.equal(healthChecks,2);assert.equal(r.submissions(),1);
  assert.ok(r.events.indexOf('collect')<r.events.indexOf('stop:'+r.engine.container));
  assert.ok(r.events.includes('returned'));assert.equal(r.containers.get(r.plan.llm_container).State.Running,true);
});

test('music never treats missing native queue counters as idle',async t=>{
  const r=cycleFixture(t,'music');r.engine.kind=r.backend.kind='ace-step';
  r.backend.request=async route=>route==='/health'?{data:{status:'ok',models_initialized:true}}:{data:{queue_size:0}};
  await assert.rejects(runMediaCycle(r.plan,r.io),/queue observation unavailable/);
  assert.equal(r.submissions(),0);assert.ok(r.events.includes('needs_attention'));
  assert.ok(!r.events.includes('stop:'+r.engine.container));
});

test('a busy music engine is left running until its direct work finishes',async t=>{
  const r=cycleFixture(t,'music');r.engine.kind=r.backend.kind='ace-step';let stats=0;
  r.backend.request=async route=>route==='/health'?{data:{status:'ok',models_initialized:true}}:{data:{jobs:{queued:0,running:++stats<=2?1:0},queue_size:0}};
  await assert.rejects(runMediaCycle(r.plan,r.io),/already has native work/);
  assert.equal(r.submissions(),0);assert.ok(stats>=3);
  assert.ok(r.events.includes('failed_returned'));
});

test('Docker first-start false/null OOM metadata normalization does not strand the LLM',async t=>{
  const r=cycleFixture(t),start=r.io.start;r.containers.get(r.engine.container).HostConfig.OomKillDisable=false;
  r.io.start=async id=>{await start(id);if(id===r.engine.container)r.containers.get(id).HostConfig.OomKillDisable=null;};
  await runMediaCycle(r.plan,r.io);assert.ok(r.events.includes('returned'));assert.ok(r.events.includes('finish'));
});

test('real media setting changes are reported after returning the unchanged LLM',async t=>{
  const r=cycleFixture(t),start=r.io.start;r.containers.get(r.engine.container).HostConfig.OomKillDisable=false;
  r.io.start=async id=>{await start(id);if(id===r.engine.container)r.containers.get(id).HostConfig.OomKillDisable=true;};
  await assert.rejects(runMediaCycle(r.plan,r.io),/HostConfig changed/);
  assert.ok(r.events.includes('failed_returned'));assert.ok(r.events.includes('finish'));
  assert.equal(r.containers.get(r.plan.llm_container).State.Running,true);
});

test('installed model mismatch fails before native submission, names the field and restores the LLM',async t=>{
 const r=cycleFixture(t);
 r.jobs.update(r.job.id,{payload:{prompt:{one:{class_type:'UNETLoader',inputs:{unet_name:'absent.safetensors'}}}}});
 const request=r.backend.request;r.backend.request=async route=>route==='/object_info'?{UNETLoader:{input:{required:{unet_name:[['installed.safetensors']]}}}}:request(route);
 await assert.rejects(runMediaCycle(r.plan,r.io),/node one.*unet_name.*not available/);
 assert.equal(r.submissions(),0);assert.match(r.jobs.get(r.job.id).detail,/absent.safetensors/);
 assert.ok(r.events.includes('failed_returned'));assert.equal(r.containers.get(r.plan.llm_container).State.Running,true);
});

test('native failure detail survives restoration in both job status and machine progress',async t=>{
 const r=cycleFixture(t),progress=[];r.io.progress=(phase,detail)=>progress.push({phase,detail});
 r.backend.observe=async()=>({state:'failed',result:{status:{messages:[['execution_error',{node_id:'7',node_type:'MiniMaxH3ReferenceToVideo',exception_message:'CUDA out of memory'}]]}}});
 await assert.rejects(runMediaCycle(r.plan,r.io),/node 7.*CUDA out of memory/);
 assert.match(progress.find(p=>p.phase==='failed_returned').detail,/node 7.*CUDA out of memory.*Original LLM returned/);
 assert.equal(r.submissions(),1);assert.match(r.jobs.get(r.job.id).next_step,/not reduced automatically/);
});

test('reference index outside the installed dynamic schema is rejected instead of silently ignored',async t=>{
 const r=cycleFixture(t);
 r.jobs.update(r.job.id,{payload:{prompt:{one:{class_type:'MiniMaxH3ReferenceToVideo',inputs:{'ref_images.ref_image_9':['source',0]}},source:{class_type:'Fixture'}}}});
 const request=r.backend.request;r.backend.request=async route=>route==='/object_info'?{MiniMaxH3ReferenceToVideo:{input:{optional:{ref_images:['AUTOGROW',{template:{prefix:'ref_image_',min:0,max:9}}]}}},Fixture:{}}:request(route);
 await assert.rejects(runMediaCycle(r.plan,r.io),/ref_image_9.*would be ignored/);
 assert.equal(r.submissions(),0);assert.ok(r.events.includes('failed_returned'));
});

test('readiness failure retains the engine cause and returns the original LLM without submitting',async t=>{
 const r=cycleFixture(t),request=r.backend.request;
 r.backend.request=async route=>{if(route==='/system_stats')throw Error('HTTP 401: incorrect engine token');return request(route);};
 await assert.rejects(runMediaCycle(r.plan,r.io),/comfyui.*readiness not established.*401.*token/);
 assert.equal(r.submissions(),0);assert.ok(r.events.includes('failed_returned'));
});

test('reference shortcut transfers retained input before native submission on the selected worker',async t=>{
 const r=cycleFixture(t),stream=Readable.from(['portable-image']);stream.headers={'content-type':'image/png','content-length':'14'};
 const input=await r.jobs.inputs.receive(stream),job=r.jobs.enqueue('video',{prompt:'Animate <Picture 1>.',reference_image:input.id,seed:42},{key:'portable-shortcut'}).job;
 r.plan.operation_id=job.id;
 const request=r.backend.request;r.backend.request=async route=>route==='/object_info'?Object.fromEntries(Object.values(job.payload.prompt).map(n=>[n.class_type,{}])):request(route);
 r.backend.uploadInput=async(blob,name)=>{r.events.push('upload-shortcut');assert.equal(name,input.name);assert.equal(await blob.text(),'portable-image');};
 const submit=r.backend.submit;r.backend.submit=async(payload,id)=>{r.events.push('submit-shortcut');assert.deepEqual(payload.prompt['7'].inputs['ref_images.ref_image_0'],['5',0]);assert.equal(payload.prompt['5'].inputs.image,input.name);assert.equal(payload.input_files,undefined);return submit(payload,id);};
 await runMediaCycle(r.plan,r.io);
 assert.ok(r.events.indexOf('upload-shortcut')<r.events.indexOf('submit-shortcut'));assert.equal(r.submissions(),1);assert.equal(r.jobs.get(job.id).state,'completed');assert.ok(r.events.includes('returned'));
});
