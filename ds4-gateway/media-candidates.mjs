import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {spawn,execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {mediaEngine,mediaMemberInput} from './media-enrollment.mjs';
import {mediaPair} from './media-pair.mjs';
import {machinesFor} from './fleet-machines.mjs';
import {saveMediaReceipt,launchMediaRunner} from './media-execution.mjs';
import {MediaJobs} from './media-jobs.mjs';
import {aceQualificationPayload,assertAceSourceProof} from './ace-qualification.mjs';
import {glmRecoveryProofValid} from './recovery-verify.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),runner=path.join(root,'ds4-gateway/media-candidate-runner.py');
const modules=['docker_profile','recovery_pair','recovery_pair_native','recovery_media_command','media_recipe_contract','media_ace_candidate'];
const sha=b=>createHash('sha256').update(b).digest('hex'),fingerprint=v=>sha(JSON.stringify(v));
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const publicRow=r=>Object.fromEntries(['operation_id','worker_id','member','phase','created_at','finished_at','candidate','qualification_job_id','qualification','promotion','reason'].filter(k=>r[k]!==undefined).map(k=>[k,r[k]]));
const readPrivate=p=>{const st=fs.lstatSync(p);assert.ok(st.isFile()&&!st.isSymbolicLink()&&(st.mode&0o077)===0&&(!process.getuid||st.uid===process.getuid())&&st.size<=4*1024*1024,'Candidate receipt is not private');return fs.readFileSync(p);};
const frozenBundle=()=>({modules:Object.fromEntries(modules.map(name=>[name,fs.readFileSync(path.join(root,'ds4-gateway',name+'.py'),'utf8')])),patch:Object.fromEntries(['apply-recipe-fields.py','verify-api-fields.py'].map(name=>[name,fs.readFileSync(path.join(root,'examples/spark-build/ace-step',name),'utf8')]))});
async function launch(folder,python){const log=fs.openSync(path.join(folder,'runner.log'),'ax',0o600);try{const child=spawn(python,['-I','-B',runner,folder,'run'],{detached:true,stdio:['ignore',log,log]});await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});child.unref();return {pid:child.pid};}finally{fs.closeSync(log);}}
const observePromotion=(folder,python)=>new Promise((resolve,reject)=>{execFile(python,['-I','-B',path.join(root,'ds4-gateway/media_candidate_promotion.py'),folder],{timeout:300000,maxBuffer:1024*1024},(error,stdout)=>{if(error)return reject(Error('Native postqualification proof unavailable; enrollment unchanged'));try{resolve(JSON.parse(stdout));}catch{reject(Error('Native promotion proof unreadable'));}}).stdin.end();});
const observe=(folder,python)=>new Promise((resolve,reject)=>{const child=execFile(python,['-I','-B',runner,folder,'status'],{timeout:300000,maxBuffer:1024*1024},(error,stdout)=>{if(error)return reject(Error('Candidate native observation unconfirmed; preparation was not repeated'));try{resolve(JSON.parse(stdout));}catch{reject(Error('Candidate status unreadable'));}});child.stdin.end();});
export function createMediaCandidates(config,store,{directory,workers,isEnabled,isAllowed,assertCapacity,hostAvailable=()=>true,launchRunner=launch,launchQualification=launchMediaRunner,observeRunner=observe,observePromotionRunner=observePromotion,promotions=null,bundle=frozenBundle}={}){
 const policy=config.media_jobs?.improvements;
 if(policy!==undefined)assert.ok(policy&&Object.keys(policy).every(k=>k==='enabled')&&typeof policy.enabled==='boolean','media_jobs.improvements accepts enabled boolean only');
 const enabled=()=>config.media_jobs?.improvements?.enabled===true&&isEnabled();
 const uncertainCommits=new Set();
 const rows=()=>Object.values(store.data.media_candidates??{});
 const backup=()=>{if(fs.existsSync(store.filename))fs.copyFileSync(store.filename,`${store.filename}.media-candidate-${Date.now()}-${randomUUID()}.bak`,fs.constants.COPYFILE_EXCL);};
 const save=row=>{backup();store.save({...store.data,media_candidates:{...store.data.media_candidates,[row.operation_id]:row}});};
 const selection=(id,member)=>{
  const worker=workers().find(w=>w.id===id),pair=mediaPair(config,worker),engine=mediaEngine(config,id,'music',member),inspection=config.genie_chat?.inspection?.workers?.[id];
  assert.ok(worker&&engine&&engine.kind==='ace-step'&&/^[a-f0-9]{64}$/.test(engine.container)&&/^sha256:[a-f0-9]{64}$/.test(engine.image),'Exact enrolled ACE target required');
  assert.ok(!config.media_jobs?.pairs?.[id]||pair,'Current pair binding required');
  assert.ok(member===undefined||pair,'Explicit member needs a current pair binding');
  const selected=pair?(member??engine.member??0):undefined,host=pair?.members[selected]?.ssh??inspection?.ssh?.[0];
  assert.ok(typeof host==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.@-]*$/.test(host)&&path.isAbsolute(config.genie_chat?.python??'')&&path.isAbsolute(config.control_socket??''),'Candidate preparation needs enrolled SSH, Python and control socket');
  return {worker_id:id,...(selected!==undefined?{member:selected}:{}),engine:structuredClone(engine),host,python:config.genie_chat.python,control_socket:config.control_socket,physical_machines:machinesFor(id,config),binding:fingerprint({worker,pair,engine,inspection,python:config.genie_chat.python,socket:config.control_socket})};
 };
 function permitted(row,ownLock){
  assert.ok(enabled()&&isAllowed(row.worker_id,'music'),'Media improvement policy or capabilities are off');
  const current=selection(row.worker_id,row.member);assert.equal(current.binding,row.binding,'Candidate target binding changed');
  assert.deepEqual(current.physical_machines,row.physical_machines,'Candidate physical-machine mapping changed');
  assert.ok(config.media_jobs?.standard?.enabled===true&&config.media_jobs.standard.targets?.some(t=>t.worker_id===row.worker_id&&t.engine==='ace-step'&&(t.member??(current.member===undefined?undefined:mediaEngine(config,row.worker_id,'music')?.member??0))===current.member),'Candidate must belong to the enabled standard');
  assert.ok(hostAvailable(row.worker_id,ownLock),'Another native operation owns this host');assertCapacity(row.worker_id,row.operation_id);
  return current;
 }
 const get=id=>{assert.ok(uuid(id)&&store.data.media_candidates?.[id],'Unknown candidate operation');return store.data.media_candidates[id];};
 const folder=id=>path.join(directory,id);
 const qualificationFolder=row=>{assert.ok(uuid(row.qualification_job_id),'Saved qualification job required');return path.join(folder(row.operation_id),'qualification',row.qualification_job_id);};
 const view=row=>{
  if(uncertainCommits.has(row.operation_id))return {...publicRow(row),phase:'requires_reconciliation',reason:'Promotion persistence unconfirmed; the same commit is not repeated in this process.'};
  if(row.qualification_job_id){
   if(['qualified_returned','promoted'].includes(row.phase))return publicRow(row);
   const root=qualificationFolder(row);
   try{
    const progress=fs.existsSync(path.join(root,'progress.json'))?JSON.parse(readPrivate(path.join(root,'progress.json'))):null;
    const attention=fs.existsSync(path.join(root,'runner-error.json'))||fs.existsSync(path.join(root,'launch-uncertain.json'));
    return {...publicRow(row),...(progress?{recorded_stage:progress.phase,stage_at:progress.changed_at}:{}),...(attention?{phase:'requires_reconciliation',reason:'Qualification needs reconciliation; saved work is not repeated.'}:{})};
   }catch{return {...publicRow(row),phase:'requires_reconciliation',reason:'Qualification receipts unreadable; ownership retained.'};}
  }
  if(row.phase==='candidate_prepared')return publicRow(row);
  const attention=path.join(folder(row.operation_id),'attention.json'),native=path.join(directory,'native',row.operation_id,'candidate.json');
  let stage={};
  if(fs.existsSync(native))try{const receipt=JSON.parse(readPrivate(native));stage={recorded_stage:receipt.state,stage_at:receipt.at};}catch{return {...publicRow(row),phase:'requires_reconciliation',reason:'Native preparation receipt is unreadable; ownership retained.'};}
  if(fs.existsSync(attention))return {...publicRow(row),...stage,phase:'requires_reconciliation',reason:'Runner requires reconciliation; native preparation is not repeated.'};
  return {...publicRow(row),...stage};
 };
 async function finish(input){
  assert.deepEqual(Object.keys(input??{}),['operation_id']);const row=get(input.operation_id);
  assert.ok(!row.qualification_job_id,'Preparation completion cannot replace a qualification operation');
  if(row.phase==='candidate_prepared')return publicRow(row);
  const saved=JSON.parse(readPrivate(path.join(folder(row.operation_id),'result.json')));
  assert.equal(saved.state,'prepared_stopped');assert.equal(saved.operation_id,row.operation_id);
  const requestBytes=readPrivate(path.join(folder(row.operation_id),'request.json'));
  assert.equal(sha(requestBytes),row.request_file_sha256,'Captured request binding is missing or changed');assert.equal(saved.request_file_sha256,row.request_file_sha256);
  // Read-only verification may finish an already completed preparation after
  // policy withdrawal. This does not authorize any new command or promotion.
  const live=await observeRunner(folder(row.operation_id),row.python);
  assert.deepEqual(live,saved,'Candidate native preparation proof changed');
  const candidate={container:live.container,image:live.image,snapshot_image:live.snapshot_image};
  const updated={...row,phase:'candidate_prepared',candidate,finished_at:new Date().toISOString()};save(updated);return publicRow(updated);
 }
 function qualificationPlan(row){
  assert.equal(sha(readPrivate(path.join(folder(row.operation_id),'plan.json'))),row.plan_sha256,'Preparation plan changed');
  assert.equal(sha(readPrivate(path.join(folder(row.operation_id),'request.json'))),row.request_file_sha256,'Preparation request changed');
  const root=qualificationFolder(row),bytes=readPrivate(path.join(root,'plan.json'));
  assert.equal(sha(bytes),row.qualification_plan_sha256,'Qualification plan changed');
  const plan=JSON.parse(bytes);assert.equal(plan.operation_id,row.qualification_job_id);assert.equal(plan.ace_qualification.candidate_operation_id,row.operation_id);
  return {root,plan};
 }
 function completeQualification(row,{persist=true}={}){
  const {root,plan}=qualificationPlan(row),completion=JSON.parse(readPrivate(path.join(root,'completion.json'))),proof=completion.qualification;
  assert.ok(completion.native_generation_verified===true&&completion.llm_return_verified===true&&proof?.state==='qualified_returned','Native qualification and LLM return are not complete');
  assert.equal(proof.candidate_operation_id,row.operation_id);assert.equal(proof.job_id,row.qualification_job_id);
  assert.equal(proof.container,row.candidate.container);assert.equal(proof.image,row.candidate.image);assert.equal(proof.enrollment_changed,false);
  const audio=JSON.parse(readPrivate(path.join(root,'ace-audio-proof.json'))),llm=JSON.parse(readPrivate(path.join(root,'llm-proof.json'))),readmission=JSON.parse(readPrivate(path.join(root,'readmission.json')));
  assert.equal(proof.source_receipt_sha256,plan.ace_qualification.source_proof.receipt_sha256);
  const original=JSON.parse(readPrivate(path.join(root,'llm-pair-before.json')));
  assert.equal(original.containers?.length,2);assert.deepEqual(original.members,plan.llm_pair.members);assert.equal(llm.context_length,plan.context_length);
  assert.deepEqual(llm.containers,original.containers.map(c=>({id:c.Id,image:c.Image})),'Original GLM identity differs');
  assert.ok(audio.state==='audio_verified'&&audio.job_id===row.qualification_job_id&&audio.container===proof.container&&audio.image===proof.image&&audio.source_receipt_sha256===plan.ace_qualification.source_proof.receipt_sha256,'Audio qualification binding changed');
  assert.ok(llm.configuration_unchanged===true&&glmRecoveryProofValid(llm.cache,plan.context_length)&&readmission.state==='readmitted','Original GLM return/cache/readmission proof missing');
  const files=['completion.json','ace-audio-proof.json','llm-proof.json','readmission.json','llm-pair-before.json','llm-pair-files-before.json','containers-before.json','media-recipe-contracts.json','media-command-bindings.json','media-jobs.json'];
  for(const step of ['llm-stop-0','llm-start-0','llm-stop-1','llm-start-1','media-start-'+plan.llm_pair.media_member,'media-stop-'+plan.llm_pair.media_member])files.push('commands/'+step+'.request',...['.json','.backup'].map(suffix=>'commands/'+plan.operation_id+'-'+step+suffix));
  const hashes=Object.fromEntries(files.map(name=>[name,sha(readPrivate(path.join(root,name)))]));
  if(row.qualification_receipts_sha256)assert.deepEqual(hashes,row.qualification_receipts_sha256,'Qualification receipts changed');
  else assert.ok(persist,'Qualification lacks pinned evidence; fresh qualification is required');
  if(!persist)return {root,plan,proof,audio};
  const updated={...row,phase:'qualified_returned',qualification:proof,qualification_receipts_sha256:hashes,finished_at:new Date().toISOString()};save(updated);return publicRow(updated);
 }
 return {
  operations:()=>rows().map(r=>({...view(r),physical_machines:r.physical_machines})),
  status:()=>({supported:true,enabled:enabled(),improvement:'ace-api-fields-v1',qualification_supported:true,promotion_supported:!!promotions,operations:rows().map(view),scope:'Separate ACE candidate preparation and fixed one-song qualification with GLM return/cache checks. Qualification borrows an idle pair. Conditional promotion retains the original engine and changes only the qualified target enrollment.'}),
  finish,
  finishQualification(input){
   assert.deepEqual(Object.keys(input??{}),['operation_id']);const row=get(input.operation_id);
   if(['qualified_returned','promoted'].includes(row.phase))return view(row);
   assert.equal(row.phase,'candidate_qualifying','Saved qualification required');
   return completeQualification(row);
  },
  qualificationPermit(input){
   assert.ok(input&&Object.keys(input).sort().join(',')==='job_id,operation_id,plan_file_sha256','Exact saved qualification permit required');
   const row=get(input.operation_id);assert.equal(row.phase,'candidate_qualifying','Qualification no longer owns execution');
   assert.equal(input.job_id,row.qualification_job_id);assert.equal(input.plan_file_sha256,row.qualification_plan_sha256);
   const {root,plan}=qualificationPlan(row);
   const saved=JSON.parse(readPrivate(path.join(root,'media-jobs.json')));
   assert.equal(saved.jobs?.length,1);assert.equal(saved.jobs[0].id,plan.operation_id);assert.deepEqual(saved.jobs[0].payload,aceQualificationPayload(),'Qualification recipe changed');
   let ownLock;
   const acquired=path.join(root,'gateway','acquire.result.json');
   if(fs.existsSync(acquired)){
    const value=JSON.parse(readPrivate(acquired));
    assert.ok(value.request_id===row.qualification_job_id&&value.action==='lock'&&value.control_channel==='approved_operation'&&value.result?.worker_id===row.worker_id&&uuid(value.result.lock_id),'Qualification maintenance receipt differs');
    ownLock=value.result.lock_id;
   }
   permitted(row,ownLock);
   return {allowed:true,operation_id:row.operation_id,job_id:row.qualification_job_id,scope:'Permission for the next qualification transition only. Returning the original LLM remains separately owned.'};
  },
  async qualify(input){
   assert.deepEqual(Object.keys(input??{}),['operation_id']);const row=get(input.operation_id);
   if(row.qualification_job_id){
    if(row.phase==='candidate_qualifying'&&fs.existsSync(path.join(qualificationFolder(row),'completion.json')))return completeQualification(row);
    return view(row);
   }
   assert.equal(row.phase,'candidate_prepared','Prepare an exact stopped candidate first');permitted(row);
   const prepared=JSON.parse(readPrivate(path.join(folder(row.operation_id),'result.json')));
   assert.equal(sha(readPrivate(path.join(folder(row.operation_id),'plan.json'))),row.plan_sha256,'Preparation plan changed');
   assert.equal(sha(readPrivate(path.join(folder(row.operation_id),'request.json'))),row.request_file_sha256,'Preparation request changed');
   assert.equal(prepared.request_file_sha256,row.request_file_sha256);
   assert.deepEqual(await observeRunner(folder(row.operation_id),row.python),prepared,'Native prepared candidate changed');
   permitted(row); // Recheck after the asynchronous native inspection.
   assert.equal(get(row.operation_id).phase,'candidate_prepared','Qualification already started');
   assert.equal(prepared.container,row.candidate.container);assert.equal(prepared.image,row.candidate.image);assert.equal(prepared.original_preserved,true);
   const engine={...row.engine,container:prepared.container,image:prepared.image};assertAceSourceProof(prepared.recipe_contract,engine);
   const worker=workers().find(w=>w.id===row.worker_id),pair=mediaPair(config,worker);
   assert.ok(pair&&[0,1].includes(row.member)&&Number.isSafeInteger(config.context_length)&&config.context_length>0,'Qualification requires a registered paired GLM and explicit context');pair.media_member=row.member;
   const jobs=new MediaJobs(path.join(folder(row.operation_id),'qualification-jobs.json'),{resultsDirectory:path.join(folder(row.operation_id),'qualification-results')});
   assert.equal(jobs.data.jobs.length,0,'Qualification job already exists; reconcile it without resubmission');
   const {job}=jobs.enqueue('music',aceQualificationPayload(),{key:'ace-qualification-'+row.operation_id});
   const updated={...row,phase:'candidate_qualifying',qualification_job_id:job.id};delete updated.finished_at;
   const root=qualificationFolder(updated);fs.mkdirSync(root,{recursive:true,mode:0o700});
   const plan={operation_id:job.id,command_journal_version:1,required_recipe_fields:['dcw_enabled','sampler_mode'],worker_id:row.worker_id,
    separate_workers:workers().filter(w=>!machinesFor(w.id,config).some(m=>row.physical_machines.includes(m))).map(w=>w.id),
    host:row.host,llm_container:pair.members[row.member].container,engine,python:row.python,control_socket:row.control_socket,
    recovery:{profile:'glm53-docker-pair',url:pair.worker_binding.url},llm_pair:pair,endpoint:worker,model:config.model,context_length:config.context_length,
    results_directory:jobs.results.directory,inputs_directory:jobs.inputs.directory,
    ace_qualification:{schema:1,candidate_operation_id:row.operation_id,preparation_directory:folder(row.operation_id),source_proof:prepared.recipe_contract,prepared_result:prepared}};
   saveMediaReceipt(root,'plan.json',plan);saveMediaReceipt(root,'media-jobs.json',{schema:1,jobs:[job]});
   updated.qualification_plan_sha256=sha(readPrivate(path.join(root,'plan.json')));save(updated);
   try{saveMediaReceipt(root,'launched.json',await launchQualification(root));}
   catch{saveMediaReceipt(root,'launch-uncertain.json',{state:'launch_uncertain'});throw Error('Qualification launch unconfirmed; observe the same operation without resubmission');}
   return publicRow(updated);
  },
  async promote(input){
   assert.deepEqual(Object.keys(input??{}),['operation_id']);const row=get(input.operation_id);
   assert.ok(!uncertainCommits.has(row.operation_id),'Promotion commit requires reconciliation');
   if(row.phase==='promoted')return view(row);
   assert.ok(promotions&&['qualified_returned','candidate_promoting'].includes(row.phase),'Saved native qualification and promotion support required');
   permitted(row);const verified=completeQualification(row,{persist:false});
   const reserved={...row,phase:'candidate_promoting'};save(reserved);
   const native=await observePromotionRunner(verified.root,row.python);
   permitted(reserved);assert.equal(get(row.operation_id).phase,'candidate_promoting');
   const fresh=completeQualification(reserved,{persist:false});
   assert.ok(native?.schema===1&&native.state==='qualified_current'&&native.operation_id===row.operation_id&&native.qualification_job_id===row.qualification_job_id,'Native qualification binding changed');
   assert.equal(native.container,row.candidate.container);assert.equal(native.image,row.candidate.image);assert.equal(native.snapshot_image,row.candidate.snapshot_image);
   assert.deepEqual(native.original,{container:row.engine.container,image:row.engine.image,preserved:true});
   assert.equal(native.source_receipt_sha256,fresh.plan.ace_qualification.source_proof.receipt_sha256);
   assert.equal(native.retained_output?.sha256,fresh.audio.output.sha256);assert.equal(native.retained_output?.bytes,fresh.audio.output.bytes);assert.equal(native.retained_output?.id,fresh.audio.output.id);
   assert.deepEqual(native.commands?.map(c=>c.step),['media-stop-'+row.member,'llm-start-0','llm-start-1']);
   assert.ok(native.commands.every(c=>c.epoch?.running===c.step.startsWith('llm-'))&&Number.isFinite(Date.parse(native.observed_at)),'Native return epochs unverified');
   saveMediaReceipt(verified.root,'promotion-native.json',native);
   const proposal=promotions.propose({operation_id:row.operation_id,worker_id:row.worker_id,member:row.member,original:row.engine,candidate:{...row.engine,container:row.candidate.container,image:row.candidate.image},qualification_job_id:row.qualification_job_id,proof_sha256:sha(readPrivate(path.join(verified.root,'promotion-native.json')))});
   saveMediaReceipt(verified.root,'promotion-intent.json',{record:proposal.record,previous_enrollment:proposal.previous_enrollment,delta:'Only selected ACE container/image bindings change. Original container, image, snapshot, runtime settings and other members/engines remain retained.'});
   const updated={...reserved,phase:'promoted',promotion:{record_sha256:proposal.record_sha256,promoted_at:proposal.record.at,previous_container:row.engine.container,previous_image:row.engine.image,container:row.candidate.container,image:row.candidate.image},finished_at:proposal.record.at};
   backup();
   try{
    store.save({...store.data,media_candidates:{...store.data.media_candidates,[row.operation_id]:updated},media_engine_promotions:{...store.data.media_engine_promotions,[row.worker_id]:[...(store.data.media_engine_promotions?.[row.worker_id]??[]),proposal.record]},media_engine_enrollments:{...store.data.media_engine_enrollments,[row.worker_id]:proposal.enrollment}});
    promotions.apply(proposal);
   }catch{
    uncertainCommits.add(row.operation_id);try{saveMediaReceipt(verified.root,'promotion-commit-uncertain.json',{state:'requires_reconciliation'});}catch{}
    throw Error('Promotion persistence unconfirmed; observe durable state before another action');
   }
   return publicRow(updated);
  },
  permit(input){
   assert.ok(input&&Object.keys(input).sort().join(',')==='operation_id,request_file_sha256'&&/^[a-f0-9]{64}$/.test(input.request_file_sha256),'Exact candidate request receipt required');
   const row=get(input.operation_id);assert.equal(row.phase,'candidate_preparing','This preparation no longer owns execution');permitted(row);assert.ok(!fs.existsSync(path.join(folder(row.operation_id),'attention.json')),'Candidate needs reconciliation');
   const bytes=readPrivate(path.join(folder(row.operation_id),'request.json'));assert.equal(sha(bytes),input.request_file_sha256);
   const request=JSON.parse(bytes),planBytes=readPrivate(path.join(folder(row.operation_id),'plan.json')),plan=JSON.parse(planBytes);assert.equal(sha(planBytes),row.plan_sha256,'Candidate plan changed');
   assert.equal(request.operation_id,row.operation_id);assert.equal(request.before.Id,row.engine.container);assert.equal(request.before.Image,row.engine.image);assert.equal(request.epoch.running,false);
   assert.match(request.machine,/^[a-f0-9]{64}$/);assert.deepEqual(request.source_sha256,plan.source_sha256);assert.equal(plan.binding,row.binding);
   if(row.request_file_sha256)assert.equal(row.request_file_sha256,input.request_file_sha256,'Candidate request changed');else save({...row,request_file_sha256:input.request_file_sha256});
   return {allowed:true,operation_id:row.operation_id,scope:'One current preparation-stage permit; no service lifecycle or promotion authority.'};
  },
  async start(input){
   assert.ok(input&&mediaMemberInput(input,'worker_id'),'Choose worker and optional physical member only');
   const selected=selection(input.worker_id,input.member);
   const promoted=rows().find(r=>r.phase==='promoted'&&r.worker_id===selected.worker_id&&r.member===selected.member&&r.candidate.container===selected.engine.container&&r.candidate.image===selected.engine.image);if(promoted)return view(promoted);
   const prior=rows().find(r=>r.worker_id===selected.worker_id&&r.member===selected.member&&r.engine.container===selected.engine.container&&r.engine.image===selected.engine.image);
   if(prior){if(!prior.qualification_job_id&&prior.phase!=='candidate_prepared'&&fs.existsSync(path.join(folder(prior.operation_id),'result.json')))return finish({operation_id:prior.operation_id});return view(prior);}
   const operation_id=randomUUID(),row={...selected,operation_id,phase:'candidate_preparing',created_at:new Date().toISOString()};permitted(row);
   fs.mkdirSync(directory,{recursive:true,mode:0o700});const parent=fs.lstatSync(directory);assert.ok(parent.isDirectory()&&!parent.isSymbolicLink()&&(parent.mode&0o077)===0&&(!process.getuid||parent.uid===process.getuid()),'Private candidate directory required');fs.mkdirSync(folder(operation_id),{mode:0o700});
   const frozen=bundle();saveMediaReceipt(folder(operation_id),'bundle.json',frozen);
   const plan={...row,runner_sha256:sha(fs.readFileSync(runner)),transport_sha256:sha(fs.readFileSync(path.join(root,'ds4-gateway/media_candidate_remote.py'))),bundle_sha256:sha(fs.readFileSync(path.join(folder(operation_id),'bundle.json'))),source_sha256:Object.fromEntries(Object.entries(frozen.patch).map(([k,v])=>[k,sha(v)]))};
   saveMediaReceipt(folder(operation_id),'plan.json',plan);row.plan_sha256=sha(readPrivate(path.join(folder(operation_id),'plan.json')));save(row);
   try{saveMediaReceipt(folder(operation_id),'launched.json',await launchRunner(folder(operation_id),row.python));}
   catch{saveMediaReceipt(folder(operation_id),'attention.json',{state:'launch_uncertain'});throw Error('Candidate launch unconfirmed; observe the saved operation instead of repeating it');}
   return publicRow(row);
  }
 };
}
