import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createMediaCandidates} from './media-candidates.mjs';
import {createMediaExecution,saveMediaReceipt} from './media-execution.mjs';
import {createMediaTools} from './genie-media.mjs';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
function fixture(t){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'sg-candidate-'));t.after(async()=>{await f.cleanup?.();fs.rmSync(directory,{recursive:true,force:true});});
 const worker={id:'pair',url:'http://127.0.0.1:8000'},engine=member=>({kind:'ace-step',member,container:(member?'b':'a').repeat(64),image:'sha256:'+'c'.repeat(64),port:8002});
 const config={control_socket:path.join(directory,'control.sock'),genie_chat:{python:'/usr/bin/python3',inspection:{workers:{pair:{ssh:['host-one'],container:'llm-head'}}}},machine_groups:{pair:['s1','s2'],alias:['s1','s2']},media_jobs:{max_borrowed_sparks:2,improvements:{enabled:true},standard:{enabled:true,targets:[{worker_id:'pair',engine:'ace-step'}]},pairs:{pair:{kind:'glm53-docker-pair',model:'glm',worker_binding:worker,members:[{ssh:'host-one',container:'llm-head'},{ssh:'host-two',container:'llm-rank'}]}},workers:{pair:{engines:{music:engine(0)},member_engines:{0:{music:engine(0)},1:{music:engine(1)}}}}}};
 const store={filename:path.join(directory,'state.json'),data:{},save(value){this.data=structuredClone(value);fs.writeFileSync(this.filename,JSON.stringify(value),{mode:0o600});}};
 const f={directory,config,store,launches:0,enabled:true,available:true,allowed:true,external:[],worker};let service;
 const execution=createMediaExecution(config,null,{externalOperations:()=>[...f.external,...(service?.operations()??[])]});f.execution=execution;
 f.options={directory:path.join(directory,'operations'),workers:()=>[worker],isEnabled:()=>f.enabled,isAllowed:()=>f.allowed,hostAvailable:()=>f.available,assertCapacity:(id,own)=>execution.assertCapacity(id,own),launchRunner:async(folder)=>{f.launches++;assert.ok(store.data.media_candidates[path.basename(folder)],'ownership saved before spawn');return {pid:123};},observeRunner:async()=>structuredClone(f.result)};
 f.reopen=()=>f.service=service=createMediaCandidates(config,store,f.options);f.reopen();
 f.capture=row=>{const folder=path.join(f.options.directory,row.operation_id),plan=JSON.parse(fs.readFileSync(path.join(folder,'plan.json')));const request={operation_id:row.operation_id,before:{Id:plan.engine.container,Image:plan.engine.image},epoch:{running:false},machine:'d'.repeat(64),source_sha256:plan.source_sha256};saveMediaReceipt(folder,'request.json',request);return {folder,request,permit:{operation_id:row.operation_id,request_file_sha256:sha(fs.readFileSync(path.join(folder,'request.json')))}};};
 return f;
}
test('candidate reserves pair before launch; restart and aliases cannot duplicate work',async t=>{
 const f=fixture(t),row=await f.service.start({worker_id:'pair'});assert.equal(f.launches,1);
 assert.throws(()=>f.execution.assertCapacity('alias'),/overlapping/);
 const captured=f.capture(row);assert.equal(f.service.permit(captured.permit).allowed,true,'own reservation excluded only from own permit');
 f.reopen();assert.deepEqual(await f.service.start({worker_id:'pair'}),row);assert.equal(f.launches,1);
 f.external.push({operation_id:'other',worker_id:'alias',phase:'preparing'});assert.throws(()=>f.service.permit(captured.permit),/overlapping/);
});
test('default standard member cannot authorize the other physical member',async t=>{
 const f=fixture(t);await assert.rejects(f.service.start({worker_id:'pair',member:1}),/standard/);assert.equal(f.launches,0);
 f.config.media_jobs.standard.targets[0].member=1;const row=await f.service.start({worker_id:'pair',member:1});assert.equal(row.member,1);
});
test('policy, placement, ownership and binding changes revoke the next native-stage permit',async t=>{
 const f=fixture(t),row=await f.service.start({worker_id:'pair'}),c=f.capture(row);
 for(const key of ['enabled','allowed','available']){f[key]=false;assert.throws(()=>f.service.permit(c.permit));f[key]=true;}
 f.config.media_jobs.improvements.enabled=false;assert.throws(()=>f.service.permit(c.permit),/policy/);f.config.media_jobs.improvements.enabled=true;
 f.worker.url='http://127.0.0.1:9000';assert.throws(()=>f.service.permit(c.permit),/binding/);assert.equal(f.launches,1);
});
test('lost launch response is retained across restart and cannot release or relaunch',async t=>{
 const f=fixture(t);f.options.launchRunner=async()=>{f.launches++;throw Error('lost response after spawn');};f.reopen();
 await assert.rejects(f.service.start({worker_id:'pair'}),/unconfirmed/);f.reopen();const row=await f.service.start({worker_id:'pair'});
 assert.equal(row.phase,'requires_reconciliation');assert.equal(f.launches,1);assert.throws(()=>f.execution.assertCapacity('alias'),/overlapping/);
 const c=f.capture(row);assert.throws(()=>f.service.permit(c.permit),/reconciliation/);
});
test('changed request or plan cannot acquire or retain execution authority',async t=>{
 const f=fixture(t),row=await f.service.start({worker_id:'pair'}),c=f.capture(row);f.service.permit(c.permit);
 saveMediaReceipt(c.folder,'request.json',{...c.request,machine:'e'.repeat(64)});assert.throws(()=>f.service.permit({...c.permit,request_file_sha256:sha(fs.readFileSync(path.join(c.folder,'request.json')))}),/changed/);
 saveMediaReceipt(c.folder,'request.json',c.request);const p=JSON.parse(fs.readFileSync(path.join(c.folder,'plan.json')));p.source_sha256['apply-recipe-fields.py']='f'.repeat(64);saveMediaReceipt(c.folder,'plan.json',p);assert.throws(()=>f.service.permit(c.permit),/plan changed/);
});
test('completion needs current native proof; policy withdrawal allows read-only completion only',async t=>{
 const f=fixture(t),row=await f.service.start({worker_id:'pair'}),c=f.capture(row);f.service.permit(c.permit);
 const result={state:'prepared_stopped',operation_id:row.operation_id,request_file_sha256:c.permit.request_file_sha256,container:'e'.repeat(64),image:'sha256:'+'f'.repeat(64),snapshot_image:'sha256:'+'d'.repeat(64)};
 saveMediaReceipt(c.folder,'result.json',result);f.result={...result,state:'requires_reconciliation'};
 await assert.rejects(f.service.finish({operation_id:row.operation_id}),/proof changed/);assert.throws(()=>f.execution.assertCapacity('alias'),/overlapping/);
 f.result=result;f.enabled=false;f.config.media_jobs.improvements.enabled=false;
 const complete=await f.service.finish({operation_id:row.operation_id});assert.equal(complete.phase,'candidate_prepared');assert.equal(f.execution.assertCapacity('alias').allowed,true);
 assert.equal(f.config.media_jobs.workers.pair.engines.music.container,'a'.repeat(64),'enrollment unchanged');assert.equal(f.launches,1);assert.throws(()=>f.service.permit(c.permit),/no longer/);
 assert.ok(fs.readdirSync(f.directory).some(x=>x.includes('.bak')));
});
test('no model-supplied source, image, command or policy enters candidate tool',async t=>{
 const f=fixture(t);let testing=false;const tools=createMediaTools({improve:input=>f.service.start(input),isTesting:()=>testing});
 for(const extra of [{command:'docker stop'},{image:'replacement'},{enabled:true},{member:2}])await assert.rejects(tools.tool({action:'improve',worker_id:'pair',...extra}));
 testing=true;await assert.rejects(tools.tool({action:'improve',worker_id:'pair'}),/testing/);assert.equal(f.launches,0);
 testing=false;assert.equal((await tools.tool({action:'improve',worker_id:'pair'})).phase,'candidate_preparing');
});
test('private plan and frozen source hashes persist before launch',async t=>{
 const f=fixture(t),row=await f.service.start({worker_id:'pair'}),folder=path.join(f.options.directory,row.operation_id),plan=JSON.parse(fs.readFileSync(path.join(folder,'plan.json'))),bundle=JSON.parse(fs.readFileSync(path.join(folder,'bundle.json')));
 assert.equal(plan.bundle_sha256,sha(fs.readFileSync(path.join(folder,'bundle.json'))));assert.match(plan.transport_sha256,/^[a-f0-9]{64}$/);
 for(const [key,value] of Object.entries(bundle.patch))assert.equal(plan.source_sha256[key],sha(value));
 const c=f.capture(row);fs.chmodSync(path.join(folder,'request.json'),0o644);assert.throws(()=>f.service.permit(c.permit),/private/);
});

test('private core routes retain a failed launch across gateway restart; public API grants no preparation authority',async t=>{
 const {createGateway}=await import('./gateway.mjs'),{workerControl}=await import('./worker-client.mjs'),http=await import('node:http');
 const f=fixture(t),worker={id:'single',url:'http://127.0.0.1:9'};
 const config={host:'127.0.0.1',port:0,api_key:'fixture',model:'fixture',context_length:262144,nodes:[worker],state_file:path.join(f.directory,'gateway-state.json'),control_socket:path.join(f.directory,'core.sock'),health_interval_ms:100000,
  genie_chat:{python:path.join(f.directory,'missing-python'),inspection:{workers:{single:{ssh:['fixture-host'],container:'llm'}}}},
  media_jobs:{enabled:true,execution_enabled:true,improvements:{enabled:true},standard:{enabled:true,targets:[{worker_id:'single',engine:'ace-step'}]},workers:{single:{engines:{music:{kind:'ace-step',container:'a'.repeat(64),image:'sha256:'+'b'.repeat(64),port:8002}}}}}};
 let core=createGateway(config),address=await core.start();f.cleanup=()=>core.close();
 const post=(route,body)=>new Promise((resolve,reject)=>{const req=http.request({socketPath:config.control_socket,path:route,method:'POST',headers:{'content-type':'application/json'}},res=>{let text='';res.on('data',v=>text+=v);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text)}));});req.on('error',reject);req.end(JSON.stringify(body));});
 const publicAttempt=await fetch(`http://127.0.0.1:${address.port}/genie-media-improvement`,{method:'POST',headers:{authorization:'Bearer fixture','content-type':'application/json'},body:JSON.stringify({worker_id:'single'})});assert.equal(publicAttempt.status,404);
 await assert.rejects(workerControl(config.control_socket,'/genie-media-improvement',{worker_id:'single'}),/launch unconfirmed/);
 const first=(await workerControl(config.control_socket,'/media-jobs')).improvements.operations[0];assert.equal(first.phase,'requires_reconciliation');
 await core.close();core=createGateway(config);address=await core.start();
 const again=await workerControl(config.control_socket,'/genie-media-improvement',{worker_id:'single'});assert.deepEqual(again,first);
 assert.equal((await post('/media-candidate-permit',{operation_id:first.operation_id,request_file_sha256:'f'.repeat(64)})).status,409);
 assert.equal((await post('/media-candidate-complete',{operation_id:first.operation_id})).status,409);
 const state=await workerControl(config.control_socket,'/media-jobs');assert.equal(state.improvements.operations.length,1);assert.equal(state.media_budget.borrowed_sparks,1);
 assert.equal((await workerControl(config.control_socket,'/workers')).workers[0].drained,false,'candidate launch did not drain inference');
});

async function preparedFixture(t){
 const f=fixture(t);f.config.context_length=400000;f.config.model='glm';f.qualifications=0;
 f.options.launchQualification=async root=>{f.qualifications++;const row=Object.values(f.store.data.media_candidates)[0];assert.equal(row.phase,'candidate_qualifying');assert.equal(path.basename(root),row.qualification_job_id);return {pid:456};};f.reopen();
 const row=await f.service.start({worker_id:'pair'}),c=f.capture(row);f.service.permit(c.permit);
 f.result={state:'prepared_stopped',operation_id:row.operation_id,request_file_sha256:c.permit.request_file_sha256,container:'e'.repeat(64),image:'sha256:'+'f'.repeat(64),snapshot_image:'sha256:'+'d'.repeat(64),original_preserved:true};
 f.result.recipe_contract={state:'verified',container:f.result.container,image:f.result.image,container_state_unchanged:true,receipt_sha256:'c'.repeat(64),generation_receipt:{schema:1,source:'acestep.inference.audio.params',per_audio:true,query_paths:['cache','store']}};
 saveMediaReceipt(c.folder,'result.json',f.result);await f.service.finish({operation_id:row.operation_id});
 f.row=row;f.preparation=c.folder;f.input={operation_id:row.operation_id};
 f.qualification=()=>{const row=f.store.data.media_candidates[f.row.operation_id],root=path.join(f.preparation,'qualification',row.qualification_job_id),plan=JSON.parse(fs.readFileSync(path.join(root,'plan.json')));return {root,plan,permit:{operation_id:row.operation_id,job_id:row.qualification_job_id,plan_file_sha256:row.qualification_plan_sha256}};};
 return f;
}
test('qualification holds physical capacity before launch, retains enrollment and uses one fixed private job across restart',async t=>{
 const f=await preparedFixture(t),before=structuredClone(f.config.media_jobs.workers);
 const row=await f.service.qualify(f.input),q=f.qualification();assert.equal(row.phase,'candidate_qualifying');assert.equal(f.qualifications,1);
 assert.equal(q.plan.engine.container,f.result.container);assert.equal(q.plan.command_journal_version,1);assert.equal(q.plan.llm_pair.media_member,0);
 const queue=JSON.parse(fs.readFileSync(path.join(q.root,'media-jobs.json')));assert.equal(queue.jobs.length,1);assert.equal(queue.jobs[0].payload.sampler_mode,'heun');assert.equal(queue.jobs[0].payload.thinking,false);assert.equal(queue.jobs[0].payload.audio_duration,-1);
 assert.deepEqual(f.config.media_jobs.workers,before);assert.throws(()=>f.execution.assertCapacity('alias'),/overlapping/);
 assert.equal(f.service.qualificationPermit(q.permit).allowed,true);f.reopen();assert.deepEqual(await f.service.qualify(f.input),row);assert.equal(f.qualifications,1);
 assert.equal((await f.service.start({worker_id:'pair'})).phase,'candidate_qualifying');await assert.rejects(f.service.finish(f.input),/cannot replace/);
});
test('qualification refuses changed native preparation and rechecks policy after asynchronous inspection',async t=>{
 const f=await preparedFixture(t);f.result.container='d'.repeat(64);await assert.rejects(f.service.qualify(f.input),/changed/);assert.equal(f.qualifications,0);
 f.result.container='e'.repeat(64);f.options.observeRunner=async()=>{f.enabled=false;return f.result;};f.reopen();await assert.rejects(f.service.qualify(f.input),/policy/);assert.equal(f.qualifications,0);
});
test('qualification cannot use a legacy source witness lacking native per-output parameter receipts',async t=>{
 const f=await preparedFixture(t);delete f.result.recipe_contract.generation_receipt;saveMediaReceipt(f.preparation,'result.json',f.result);
 await assert.rejects(f.service.qualify(f.input),/receipt support/);assert.equal(f.qualifications,0);
});
test('uncertain qualification spawn retains its job and reservation and never dispatches again',async t=>{
 const f=await preparedFixture(t);f.options.launchQualification=async()=>{f.qualifications++;throw Error('reply lost');};f.reopen();
 await assert.rejects(f.service.qualify(f.input),/launch unconfirmed/);f.reopen();assert.equal((await f.service.qualify(f.input)).phase,'requires_reconciliation');assert.equal(f.qualifications,1);
 assert.throws(()=>f.execution.assertCapacity('alias'),/overlapping/);
});
test('qualification permit binds exact plan/job/recipe, excludes only its owned maintenance lock and checks current policy',async t=>{
 const f=await preparedFixture(t);await f.service.qualify(f.input);const q=f.qualification();
 for(const key of ['enabled','allowed','available']){f[key]=false;assert.throws(()=>f.service.qualificationPermit(q.permit));f[key]=true;}
 const lock='22222222-2222-4222-8222-222222222222';fs.mkdirSync(path.join(q.root,'gateway'),{mode:0o700});
 saveMediaReceipt(path.join(q.root,'gateway'),'acquire.result.json',{request_id:q.plan.operation_id,action:'lock',control_channel:'approved_operation',result:{worker_id:'pair',lock_id:lock}});
 f.options.hostAvailable=(id,own)=>id==='pair'&&own===lock;f.reopen();assert.equal(f.service.qualificationPermit(q.permit).allowed,true);
 const queue=JSON.parse(fs.readFileSync(path.join(q.root,'media-jobs.json')));queue.jobs[0].payload.inference_steps=8;saveMediaReceipt(q.root,'media-jobs.json',queue);
 assert.throws(()=>f.service.qualificationPermit(q.permit),/recipe changed/);
 queue.jobs[0].payload.inference_steps=80;saveMediaReceipt(q.root,'media-jobs.json',queue);saveMediaReceipt(q.root,'plan.json',{...q.plan,engine:f.config.media_jobs.workers.pair.engines.music});
 assert.throws(()=>f.service.qualificationPermit(q.permit),/plan changed/);
});
test('read-only qualification completion needs audio, cache, original identity and readmission evidence, even after permission withdrawal',async t=>{
 const f=await preparedFixture(t);await f.service.qualify(f.input);const q=f.qualification(),engine=q.plan.engine;
 const proof={state:'qualified_returned',candidate_operation_id:f.row.operation_id,job_id:q.plan.operation_id,container:engine.container,image:engine.image,enrollment_changed:false,source_receipt_sha256:q.plan.ace_qualification.source_proof.receipt_sha256};
 saveMediaReceipt(q.root,'completion.json',{native_generation_verified:true,llm_return_verified:true,qualification:proof});
 assert.throws(()=>f.service.finishQualification(f.input));assert.throws(()=>f.execution.assertCapacity('alias'),/overlapping/);
 saveMediaReceipt(q.root,'ace-audio-proof.json',{...proof,state:'audio_verified'});
 saveMediaReceipt(q.root,'llm-pair-before.json',{members:q.plan.llm_pair.members,containers:['a','b'].map(id=>({Id:id.repeat(64),Image:'sha256:'+'b'.repeat(64)}))});
 const cache={check:'glm53_vllm_two_conversations_cold_to_warm',context_length:400000,verified_at:new Date().toISOString(),samples:['cold-A','cold-B','warm-A','warm-B'].map((label,i)=>({label,prompt_tokens:i<2?20000:20100,cached_tokens:i<2?0:14336,elapsed_ms:100}))};
 saveMediaReceipt(q.root,'llm-proof.json',{configuration_unchanged:true,context_length:400000,containers:['a','b'].map(id=>({id:id.repeat(64),image:'sha256:'+'b'.repeat(64)})),cache});
 saveMediaReceipt(q.root,'readmission.json',{state:'readmitted'});f.enabled=false;
 assert.equal(f.service.finishQualification(f.input).phase,'qualified_returned');assert.equal(f.execution.assertCapacity('alias').allowed,true);
 assert.equal(f.config.media_jobs.workers.pair.engines.music.container,'a'.repeat(64));assert.equal((await f.service.qualify(f.input)).phase,'qualified_returned');assert.equal(f.qualifications,1);
});
