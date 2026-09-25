// Executes only operator-enrolled, hashed recipe plans. Chat supplies no shell,
// paths, settings or hostnames. The trusted executor owns backup and restoration.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {machineGroup} from './fleet-machines.mjs';
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
  const busy=worker=>allStatus().some(r=>['starting','running','restoration_required'].includes(r.state)&&(machineGroup(r.worker)??[]).some(g=>(machineGroup(worker)??[]).includes(g)));
  async function start({profile,stage,trial_id}){
    if(!uuid.test(trial_id??'')||!['prepare','run','rollout'].includes(stage)||!Object.hasOwn(enrolled,profile))throw Error('Use an enrolled recipe profile, supported stage and one operation UUID.');
    const binding=enrolled[profile];
    if(!path.isAbsolute(binding.plan_file??'')||!/^[a-f0-9]{64}$/.test(binding.plan_sha256??''))throw Error('Recipe plan enrollment is incomplete');
    const bytes=fs.readFileSync(binding.plan_file);if(hash(bytes)!==binding.plan_sha256)throw Error('Enrolled recipe plan changed; leave serving unchanged');
    const plan=JSON.parse(bytes),folder=path.join(directory,trial_id),file=path.join(folder,`${stage}.status.json`);
    const localMtp=plan.kind==='omlx-glm53-mtp-depth'&&plan.worker==='glm53f-m3';
    const spark=plan.kind==='glm53-spark-pair-long-coding'&&['glm53f-sparks12','glm53f-sparks34'].includes(plan.worker);
    const rollout=plan.kind==='glm53-spark-pair-rollout'&&['glm53f-sparks12','glm53f-sparks34'].includes(plan.worker);
    if(plan.schema!==1||(!localMtp&&!spark&&!rollout)||rollout!==(stage==='rollout'))throw Error('Unsupported enrolled recipe plan or operation stage');
    const prior=read(file);
    if(prior){if(prior.profile!==profile||prior.plan_sha256!==binding.plan_sha256)throw Error('Operation ID belongs to another plan');return prior;}
    const target=config.genie_chat?.inspection?.workers?.[plan.worker];
    if(localMtp?target?.kind!=='omlx-local'||target.root!==plan.root||target.url!==plan.url||target.api_key_file!==plan.api_key_file:!target?.ssh?.includes(plan.ssh)||target.recipe_root!==plan.recipe_root)throw Error('Recipe plan does not match the enrolled worker inspection binding');
    if(powerBusy(plan.worker)||busy(plan.worker))throw Error('An operation on this hardware is already running or needs restoration; inspect its existing receipt');
    fs.mkdirSync(folder,{recursive:true,mode:0o700});
    const savedPlan=path.join(folder,'plan.json');
    if(stage==='prepare'||rollout)fs.writeFileSync(savedPlan,bytes,{flag:'wx',mode:0o600});
    else{
      if(hash(fs.readFileSync(savedPlan))!==binding.plan_sha256||read(path.join(folder,'prepare.status.json'))?.state!=='prepared')throw Error('Prepare this exact trial before running it');
    }
    const receipt={trial_id,...(rollout?{rollout_id:trial_id,operation_kind:'permanent_rollout'}:{}),profile,worker:plan.worker,stage,plan_sha256:binding.plan_sha256,state:'starting',started_at:new Date().toISOString()};
    fs.writeFileSync(file,JSON.stringify(receipt)+'\n',{flag:'wx',mode:0o600});
    const output=fs.openSync(path.join(folder,`${stage}.log`),'ax',0o600);
    try{
      const child=launch(config.genie_chat.python,[path.join(here,rollout?'spark_recipe_rollout.py':localMtp?'omlx_recipe_trial.py':'spark_recipe_trial.py'),stage,folder,config.control_socket],{detached:true,stdio:['ignore',output,output]});
      child.once('error',()=>{const current=read(file);if(current?.state==='starting')fs.writeFileSync(file,JSON.stringify({...current,state:'failed',error:'Executor could not start; no serving change was issued.'})+'\n',{mode:0o600});});
      child.unref();
    }finally{fs.closeSync(output);}
    return {...receipt,next_step:'Read fleet_power_status recipe_trials for this trial ID. Do not repeat or claim completion while running.'};
  }
  return {start,status,busy};
}
