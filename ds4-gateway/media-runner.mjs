import {mediaPairReturn} from './media-pair-return.mjs';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {once} from 'node:events';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {MediaJobs} from './media-jobs.mjs';
import {MediaBackend} from './media-backend.mjs';
import {runMediaCycle,mediaBatchCanContinue} from './media-cycle.mjs';
import {saveMediaReceipt} from './media-execution.mjs';
import {recoveryCall} from './recovery-transport.mjs';
import {verifyRecovery,qwenRecoveryProofValid} from './recovery-verify.mjs';
import {workerControl} from './worker-client.mjs';

const folder=path.resolve(process.argv[2]),p=JSON.parse(fs.readFileSync(path.join(folder,'plan.json'),'utf8'));
if(path.basename(folder)!==p.operation_id)throw new Error('Media operation identity mismatch');
fs.writeFileSync(path.join(folder,'runner-claim.json'),JSON.stringify({pid:process.pid,at:new Date().toISOString()}),{mode:0o600,flag:'wx'});
const execute=promisify(execFile),quote=s=>"'"+String(s).replaceAll("'","'\\''")+"'";
const remote=async args=>(await execute('ssh',['-o','BatchMode=yes','-o','ConnectTimeout=10',p.host,args.map(quote).join(' ')],{maxBuffer:8*1024*1024})).stdout;
const save=(name,value)=>saveMediaReceipt(folder,name,{...value,at:new Date().toISOString()});
const maintenanceScript=fileURLToPath(new URL('./media_maintenance.py',import.meta.url));
let phase='',detail='',changedAt,batch={};
const progress=(next,message,context=batch)=>{if(next!==phase||message!==detail||context.active_job_id!==batch.active_job_id)changedAt=new Date().toISOString();phase=next;detail=message;batch=context;save('progress.json',{phase,detail,...batch,changed_at:changedAt,heartbeat_at:new Date().toISOString()});};
const heartbeat=setInterval(()=>{if(phase)progress(phase,detail);},5000);heartbeat.unref();
try{
  const pair=mediaPairReturn(p,save);
  const result=await runMediaCycle(p,{pair,
    jobs:new MediaJobs(path.join(folder,'media-jobs.json'),{resultsDirectory:p.results_directory,inputsDirectory:p.inputs_directory}),save,progress,delay,
    continueBatch:async next=>{
      const status=await workerControl(p.control_socket,'/media-jobs');
      return mediaBatchCanContinue(next,status);
    },
    maintenance:async action=>JSON.parse((await execute(p.python,['-I','-B',maintenanceScript,folder,action],{maxBuffer:1024*1024})).stdout),
    hasMaintenanceIntent:()=>fs.existsSync(path.join(folder,'gateway','acquire.intent.json')),
    inspect:async id=>JSON.parse(await remote(['docker','inspect',id]))[0],start:id=>remote(['docker','start',id]),stop:id=>remote(['docker','stop','-t','120',id]),
    recoveryInspect:()=>pair?pair.recoveryInspect():recoveryCall(p.recovery,{action:'inspect'}),
    verify:async()=>{if(pair)return pair.verify();const proof=await verifyRecovery(p.recovery.url,p.model,p.context_length,{kind:'qwen_vllm'});if(!qwenRecoveryProofValid(proof,p.context_length))throw new Error('Original LLM response/cache checks failed');return proof;},
    connect:async()=>{
      const listener=net.createServer();listener.listen(0,'127.0.0.1');await once(listener,'listening');const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
      const fd=fs.openSync(path.join(folder,'tunnel.log'),'a',0o600);
      const child=spawn('ssh',['-N','-o','BatchMode=yes','-o','ExitOnForwardFailure=yes','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=3','-L',`127.0.0.1:${port}:127.0.0.1:${p.engine.port}`,p.host],{stdio:['ignore','ignore',fd]});fs.closeSync(fd);
      await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
      return {backend:new MediaBackend({kind:p.engine.kind,url:`http://127.0.0.1:${port}`}),close:()=>child.kill('SIGTERM')};
    },
  });
  save('completion.json',result);
}catch(e){save('runner-error.json',{error:e.message});process.exitCode=1;}
finally{clearInterval(heartbeat);}
