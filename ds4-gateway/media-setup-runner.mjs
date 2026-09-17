import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {runMediaSetup} from './media-setup-cycle.mjs';
import {saveMediaReceipt} from './media-execution.mjs';
import {setupTransport} from './genie-spark-setup.mjs';
import {recoveryCall} from './recovery-transport.mjs';
import {verifyRecovery,qwenRecoveryProofValid} from './recovery-verify.mjs';
import {workerControl} from './worker-client.mjs';

const folder=path.resolve(process.argv[2]),plan=JSON.parse(fs.readFileSync(path.join(folder,'plan.json')));
assert.equal(path.basename(folder),plan.operation_id);
fs.writeFileSync(path.join(folder,'runner-claim.json'),JSON.stringify({pid:process.pid,at:new Date().toISOString()}),{flag:'wx',mode:0o600});
const execute=promisify(execFile),quote=s=>"'"+String(s).replaceAll("'","'\\''")+"'";
const remote=async args=>(await execute('ssh',['-o','BatchMode=yes','-o','ConnectTimeout=10','--',plan.target.ssh,args.map(quote).join(' ')],{maxBuffer:8*1024*1024})).stdout;
const save=(name,value)=>saveMediaReceipt(folder,name,{...value,at:new Date().toISOString()});
let current={phase:'starting',detail:'Media setup runner started.'};
const progress=(phase,detail)=>{current={phase,detail};save('progress.json',{...current,heartbeat_at:new Date().toISOString()});};
const heartbeat=setInterval(()=>save('progress.json',{...current,heartbeat_at:new Date().toISOString()}),5000);heartbeat.unref();
try{
 // Read the exact recipe bundle retained before ownership or any shutdown.
 const bundle=JSON.parse(fs.readFileSync(path.join(folder,'recipe-bundle.json')));
 const location=await setupTransport(plan.target,{action:'media_location',operation_id:plan.operation_id});
 assert.ok(path.isAbsolute(location.directory));plan.target.directory=location.directory;saveMediaReceipt(folder,'plan.json',plan);
 const result=await runMediaSetup(plan,{
  save,progress,delay,
  maintenance:async action=>JSON.parse((await execute(plan.python,['-I','-B',fileURLToPath(new URL('./media_maintenance.py',import.meta.url)),folder,action],{maxBuffer:1024*1024})).stdout),
  hasMaintenanceIntent:()=>fs.existsSync(path.join(folder,'gateway/acquire.intent.json')),
  inspect:async id=>JSON.parse(await remote(['docker','inspect',id]))[0],start:id=>remote(['docker','start',id]),stop:id=>remote(['docker','stop','-t','120',id]),
  recoveryInspect:()=>recoveryCall(plan.recovery,{action:'inspect'}),
  verify:async()=>{const proof=await verifyRecovery(plan.recovery.url,plan.model,plan.context_length,{kind:'qwen_vllm',endpoint:plan.endpoint});assert.ok(qwenRecoveryProofValid(proof,plan.context_length),'Original LLM cache proof failed');return proof;},
  prepare:()=>setupTransport(plan.target,{action:'prepare_media',selected_engines:plan.engines,llm_container:plan.llm_container,...bundle}),
  readPreparation:()=>setupTransport(plan.target,{action:'status'}),
  preparedMedia:()=>setupTransport(plan.target,{action:'media_plan'}),
  qualify:async preparation=>{
   // Reuse the new-Spark native sample runner, which owns the setup host lock,
   // observes accepted jobs, retains/decodes outputs and stops its media engines.
   const destination=path.join(folder,'qualification');fs.mkdirSync(destination,{mode:0o700});
   saveMediaReceipt(destination,'plan.json',{target_id:plan.worker_id,target:plan.target,preparation});
   const log=fs.openSync(path.join(destination,'runner.log'),'ax',0o600);
   try{
    const child=spawn(process.execPath,[fileURLToPath(new URL('./spark-media-runner.mjs',import.meta.url)),destination],{stdio:['ignore',log,log]});
    await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',code=>code===0?resolve():reject(Error('Native media qualification needs attention; inspect its retained receipt.')));});
   }finally{fs.closeSync(log);}
   return JSON.parse(fs.readFileSync(path.join(destination,'completion.json')));
  },
 });save('completion.json',result);
 try{await workerControl(plan.control_socket,'/media-setup-complete',{operation_id:plan.operation_id},{channel:'media_setup'});progress('enrolled','Engine qualified and saved; original LLM is back in service.');}
 catch(e){save('enrollment-error.json',{error:e.message});progress('qualified_returned','Original LLM returned. Engine enrollment needs attention; use Finish setup to retry this final step.');}
}catch(error){save('runner-error.json',{error:error.message});if(current.phase==='starting')progress('failed_unchanged',error.message);process.exitCode=1;}
finally{clearInterval(heartbeat);}
