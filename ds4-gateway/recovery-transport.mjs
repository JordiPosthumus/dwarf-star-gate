import { spawn } from 'node:child_process';
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
    if(Object.keys(entry).some(k=>!['id','url','ssh','ssh_fallbacks','remote_port','adapter','helper','config','machine','profile','service_profile','start_stopped','exclusive'].includes(k)))throw new Error('Unsupported recovery configuration field');
    const worker=workerConfig(Object.fromEntries(['id','url','ssh','ssh_fallbacks','remote_port'].filter(k=>entry[k]!==undefined).map(k=>[k,entry[k]])));
    if(!['systemd-user','launchd'].includes(entry.adapter) || !worker.ssh)throw new Error('Recovery requires an enrolled systemd-user or launchd SSH adapter');
    if(entry.exclusive!==true)throw new Error('Recovery requires explicit exclusive DSG ownership of the endpoint');
    for(const field of ['helper','config'])if(typeof entry[field]!=='string' || !/^\/[A-Za-z0-9_./-]+$/.test(entry[field]) || entry[field].includes('/../'))throw new Error('Recovery paths must be absolute shell-safe paths');
    for(const field of ['machine','profile'])if(!/^[a-f0-9]{64}$/.test(entry[field]))throw new Error('Enroll the recovery machine and profile first');
    if(entry.start_stopped!==undefined&&typeof entry.start_stopped!=='boolean')throw new Error('start_stopped must be boolean');
    if(entry.start_stopped===true&&!/^[a-f0-9]{64}$/.test(entry.service_profile))throw new Error('Starting a stopped service requires its enrolled static service profile');
    if(entry.start_stopped!==true&&entry.service_profile!==undefined)throw new Error('service_profile is valid only with start_stopped enabled');
    if(configs.has(worker.id) || machines.has(entry.machine))throw new Error('Only one registered recovery service per physical machine in v1');
    configs.set(worker.id,{...entry,...worker});machines.add(entry.machine);
  }
  return configs;
}

// Operator-owned paths/host only, strict host-key checking; no shell strings
// derived from requests, model text, service names, or telemetry. The selected
// helper is enrolled in private config; both helpers share this JSON protocol.
function recoveryAttempt(config,request,target,{spawnFn=spawn,timeoutMs=45000}={}) {
  return new Promise((resolve,reject)=>{
    const child=spawnFn('/usr/bin/ssh',['-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=8',target,
      `python3 ${config.helper} ${config.config}`],{stdio:['pipe','pipe','pipe']});
    let output='',stderr='',settled=false;
    const finish=(err,result)=>{if(settled)return;settled=true;clearTimeout(timer);if(err)reject(err);else resolve(result);};
    const timer=setTimeout(()=>{child.kill();finish(new Error('adapter_timeout'));},timeoutMs);
    child.stdout.on('data',chunk=>{output+=chunk;if(output.length>65536){child.kill();finish(new Error('adapter_output_limit'));}});
    child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-4096);});
    child.on('error',error=>finish(new Error(classifySshFailure(stderr,error.code))));
    child.stdin.on('error',()=>{});
    child.on('exit',code=>{try {const result=JSON.parse(output);if(code!==0 || result.error)throw new Error();finish(null,result);}catch{finish(new Error(classifySshFailure(stderr,null,code)));}});
    child.stdin.end(JSON.stringify(request));
  });
}

export async function recoveryCall(config,request,options={}) {
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
