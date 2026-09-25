import {mediaReuse,selectedMediaPreparation,mediaPreparationRequest} from './media-reuse.mjs';
import {mediaEngine,mediaMemberInput} from './media-enrollment.mjs';
import {machinesFor} from './fleet-machines.mjs';
import {mediaPair} from './media-pair.mjs';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {isDeepStrictEqual} from 'node:util';
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
export function createMediaSetup(config,store,{directory,workers,binding,isEnabled,isAllowed,isInspectionEnabled=()=>true,bundle=bundleRecipes,transport=setupTransport,launchRunner=launch}){
 const restoreErrors={};
 const identity=(id,reuse=config.media_jobs?.reuse?.[id])=>{
  const worker=workers().find(w=>w.id===id),recovery=config.recovery?.workers?.find(w=>w.id===id),inspection=config.genie_chat?.inspection?.workers?.[id];
  const pair=mediaPair(config,worker);
  if(!worker||(!recovery&&!pair)||!inspection)return null;
  const route=Object.fromEntries(['id','url','ssh','ssh_fallbacks','remote_port'].filter(k=>worker[k]!==undefined).map(k=>[k,worker[k]]));
  return createHash('sha256').update(JSON.stringify({route,recovery,inspection,...(pair?{pair}:{}),...(reuse?{reuse}:{})})).digest('hex');
 };
 // Media was qualified with the LLM stopped. Its retained engine belongs to
 // that physical machine, not a particular LLM version or local tunnel port.
 // In-flight setup still checks the full identity above before enrollment.
 const hostIdentity=id=>{
  if(!workers().some(w=>w.id===id))return null;
  const pair=mediaPair(config,workers().find(w=>w.id===id));
  if(pair)return createHash('sha256').update(JSON.stringify([id,pair.members.map(m=>({ssh:m.ssh}))])).digest('hex');
  const machine=config.recovery?.workers?.find(w=>w.id===id)?.machine;
  return /^[a-f0-9]{64}$/.test(machine??'')?createHash('sha256').update(JSON.stringify([id,machine])).digest('hex'):null;
 };
 const retainedMatches=(id,saved)=>saved?.host_binding?hostIdentity(id)===saved.host_binding:identity(id)!==null&&identity(id)===saved?.binding;
 const backup=()=>{if(fs.existsSync(store.filename))fs.copyFileSync(store.filename,`${store.filename}.media-setup-${Date.now()}-${randomUUID()}.bak`,fs.constants.COPYFILE_EXCL);};
 const apply=(id,engines,member)=>{
  const previous=(member===undefined?config.media_jobs?.workers?.[id]?.engines:config.media_jobs?.workers?.[id]?.member_engines?.[member])??{};
  for(const [kind,e] of Object.entries(engines)){
   assert.ok(['music','video'].includes(kind)&&e&&['container,image,kind,port','container,image,kind,member,port'].includes(Object.keys(e).sort().join(','))&&(e.member===undefined||[0,1].includes(e.member))&&/^[a-f0-9]{64}$/.test(e.container)&&/^sha256:[a-f0-9]{64}$/.test(e.image)&&e.kind===(kind==='music'?'ace-step':'comfyui')&&Number.isSafeInteger(e.port)&&e.port>0&&e.port<=65535,'Invalid retained media enrollment');
   if(previous[kind])assert.deepEqual(previous[kind],e,'Existing media enrollment is preserved');
  }
  config.media_jobs??={enabled:false};config.media_jobs.workers??={};config.media_jobs.workers[id]??={engines:{}};
  if(member===undefined)config.media_jobs.workers[id].engines={...previous,...structuredClone(engines)};
  else {assert.ok([0,1].includes(Number(member)));assert.ok(Object.values(engines).every(e=>e.member===Number(member)));config.media_jobs.workers[id].member_engines??={};config.media_jobs.workers[id].member_engines[member]={...previous,...structuredClone(engines)};}
 };
 // Migrate only when the complete previously pinned configuration still matches.
 // This is gateway-owned state under its process lock, never an offline edit.
 const migrated=structuredClone(store.data.media_setups??{});let changed=false;
 for(const saved of Object.values(migrated))if(!saved.infrastructure_binding&&identity(saved.worker_id)===saved.binding){saved.infrastructure_binding=identity(saved.worker_id,null);changed=true;}
 if(changed){backup();store.save({...store.data,media_setups:migrated});}
 const sourceKey=(id,member,engine)=>JSON.stringify([id,member??null,engine]);
 const sourceBases=new Map();
 for(const [key,saved] of Object.entries(store.data.media_setup_sources??{})){
  const baseline=config.media_jobs?.reuse?.[saved.worker_id]?.[saved.member??0]?.[saved.engine]??null;
  sourceBases.set(key,structuredClone(baseline));
  if(saved.host_binding!==hostIdentity(saved.worker_id)||!isDeepStrictEqual(baseline,saved.configured_source))continue;
  try{assert.ok(saved.selection===null||saved.selection?.source==='docker');if(saved.selection!==null)mediaReuse({media_jobs:{reuse:{[saved.worker_id]:{[saved.member??0]:{[saved.engine]:saved.selection}}}}},saved.worker_id,saved.engine,saved.member);}catch{restoreErrors[saved.worker_id]='Retained source selection is invalid; it was not applied.';continue;}
  config.media_jobs.reuse??={};config.media_jobs.reuse[saved.worker_id]??={};config.media_jobs.reuse[saved.worker_id][saved.member??0]??={};
  config.media_jobs.reuse[saved.worker_id][saved.member??0][saved.engine]=structuredClone(saved.selection);
 }
 for(const [id,saved] of Object.entries(store.data.media_engine_enrollments??{})){
  try{assert.ok(retainedMatches(id,saved),'Worker or physical-machine binding changed');apply(id,saved.engines??{});for(const [member,engines] of Object.entries(saved.member_engines??{}))apply(id,engines,member);}catch(e){restoreErrors[id]=e.message;}
 }
 const candidateCorrected=saved=>{
  if(identity(saved.worker_id)===saved.binding)return false;
  try{
   const plan=JSON.parse(fs.readFileSync(path.join(directory,saved.operation_id,'plan.json')));
   if(!plan.reuse||plan.worker_id!==saved.worker_id||plan.engines?.length!==1||plan.engines[0]!==saved.engine)return false;
   const member=saved.member??plan.llm_pair?.media_member??0;
   const before=Object.fromEntries(Object.entries(plan.reuse).filter(([k])=>!['engine','llm_container'].includes(k))),after=config.media_jobs?.reuse?.[saved.worker_id]?.[member]?.[saved.engine]??null;
   if(isDeepStrictEqual(before,after))return false;
   if(saved.infrastructure_binding)return identity(saved.worker_id,null)===saved.infrastructure_binding;
   const old=structuredClone(config.media_jobs?.reuse?.[saved.worker_id]??{});old[member]??={};
   old[member][saved.engine]=Object.fromEntries(Object.entries(plan.reuse).filter(([k])=>!['engine','llm_container'].includes(k)));
   // Only this selected reuse candidate may differ. Route, LLM, other engines,
   // physical members and all remaining inspection/recovery fields still match.
   return identity(saved.worker_id,old)===saved.binding;
  }catch{return false;}
 };
 const unchangedAttemptExited=saved=>{
  const folder=path.join(directory,saved.operation_id);
  for(const name of ['gateway/acquire.intent.json','stop-llm-intent.json','llm-pair-stop-intent.json','prepare-intent.json'])assert.ok(!fs.existsSync(path.join(folder,name)),'Setup advanced past read-only preflight; inspect it instead of retrying');
  const {pid}=JSON.parse(fs.readFileSync(path.join(folder,'launched.json')));assert.ok(Number.isSafeInteger(pid)&&pid>0,'Runner identity is unconfirmed');
  let stopped=false;try{process.kill(pid,0);}catch(e){if(e.code==='ESRCH')stopped=true;else throw e;}
  assert.ok(stopped,'Original setup runner may still be active');
 };
 const read=id=>{
  let saved=store.data.media_setups?.[id];assert.ok(saved,'Unknown media setup');
  if(saved.member===undefined)try{const member=JSON.parse(fs.readFileSync(path.join(directory,id,'plan.json'))).llm_pair?.media_member;if([0,1].includes(member))saved={...saved,member};}catch{}
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
  let failure_context;
  if(progress.phase==='failed_unchanged')try{
   const plan=JSON.parse(fs.readFileSync(path.join(folder,'plan.json'))),resolution=JSON.parse(fs.readFileSync(path.join(folder,'llm-resolution.json')));
   const intents=['gateway/acquire.intent.json','stop-llm-intent.json','llm-pair-stop-intent.json','prepare-intent.json'];
   if(intents.every(name=>!fs.existsSync(path.join(folder,name))))failure_context={stage:'read_only_preflight',selected_engine:saved.engine,selected_media_container:plan.reuse?.container??null,current_llm_container:resolution.container,maintenance_started:false,llm_stop_started:false,media_preparation_started:false,scope:'Saved intent evidence: this attempt stopped before maintenance, LLM stop or media preparation. The selected media and current LLM identities are distinct. An inspection failure does not alone establish why an object was unavailable.'};
  }catch{}
  let retry_ready=false;if(progress.phase==='failed_unchanged'&&candidateCorrected(saved))try{unchangedAttemptExited(saved);retry_ready=true;}catch{}
  return {...saved,...progress,preparation,qualification,...(failure_context?{failure_context}:{}),...(retry_ready?{retry_ready:true}:{}),...(enrollmentError?{enrollment_error:enrollmentError}:{})};
 };
 const canSetup=id=>{
  const recovery=config.recovery?.workers?.find(w=>w.id===id),inspection=config.genie_chat?.inspection?.workers?.[id];
  const pair=mediaPair(config,workers().find(w=>w.id===id));
  if(pair)return !!(config.control_socket&&path.isAbsolute(config.genie_chat?.python??''));
  return !!(config.control_socket&&path.isAbsolute(config.genie_chat?.python??'')&&recovery?.adapter==='docker'&&recovery.verification==='qwen_vllm'&&recovery.ssh&&inspection?.ssh?.[0]&&/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(inspection.container??'')&&binding(id,recovery));
 };
 const status=()=>({connected:true,source_repair_supported:true,enabled:isEnabled(),operations:Object.keys(store.data.media_setups??{}).map(id=>{const {binding,infrastructure_binding,...row}=read(id);return row;}),hosts:workers().map(w=>({worker_id:w.id,available:canSetup(w.id),error:restoreErrors[w.id]??null}))});
 async function finish(input){
  assert.ok(input&&Object.keys(input).join(',')==='operation_id','Choose one saved setup');const saved=store.data.media_setups?.[input.operation_id];assert.ok(saved,'Unknown media setup');
  if(saved.phase==='enrolled')return read(input.operation_id);
  const folder=path.join(directory,input.operation_id),plan=JSON.parse(fs.readFileSync(path.join(folder,'plan.json'))),result=JSON.parse(fs.readFileSync(path.join(folder,'completion.json')));
  assert.equal(identity(saved.worker_id),saved.binding,'Worker binding changed; enrollment was not applied');assert.ok(canSetup(saved.worker_id));
  assert.equal(plan.worker_id,saved.worker_id);if(saved.member!==undefined)assert.equal(plan.llm_pair?.media_member,saved.member,'Setup physical member changed');assert.deepEqual(plan.engines,[saved.engine]);assert.equal(result.state,'qualified_returned');
  assert.equal(JSON.parse(fs.readFileSync(path.join(folder,'readmission.json'))).state,'readmitted');
  const fresh=selectedMediaPreparation(await transport(plan.target,mediaPreparationRequest(plan.reuse,false)),plan.reuse);assert.deepEqual(mediaPlanIdentity(fresh),mediaPlanIdentity(result.preparation),'Prepared media changed since qualification');
  const e=fresh.engines[saved.engine],proof=result.proof.engines[saved.engine];assert.equal(result.proof.state,'qualified_stopped');
  assert.equal(proof.container,e.container);assert.equal(proof.image,e.image);assert.equal(proof.outputs?.state,'ready');
  assert.ok(proof.decoded?.length&&proof.decoded.every(p=>p.full_decode));const streams=new Set(proof.decoded.flatMap(p=>p.streams.map(s=>s.codec_type)));assert.ok(streams.has('audio'));if(saved.engine==='h3')assert.ok(streams.has('video'));
  assert.ok(/^[a-f0-9]{64}$/.test(e.container)&&/^sha256:[a-f0-9]{64}$/.test(e.image)&&Number.isSafeInteger(e.port)&&e.port>0&&e.port<=65535&&e.kind===(saved.engine==='h3'?'comfyui':'ace-step'));
  const kind=kinds[saved.engine],engine={...Object.fromEntries(['container','image','kind','port'].map(k=>[k,e[k]])),...(plan.llm_pair?{member:plan.llm_pair.media_member??0}:{})};
  const existing=mediaEngine(config,saved.worker_id,kind,saved.member);if(existing)assert.deepEqual(existing,engine,'Existing media enrollment is preserved');
  const row={...saved,phase:'enrolled',finished_at:new Date().toISOString()};backup();
  const prior=store.data.media_engine_enrollments?.[row.worker_id],retained=retainedMatches(row.worker_id,prior)?prior:{};
  const defaults={...retained.engines};if(!config.media_jobs?.workers?.[saved.worker_id]?.engines?.[kind])defaults[kind]=engine;
  const additions=saved.member===undefined?{engines:{...retained.engines,[kind]:engine}}:{engines:defaults,member_engines:{...retained.member_engines,[saved.member]:{...retained.member_engines?.[saved.member],[kind]:engine}}};
  store.save({...store.data,media_setups:{...store.data.media_setups,[row.operation_id]:row},media_engine_enrollments:{...store.data.media_engine_enrollments,[row.worker_id]:{...retained,...additions,binding:saved.binding,host_binding:hostIdentity(row.worker_id)}}});
  apply(row.worker_id,{[kind]:engine},saved.member);if(!config.media_jobs.workers[row.worker_id].engines?.[kind])apply(row.worker_id,{[kind]:engine});return row;
 }
 async function repair(input){
  assert.ok(input&&mediaMemberInput(input,'engine,expected_failed_at,worker_id')&&Object.hasOwn(kinds,input.engine),'Choose the exact failed setup target and timestamp');
  assert.ok(isEnabled(),'Media capability is switched off');assert.ok(isInspectionEnabled(),'Server inspection is switched off');assert.ok(isAllowed(input.worker_id,kinds[input.engine]),'Placement is off');
  assert.ok(config.media_jobs?.standard?.enabled===true&&config.media_jobs.standard.targets?.some(t=>t.worker_id===input.worker_id&&t.member===input.member&&t.engine===input.engine),'Source repair requires this target in the owner-enabled standard');
  const prior=Object.values(store.data.media_setups??{}).find(s=>s.worker_id===input.worker_id&&s.member===input.member&&s.engine===input.engine);assert.ok(prior,'Unknown setup target');
  const observed=read(prior.operation_id);assert.ok(observed.phase==='failed_unchanged'&&observed.at===input.expected_failed_at,'Only the exact current unchanged preflight failure can select another source');
  unchangedAttemptExited(prior);assert.ok(canSetup(prior.worker_id),'Current setup binding is unavailable');
  assert.ok(!mediaEngine(config,prior.worker_id,kinds[prior.engine],prior.member),'Existing qualified media is preserved');
  assert.ok(!Object.values(store.data.media_setups??{}).some(s=>s.worker_id===prior.worker_id&&s.operation_id!==prior.operation_id&&!terminal.has(read(s.operation_id).phase)),'Another setup owns this worker');
  assert.ok(hostIdentity(prior.worker_id),'Enrolled physical machine identity is required for source repair');
  const key=sourceKey(prior.worker_id,prior.member,prior.engine),previous=store.data.media_setup_sources?.[key];
  if(previous?.operation_id===prior.operation_id&&previous.failed_at===input.expected_failed_at)return {operation_id:prior.operation_id,state:'source_selected',selection:previous.selection,scope:'Previously saved source decision; native setup was not replayed.'};
  assert.ok(prior.infrastructure_binding&&identity(prior.worker_id,null)===prior.infrastructure_binding,'Current LLM/worker binding changed; preserve the failed operation');
  const folder=path.join(directory,prior.operation_id),plan=JSON.parse(fs.readFileSync(path.join(folder,'plan.json'))),resolution=JSON.parse(fs.readFileSync(path.join(folder,'llm-resolution.json')));
  assert.ok(plan.reuse?.container,'This is not a failed retained-media source');
  const evidence=await transport(plan.target,{action:'discover_media',engine:prior.engine,missing_container:plan.reuse.container,llm_container:resolution.container});
  assert.equal(evidence.state,'source_selected');assert.equal(evidence.engine,prior.engine);assert.equal(evidence.missing_container,plan.reuse.container);assert.equal(evidence.current_llm_container,resolution.container);
  const candidate=evidence.selection;
  if(candidate!==null)mediaReuse({media_jobs:{reuse:{[prior.worker_id]:{[prior.member??0]:{[prior.engine]:candidate}}}}},prior.worker_id,prior.engine,prior.member);
  assert.ok(candidate===null||candidate.source==='docker','Discovery must select a pinned existing container or fresh preparation');
  // Recheck after the read-only remote observation, before saving a selection.
  assert.equal(read(prior.operation_id).at,input.expected_failed_at);unchangedAttemptExited(prior);assert.equal(identity(prior.worker_id,null),prior.infrastructure_binding);
  const baseline=sourceBases.has(key)?sourceBases.get(key):config.media_jobs?.reuse?.[prior.worker_id]?.[prior.member??0]?.[prior.engine]??null;
  const saved={worker_id:prior.worker_id,...(prior.member!==undefined?{member:prior.member}:{}),engine:prior.engine,operation_id:prior.operation_id,failed_at:input.expected_failed_at,host_binding:hostIdentity(prior.worker_id),configured_source:structuredClone(baseline),selection:structuredClone(candidate),at:new Date().toISOString()};
  saveMediaReceipt(folder,'source-correction.json',{...saved,evidence});backup();store.save({...store.data,media_setup_sources:{...store.data.media_setup_sources,[key]:saved}});
  sourceBases.set(key,structuredClone(baseline));config.media_jobs.reuse??={};config.media_jobs.reuse[prior.worker_id]??={};config.media_jobs.reuse[prior.worker_id][prior.member??0]??={};config.media_jobs.reuse[prior.worker_id][prior.member??0][prior.engine]=structuredClone(candidate);
  return {operation_id:prior.operation_id,state:'source_selected',selection:candidate,retry_ready:read(prior.operation_id).retry_ready===true,scope:'Source decision saved with backup; old records and files preserved. Fresh native qualification and exact current LLM return still required.'};
 }
 return {status,finish,repair,async start(input){
  assert.ok(input&&(mediaMemberInput(input,'engine,worker_id')||mediaMemberInput(input,'engine,expected_failed_at,worker_id'))&&Object.hasOwn(kinds,input.engine),'Choose a worker and supported engine');
  const selectedPair=mediaPair(config,workers().find(w=>w.id===input.worker_id));
  assert.ok(input.member===undefined||selectedPair,'Explicit member selection requires a matching paired LLM');
  const selectedMember=selectedPair?(input.member??selectedPair.engine_members?.[kinds[input.engine]]??0):undefined;
  const prior=Object.values(store.data.media_setups??{}).find(s=>s.worker_id===input.worker_id&&s.engine===input.engine&&(s.member??selectedPair?.engine_members?.[kinds[input.engine]]??(selectedPair?0:undefined))===selectedMember);
  const retry=input.expected_failed_at!==undefined;
  if(retry){
   assert.ok(prior&&typeof input.expected_failed_at==='string'&&Number.isFinite(Date.parse(input.expected_failed_at)),'Retry requires the exact saved pre-maintenance failure timestamp');
   const observed=read(prior.operation_id),folder=path.join(directory,prior.operation_id);
   assert.ok(observed.phase==='failed_unchanged'&&observed.at===input.expected_failed_at,'Only the current confirmed unchanged failure can retry');
   assert.ok(identity(input.worker_id)===prior.binding||candidateCorrected(prior),'Worker binding changed; preserve this operation');
   unchangedAttemptExited(prior);
  }else if(prior){if(read(prior.operation_id).phase==='qualified_returned')return finish({operation_id:prior.operation_id});return read(prior.operation_id);}
  assert.ok(isEnabled(),'Media capability is switched off');assert.ok(isAllowed(input.worker_id,kinds[input.engine]),'Allow this engine on the machine before setup');assert.ok(canSetup(input.worker_id),'This machine needs a matching Docker LLM inspection/recovery enrollment');
  assert.ok(!mediaEngine(config,input.worker_id,kinds[input.engine],selectedMember),'This engine is already enrolled; its working installation is preserved');
  assert.ok(!Object.values(store.data.media_setups??{}).some(s=>s.worker_id===input.worker_id&&!terminal.has(read(s.operation_id).phase)),'A setup already owns this machine');
  const operation_id=prior?.operation_id??randomUUID(),folder=path.join(directory,operation_id),worker=workers().find(w=>w.id===input.worker_id),recovery=config.recovery?.workers?.find(w=>w.id===input.worker_id),inspection=config.genie_chat.inspection.workers[input.worker_id];
  const enrolled=mediaPair(config,worker),pair=enrolled?{...enrolled,media_member:selectedMember}:null;
  const member=pair?.members[pair.media_member],reuse=mediaReuse(config,input.worker_id,input.engine,selectedMember);
  const recipes=bundle();
  if(retry){const history=path.join(directory,'history',operation_id);fs.mkdirSync(history,{recursive:true,mode:0o700});fs.renameSync(folder,path.join(history,`attempt-${prior.attempt??1}`));}
  fs.mkdirSync(folder,{recursive:true,mode:0o700});saveMediaReceipt(folder,'recipe-bundle.json',recipes);
  saveMediaReceipt(folder,'plan.json',{operation_id,worker_id:input.worker_id,separate_workers:workers().filter(w=>!machinesFor(w.id,config).some(m=>machinesFor(input.worker_id,config).includes(m))).map(w=>w.id),engines:[input.engine],target:{ssh:member?.ssh??inspection.ssh[0],...(reuse?.directory?{directory:reuse.directory}:{})},...(reuse?{reuse}:{}),llm_container:member?.container??inspection.container,recovery:pair?{profile:'glm53-docker-pair',url:worker.url}:recovery,...(pair?{llm_pair:pair}:{}),endpoint:worker,model:config.model,context_length:worker.context_length??config.context_length,control_socket:config.control_socket,python:config.genie_chat.python});
  const row={operation_id,worker_id:input.worker_id,engine:input.engine,...(input.member!==undefined?{member:input.member}:{}),binding:identity(input.worker_id),infrastructure_binding:identity(input.worker_id,null),attempt:prior?(prior.attempt??1)+1:1,phase:'starting',at:new Date().toISOString()};backup();store.save({...store.data,media_setups:{...store.data.media_setups,[operation_id]:row}});
  try{saveMediaReceipt(folder,'launched.json',await launchRunner(folder));}catch(e){saveMediaReceipt(folder,'progress.json',{phase:'needs_attention',detail:'Setup launch was not confirmed; inspect this operation before retrying.'});throw e;}
  return read(operation_id);
 }};
}
