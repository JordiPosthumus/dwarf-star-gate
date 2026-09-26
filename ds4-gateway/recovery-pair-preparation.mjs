// Native preparation is read-only on the fleet. It never installs recovery authority.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mediaPair} from './media-pair.mjs';

const helper=fileURLToPath(new URL('./recovery-pair-capture.py',import.meta.url));
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const execute=promisify(execFile);
const write=(file,value)=>{const fd=fs.openSync(file,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(value)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}};
function read(file){
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
  try{const s=fs.fstatSync(fd);if(!s.isFile()||s.uid!==process.getuid()||(s.mode&0o077)||s.size>65536)throw Error('Invalid private capture receipt');return JSON.parse(fs.readFileSync(fd,'utf8'));}finally{fs.closeSync(fd);}
}
export function createPairPreparation({config,readWorkers,spawnFn=spawn,inspect=null}){
  const directory=path.join(path.dirname(config.state_file),'genie','recovery-pair-preparation');
  const python=()=>fs.realpathSync(config.genie_chat.python);
  const statusOne=inspect??(async folder=>JSON.parse((await execute(python(),['-I','-B',helper,folder,'--status'],{timeout:10000,maxBuffer:65536})).stdout));
  const root=()=>{
    fs.mkdirSync(directory,{recursive:true,mode:0o700});const s=fs.lstatSync(directory);
    if(!s.isDirectory()||s.uid!==process.getuid()||(s.mode&0o077))throw Error('Private capture directory is not owner-only');
  };
  async function status(){
    root();const rows=[];
    for(const name of fs.readdirSync(directory).filter(name=>uuid.test(name))){
      const folder=path.join(directory,name),s=fs.lstatSync(folder);if(!s.isDirectory()||s.isSymbolicLink())throw Error('Invalid private capture directory');
      const request=read(path.join(folder,'request.json'));
      let result;try{result=await statusOne(folder);}catch{result={state:'unverified',reason:'native_capture_status_unavailable'};}
      rows.push({action_id:name,worker_id:request.worker_id,...Object.fromEntries(['state','reason','created_at','finished_at','evidence_sha256','context_length','concurrency','members','scope'].filter(k=>result[k]!==undefined).map(k=>[k,result[k]]))});
    }
    return rows;
  }
  async function prepare(input){
    if(!input||Object.keys(input).sort().join(',')!=='action_id,worker_id'||!uuid.test(input.action_id)||typeof input.worker_id!=='string')throw Error('Specify one worker and capture action ID');
    root();const folder=path.join(directory,input.action_id);
    if(fs.existsSync(folder)){
      const previous=read(path.join(folder,'request.json'));if(previous.worker_id!==input.worker_id)throw Error('Capture action belongs to another worker');
      return (await status()).find(r=>r.action_id===input.action_id);
    }
    const registry=await readWorkers(),worker=registry.workers?.find(w=>w.id===input.worker_id),pair=mediaPair(config,worker);
    if(!pair||!worker.is_healthy||worker.quarantine||worker.recovering)throw Error('Use a healthy worker with an exact configured GLM pair binding');
    const context=worker.context_length,concurrency=worker.max_concurrent_requests;
    if(!Number.isSafeInteger(context)||context<=0||!Number.isSafeInteger(concurrency)||concurrency<=0)throw Error('Current serving capacity is unverified');
    const endpoint=new URL(worker.url),port=worker.ssh?(worker.remote_port??8000):Number(endpoint.port||(endpoint.protocol==='https:'?443:80));
    const binding={worker_id:worker.id,model:pair.model,port,context_length:context,concurrency,
      members:pair.members.map(m=>({ssh:m.ssh,container:m.container,recipe_root:m.recipe_root??null}))};
    const request={...input,created_at:new Date().toISOString(),binding,route:pair.worker_binding};
    const interpreter=python(); // Optional capture availability cannot break dashboard startup.
    fs.mkdirSync(folder,{mode:0o700});write(path.join(folder,'request.json'),request);
    const fd=fs.openSync(folder,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    const log=fs.openSync(path.join(folder,'runner.log'),'wx',0o600);
    try{
      const child=spawnFn(interpreter,['-I','-B',helper,folder],{detached:true,stdio:['ignore',log,log],shell:false});
      child.on('error',()=>{});child.unref();
    }finally{fs.closeSync(log);}
    return {action_id:input.action_id,worker_id:input.worker_id,state:'submitted',scope:'Read-only capture requested. Observe recovery_status; no enrollment, restart or routing change.'};
  }
  return {prepare,status};
}
