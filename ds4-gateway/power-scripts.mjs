// Fleet power switches: run the owner's existing startScripts behind Star Gate.
// The scripts stay the source of truth; this module only execs exact paths with
// no arguments, single-flight per (worker,action), and never mutates launch
// logic. The gate execs; it never parses model configuration out of scripts.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const SCRIPTS_DIR=path.join(path.dirname(fileURLToPath(import.meta.url)),'..','..','startScripts');
const RESOLVED=path.resolve(SCRIPTS_DIR);
const DEFAULT_TIMEOUT_MS=120000,STATUS_TIMEOUT_MS=20000;

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

export function createPowerRunner({
  scriptsDir=RESOLVED,
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
  now=Date.now,
}={}){
  if(scriptsDir!==RESOLVED)throw new Error('Power scripts must come from the enrolled startScripts directory');
  const running=new Map(); // key -> Promise, single-flight per worker/action
  const history=[]; // last receipts, bounded
  async function run(worker,action){
    const key=`${worker}:${action}`;
    if(running.has(key))return {worker,action,ok:false,output:'An earlier start/stop for this worker is still running; wait for it to finish.',busy:true};
    const file=powerScript(worker,action);
    if(!file)return {worker,action,ok:false,output:'No enrolled script for this worker/action; scripts remain the source of truth.'};
    const timeoutMs=action==='status'?STATUS_TIMEOUT_MS:DEFAULT_TIMEOUT_MS;
    const promise=(async()=>{
      const started=now();
      let result;
      try{result=await spawn(file,{timeoutMs});}
      catch(error){result={exit_code:null,timed_out:false,output:`Launch failed: ${error.message}`};}
      const receipt={worker,action,ok:!result.timed_out&&result.exit_code===0,exit_code:result.exit_code??null,
        timed_out:!!result.timed_out,at:started,finished_at:now(),output:String(result.output??'').slice(-4000)};
      history.unshift(receipt);history.length=Math.min(history.length,64);
      return receipt;
    })();
    if(action!=='status'){running.set(key,promise);promise.finally(()=>running.delete(key));}
    return promise;
  }
  return {
    run,
    busy:key=>running.has(key),
    receipts:()=>history.slice(),
    directory:RESOLVED,
  };
}

export function powerRunnerAllowed(worker,action){return !!powerScript(worker,action);}