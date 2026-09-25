import {mediaEngine,mediaMemberInput} from './media-enrollment.mjs';
import fs from 'node:fs';
import {execFile} from 'node:child_process';

const collector=fs.readFileSync(new URL('./media_input_placement.py',import.meta.url),'utf8');
const quote=v=>"'"+v.replaceAll("'","'\\''")+"'";
export function mediaInputRequirements(job){
  const files=[];
  if(job.kind==='video')for(const [node_id,node] of Object.entries(job.payload?.prompt??{})){
    const field=node?.class_type==='LoadImage'?'image':node?.class_type==='LoadAudio'?'audio':null;
    const name=field&&node.inputs?.[field];
    if(typeof name==='string'&&!name.startsWith('stargate/'))files.push({node_id,node_type:node.class_type,field,name});
  }
  return {engine_local_files:files,uploaded_inputs:job.kind==='video'&&Array.isArray(job.payload?.input_files)?job.payload.input_files.length:0,
    scope:'Known stock video loaders only. Engine-local files are not copied between workers. Custom loaders and music paths are not inspected.'};
}
export async function inspectMediaJobInputs(config,jobs,input,{inspect=remoteInspect}={}){
  if(!input||!mediaMemberInput(input,'job_id,worker_id'))throw Error('Choose a saved job_id and enrolled worker_id.');
  const job=jobs.get(input.job_id),requirements=mediaInputRequirements(job);
  const engine=mediaEngine(config,input.worker_id,job.kind,input.member);
  let connection=config.genie_chat?.inspection?.workers?.[input.worker_id];
  if(engine?.member!==undefined){
    const pair=config.media_jobs?.pairs?.[input.worker_id];
    if(![0,1].includes(engine.member)||pair?.kind!=='glm53-docker-pair'||pair.members?.[0]?.ssh!==connection?.ssh?.[0]||pair.members?.[0]?.container!==connection?.container)throw Error('Paired media inspection binding changed');
    connection={ssh:[pair.members[engine.member].ssh]};
  }
  if(job.kind!=='video'||engine?.kind!=='comfyui'||!connection)throw Error('Input inspection supports an enrolled ComfyUI video worker.');
  const result=requirements.engine_local_files.length?await inspect(connection,engine,requirements.engine_local_files):{files:[],scope:'No engine-local stock-loader files to inspect.'};
  return {job_id:job.id,worker_id:input.worker_id,...(input.member!==undefined?{member:input.member}:{}),observed_at:new Date().toISOString(),...requirements,...result,
    interpretation:'Read-only file presence, not image decoding or reference fidelity. A missing file on this worker may exist on another worker. Upload references to make them portable. Unknown checks do not establish absence. No job was started or changed.'};
}
function remoteInspect(connection,engine,files){
  if(!/^[a-f0-9]{64}$/.test(engine.container)||!/^sha256:[a-f0-9]{64}$/.test(engine.image))throw Error('Use an exact enrolled media container and image.');
  const host=connection.ssh?.[0];
  if(typeof host!=='string'||!/^[a-zA-Z0-9][\w.@-]{0,252}$/.test(host))throw Error('Use an enrolled inspection connection.');
  return new Promise((resolve,reject)=>{
    const child=execFile('ssh',['-T','-o','BatchMode=yes','-o','ConnectTimeout=8','--',host,`python3 -I -B -c ${quote(collector)}`],{timeout:20000,maxBuffer:65536},(error,out)=>{
      if(error)return reject(Error('Input inspection unavailable; no job or service changed.'));
      try{resolve(JSON.parse(out));}catch{reject(Error('Input inspection returned unreadable evidence; no job or service changed.'));}
    });
    child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify({container:engine.container,image:engine.image,files}));
  });
}
