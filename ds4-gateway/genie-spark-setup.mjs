import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn,execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createToolEndpoint} from './genie-tool-endpoint.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const remote=fs.readFileSync(new URL('./spark_setup_remote.py',import.meta.url),'utf8');
const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
export function bundleRecipes(){
  const files=['ds4-gateway/spark_qualify.py','ds4-gateway/spark_recovery.py','ds4-gateway/recovery-docker.py','ds4-gateway/docker_profile.py','ds4-gateway/serving_qualification.py','ds4-gateway/operation_runner.py','ds4-gateway/spark_setup_remote.py','examples/server-profiles/qwen38-nvfp4-vllm.json'];
  const visit=dir=>{for(const entry of fs.readdirSync(path.join(root,dir),{withFileTypes:true})){
    if(entry.name==='__pycache__'||entry.name.startsWith('test_')||entry.name.startsWith('.'))continue;
    const name=path.posix.join(dir,entry.name);
    if(entry.isDirectory())visit(name);
    else if(entry.isFile()&&(/\.(py|json|lock|txt|md)$/.test(name)||entry.name==='Dockerfile'||entry.name.startsWith('LICENSE')))files.push(name);
  }};
  visit('examples/spark-build');
  const bytes=execFileSync('tar',['-czf','-','-C',root,...files.sort()],{maxBuffer:8*1024*1024,env:{...process.env,COPYFILE_DISABLE:'1'}});
  return {bundle:bytes.toString('base64'),bundle_sha256:createHash('sha256').update(bytes).digest('hex')};
}
export function setupTransport(target,input){
  return new Promise((resolve,reject)=>{
    const child=spawn('ssh',['-T','-o','BatchMode=yes','-o','ConnectTimeout=10','--',target.ssh,`python3 -I -B -c ${quote(remote)}`],{stdio:['pipe','pipe','pipe']});
    let output='',overflow=false;
    const timer=setTimeout(()=>child.kill(),20000);timer.unref();
    child.stdout.setEncoding('utf8');child.stderr.resume();child.stdin.on('error',()=>{});
    child.stdout.on('data',chunk=>{output+=chunk;if(Buffer.byteLength(output)>1024*1024){overflow=true;child.kill();}});
    child.once('error',()=>{clearTimeout(timer);reject(new Error('Setup SSH unavailable; read the same target status before retrying.'));});
    child.once('close',code=>{clearTimeout(timer);try{const result=JSON.parse(output);if(overflow||code!==0)throw new Error(result.error??'Setup acknowledgement unavailable');resolve(result);}catch(error){reject(new Error(`${error.message}. Inspect the same target before another start; remote work may continue.`));}});
    child.stdin.end(JSON.stringify({...input,directory:target.directory}));
  });
}

export function createSparkSetupTools(config,{isEnabled=()=>true,isTesting=()=>false,transport=setupTransport,bundle=bundleRecipes,registration=null,mediaQualification=null,continuation=null}={}){
  if(config.spark_setup?.enabled!==true)return null;
  if(config.ui_worker_management!==true)throw new Error('Spark setup requires local worker management.');
  const targets=config.spark_setup.targets??{};
  if(!targets||typeof targets!=='object'||Array.isArray(targets))throw new Error('Spark setup targets must be an object.');
  const aliases=new Set();
  for(const [id,target] of Object.entries(targets)){
    if(!/^[a-zA-Z0-9][\w-]{0,63}$/.test(id)||!target||!/^[a-zA-Z0-9][\w.-]{0,127}$/.test(target.ssh)||typeof target.directory!=='string'||!target.directory.startsWith('/')||target.directory==='/'||target.directory.split('/').includes('..'))throw new Error('Enroll each new Spark with an ID, SSH alias and dedicated absolute remote directory.');
    if(aliases.has(target.ssh))throw new Error('One setup enrollment per SSH alias.');aliases.add(target.ssh);
  }
  // Cache observations for frequent UI refresh; only explicit tool reads call SSH.
  const observations=new Map();
  const present=()=>({configured:true,targets:Object.keys(targets).map(id=>({target_id:id,...(observations.get(id)??{state:'not_observed'}),registration:registration?.read(id)??null,media_qualification:mediaQualification?.read(id)??null,media_qualification_required:!!mediaQualification,continuation:continuation?.status(id)??null})),scope:'New Spark preparation. Native qualification and gateway registration are separate steps.'});
  const read=async id=>{try{const result=await transport(targets[id],{action:'status'});const row={...result,observed_at:new Date().toISOString()};observations.set(id,row);return {target_id:id,...row};}catch(error){const row={state:'unavailable',error:error.message,observed_at:new Date().toISOString()};observations.set(id,row);return {target_id:id,...row};}};
  const pending=new Set();
  const endpoint=createToolEndpoint('/api/genie/spark-setup-tools','x-sg-spark-setup-tool',async input=>{
    if(input?.action==='status'&&Object.keys(input).sort().join(',')==='action'){
      await Promise.all(Object.keys(targets).map(read));return present();
    }
    if(!['setup','start','qualify_media','qualify','register'].includes(input?.action)||Object.keys(input).sort().join(',')!=='action,target_id'||!Object.hasOwn(targets,input.target_id))throw new Error('Read setup status and select an explicitly enrolled new Spark.');
    if(!isEnabled())throw new Error('New Spark setup is switched off. Existing preparation continues.');
    if(isTesting())throw new Error('New setup starts are paused in testing mode.');
    const id=input.target_id;
    if(pending.has(id))throw new Error('Setup submission is already in progress; inspect the same target.');
    pending.add(id);
    try{
      if(input.action==='setup'){
        if(!continuation)throw new Error('Automatic setup continuation is not connected.');
        return continuation.request(id);
      }
      if(input.action==='qualify_media'){
        if(!mediaQualification)throw new Error('New-host media qualification is not connected.');
        return await mediaQualification.start(id,targets[id]);
      }
      if(['qualify','register'].includes(input.action)&&['accepted','running'].includes(mediaQualification?.read(id)?.state))throw new Error('Wait for this target media qualification to finish.');
      if(input.action==='register'){
        if(!registration)throw new Error('Gateway registration is not connected.');
        const proof=await transport(targets[id],{action:'verify_serving'});
        const media=proof.recovery&&mediaQualification?.enrollment?await mediaQualification.enrollment(id,targets[id],proof.container):{};
        return await registration.register(id,targets[id],proof,media);
      }
      const before=await read(id);
      if(input.action==='start'&&before.state!=='not_started')return before;
      if(input.action==='qualify'&&(before.state!=='prepared_stopped'||before.qualification))return before;
      const result=await transport(targets[id],{action:input.action,...bundle()});
      observations.set(id,{...(input.action==='qualify'?{...before,qualification:result}:result),observed_at:new Date().toISOString()});return {target_id:id,...result};
    }catch(error){observations.set(id,{state:'unconfirmed',error:error.message,observed_at:new Date().toISOString()});throw error;}
    finally{pending.delete(id);}
  });
  let refresh=null,lastRefresh=0;
  const status=()=>{
    // A slow/offline SSH target must not hold up the other capability controls.
    if(!refresh&&Date.now()-lastRefresh>=15000){
      refresh=Promise.all(Object.keys(targets).map(read)).finally(()=>{lastRefresh=Date.now();refresh=null;});
    }
    return present();
  };
  return {...endpoint,status};
}
