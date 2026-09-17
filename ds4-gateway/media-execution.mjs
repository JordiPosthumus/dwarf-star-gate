// One detached process owns a selected job/batch and its single LLM return.
// It writes its own queue receipt; the core remains the sole global-queue writer.
import fs from 'node:fs';
import {mediaInputRequirements} from './media-input-placement.mjs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
const script=fileURLToPath(new URL('./media-runner.mjs',import.meta.url));
export function saveMediaReceipt(folder,name,value){
  const target=path.join(folder,name),temporary=target+'.'+randomUUID()+'.tmp';
  fs.writeFileSync(temporary,JSON.stringify(value,null,2)+'\n',{mode:0o600,flag:'wx'});
  fs.renameSync(temporary,target);
}
const launch=async folder=>{
  const log=fs.openSync(path.join(folder,'runner.log'),'ax',0o600);
  try{
    const child=spawn(process.execPath,[script,folder],{detached:true,stdio:['ignore',log,log]});
    await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
    child.unref();return {pid:child.pid,at:new Date().toISOString()};
  }finally{fs.closeSync(log);}
};
export function createMediaExecution(config,jobs,{isEnabled=()=>false,launchRunner=launch,matchesWorker=()=>true,isAllowed=()=>true}={}){
  const targets=()=>config.media_jobs?.workers??{};
  const terminal=new Set(['returned','failed_returned','failed_unchanged']);
  const busy=worker=>jobs.list().some(j=>j.execution?.worker_id===worker&&!terminal.has(j.execution.phase));
  return {
    status:()=>({configured:!!jobs,enabled:isEnabled(),batch_jobs_supported:true,jobs:jobs?.list().map(j=>({...j,input_requirements:mediaInputRequirements(jobs.get(j.id))}))??[],workers:Object.entries(targets()).map(([id,t])=>({id,kinds:Object.keys(t.engines??{}).filter(kind=>isAllowed(id,kind)),busy:jobs?busy(id):false}))}),
    async start(input){
      if(!jobs||!isEnabled())throw new Error('Media execution is switched off.');
      if(!input||!['job_id,worker_id','following_job_ids,job_id,worker_id'].includes(Object.keys(input).sort().join(',')))throw new Error('Choose a queued job and enrolled worker.');
      const following=input.following_job_ids===undefined?[]:input.following_job_ids;
      if(!Array.isArray(following)||following.length>7)throw new Error('Choose at most seven following jobs.');
      const ids=[input.job_id,...following];
      if(new Set(ids).size!==ids.length)throw new Error('Choose each job only once.');
      const job=jobs.get(input.job_id);
      if(job.execution){
        if(job.execution.worker_id!==input.worker_id)throw new Error('This job already belongs to another worker.');
        if(input.following_job_ids!==undefined&&JSON.stringify(ids)!==JSON.stringify(job.execution.batch_job_ids??[job.id]))throw new Error('This job already belongs to a different batch; read its existing execution.');
        return jobs.list().find(j=>j.id===job.id);
      }
      if(!isAllowed(input.worker_id,job.kind))throw new Error('Media placement is off for this engine on this machine. Existing work continues.');
      if(job.state!=='queued')throw new Error('Only an unstarted queued job can be assigned.');
      const selected=ids.map(id=>jobs.get(id));
      if(selected.some(j=>j.state!=='queued'||j.execution||j.kind!==job.kind||j.priority!==job.priority))throw new Error('Batch jobs must be unassigned, queued, and use the same engine and priority.');
      if(busy(input.worker_id))throw new Error('This worker already has a media operation.');
      const target=targets()[input.worker_id],engine=target?.engines?.[job.kind];
      const recovery=config.recovery?.workers?.find(w=>w.id===input.worker_id);
      const inspection=config.genie_chat?.inspection?.workers?.[input.worker_id];
      if(!engine||!inspection?.container||!recovery||recovery.adapter!=='docker'||recovery.verification!=='qwen_vllm'||!config.control_socket||!path.isAbsolute(config.genie_chat?.python??''))throw new Error('This worker lacks a qualified media and LLM-return enrollment.');
      if(!matchesWorker(input.worker_id,recovery))throw new Error('Media enrollment no longer matches the registered worker; no engine was changed.');
      if(engine.kind!==(job.kind==='video'?'comfyui':'ace-step')||!/^[a-f0-9]{64}$/.test(engine.container)||!/^sha256:[a-f0-9]{64}$/.test(engine.image)||!Number.isSafeInteger(engine.port)||engine.port<1||engine.port>65535)throw new Error('Enroll an exact native media container, image and port.');
      const ssh=inspection.ssh?.[0];if(typeof ssh!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9_.@-]*$/.test(ssh)||!recovery.ssh)throw new Error('Media execution needs its enrolled SSH host.');
      const folder=jobs.executionFolder(job.id);fs.mkdirSync(folder,{recursive:true,mode:0o700});
      const plan={operation_id:job.id,...(ids.length>1?{job_ids:ids}:{}),worker_id:input.worker_id,host:ssh,llm_container:inspection.container,engine,python:config.genie_chat.python,control_socket:config.control_socket,
        recovery,model:config.model,context_length:config.context_length,results_directory:jobs.results.directory,inputs_directory:jobs.inputs.directory};
      saveMediaReceipt(folder,'plan.json',plan);
      saveMediaReceipt(folder,'media-jobs.json',{schema:1,jobs:selected});
      // Persist ownership before spawning. Lost acknowledgement never launches twice.
      jobs.assignExecution(ids,{worker_id:input.worker_id,...(ids.length>1?{operation_id:job.id,batch_job_ids:ids}:{}),phase:'starting',at:new Date().toISOString()});
      try{saveMediaReceipt(folder,'launched.json',await launchRunner(folder));}
      catch(error){saveMediaReceipt(folder,'progress.json',{phase:'launch_uncertain',detail:'Runner launch was not confirmed. Inspect this operation before any further action.',at:new Date().toISOString()});throw error;}
      return jobs.list().find(j=>j.id===job.id);
    },
  };
}
