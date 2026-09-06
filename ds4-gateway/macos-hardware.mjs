// Unprivileged local readings only. No powermetrics, sudo or server commands.
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const run=promisify(execFile);
const SMC_SCRIPT=fileURLToPath(new URL('./macos-smc.py',import.meta.url));
// Use the actual Command Line Tools interpreter, not the /usr/bin shim that
// can offer to install developer tools. A missing interpreter leaves unknowns.
const SMC_PYTHON='/Library/Developer/CommandLineTools/usr/bin/python3';
export function parseMacSensors(text,time=Date.now()){
  if(typeof text!=='string'||Buffer.byteLength(text)>16384)return {};
  let raw;try{raw=JSON.parse(text);}catch{return {};}
  if(raw?.schema!==1||!raw.values||typeof raw.values!=='object'||Array.isArray(raw.values))return {};
  const value=raw.values,sample={};
  if(Number.isFinite(value.PSTR)&&value.PSTR>0&&value.PSTR<=5000)Object.assign(sample,{power_watts:value.PSTR,power_scope:'system',power_sensor:'smc_pstr'});
  const temperatures=[];
  for(const [key,sensor,scope] of [['Tf14','smc_tf14','gpu'],['Tf04','smc_tf04','cpu']])if(Number.isFinite(value[key])&&value[key]>0&&value[key]<=150)temperatures.push({sensor,scope,celsius:value[key],time});
  if(temperatures.length)sample.temperatures=temperatures;
  return sample;
}
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
  await Promise.all([
    (async()=>{try{const {stdout}=await exec('/usr/sbin/ioreg',['-r','-c','AGXAccelerator','-l'],{encoding:'utf8',timeout:4000,maxBuffer:4*1024*1024,signal});
      const activity=parseMacActivity(stdout);if(activity!==null)Object.assign(sample,{accelerator_activity_pct:activity,accelerator_scope:'accelerator'});
    }catch{/* A driver query failure must not discard valid RAM observations. */}})(),
    (async()=>{try{const {stdout}=await exec(SMC_PYTHON,[SMC_SCRIPT],{encoding:'utf8',timeout:4000,maxBuffer:16384,signal});Object.assign(sample,parseMacSensors(stdout,sample.time));
    }catch{/* No interpreter, permission or sensor means unknown, never an estimate. */}})()
  ]);
  return sample;
}
