// Launch once, independent of the dashboard. Observation never spawns a runner.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
const execute=promisify(execFile);
const source=fileURLToPath(new URL('./operation_runner.py',import.meta.url));
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

export function operationRunner({python,directory}) {
  if(typeof python!=='string'||!path.isAbsolute(python)||typeof directory!=='string'||!path.isAbsolute(directory))throw new Error('Use configured absolute Python and private operation directory paths.');
  const root=path.resolve(directory);
  function folder(input){
    if(!UUID.test(input.id)||path.resolve(input.directory)!==path.join(root,input.id)||fs.lstatSync(input.directory).isSymbolicLink())throw new Error('Operation directory does not match its configured identity.');
    return path.join(root,input.id);
  }
  const launchAction=async(input,action,logName)=>{
      const target=folder(input);
      // The store already saved approval and launch intent. Python checks them
      // independently before acquiring the one-attempt execution claim.
      const log=fs.openSync(path.join(target,logName),'ax',0o600);
      try{
        const child=spawn(python,['-I',source,action,target],{detached:true,stdio:['ignore',log,log]});
        await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
        const receipt={pid:child.pid,at:Date.now(),scope:'Independent runner spawned. Current operation state requires observation.'};
        child.unref();return receipt;
      }finally{fs.closeSync(log);}
    };
  return {
    launch:input=>launchAction(input,'run','runner-output.log'),
    launchReturn:input=>launchAction(input,'return','reconcile-output.log'),
    inspectReturn:async input=>{
      try{
        const {stdout}=await execute(python,['-I',source,'inspect-return',folder(input)],{timeout:120000,maxBuffer:3*1024*1024});
        return JSON.parse(stdout);
      }catch{return {state:'unavailable',error:'Return is not ready. The stopped process, finished native job, idle server and exclusive hold must be verified. Any readmission already attempted needs separate inspection.'};}
    },
    observe:async input=>{
      const {stdout}=await execute(python,['-I',source,'observe',folder(input)],{timeout:10000,maxBuffer:3*1024*1024});
      return JSON.parse(stdout);
    },
  };
}
