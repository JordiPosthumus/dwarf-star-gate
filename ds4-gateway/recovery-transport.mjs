import { spawn } from 'node:child_process';
import { workerConfig } from './worker-config.mjs';

export function recoveryConfig(raw={}) {
  if(Object.keys(raw).some(k=>!['workers'].includes(k)) || !Array.isArray(raw.workers??[]))throw new Error('Invalid recovery configuration');
  const configs=new Map(), machines=new Set();
  for(const entry of raw.workers??[]) {
    if(Object.keys(entry).some(k=>!['id','url','ssh','remote_port','adapter','helper','config','machine','profile','exclusive'].includes(k)))throw new Error('Unsupported recovery configuration field');
    const worker=workerConfig(Object.fromEntries(['id','url','ssh','remote_port'].filter(k=>entry[k]!==undefined).map(k=>[k,entry[k]])));
    if(entry.adapter!=='systemd-user' || !worker.ssh)throw new Error('Recovery requires the systemd-user SSH adapter');
    if(entry.exclusive!==true)throw new Error('Recovery requires explicit exclusive DSG ownership of the endpoint');
    for(const field of ['helper','config'])if(typeof entry[field]!=='string' || !/^\/[A-Za-z0-9_./-]+$/.test(entry[field]) || entry[field].includes('/../'))throw new Error('Recovery paths must be absolute shell-safe paths');
    for(const field of ['machine','profile'])if(!/^[a-f0-9]{64}$/.test(entry[field]))throw new Error('Enroll the recovery machine and profile first');
    if(configs.has(worker.id) || machines.has(entry.machine))throw new Error('Only one registered recovery service per physical machine in v1');
    configs.set(worker.id,{...entry,...worker});machines.add(entry.machine);
  }
  return configs;
}

// Operator-owned paths/host only, strict host-key checking; no shell strings
// derived from requests, model text, unit names, or telemetry. JSON uses stdin.
export function systemdCall(config,request) {
  return new Promise((resolve,reject)=>{
    const child=spawn('/usr/bin/ssh',['-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=8',config.ssh,
      `python3 ${config.helper} ${config.config}`],{stdio:['pipe','pipe','ignore']});
    let output='',settled=false;
    const finish=(err,result)=>{if(settled)return;settled=true;clearTimeout(timer);if(err)reject(err);else resolve(result);};
    const timer=setTimeout(()=>{child.kill();finish(new Error('adapter_timeout'));},45000);
    child.stdout.on('data',chunk=>{output+=chunk;if(output.length>65536){child.kill();finish(new Error('adapter_output_limit'));}});
    child.on('error',()=>finish(new Error('adapter_unreachable')));
    child.stdin.on('error',()=>{});
    child.on('exit',code=>{try {const result=JSON.parse(output);if(code!==0 || result.error)throw new Error();finish(null,result);}catch{finish(new Error('adapter_check_failed'));}});
    child.stdin.end(JSON.stringify(request));
  });
}
