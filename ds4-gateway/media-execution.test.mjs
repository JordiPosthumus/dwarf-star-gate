import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {MediaJobs} from './media-jobs.mjs';
import {createMediaExecution,saveMediaReceipt} from './media-execution.mjs';
import {runMediaCycle} from './media-cycle.mjs';

function fixture(t){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'sg-media-execution-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const jobs=new MediaJobs(path.join(directory,'queue.json'));
  const job=jobs.enqueue('video',{prompt:{one:{class_type:'Fixture'}}},{key:'fixture'}).job;
  const engine={kind:'comfyui',container:'b'.repeat(64),image:'sha256:'+'c'.repeat(64),port:8188};
  const config={model:'fixture',context_length:262144,control_socket:'/fixture.sock',media_jobs:{workers:{one:{engines:{video:engine}}}},genie_chat:{python:'/python',inspection:{workers:{one:{container:'a'.repeat(64),ssh:['fixture-host']}}}},recovery:{workers:[{id:'one',ssh:'fixture-host',adapter:'docker',verification:'qwen_vllm',profile:'profile'}]}};
  return {directory,jobs,job,config,engine};
}
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

function cycleFixture(t){
  const r=fixture(t),containers=new Map();
  const container=(Id,Image,Running)=>({Id,Image,Config:{untouched:true},HostConfig:{untouched:true},Mounts:[],State:{Running,StartedAt:'2026-01-01T00:00:00Z'}});
  containers.set('a'.repeat(64),container('a'.repeat(64),'original-image',true));containers.set(r.engine.container,container(r.engine.container,r.engine.image,false));
  const llm=containers.get('a'.repeat(64)),instance=createHash('sha256').update(JSON.stringify([llm.Id,llm.State.StartedAt])).digest('hex').slice(0,32);
  const plan={operation_id:r.job.id,worker_id:'one',llm_container:llm.Id,engine:r.engine,recovery:{profile:'profile'}};
  const events=[];let held=false,submitted=0;
  const backend={kind:'comfyui',request:async route=>route==='/object_info'?{Fixture:{}}:route==='/queue'?{queue_running:[],queue_pending:[]}:{},submit:async()=>{submitted++;return {native_id:r.job.id};},observe:async()=>({state:'completed',result:{}})};
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
test('mismatched LLM identity causes no stop or maintenance action',async t=>{
  const r=cycleFixture(t);r.io.recoveryInspect=async()=>({profile:'profile',listener:true,fault:null,instance:'another-container'});
  await assert.rejects(runMediaCycle(r.plan,r.io),/same LLM container/);
  assert.equal(r.events.filter(e=>e==='prepare'||e.startsWith('stop:')).length,0);
  assert.ok(r.events.includes('failed_unchanged'));
});
