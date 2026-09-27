import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn,execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';

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
