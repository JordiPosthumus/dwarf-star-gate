import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { workerConfig, sshTargets } from './worker-config.mjs';

const sshFailurePatterns = [
  ['adapter_dns_failure', /could not resolve hostname|name or service not known|nodename nor servname provided/i],
  ['adapter_host_key_failure', /host key verification failed|remote host identification has changed/i],
  ['adapter_auth_failure', /permission denied|no supported authentication methods available/i],
  ['adapter_connect_timeout', /connection timed out|operation timed out|connect timeout/i],
  ['adapter_connection_refused', /connection refused/i],
  ['adapter_route_unreachable', /no route to host|network is unreachable/i],
  ['adapter_connection_reset', /connection reset|connection closed by remote host|connection closed by .* port/i],
];

// Public recovery state receives a bounded reason class, never SSH stderr,
// aliases, addresses, usernames or command output.
export function classifySshFailure(stderr='', errorCode=null, exitCode=null) {
  const text=String(stderr).slice(-4096);
  for(const [reason,pattern] of sshFailurePatterns)if(pattern.test(text))return reason;
  if(errorCode==='ENOENT'||errorCode==='EACCES')return 'adapter_spawn_failed';
  if(errorCode==='ETIMEDOUT')return 'adapter_connect_timeout';
  if(errorCode==='ECONNREFUSED')return 'adapter_connection_refused';
  if(errorCode==='EHOSTUNREACH'||errorCode==='ENETUNREACH')return 'adapter_route_unreachable';
  if(errorCode==='ECONNRESET')return 'adapter_connection_reset';
  if(errorCode===null&&exitCode===null)return null;
  return exitCode===255?'adapter_unreachable':'adapter_check_failed';
}

export function recoveryConfig(raw={}) {
  if(Object.keys(raw).some(k=>!['workers'].includes(k)) || !Array.isArray(raw.workers??[]))throw new Error('Invalid recovery configuration');
  const configs=new Map(), machines=new Set();
  for(const entry of raw.workers??[]) {
    if(Object.keys(entry).some(k=>!['id','url','ssh','ssh_fallbacks','remote_port','adapter','transport','python','helper','config','machine','profile','service_profile','start_stopped','exclusive','bootstrap_removed','bootstrap_callers','retained_definition_sha256'].includes(k)))throw new Error('Unsupported recovery configuration field');
    const worker=workerConfig(Object.fromEntries(['id','url','ssh','ssh_fallbacks','remote_port'].filter(k=>entry[k]!==undefined).map(k=>[k,entry[k]])));
    const local=entry.transport==='local';
    if(entry.transport!==undefined&&!['ssh','local'].includes(entry.transport))throw new Error('Recovery transport must be ssh or local');
    if(!['systemd-user','launchd'].includes(entry.adapter)||(!local&&!worker.ssh)||(local&&(entry.adapter!=='launchd'||worker.ssh)))throw new Error('Recovery requires an enrolled SSH adapter or an explicitly local launchd worker');
    if(local){
      if(typeof entry.python!=='string'||!path.isAbsolute(entry.python)||entry.python.includes('\0'))throw new Error('Local recovery requires an absolute enrolled Python interpreter');
    }else if(entry.python!==undefined)throw new Error('Python interpreter enrollment is only valid for local recovery');
    if(entry.exclusive!==true)throw new Error('Recovery requires explicit exclusive DSG ownership of the endpoint');
    for(const field of ['helper','config'])if(typeof entry[field]!=='string'||!path.isAbsolute(entry[field])||entry[field].includes('\0')||(!local&&(!/^\/[A-Za-z0-9_./-]+$/.test(entry[field])||entry[field].includes('/../'))))throw new Error('Recovery paths must be absolute and shell-safe for SSH');
    for(const field of ['machine','profile'])if(!/^[a-f0-9]{64}$/.test(entry[field]))throw new Error('Enroll the recovery machine and profile first');
    if(entry.start_stopped!==undefined&&typeof entry.start_stopped!=='boolean')throw new Error('start_stopped must be boolean');
    if(entry.start_stopped===true&&!/^[a-f0-9]{64}$/.test(entry.service_profile))throw new Error('Starting a stopped service requires its enrolled static service profile');
    if(entry.bootstrap_removed!==undefined&&typeof entry.bootstrap_removed!=='boolean')throw new Error('bootstrap_removed must be boolean');
    if(entry.bootstrap_removed===true){
      if(entry.adapter!=='launchd'||!/^[a-f0-9]{64}$/.test(entry.service_profile)||!/^[a-f0-9]{64}$/.test(entry.retained_definition_sha256)||
        !Array.isArray(entry.bootstrap_callers)||entry.bootstrap_callers.some(c=>!['loginwindow','runningboardd'].includes(c))||new Set(entry.bootstrap_callers).size!==entry.bootstrap_callers.length)
        throw new Error('Bootstrap requires explicit launchd static identity, retained pin and caller policy');
    }else if(entry.bootstrap_callers!==undefined||entry.retained_definition_sha256!==undefined)throw new Error('Bootstrap fields require explicit bootstrap enrollment');
    if(entry.start_stopped!==true&&entry.bootstrap_removed!==true&&entry.service_profile!==undefined)throw new Error('service_profile requires enrolled start or bootstrap authority');
    if(configs.has(worker.id) || machines.has(entry.machine))throw new Error('Only one registered recovery service per physical machine in v1');
    configs.set(worker.id,{...entry,...worker});machines.add(entry.machine);
  }
  return configs;
}

// Same-host execution is explicit, macOS-only and never falls back from failed
// SSH. Private enrollment, not Genie input, selects these files and interpreter.
function localInvocation(config,{platform=process.platform,uid=process.getuid?.()}={}){
  if(platform!=='darwin'||!Number.isInteger(uid)||uid===0)throw new Error('adapter_local_unavailable');
  try{
    recoveryConfig({workers:[config]});
    if(config.adapter!=='launchd'||config.transport!=='local'||config.ssh||config.ssh_fallbacks||config.remote_port!==undefined)throw new Error();
    for(const key of ['python','helper','config']){
      const file=config[key];
      if(typeof file!=='string'||!path.isAbsolute(file)||file.includes('\0'))throw new Error();
      const s=fs.lstatSync(file);
      if(!s.isFile()||![uid,0].includes(s.uid)||s.mode&0o022)throw new Error();
      if(key==='config'&&(s.uid!==uid||s.mode&0o077||s.size>65536))throw new Error();
    }
    const fd=fs.openSync(config.config,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
    let text;try{const buf=Buffer.alloc(65537),size=fs.readSync(fd,buf,0,buf.length,0);if(size>65536)throw new Error();text=buf.subarray(0,size).toString('utf8');}finally{fs.closeSync(fd);}
    const enrolled=JSON.parse(text),worker=workerConfig({id:config.id,url:config.url});
    if(enrolled.port!==Number(new URL(worker.url).port))throw new Error();
    return {file:config.python,args:['-I',config.helper,config.config]};
  }catch{throw new Error('adapter_local_identity_unverified');}
}

// Operator-owned paths/host only, strict host-key checking; no shell strings
// derived from requests, model text, service names, or telemetry. The selected
// helper is enrolled in private config; both helpers share this JSON protocol.
function recoveryAttempt(config,request,target,{spawnFn=spawn,timeoutMs=45000,...localOptions}={}) {
  return new Promise((resolve,reject)=>{
    const local=config.transport==='local';
    const invocation=local?localInvocation(config,localOptions):{file:'/usr/bin/ssh',args:['-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=8',target,`python3 ${config.helper} ${config.config}`]};
    let child;try{child=spawnFn(invocation.file,invocation.args,{stdio:['pipe','pipe','pipe'],shell:false});}catch{return reject(new Error('adapter_spawn_failed'));}
    let output='',stderr='',settled=false;
    const finish=(err,result)=>{if(settled)return;settled=true;clearTimeout(timer);if(err)reject(err);else resolve(result);};
    const timer=setTimeout(()=>{child.kill();finish(new Error('adapter_timeout'));},timeoutMs);
    child.stdout.on('data',chunk=>{output+=chunk;if(output.length>65536){child.kill();finish(new Error('adapter_output_limit'));}});
    child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-4096);});
    child.on('error',error=>finish(new Error(local?'adapter_spawn_failed':classifySshFailure(stderr,error.code))));
    child.stdin.on('error',()=>{});
    // Process exit can precede the final stdout bytes. Settle only after pipes
    // close, otherwise a valid inspection can be misclassified as malformed.
    child.on('close',code=>{try {const result=JSON.parse(output);if(code!==0 || !result || typeof result!=='object' || Array.isArray(result) || result.error)throw new Error();finish(null,result);}catch{finish(new Error(local?'adapter_check_failed':classifySshFailure(stderr,null,code)));}});
    child.stdin.end(JSON.stringify(request));
  });
}

export async function recoveryCall(config,request,options={}) {
  if(config.transport==='local')return recoveryAttempt(config,request,null,options);
  let failure;
  for(const target of sshTargets(config)){
    try{return await recoveryAttempt(config,request,target,options);}
    catch(error){failure=error;}
  }
  throw failure??new Error('adapter_unreachable');
}
// Backward-compatible name for existing integrations and tests. The transport
// never inferred systemd behavior; that boundary lives in the enrolled helper.
export const systemdCall=recoveryCall;
