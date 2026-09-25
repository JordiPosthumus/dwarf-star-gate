import {mediaPair} from './media-pair.mjs';
import fs from 'node:fs';
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mediaEngines} from './media-hosts.mjs';

const collector=fs.readFileSync(new URL('./media_resources.py',import.meta.url),'utf8');
const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
// Registry-driven: every supported engine with a shipped recipe manifest is
// described; engines without a manifest are honestly absent.
export const mediaRecipeResources=mediaEngines.filter(e=>e.supported&&fs.existsSync(new URL(`../examples/spark-build/${e.id}/models.json`,import.meta.url))).map(({id:engine})=>{
  const bytes=fs.readFileSync(new URL(`../examples/spark-build/${engine}/models.json`,import.meta.url)),manifest=JSON.parse(bytes);
  return {engine,model_bytes_required:manifest.files.reduce((n,f)=>n+f.bytes,0),model_files_required:manifest.files.length,manifest_sha256:createHash('sha256').update(bytes).digest('hex'),platform:'Linux ARM64 with NVIDIA GB10',installed_model_inventory_checked:false,scope:'Files required by this recipe, not an inventory of installed files or a RAM estimate; not all files necessarily load together. Images, build caches and generated outputs require additional disk. Runtime memory fit requires native qualification of the selected engine and job.'};
});
function execute(file,args,input){
  return new Promise((resolve,reject)=>{
    const child=execFile(file,args,{timeout:45000,maxBuffer:65536},(error,out)=>{
      if(error)return reject(Error('Resource inspection unavailable; existing services were untouched.'));
      try{resolve(JSON.parse(out));}catch{reject(Error('Invalid resource observation; existing services were untouched.'));}
    });
    child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(input));
  });
}
export async function inspectMediaResources(target){
  if(target?.kind==='omlx-local')return execute('python3',['-I','-B','-c',collector],{});
  if(!target||typeof target.container!=='string'||!/^[a-zA-Z0-9][\w.-]{0,127}$/.test(target.container)||!Array.isArray(target.ssh)||!target.ssh.length||target.ssh.some(s=>typeof s!=='string'||!/^[a-zA-Z0-9][\w.@-]{0,252}$/.test(s)))throw Error('Enroll a fixed inspection connection for this worker first.');
  for(const alias of target.ssh){
    try{return await execute('ssh',['-T','-o','BatchMode=yes','-o','ConnectTimeout=8','--',alias,`python3 -I -B -c ${quote(collector)}`],{container:target.container});}catch{}
  }
  throw Error('Resource inspection unavailable through enrolled connections; existing services were untouched.');
}
export function createMediaResources(config,{isEnabled=()=>true,inspect=inspectMediaResources}={}){
  const observations=new Map(),pending=new Map();
  return {status:()=>Object.fromEntries(observations),async inspect(id,member){
    if(!isEnabled())throw Error('Server inspection is switched off.');
    let target=config.genie_chat?.inspection?.workers?.[id];
    if(member!==undefined){
      const pair=mediaPair(config,(config.workers??config.nodes??[]).find(w=>w.id===id)??config.media_jobs?.pairs?.[id]?.worker_binding);
      if(![0,1].includes(member)||!pair)throw Error('Choose a member of an enrolled paired LLM');
      target={...target,ssh:[pair.members[member].ssh],container:pair.members[member].container};
    }
    const key=member===undefined?id:`${id}:${member}`;
    if(!target)throw Error('No inspection connection is enrolled for this worker.');
    if(pending.has(key))return pending.get(key);
    const work=(async()=>{
      try{
        const observed=await inspect(target);
        const compatible=observed.system==='Linux'&&['arm64','aarch64'].includes(observed.architecture)&&['arm64','aarch64'].includes(observed.docker_architecture)&&observed.gpu_names?.length>0&&observed.gpu_names.every(n=>n.includes('GB10'));
        const candidates=Object.entries(config.media_jobs?.reuse?.[id]?.[member??0]??{}).filter(([,v])=>v).map(([engine,v])=>({engine,container:v.container,image:v.image,source:v.source??'retained_preparation'}));
        const row={worker_id:id,...(member!==undefined?{member}:{}),state:'observed',...observed,configured_reuse_candidates:candidates,recipe_platform_matches:compatible,recipes:mediaRecipeResources,setup:compatible?'Matches the shipped Spark recipe platform. New installation needs destination/build/output space checks and native qualification.':'The shipped Spark recipes are not verified for this observed platform. Existing engine enrollments and serving capabilities are unchanged.'};
        observations.set(key,row);return row;
      }catch(error){observations.set(key,{worker_id:id,...(member!==undefined?{member}:{}),state:'unavailable',observed_at:new Date().toISOString(),error:error.message});throw error;}
      finally{pending.delete(key);}
    })();pending.set(key,work);return work;
  }};
}
