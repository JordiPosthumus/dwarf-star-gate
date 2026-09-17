import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {saveMediaReceipt} from './media-execution.mjs';
import {bundleRecipes,setupTransport} from './genie-spark-setup.mjs';
import {mediaPlanIdentity} from './spark-media-cycle.mjs';

const kinds={'ace-step':'music',h3:'video'},terminal=new Set(['enrolled','failed_returned','failed_unchanged']);
const launch=async folder=>{
 const log=fs.openSync(path.join(folder,'runner.log'),'ax',0o600);
 try{const child=spawn(process.execPath,[fileURLToPath(new URL('./media-setup-runner.mjs',import.meta.url)),folder],{detached:true,stdio:['ignore',log,log]});await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});child.unref();return {pid:child.pid};}finally{fs.closeSync(log);}
};
export function createMediaSetup(config,store,{directory,workers,binding,isEnabled,isAllowed,bundle=bundleRecipes,transport=setupTransport,launchRunner=launch}){
 const restoreErrors={};
 const identity=id=>{
  const worker=workers().find(w=>w.id===id),recovery=config.recovery?.workers?.find(w=>w.id===id),inspection=config.genie_chat?.inspection?.workers?.[id];
  if(!worker||!recovery||!inspection)return null;
  const route=Object.fromEntries(['id','url','ssh','ssh_fallbacks','remote_port'].filter(k=>worker[k]!==undefined).map(k=>[k,worker[k]]));
  return createHash('sha256').update(JSON.stringify({route,recovery,inspection})).digest('hex');
 };
 // Media was qualified with the LLM stopped. Its retained engine belongs to
 // that physical machine, not a particular LLM version or local tunnel port.
 // In-flight setup still checks the full identity above before enrollment.
 const hostIdentity=id=>{
  if(!workers().some(w=>w.id===id))return null;
  const machine=config.recovery?.workers?.find(w=>w.id===id)?.machine;
  return /^[a-f0-9]{64}$/.test(machine??'')?createHash('sha256').update(JSON.stringify([id,machine])).digest('hex'):null;
 };
 const retainedMatches=(id,saved)=>saved?.host_binding?hostIdentity(id)===saved.host_binding:identity(id)!==null&&identity(id)===saved?.binding;
 const backup=()=>{if(fs.existsSync(store.filename))fs.copyFileSync(store.filename,`${store.filename}.media-setup-${Date.now()}-${randomUUID()}.bak`,fs.constants.COPYFILE_EXCL);};
 const apply=(id,engines)=>{
  const previous=config.media_jobs?.workers?.[id]?.engines??{};
  for(const [kind,e] of Object.entries(engines)){
   assert.ok(['music','video'].includes(kind)&&e&&Object.keys(e).sort().join(',')==='container,image,kind,port'&&/^[a-f0-9]{64}$/.test(e.container)&&/^sha256:[a-f0-9]{64}$/.test(e.image)&&e.kind===(kind==='music'?'ace-step':'comfyui')&&Number.isSafeInteger(e.port)&&e.port>0&&e.port<=65535,'Invalid retained media enrollment');
   if(previous[kind])assert.deepEqual(previous[kind],e,'Existing media enrollment is preserved');
  }
  config.media_jobs??={enabled:false};config.media_jobs.workers??={};config.media_jobs.workers[id]??={engines:{}};
  config.media_jobs.workers[id].engines={...previous,...structuredClone(engines)};
 };
 for(const [id,saved] of Object.entries(store.data.media_engine_enrollments??{})){
  try{assert.ok(retainedMatches(id,saved),'Worker or physical-machine binding changed');apply(id,saved.engines);}catch(e){restoreErrors[id]=e.message;}
 }
 const read=id=>{
  const saved=store.data.media_setups?.[id];assert.ok(saved,'Unknown media setup');
  if(saved.phase==='enrolled')return {...saved};
  const folder=path.join(directory,id);let progress={phase:'starting'};
  try{progress=JSON.parse(fs.readFileSync(path.join(folder,'progress.json')));}catch(e){if(e.code!=='ENOENT')return {...saved,phase:'needs_attention',detail:'Setup progress could not be read; retained files were not changed.'};}
  if(!terminal.has(progress.phase)&&progress.phase!=='qualified_returned'){
   try{const {pid}=JSON.parse(fs.readFileSync(path.join(folder,'launched.json')));process.kill(pid,0);}catch{progress={...progress,phase:'needs_attention',detail:'Setup runner liveness is unconfirmed. Inspect this operation; it was not repeated.'};}
  }
  let enrollmentError;try{enrollmentError=JSON.parse(fs.readFileSync(path.join(folder,'enrollment-error.json'))).error;}catch{}
  let preparation,qualification;
  try{const s=JSON.parse(fs.readFileSync(path.join(folder,'preparation.json')));preparation={state:s.state,engine:s.progress?.engine,phase:s.progress?.phase,model_download:s.model_download};}catch{}
  try{const q=JSON.parse(fs.readFileSync(path.join(folder,'qualification/progress.json')));qualification={state:q.state,engine:q.engine,phase:q.phase,detail:q.detail,error:q.error};}catch{}
  return {...saved,...progress,preparation,qualification,...(enrollmentError?{enrollment_error:enrollmentError}:{})};
 };
 const canSetup=id=>{
  const recovery=config.recovery?.workers?.find(w=>w.id===id),inspection=config.genie_chat?.inspection?.workers?.[id];
  return !!(config.control_socket&&path.isAbsolute(config.genie_chat?.python??'')&&recovery?.adapter==='docker'&&recovery.verification==='qwen_vllm'&&recovery.ssh&&inspection?.ssh?.[0]&&/^[a-f0-9]{64}$/.test(inspection.container)&&binding(id,recovery));
 };
 const status=()=>({connected:true,enabled:isEnabled(),operations:Object.keys(store.data.media_setups??{}).map(id=>{const {binding,...row}=read(id);return row;}),hosts:workers().map(w=>({worker_id:w.id,available:canSetup(w.id),error:restoreErrors[w.id]??null}))});
 async function finish(input){
  assert.ok(input&&Object.keys(input).join(',')==='operation_id','Choose one saved setup');const saved=store.data.media_setups?.[input.operation_id];assert.ok(saved,'Unknown media setup');
  if(saved.phase==='enrolled')return read(input.operation_id);
  const folder=path.join(directory,input.operation_id),plan=JSON.parse(fs.readFileSync(path.join(folder,'plan.json'))),result=JSON.parse(fs.readFileSync(path.join(folder,'completion.json')));
  assert.equal(identity(saved.worker_id),saved.binding,'Worker binding changed; enrollment was not applied');assert.ok(canSetup(saved.worker_id));
  assert.equal(plan.worker_id,saved.worker_id);assert.deepEqual(plan.engines,[saved.engine]);assert.equal(result.state,'qualified_returned');
  assert.equal(JSON.parse(fs.readFileSync(path.join(folder,'readmission.json'))).state,'readmitted');
  const fresh=await transport(plan.target,{action:'media_state'});assert.deepEqual(mediaPlanIdentity(fresh),mediaPlanIdentity(result.preparation),'Prepared media changed since qualification');
  const e=fresh.engines[saved.engine],proof=result.proof.engines[saved.engine];assert.equal(result.proof.state,'qualified_stopped');
  assert.equal(proof.container,e.container);assert.equal(proof.image,e.image);assert.equal(proof.outputs?.state,'ready');
  assert.ok(proof.decoded?.length&&proof.decoded.every(p=>p.full_decode));const streams=new Set(proof.decoded.flatMap(p=>p.streams.map(s=>s.codec_type)));assert.ok(streams.has('audio'));if(saved.engine==='h3')assert.ok(streams.has('video'));
  assert.ok(/^[a-f0-9]{64}$/.test(e.container)&&/^sha256:[a-f0-9]{64}$/.test(e.image)&&Number.isSafeInteger(e.port)&&e.port>0&&e.port<=65535&&e.kind===(saved.engine==='h3'?'comfyui':'ace-step'));
  const kind=kinds[saved.engine],engine=Object.fromEntries(['container','image','kind','port'].map(k=>[k,e[k]]));
  const existing=config.media_jobs?.workers?.[saved.worker_id]?.engines?.[kind];if(existing)assert.deepEqual(existing,engine,'Existing media enrollment is preserved');
  const row={...saved,phase:'enrolled',finished_at:new Date().toISOString()};backup();
  const prior=store.data.media_engine_enrollments?.[row.worker_id];
  store.save({...store.data,media_setups:{...store.data.media_setups,[row.operation_id]:row},media_engine_enrollments:{...store.data.media_engine_enrollments,[row.worker_id]:{binding:saved.binding,host_binding:hostIdentity(row.worker_id),engines:{...(retainedMatches(row.worker_id,prior)?prior.engines:{}),[kind]:engine}}}});
  apply(row.worker_id,{[kind]:engine});return row;
 }
 return {status,finish,async start(input){
  assert.ok(input&&Object.keys(input).sort().join(',')==='engine,worker_id'&&Object.hasOwn(kinds,input.engine),'Choose a worker and supported engine');
  const prior=Object.values(store.data.media_setups??{}).find(s=>s.worker_id===input.worker_id&&s.engine===input.engine);
  if(prior){if(read(prior.operation_id).phase==='qualified_returned')return finish({operation_id:prior.operation_id});return read(prior.operation_id);}
  assert.ok(isEnabled(),'Media capability is switched off');assert.ok(isAllowed(input.worker_id,kinds[input.engine]),'Allow this engine on the machine before setup');assert.ok(canSetup(input.worker_id),'This machine needs a matching Docker LLM inspection/recovery enrollment');
  assert.ok(!config.media_jobs?.workers?.[input.worker_id]?.engines?.[kinds[input.engine]],'This engine is already enrolled; its working installation is preserved');
  assert.ok(!Object.values(store.data.media_setups??{}).some(s=>s.worker_id===input.worker_id&&!terminal.has(read(s.operation_id).phase)),'A setup already owns this machine');
  const operation_id=randomUUID(),folder=path.join(directory,operation_id),worker=workers().find(w=>w.id===input.worker_id),recovery=config.recovery.workers.find(w=>w.id===input.worker_id),inspection=config.genie_chat.inspection.workers[input.worker_id];
  const recipes=bundle();fs.mkdirSync(folder,{recursive:true,mode:0o700});saveMediaReceipt(folder,'recipe-bundle.json',recipes);
  saveMediaReceipt(folder,'plan.json',{operation_id,worker_id:input.worker_id,engines:[input.engine],target:{ssh:inspection.ssh[0]},llm_container:inspection.container,recovery,endpoint:worker,model:config.model,context_length:worker.context_length??config.context_length,control_socket:config.control_socket,python:config.genie_chat.python});
  const row={operation_id,worker_id:input.worker_id,engine:input.engine,binding:identity(input.worker_id),phase:'starting',at:new Date().toISOString()};backup();store.save({...store.data,media_setups:{...store.data.media_setups,[operation_id]:row}});
  try{saveMediaReceipt(folder,'launched.json',await launchRunner(folder));}catch(e){saveMediaReceipt(folder,'progress.json',{phase:'needs_attention',detail:'Setup launch was not confirmed; inspect this operation before retrying.'});throw e;}
  return read(operation_id);
 }};
}
