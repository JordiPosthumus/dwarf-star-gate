// Owner-supplied new hosts only. Enrollment never starts a model or modifies a launcher.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
const execute=promisify(execFile);
const idPattern=/^[a-zA-Z0-9][\w-]{0,63}$/;
const hostPattern=/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/;
const userPattern=/^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/;
const probe=`import json,os,platform,shutil,subprocess,sys
from pathlib import Path
def read(args):
 try:
  p=subprocess.run(args,capture_output=True,text=True,timeout=8)
  return p.stdout.strip() if p.returncode==0 else None
 except (OSError,subprocess.TimeoutExpired):return None
home=str(Path.home())
print(json.dumps({'home':home,'system':platform.system(),'architecture':platform.machine(),'python':list(sys.version_info[:3]),'docker_arch':read(['docker','version','--format','{{.Server.Arch}}']),'gpu':read(['nvidia-smi','--query-gpu=name','--format=csv,noheader']),'gpu_processes':read(['nvidia-smi','--query-compute-apps=pid','--format=csv,noheader,nounits']),'free_bytes':shutil.disk_usage(home).free}))`;
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
export async function sshDestination(ssh){
  const {stdout}=await execute('ssh',['-G','--',ssh],{timeout:10000,maxBuffer:131072});
  return stdout.split('\n').find(s=>s.startsWith('hostname '))?.slice(9).toLowerCase();
}
export async function inspectNewSpark(ssh,{directory}){
  // Accept a previously unknown host, never a changed host key. Keep the prior
  // known_hosts bytes before OpenSSH appends its first-use entry.
  const known=path.join(os.homedir(),'.ssh','known_hosts');
  if(fs.existsSync(known)){const backup=path.join(directory,`known-hosts-before-${Date.now()}-${randomUUID()}`);fs.copyFileSync(known,backup,fs.constants.COPYFILE_EXCL);fs.chmodSync(backup,0o600);}
  try{
    const {stdout}=await execute('ssh',['-T','-o','BatchMode=yes','-o','ConnectTimeout=10','-o','StrictHostKeyChecking=accept-new','--',ssh,`python3 -I -B -c ${quote(probe)}`],{timeout:45000,maxBuffer:65536});
    const result=JSON.parse(stdout);
    if(typeof result.home!=='string'||!result.home.startsWith('/')||result.home.includes('\n')||result.home.split('/').includes('..'))throw Error('Invalid home directory');
    return result;
  }catch{throw Error('Could not inspect this Spark through SSH. Check its address, username and SSH key access. A changed host key must be checked explicitly. No setup was started; do not put passwords or private keys in chat.');}
}
export function createSparkEnrollment({directory,targets:staticTargets={},workers=async()=>[],inspect=inspectNewSpark,resolve=sshDestination}){
  fs.mkdirSync(directory,{recursive:true,mode:0o700});
  const filename=path.join(directory,'targets.json');
  const saved=fs.existsSync(filename)?JSON.parse(fs.readFileSync(filename,'utf8')):{};
  const targets={...staticTargets};
  for(const [id,t] of Object.entries(saved)){
    if(!idPattern.test(id)||!t||typeof t.ssh!=='string'||typeof t.directory!=='string')throw Error('Invalid saved Spark enrollment; file preserved.');
    if(targets[id]&&JSON.stringify(targets[id])!==JSON.stringify(t))throw Error('Static and saved Spark enrollment differ; inspect before continuing.');
    targets[id]=t;
  }
  let busy=false;
  return {targets,async enroll(input){
    if(!input||Object.keys(input).sort().join(',')!=='host,target_id,username'||!idPattern.test(input.target_id)||typeof input.host!=='string'||!hostPattern.test(input.host)||typeof input.username!=='string'||!userPattern.test(input.username))throw Error('Give the new Spark a target ID, IPv4 address or hostname, and SSH username. No commands, passwords or paths.');
    const {target_id:id,username}=input,host=input.host.toLowerCase(),ssh=`${username}@${host}`;
    if(ssh.length>253)throw Error('SSH username and host are too long for gateway registration.');
    if(busy)throw Error('An enrollment check is already running; read status before retrying.');
    busy=true;
    try{
      if(Object.hasOwn(targets,id)){
        if(targets[id].ssh!==ssh)throw Error('This target ID already names another SSH connection; nothing was changed.');
        return {target_id:id,state:'enrolled',target:targets[id],scope:'Existing enrollment returned unchanged. No setup started.'};
      }
      const existing=await workers();
      if(existing.some(w=>w.id===id))throw Error('This worker already belongs to the gateway; use its existing controls.');
      const destination=await resolve(ssh);
      if(!destination)throw Error('Could not resolve the new SSH destination.');
      for(const t of [...existing,...Object.values(targets)])for(const alias of [t.ssh,...(t.ssh_fallbacks??[])].filter(Boolean)){
        if(alias===ssh||await resolve(alias)===destination)throw Error('This SSH destination is already enrolled or serving; it was not changed.');
      }
      const observed=await inspect(ssh,{directory});
      if(observed.system!=='Linux'||!['aarch64','arm64'].includes(observed.architecture)||!observed.gpu?.split('\n').every(s=>s.includes('GB10')))throw Error('This target did not identify as a Linux ARM64 GB10 Spark; no enrollment or setup was performed.');
      const target={ssh,directory:path.posix.join(observed.home,'.local/share/star-gate/spark-setup',id)};
      const next={...saved,[id]:target},temp=filename+'.'+randomUUID()+'.tmp';
      if(fs.existsSync(filename))fs.copyFileSync(filename,filename+`.before-${Date.now()}-${randomUUID()}`,fs.constants.COPYFILE_EXCL);
      try{fs.writeFileSync(temp,JSON.stringify(next,null,2)+'\n',{flag:'wx',mode:0o600});fs.renameSync(temp,filename);}finally{if(fs.existsSync(temp))fs.unlinkSync(temp);}
      Object.assign(saved,next);targets[id]=target;
      const issues=[];
      if(observed.python?.[0]!==3||observed.python?.[1]<12)issues.push('Python 3.12 or newer is required.');
      if(observed.docker_arch!=='arm64')issues.push('Docker ARM64 access is not ready for this SSH account.');
      if(observed.gpu_processes===null)issues.push('GPU activity could not be checked.');else if(observed.gpu_processes)issues.push('GPU work is active; leave it running and wait before setup.');
      if(observed.free_bytes<227190220529)issues.push('Insufficient free space for the 227 GB of model files alone; images and caches need additional space.');
      return {target_id:id,state:'enrolled',target,readiness:issues.length?'needs_attention':'prerequisites_observed',issues,observed,scope:'SSH and host facts inspected; target saved. No engines built or started. Native setup and qualification are still required. Use setup_spark when prerequisites are ready.'};
    }finally{busy=false;}
  }};
}
