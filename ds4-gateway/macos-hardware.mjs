// Unprivileged local readings only. No powermetrics, sudo or server commands.
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const run=promisify(execFile);
export function parseMacActivity(text){
  if(typeof text!=='string'||Buffer.byteLength(text)>4*1024*1024)return null;
  const devices=[...text.matchAll(/"PerformanceStatistics"\s*=\s*\{([^\n]*)\}/g)];
  if(devices.length!==1)return null;
  const fields=[...devices[0][1].matchAll(/"Device Utilization %"\s*=\s*(\d+)(?=\s*(?:,|$))/g)];
  if(fields.length!==1)return null;
  const value=Number(fields[0][1]);return value<=100?value:null;
}
export async function sampleMacHardware({platform=process.platform,totalmem=os.totalmem,freemem=os.freemem,exec=run,signal,now=Date.now}={}){
  if(platform!=='darwin')throw new Error('macos_local_unavailable');
  const sample={time:now()},total=totalmem(),free=freemem();
  // Occupied host pages include reclaimable cache; this is not memory pressure.
  if(Number.isSafeInteger(total)&&total>0&&Number.isSafeInteger(free)&&free>=0&&free<=total)
    Object.assign(sample,{memory_total_bytes:total,memory_used_bytes:total-free,memory_scope:'host_unified'});
  try{const {stdout}=await exec('/usr/sbin/ioreg',['-r','-c','AGXAccelerator','-l'],{encoding:'utf8',timeout:4000,maxBuffer:4*1024*1024,signal});
    const activity=parseMacActivity(stdout);if(activity!==null)Object.assign(sample,{accelerator_activity_pct:activity,accelerator_scope:'accelerator'});
  }catch{/* A driver query failure must not discard valid RAM observations. */}
  return sample;
}
