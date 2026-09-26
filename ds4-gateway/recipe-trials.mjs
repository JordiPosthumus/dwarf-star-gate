// Executes only operator-enrolled, hashed recipe plans. Chat supplies no shell,
// paths, settings or hostnames. The trusted executor owns backup and restoration.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {machinesFor} from './fleet-machines.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export function createRecipeTrials({config,powerBusy=()=>false,launch=spawn}={}){
  const enrolled=config.recipe_trials??{},directory=path.join(path.dirname(config.state_file),'genie','recipe-trials');
  const read=file=>{try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw error;}};
  const allStatus=()=>{
    const entries=[];
    for(const id of fs.existsSync(directory)?fs.readdirSync(directory):[]){
      if(!uuid.test(id))continue;
      for(const stage of ['prepare','run','rollout']){
        const value=read(path.join(directory,id,`${stage}.status.json`));
        if(value)entries.push(value);
      }
    }
    return entries;
  };
  const compact=value=>Array.isArray(value)?value.map(compact):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).filter(([key])=>!['metrics_before','metrics_after'].includes(key)).map(([key,item])=>[key,key==='answer'&&typeof item==='string'?item.slice(0,160):compact(item)])):value;
  const status=()=>allStatus().sort((a,b)=>String(b.started_at).localeCompare(String(a.started_at))).slice(0,32).map(compact);
  const busy=worker=>allStatus().some(r=>['starting','running','restoration_required'].includes(r.state)&&machinesFor(r.worker,config).some(g=>machinesFor(worker,config).includes(g)));
  async function start({profile,stage,trial_id,expected_finished_at}){
    if(!uuid.test(trial_id??'')||!['prepare','run','rollout'].includes(stage)||!Object.hasOwn(enrolled,profile))throw Error('Use an enrolled recipe profile, supported stage and one operation UUID.');
    const binding=enrolled[profile];
    if(!path.isAbsolute(binding.plan_file??'')||!/^[a-f0-9]{64}$/.test(binding.plan_sha256??''))throw Error('Recipe plan enrollment is incomplete');
    const bytes=fs.readFileSync(binding.plan_file);if(hash(bytes)!==binding.plan_sha256)throw Error('Enrolled recipe plan changed; leave serving unchanged');
    const plan=JSON.parse(bytes),folder=path.join(directory,trial_id),file=path.join(folder,`${stage}.status.json`);
    const localMtp=plan.kind==='omlx-glm53-mtp-depth'&&/^[A-Za-z0-9][\w-]{0,63}$/.test(plan.worker??'');
    const legacyPair=['glm53f-sparks12','glm53f-sparks34'].includes(plan.worker);
    const customPair=/^[A-Za-z0-9][\w-]{0,63}$/.test(plan.worker??'')&&Array.isArray(config.machine_groups?.[plan.worker])&&config.machine_groups[plan.worker].length===2;
    const spark=plan.kind==='glm53-spark-pair-long-coding'&&(legacyPair||customPair);
    const rollout=plan.kind==='glm53-spark-pair-rollout'&&(legacyPair||customPair);
    if(plan.schema!==1||(!localMtp&&!spark&&!rollout)||rollout!==(stage==='rollout'))throw Error('Unsupported enrolled recipe plan or operation stage');
    if(localMtp){
      const endpoint=typeof plan.url==='string'&&plan.url.trim()===plan.url&&/^http:\/\/(?:127\.0\.0\.1|\[::1\]):([1-9][0-9]*)\/v1$/.exec(plan.url);
      if(!endpoint||Number(endpoint[1])>65535)throw Error('Local MTP trials require an explicit numeric loopback endpoint and port');
      if((plan.worker!=='glm53f-m3'&&!Array.isArray(config.machine_groups?.[plan.worker]))||machinesFor(plan.worker,config).length!==1)throw Error('Enroll the local trial worker with one explicit physical machine');
    }
    if((spark||rollout)&&(!legacyPair||plan.separate_workers!==undefined)){
      const separate=plan.separate_workers,taken=machinesFor(plan.worker,config);
      if(!Array.isArray(separate)||!separate.length||new Set(separate).size!==separate.length||separate.some(id=>typeof id!=='string'||!/^[A-Za-z0-9][\w-]{0,63}$/.test(id)||!Array.isArray(config.machine_groups?.[id])||machinesFor(id,config).some(m=>taken.includes(m))))throw Error('Enroll separate serving workers with explicit non-overlapping machine_groups');
    }
    const prior=read(file);let resume=false;
    if(expected_finished_at!==undefined&&(!rollout||!Number.isFinite(expected_finished_at)||expected_finished_at<=0))throw Error('Resume requires one completed rollout-copy failure timestamp');
    if(prior){
      if(prior.profile!==profile||prior.plan_sha256!==binding.plan_sha256)throw Error('Operation ID belongs to another plan');
      if(expected_finished_at===undefined||(prior.accepted_resume_finished_at??[]).includes(expected_finished_at))return prior;
      if(prior.state!=='failed'||prior.phase!=='copying_qualified_image'||prior.finished_at!==expected_finished_at)throw Error('Only the same confirmed failed image copy may resume; running or uncertain work is preserved');
      if(['gateway/acquire.intent.json','prepare.result.json','rollout.result.json','publication/result.json'].some(name=>fs.existsSync(path.join(folder,name))))throw Error('Preparation advanced beyond copying; inspect its original operation');
      resume=true;
    }else if(expected_finished_at!==undefined)throw Error('Unknown rollout to resume');
    const target=config.genie_chat?.inspection?.workers?.[plan.worker];
    if(localMtp?target?.kind!=='omlx-local'||target.root!==plan.root||target.url!==plan.url||target.api_key_file!==plan.api_key_file:!target?.ssh?.includes(plan.ssh)||target.recipe_root!==plan.recipe_root)throw Error('Recipe plan does not match the enrolled worker inspection binding');
    if(powerBusy(plan.worker)||busy(plan.worker))throw Error('An operation on this hardware is already running or needs restoration; inspect its existing receipt');
    fs.mkdirSync(folder,{recursive:true,mode:0o700});
    const savedPlan=path.join(folder,'plan.json');
    if(resume){if(hash(fs.readFileSync(savedPlan))!==binding.plan_sha256)throw Error('Saved rollout plan changed');}
    else if(stage==='prepare'||rollout)fs.writeFileSync(savedPlan,bytes,{flag:'wx',mode:0o600});
    else{
      if(hash(fs.readFileSync(savedPlan))!==binding.plan_sha256||read(path.join(folder,'prepare.status.json'))?.state!=='prepared')throw Error('Prepare this exact trial before running it');
    }
    const receipt={trial_id,...(rollout?{rollout_id:trial_id,operation_kind:'permanent_rollout'}:{}),profile,worker:plan.worker,stage,plan_sha256:binding.plan_sha256,state:'starting',started_at:new Date().toISOString(),...(resume?{resume_copy:true,phase:'copying_qualified_image',attempt:(prior.attempt??1)+1,accepted_resume_finished_at:[...(prior.accepted_resume_finished_at??[]),expected_finished_at]}:{})};
    if(resume){
      fs.writeFileSync(path.join(folder,`rollout-attempt-${prior.attempt??1}.json`),JSON.stringify(prior)+'\n',{flag:'wx',mode:0o600});
      const temp=file+'.resume.tmp';fs.writeFileSync(temp,JSON.stringify(receipt)+'\n',{flag:'wx',mode:0o600});fs.renameSync(temp,file);
    }else fs.writeFileSync(file,JSON.stringify(receipt)+'\n',{flag:'wx',mode:0o600});
    const output=fs.openSync(path.join(folder,`${stage}.log`),resume?'a':'ax',0o600);
    try{
      const child=launch(config.genie_chat.python,[path.join(here,rollout?'spark_recipe_rollout.py':localMtp?'omlx_recipe_trial.py':'spark_recipe_trial.py'),stage,folder,config.control_socket],{detached:true,stdio:['ignore',output,output]});
      child.once('error',()=>{const current=read(file);if(current?.state==='starting')fs.writeFileSync(file,JSON.stringify({...current,state:'failed',error:'Executor could not start; no serving change was issued.'})+'\n',{mode:0o600});});
      child.unref();
    }finally{fs.closeSync(output);}
    return {...receipt,next_step:'Read fleet_power_status recipe_trials for this trial ID. Do not repeat or claim completion while running.'};
  }
  return {start,status,busy};
}
