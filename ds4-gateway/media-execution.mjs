import {mediaEngine,mediaStartInput} from './media-enrollment.mjs';
import {machinesFor} from './fleet-machines.mjs';
import {mediaPair} from './media-pair.mjs';
import {mediaBudget,mediaSparkLimit} from './media-budget.mjs';
// One detached process owns a selected job/batch and its single LLM return.
// It writes its own queue receipt; the core remains the sole global-queue writer.
import fs from 'node:fs';
import {mediaInputRequirements} from './media-input-placement.mjs';
import {musicRecipeRequirements} from './music-input.mjs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
const script=fileURLToPath(new URL('./media-runner.mjs',import.meta.url));
export function saveMediaReceipt(folder,name,value){
  const target=path.join(folder,name),temporary=target+'.'+randomUUID()+'.tmp';
  let fd;
  try{
    fd=fs.openSync(temporary,'wx',0o600);fs.writeFileSync(fd,JSON.stringify(value,null,2)+'\n');fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
    fs.renameSync(temporary,target);
    const parent=fs.openSync(folder,'r');try{fs.fsyncSync(parent);}finally{fs.closeSync(parent);}
  }finally{if(fd!==undefined)fs.closeSync(fd);if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
}
const launch=async folder=>{
  const log=fs.openSync(path.join(folder,'runner.log'),'ax',0o600);
  try{
    const child=spawn(process.execPath,[script,folder],{detached:true,stdio:['ignore',log,log]});
    await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
    child.unref();return {pid:child.pid,at:new Date().toISOString()};
  }finally{fs.closeSync(log);}
};
export function createMediaExecution(config,jobs,{isEnabled=()=>false,launchRunner=launch,matchesWorker=()=>true,isAllowed=()=>true,workers=()=>config.workers??[],externalOperations=()=>[]}={}){
  mediaSparkLimit(config);
  if(config.media_jobs?.parallel_pair_members!==undefined&&typeof config.media_jobs.parallel_pair_members!=='boolean')throw Error('media_jobs.parallel_pair_members must be a boolean');
  const validEngine=(e,kind)=>e?.kind===(kind==='video'?'comfyui':'ace-step')&&/^[a-f0-9]{64}$/.test(e.container)&&/^sha256:[a-f0-9]{64}$/.test(e.image)&&Number.isSafeInteger(e.port)&&e.port>=1&&e.port<=65535;
  const parallelKinds=id=>config.media_jobs?.parallel_pair_members===true&&machinesFor(id,config).length===2&&mediaPair(config,workers().find(w=>w.id===id))?
    ['video','music'].filter(kind=>isAllowed(id,kind)&&[0,1].every(member=>validEngine(mediaEngine(config,id,kind,member),kind))):[];
  const targets=()=>config.media_jobs?.workers??{};
  const terminal=new Set(['returned','failed_returned','failed_unchanged']);
  const busy=worker=>jobs.list().some(j=>j.execution?.worker_id===worker&&!terminal.has(j.execution.phase));
  const budget=()=>mediaBudget(config,jobs?.list()??[],externalOperations());
  const assertCapacity=id=>{const result=budget().admission(id);if(!result.allowed)throw Error(result.reason);return result;};
  return {
    assertCapacity,
    status:()=>{const capacity=budget();return {configured:!!jobs,enabled:isEnabled(),automatic_dispatch_enabled:config.media_jobs?.automatic_dispatch!==false,batch_jobs_supported:true,film_batches_supported:true,media_budget:capacity.snapshot,batches:(jobs?.data.batches??[]).map(b=>({id:b.id,...jobs.batchScheduling(b.id)})),jobs:jobs?.list().map(j=>({...j,input_requirements:mediaInputRequirements(jobs.get(j.id))}))??[],workers:Object.entries(targets()).map(([id,t])=>({id,kinds:Object.keys(t.engines??{}).filter(kind=>isAllowed(id,kind)),parallel_kinds:parallelKinds(id),busy:jobs?busy(id):false,budget:capacity.admission(id)}))};},
    async start(input){
      if(!jobs||!isEnabled())throw new Error('Media execution is switched off.');
      if(!input||!(mediaStartInput(input,'job_id,worker_id')||mediaStartInput(input,'following_job_ids,job_id,worker_id')))throw new Error('Choose queued jobs and an enrolled worker; select a member or parallel_members, not both.');
      const following=input.following_job_ids===undefined?[]:input.following_job_ids;
      if(!Array.isArray(following)||following.length>7)throw new Error('Choose at most seven following jobs.');
      const ids=[input.job_id,...following];
      if(new Set(ids).size!==ids.length)throw new Error('Choose each job only once.');
      const job=jobs.get(input.job_id);
      if(job.execution){
        if(input.parallel_members!==undefined&&Boolean(job.execution.parallel_members)!==input.parallel_members)throw Error('This job already belongs to a different execution mode; observe its original operation.');
        if(job.execution.worker_id!==input.worker_id||input.member!==undefined&&job.execution.member!==input.member)throw new Error('This job already belongs to another worker.');
        if(input.following_job_ids!==undefined&&JSON.stringify(ids)!==JSON.stringify(job.execution.batch_job_ids??[job.id]))throw new Error('This job already belongs to a different batch; read its existing execution.');
        return jobs.list().find(j=>j.id===job.id);
      }
      if(!isAllowed(input.worker_id,job.kind))throw new Error('Media placement is off for this engine on this machine. Existing work continues.');
      if(job.state!=='queued')throw new Error('Only an unstarted queued job can be assigned.');
      const selected=ids.map(id=>jobs.get(id));
      if(selected.some(j=>j.dispatch_hold))throw new Error('A selected media job is held by owner configuration; leave it queued.');
      if(selected.some(j=>j.state!=='queued'||j.execution||j.kind!==job.kind||j.priority!==job.priority))throw new Error('Batch jobs must be unassigned, queued, and use the same engine and priority.');
      if(busy(input.worker_id))throw new Error('This worker already has a media operation.');
      const capacity=assertCapacity(input.worker_id);
      const parallel=input.parallel_members===true;
      if(parallel&&(ids.length<2||!parallelKinds(input.worker_id).includes(job.kind)))throw Error('Parallel execution needs at least two jobs, explicit pair policy, physical mapping and both qualified member engines.');
      const engine=mediaEngine(config,input.worker_id,job.kind,input.member);
      const enrolled=mediaPair(config,workers().find(w=>w.id===input.worker_id)),pair=enrolled?{...enrolled,media_member:engine?.member??0}:null;
      if(input.member!==undefined&&!pair)throw Error('Explicit member selection requires a matching paired LLM');
      if(pair&&![0,1].includes(pair.media_member))throw Error('Invalid media pair member');
      const member=pair?.members[pair.media_member];
      const recovery=config.recovery?.workers?.find(w=>w.id===input.worker_id);
      const inspection=config.genie_chat?.inspection?.workers?.[input.worker_id];
      if(!engine||!inspection?.container||(!pair&&(!recovery||recovery.adapter!=='docker'||recovery.verification!=='qwen_vllm'))||!config.control_socket||!path.isAbsolute(config.genie_chat?.python??''))throw new Error('This worker lacks a qualified media and LLM-return enrollment.');
      if(!pair&&!matchesWorker(input.worker_id,recovery))throw new Error('Media enrollment no longer matches the registered worker; no engine was changed.');
      if(engine.kind!==(job.kind==='video'?'comfyui':'ace-step')||!/^[a-f0-9]{64}$/.test(engine.container)||!/^sha256:[a-f0-9]{64}$/.test(engine.image)||!Number.isSafeInteger(engine.port)||engine.port<1||engine.port>65535)throw new Error('Enroll an exact native media container, image and port.');
      const ssh=member?.ssh??inspection.ssh?.[0];if(typeof ssh!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9_.@-]*$/.test(ssh)||(!pair&&!recovery.ssh))throw new Error('Media execution needs its enrolled SSH host.');
      const lanes=parallel?[0,1].map(index=>({member:index,host:pair.members[index].ssh,llm_container:pair.members[index].container,
        engine:mediaEngine(config,input.worker_id,job.kind,index),job_ids:ids.filter((_,i)=>i%2===index)})):undefined;
      const assignment={worker_id:input.worker_id,physical_machines:capacity.machines,...(pair?{member:pair.media_member}:{}),...(lanes?{parallel_members:true,member_jobs:lanes.map(l=>({member:l.member,job_ids:l.job_ids}))}:{}),...(ids.length>1?{operation_id:job.id,batch_job_ids:ids}:{}),phase:'starting',at:new Date().toISOString()};
      // Check before writing a plan; assignExecution repeats the check in the
      // same synchronous durable write boundary. No async launch can oversubscribe.
      jobs.assertBatchCapacity(ids,assignment);
      // The root head is whichever member the normal enrollment uses; the
      // coordinator still captures/stops/restores the entire pair exactly once.
      const folder=jobs.executionFolder(job.id);fs.mkdirSync(folder,{recursive:true,mode:0o700});
      const required_recipe_fields=job.kind==='music'?[...new Set(selected.flatMap(j=>musicRecipeRequirements(j.payload)))].sort():[];
      const plan={operation_id:job.id,command_journal_version:1,...(required_recipe_fields.length?{required_recipe_fields}:{}),...(ids.length>1?{job_ids:ids}:{}),worker_id:input.worker_id,separate_workers:workers().filter(w=>!machinesFor(w.id,config).some(m=>machinesFor(input.worker_id,config).includes(m))).map(w=>w.id),host:ssh,llm_container:member?.container??inspection.container,engine,python:config.genie_chat.python,control_socket:config.control_socket,
        recovery:pair?{profile:'glm53-docker-pair',url:pair.worker_binding.url}:recovery,...(pair?{llm_pair:pair,endpoint:workers().find(w=>w.id===input.worker_id)}:{}),...(lanes?{media_lanes:lanes}:{}),model:config.model,context_length:config.context_length,results_directory:jobs.results.directory,inputs_directory:jobs.inputs.directory};
      saveMediaReceipt(folder,'plan.json',plan);
      saveMediaReceipt(folder,'media-jobs.json',{schema:1,jobs:selected});
      // Persist ownership before spawning. Lost acknowledgement never launches twice.
      jobs.assignExecution(ids,assignment);
      try{saveMediaReceipt(folder,'launched.json',await launchRunner(folder));}
      catch(error){saveMediaReceipt(folder,'progress.json',{phase:'launch_uncertain',detail:'Runner launch was not confirmed. Inspect this operation before any further action.',at:new Date().toISOString()});throw error;}
      return jobs.list().find(j=>j.id===job.id);
    },
  };
}
