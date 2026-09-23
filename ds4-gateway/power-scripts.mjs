// Fleet power switches: run the owner's existing startScripts behind Star Gate.
// The scripts stay the source of truth; this module only execs exact paths with
// no arguments, serializes mutations per physical machine, and verifies real
// endpoint readiness/shutdown instead of trusting script exits. The gate execs;
// it never parses model configuration out of scripts.
import fs from 'node:fs';
import {MACHINE_GROUPS as fleetMachineGroups,machineGroup as sharedMachineGroup} from './fleet-machines.mjs';
import net from 'node:net';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const SCRIPTS_DIR=path.join(path.dirname(fileURLToPath(import.meta.url)),'..','..','startScripts');
const RESOLVED=path.resolve(SCRIPTS_DIR);
const DEFAULT_TIMEOUT_MS=120000,STATUS_TIMEOUT_MS=20000;
const START_VERIFY_TIMEOUT_MS=900000,STOP_VERIFY_TIMEOUT_MS=90000,VERIFY_INTERVAL_MS=5000;

// Explicit allowlist only. A worker/action pair absent here is refused — adding
// a switch means editing this table, never passing arguments from callers.
const SCRIPTS={
  'glm53f-m3':{status:'status-glm53-m3',start:'start-glm53-m3',stop:'stop-glm53-m3'},
  'glm53f-sparks12':{status:'status-sparks12',start:'start-glm53f-sparks12',stop:'stop-sparks12'},
  'glm53f-sparks34':{status:'status-sparks34',start:'start-glm53f-sparks34',stop:'stop-sparks34'},
  'ds41-m3':{status:'status-ds41-m3',start:'start-ds41-m3',stop:'stop-ds41-m3'},
  'ds41-sparks12':{status:'status-sparks12',start:'start-ds41-sparks12',stop:'stop-sparks12'},
  'ds41-sparks34':{status:'status-sparks34',start:'start-ds41-sparks34',stop:'stop-sparks34'},
  'mimo-m3':{status:'status-mimo-m3',start:'start-mimo-m3',stop:'stop-mimo-m3'},
  'qwen-image':{status:'status-qwen-image',start:'start-qwen-image',stop:'stop-qwen-image'},
};
// Physical machines: mutations on one model sharing hardware must serialize
// against every other model on the same machine or Spark pair.
const MACHINE_GROUPS=fleetMachineGroups;
export const machineGroup=sharedMachineGroup;
const WORKERS=Object.keys(SCRIPTS);
const ACTIONS=new Set(['status','start','stop']);

export const powerWorkers=()=>WORKERS;


export function powerScript(worker,action){
  if(!WORKERS.includes(worker)||!ACTIONS.has(action))return null;
  const name=SCRIPTS[worker][action];
  const file=path.join(RESOLVED,name);
  // Refuse symlinks and anything outside the scripts directory: exact paths only.
  try{
    const stat=fs.lstatSync(file);
    if(!stat.isFile()||stat.isSymbolicLink())return null;
    if(!file.startsWith(RESOLVED+path.sep))return null;
    fs.accessSync(file,fs.constants.X_OK);
    return file;
  }catch{return null;}
}

// Endpoint reachability probe for readiness/shutdown verification. Exported for
// tests; the runner uses it through the injected verify callback by default.
export function probeEndpoint(url,{timeoutMs=3000}={}){
  return new Promise(resolve=>{
    let target;
    try{target=new URL(url);}catch{return resolve({reachable:false,detail:'invalid URL'});}
    const socket=net.connect({host:target.hostname,port:Number(target.port)|| (target.protocol==='https:'?443:80),timeout:timeoutMs});
    const finish=result=>{socket.destroy();resolve(result);};
    socket.once('connect',()=>finish({reachable:true,detail:'TCP connect succeeded'}));
    socket.once('timeout',()=>finish({reachable:false,detail:'connect timed out'}));
    socket.once('error',error=>finish({reachable:false,detail:error.code??error.message}));
  });
}

// Real-state verification for start/stop. A script exit proves neither. Start is
// ready only when the endpoint answers an authenticated model-list request;
// stopped means the port no longer accepts connections.
export function createReadinessVerifier({resolveEndpoint,startTimeoutMs=START_VERIFY_TIMEOUT_MS,stopTimeoutMs=STOP_VERIFY_TIMEOUT_MS,intervalMs=VERIFY_INTERVAL_MS,probe=probeEndpoint,sleep=ms=>new Promise(r=>setTimeout(r,ms)),now=Date.now}={}){
  if(typeof resolveEndpoint!=='function')throw new Error('resolveEndpoint is required');
  return async function verify(worker,action){
    if(action!=='start'&&action!=='stop')return {state:'unverified',detail:'no endpoint verification for this action',checked_at:now()};
    let endpoint=null;
    try{endpoint=await resolveEndpoint(worker);}catch(error){endpoint=null;}
    if(!endpoint?.url)return {state:'unverified',detail:'worker endpoint URL unknown; the script receipt is the only evidence',checked_at:now()};
    const deadline=now()+(action==='start'?startTimeoutMs:stopTimeoutMs);
    for(;;){
      let started=false;
      if(action==='start'){
        try{
          const base=endpoint.url.replace(/\/+$/,'').replace(/\/v1$/,'');
          const res=await fetch(`${base}/v1/models`,{headers:endpoint.headers??{},signal:AbortSignal.timeout(5000),redirect:'error'});
          await res.body?.cancel();
          started=res.ok;
        }catch{started=false;}
        if(started)return {state:'ready',detail:'endpoint answered an authenticated model-list request',checked_at:now()};
      }else{
        const tcp=await probe(endpoint.url);
        if(!tcp.reachable)return {state:'stopped',detail:'endpoint no longer accepts connections',checked_at:now()};
      }
      if(now()>=deadline)return {state:'timeout',checked_at:now(),
        detail:action==='start'
          ?'endpoint still not answering when verification gave up; the model may still be loading — run Status before retrying or assuming failure'
          :'endpoint still accepting connections when verification gave up; the model process may not be fully stopped'};
      await sleep(intervalMs);
    }
  };
}

export function createPowerRunner({
  spawn=async(file,{timeoutMs})=>{
    const {execFile}=await import('node:child_process');
    return await new Promise(resolve=>{
      // Scripts own their output entirely; a bounded buffer is evidence, not control.
      const child=execFile(file,{cwd:path.dirname(file),timeout:timeoutMs,maxBuffer:256*1024,windowsHide:true},(error,stdout,stderr)=>{
        resolve({exit_code:error?.code??(error?.killed?null:0),timed_out:!!error?.killed,output:`${stdout}${stderr}`.slice(-4000)});
      });
      return child;
    });
  },
  // verify(worker, action) must report real state, not script exit:
  //   {state:'ready'|'stopped'|...} for start/stop; never called for status.
  verify=null,
  now=Date.now,
}={}){
  if(verify!==null&&typeof verify!=='function')throw new Error('verify must be a function when provided');
  const running=new Map(); // machine-group key -> in-flight mutation
  const history=[]; // last receipts, bounded
  async function run(worker,action){
    const groups=machineGroup(worker);
    if(!groups)return {worker,action,ok:false,output:'No enrolled script for this worker; scripts remain the source of truth.'};
    const file=powerScript(worker,action);
    if(!file)return {worker,action,ok:false,output:'No enrolled script for this worker/action; scripts remain the source of truth.'};
    // Mutations serialize across the whole physical machine/pair, including
    // Start versus Stop and different model IDs sharing the hardware.
    if(action!=='status'){
      const busyGroup=groups.find(group=>running.has(group));
      if(busyGroup)return {worker,action,ok:false,busy:true,
        output:`A start/stop is already running for another model on the same hardware (${busyGroup}); wait for it to finish. Read-only status stays available.`};
    }
    const timeoutMs=action==='status'?STATUS_TIMEOUT_MS:DEFAULT_TIMEOUT_MS;
    const execute=(async()=>{
      const started=now();
      let result;
      try{result=await spawn(file,{timeoutMs});}
      catch(error){result={exit_code:null,timed_out:false,output:`Launch failed: ${error.message}`};}
      const scriptOk=!result.timed_out&&result.exit_code===0;
      let verified={state:'unverified',detail:'status receipts are script output, not readiness proof',checked_at:started};
      if(action!=='status'&&scriptOk&&verify){
        verified=await verify(worker,action);
      }else if(action!=='status'&&!scriptOk){
        verified={state:'failed',detail:'script exited nonzero; endpoint state unknown',checked_at:now()};
      }
      const receipt={worker,action,ok:scriptOk&&verified.state!=='failed'&&verified.state!=='timeout',exit_code:result.exit_code??null,
        timed_out:!!result.timed_out,at:started,finished_at:now(),output:String(result.output??'').slice(-4000),verified};
      history.unshift(receipt);history.length=Math.min(history.length,64);
      return receipt;
    })();
    if(action!=='status'){
      for(const group of groups)running.set(group,execute);
      execute.finally(()=>{for(const group of groups)if(running.get(group)===execute)running.delete(group);});
    }
    return execute;
  }
  return {
    run,
    busy:worker=>machineGroup(worker)?.some(group=>running.has(group))??false,
    receipts:()=>history.slice(),
    directory:RESOLVED,
  };
}

export const VERIFY_TIMINGS={START_VERIFY_TIMEOUT_MS,STOP_VERIFY_TIMEOUT_MS,VERIFY_INTERVAL_MS};
export function powerRunnerAllowed(worker,action){return !!powerScript(worker,action);}