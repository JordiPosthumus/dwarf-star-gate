import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {Readable} from 'node:stream';
import {MediaJobs} from './media-jobs.mjs';
import {MediaBackend,MediaBackendError} from './media-backend.mjs';
import {createGateway} from './gateway.mjs';
import {videoCapabilities} from './media-capabilities.mjs';

function directory(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sg-media-jobs-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
test('film parallelism is durable, validates atomically, and holds lane capacity through uncertainty and return',t=>{
 const q=new MediaJobs(path.join(directory(t),'queue.json'));
 const payload={requested_parallelism:2,clips:Array.from({length:6},(_,i)=>({clip_id:`c${i}`,payload:{prompt:{}}}))};
 for(const requested_parallelism of [0,-1,1.5,'2',null,129]){
  assert.throws(()=>q.enqueueBatch({...payload,requested_parallelism},{key:'film'}),e=>e.status===400);assert.equal(q.data.jobs.length,0);
 }
 const {batch}=q.enqueueBatch(payload,{key:'film'}),ids=batch.clips.map(c=>c.id),operation_id=ids[0];
 assert.equal(batch.scheduling.requested_parallelism,2);
 assert.throws(()=>q.enqueueBatch({...payload,requested_parallelism:1},{key:'film'}),e=>e.status===409);
 q.assignExecution(ids.slice(0,4),{operation_id,phase:'launch_uncertain',parallel_members:true,member_jobs:[{member:0,job_ids:[ids[0],ids[2]]},{member:1,job_ids:[ids[1],ids[3]]}]});
 const restored=new MediaJobs(q.filename);
 assert.equal(restored.batch(batch.id).scheduling.reserved_generation_slots,2,'four clips on two lanes reserve two slots');
 assert.equal(restored.batchScheduling(batch.id).remaining_requested_slots,0);
 const before=fs.readFileSync(q.filename);
 assert.throws(()=>restored.assignExecution([ids[4]],{phase:'starting'}),/requested_parallelism/);assert.deepEqual(fs.readFileSync(q.filename),before);
 const folder=restored.executionFolder(operation_id);fs.mkdirSync(folder,{recursive:true});
 fs.writeFileSync(path.join(folder,'progress.json'),'{broken');
 assert.equal(restored.batchScheduling(batch.id).reserved_generation_slots,2,'unreadable progress keeps reservations');
 fs.writeFileSync(path.join(folder,'progress.json'),JSON.stringify({phase:'returned'}));
 assert.equal(restored.batchScheduling(batch.id).reserved_generation_slots,0);
 restored.assignExecution([ids[4],ids[5]],{operation_id:ids[4],phase:'starting'});
 assert.equal(restored.batchScheduling(batch.id).reserved_generation_slots,1,'sequential clips use one reserved generation lane');
});
test('mixed films reserve only their assigned lanes and omitted ceilings preserve previous capacity',t=>{
 const q=new MediaJobs(path.join(directory(t),'queue.json'));
 const film=(key,requested_parallelism)=>q.enqueueBatch({...(requested_parallelism?{requested_parallelism}:{}),clips:[0,1,2].map(i=>({clip_id:`c${i}`,payload:{prompt:{}}}))},{key}).batch;
 const a=film('a',1),b=film('b',1),c=film('c');const ids=[a.clips[0].id,b.clips[0].id,a.clips[1].id,b.clips[1].id];
 q.assignExecution(ids,{operation_id:ids[0],phase:'starting',parallel_members:true,member_jobs:[{member:0,job_ids:[ids[0],ids[2]]},{member:1,job_ids:[ids[1],ids[3]]}]});
 assert.equal(q.batchScheduling(a.id).reserved_generation_slots,1);assert.equal(q.batchScheduling(b.id).reserved_generation_slots,1);
 assert.throws(()=>q.assignExecution([a.clips[2].id],{phase:'starting'}),/requested_parallelism/);
 for(const clip of c.clips)q.assignExecution([clip.id],{phase:'starting'});
 assert.equal(q.batchScheduling(c.id).requested_parallelism,null);assert.equal(q.batchScheduling(c.id).reserved_generation_slots,3);
 const data=JSON.parse(fs.readFileSync(q.filename));data.batches[0].requested_parallelism=0;fs.writeFileSync(q.filename,JSON.stringify(data));
 assert.throws(()=>new MediaJobs(q.filename),/Invalid saved media batches/);
});
test('sixteen-clip film commits once, preserves individual recipes and deduplicates through restart',t=>{
 const file=path.join(directory(t),'queue.json'),q=new MediaJobs(file);let writes=0;const save=q.save.bind(q);q.save=data=>{writes++;save(data);};
 const payload={name:'Example film',defaults:{seed:42},clips:Array.from({length:16},(_,i)=>({clip_id:`c${i}`,payload:{prompt:`Scene ${i}`,...(i===3?{seed:123}:{})}}))};
 const first=q.enqueueBatch(payload,{key:'film-one',priority:'high'});assert.equal(first.created,true);assert.equal(first.batch.clips.length,16);assert.equal(writes,1);
 assert.equal(first.batch.clips[3].generation.seed,123);assert.equal(first.batch.clips[4].generation.seed,42);
 assert.equal(first.batch.counts.queued,16);assert.equal(first.batch.generation_complete,false);assert.equal(first.batch.restoration_complete,false);
 assert.ok(first.batch.clips.every(c=>c.priority==='high'&&c.batch_id===first.batch.id));assert.equal(first.batch.clips[0].payload,undefined);
 const restored=new MediaJobs(file);assert.deepEqual(restored.enqueueBatch(payload,{key:'film-one',priority:'high'}),{batch:first.batch,created:false});
 assert.equal(restored.data.jobs.length,16);assert.throws(()=>restored.enqueueBatch({...payload,name:'changed'},{key:'film-one',priority:'high'}),e=>e.status===409);
 assert.throws(()=>restored.enqueue('video',{prompt:{}},{key:'film-one'}),e=>e.status===409);
 restored.enqueue('music',{prompt:'music'},{key:'single'});assert.throws(()=>restored.enqueueBatch(payload,{key:'single'}),e=>e.status===409);
});
test('invalid last film clip cannot partially enqueue earlier clips; duplicate IDs and missing refs refuse',t=>{
 const q=new MediaJobs(path.join(directory(t),'queue.json'));q.enqueue('video',{prompt:{}},{key:'existing'});const before=fs.readFileSync(q.filename);
 const first={clip_id:'one',payload:{prompt:'Scene'}};
 for(const clips of [[first,{clip_id:'two',payload:{prompt:''}}],[first,first],[first,{clip_id:'two',payload:{prompt:'Scene',reference_image:'missing'}}]]){
  assert.throws(()=>q.enqueueBatch({clips},{key:'bad'}));assert.deepEqual(fs.readFileSync(q.filename),before);
 }
 assert.equal(q.data.jobs.length,1);
});
test('film reports per-clip partial output separately from final LLM restoration',t=>{
 const q=new MediaJobs(path.join(directory(t),'queue.json'));
 const {batch}=q.enqueueBatch({clips:[{clip_id:'first',payload:{prompt:{}}},{clip_id:'second',payload:{prompt:{}}}]},{key:'movie'});
 const [a,b]=batch.clips;q.update(a.id,{state:'completed',outputs:{state:'ready',files:[]}});
 assert.equal(q.batch(batch.id).counts.completed,1);assert.equal(q.batch(batch.id).generation_complete,false);
 q.update(b.id,{state:'completed',outputs:{state:'ready',files:[]}});assert.equal(q.batch(batch.id).generation_complete,true);assert.equal(q.batch(batch.id).restoration_complete,false);
 for(const c of batch.clips){
  const folder=q.executionFolder(c.id);fs.mkdirSync(folder,{recursive:true});
  fs.writeFileSync(path.join(folder,'media-jobs.json'),JSON.stringify({jobs:[q.get(c.id)]}));
  fs.writeFileSync(path.join(folder,'progress.json'),JSON.stringify({phase:'returned'}));q.update(c.id,{execution:{phase:'restoring_llm',worker_id:'one'}});
 }
 assert.equal(q.batch(batch.id).state,'completed');assert.equal(q.batch(batch.id).restoration_complete,true);
});
test('film API accepts all clips through authenticated HTTP and restores their identities after core replacement',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sg-film-api-')),config={host:'127.0.0.1',port:0,api_key:'fixture',model:'fixture',context_length:262144,nodes:[],state_file:path.join(dir,'state.json'),media_jobs:{enabled:true}};
 let core=createGateway(config),address=await core.start();t.after(async()=>{await core.close();fs.rmSync(dir,{recursive:true,force:true});});
 const call=(route,body,key='fixture')=>fetch(`http://127.0.0.1:${address.port}${route}`,{method:body?'POST':'GET',headers:{authorization:'Bearer '+key,'content-type':'application/json','idempotency-key':'film'},...(body?{body:JSON.stringify(body)}:{})});
 const payload={requested_parallelism:4,clips:Array.from({length:16},(_,i)=>({clip_id:`c${i}`,payload:{prompt:`Scene ${i}`}}))};
 assert.equal((await call('/v1/video/batches',payload,'wrong')).status,401);
 assert.equal((await call('/v1/video/capabilities',undefined,'wrong')).status,401);
 const capabilities=await(await call('/v1/video/capabilities')).json();assert.equal(capabilities.submission.atomic_film_batches,true);assert.equal(capabilities.submission.max_batch_clips,128);assert.equal(capabilities.submission.requested_parallelism_supported,true);
 const response=await call('/v1/video/batches',payload);assert.equal(response.status,202);const batch=await response.json();assert.equal(batch.clips.length,16);assert.equal(batch.scheduling.requested_parallelism,4);
 assert.equal((await call('/v1/video/batches',payload)).status,200);
 await core.close();core=createGateway(config);address=await core.start();
 assert.deepEqual(await(await call(batch.status_url)).json(),batch);assert.equal((await(await call('/v1/video/jobs')).json()).jobs.length,16);
});
test('public capability counts only physical nonoverlapping budgeted slots and distinguishes present implementation',()=>{
 const config={media_jobs:{max_borrowed_sparks:4}},status={enabled:true,automatic_dispatch_enabled:true,
  media_budget:{max_borrowed_sparks:4,borrowed_sparks:0,remaining_sparks:4},
  workers:['a','alias','b','c'].map((id,i)=>({id,kinds:['video'],busy:false,budget:{allowed:true,sparks_required:2,machines:i<2?['s1','s2']:i===2?['s3','s4']:['s5','s6']}})),
  hosts:['a','alias','b','c'].map(id=>({id,engines:[{kind:'video',ready:true}]})),jobs:[{payload:{prompt:'private scene'}}]};
 const value=videoCapabilities(status,config);assert.equal(value.capacity.available_generation_slots,2);assert.equal(value.capacity.paired_members_parallel,false);
 assert.equal(value.recipes.h3_short.width,608);assert.equal(value.recipes.native_workflow.preserved,true);assert.equal(value.results.estimated_wait_seconds,null);
 assert.doesNotMatch(JSON.stringify(value),/private scene|s1|s2|alias/);
 status.workers.forEach(w=>{w.parallel_kinds=['video'];});
 assert.equal(videoCapabilities(status,config).capacity.available_generation_slots,4,'two budgeted pairs can expose one slot per physical member');
 assert.equal(videoCapabilities(status,config).capacity.paired_members_parallel,true);
 status.automatic_dispatch_enabled=false;assert.equal(videoCapabilities(status,config).capacity.available_generation_slots,0);
 status.automatic_dispatch_enabled=true;status.media_budget.remaining_sparks=1;assert.equal(videoCapabilities(status,config).capacity.available_generation_slots,0);
});
test('configured job holds preserve queue bytes and idempotency while refusing assignment and native submission',async t=>{
 const file=path.join(directory(t),'queue.json'),original=new MediaJobs(file);
 const old=original.enqueue('video',{prompt:{}},{key:'old'}).job,next=original.enqueue('video',{prompt:{}},{key:'new'}).job;
 const before=fs.readFileSync(file),held=new MediaJobs(file,{heldJobIds:[old.id]});
 assert.deepEqual(fs.readFileSync(file),before);assert.equal(held.get(old.id).state,'queued');assert.match(held.get(old.id).dispatch_hold,/Held/);
 assert.deepEqual(held.queued().map(j=>j.id),[next.id]);assert.equal(held.enqueue('video',{prompt:{}},{key:'old'}).job.id,old.id);
 assert.throws(()=>held.assignExecution([next.id,old.id],{phase:'starting'}),/held/);
 await assert.rejects(held.dispatch(old.id,{kind:'comfyui',submit:()=>assert.fail('must not submit')},'worker'),/held/);
 assert.deepEqual(fs.readFileSync(file),before);assert.equal(new MediaJobs(file).get(old.id).dispatch_hold,undefined);
 held.assignExecution([next.id],{phase:'starting'});assert.equal(held.get(next.id).execution.phase,'starting');
 assert.equal(new MediaJobs(file,{heldJobIds:[next.id]}).get(next.id).dispatch_hold,undefined,'a later hold never cancels accepted work');
 for(const ids of [null,'bad',[old.id,old.id],['invalid']])assert.throws(()=>new MediaJobs(file,{heldJobIds:ids}),/held_job_ids/);
});
test('completed job identity survives explicit deletion of its reference input',async t=>{
 const jobs=new MediaJobs(path.join(directory(t),'jobs.json')),stream=Readable.from(['image']);stream.headers={'content-type':'image/png','content-length':'5'};
 const input=await jobs.inputs.receive(stream),payload={prompt:{},input_files:[input.id]},first=jobs.enqueue('video',payload,{key:'original'});
 jobs.update(first.job.id,{state:'completed'});jobs.inputs.remove(input.id);
 const repeated=jobs.enqueue('video',payload,{key:'original'});assert.equal(repeated.job.id,first.job.id);assert.equal(repeated.created,false);
 assert.throws(()=>jobs.enqueue('video',payload,{key:'new-job'}),e=>e.status===404);
});
test('authenticated video inputs persist privately, enforce storage limits and protect queued references from deletion',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sg-media-jobs-')),config={host:'127.0.0.1',port:0,api_key:'fixture',model:'fixture',context_length:262144,nodes:[],state_file:path.join(dir,'state.json'),media_jobs:{enabled:true,input_max_bytes:16,input_total_bytes:24}};
 let core=createGateway(config),address=await core.start();t.after(async()=>{await core.close();fs.rmSync(dir,{recursive:true,force:true});});
 const call=(route,body,method=body===undefined?'GET':'POST',type='image/png',key='fixture')=>fetch(`http://127.0.0.1:${address.port}${route}`,{method,headers:{authorization:'Bearer '+key,'content-type':type,'idempotency-key':'video-fixture'},...(body===undefined?{}:{body})});
 const bytes=Buffer.from('png-data');assert.equal((await call('/v1/video/inputs',bytes,'POST','image/png','wrong')).status,401);assert.equal(fs.existsSync(path.join(dir,'media-inputs')),false);
 assert.equal((await call('/v1/video/inputs',Buffer.alloc(17))).status,413);
 assert.equal((await call('/v1/video/inputs',bytes,'POST','text/plain')).status,415);
 const accepted=await call('/v1/video/inputs',bytes);assert.equal(accepted.status,201);const input=await accepted.json();assert.match(input.name,/^stargate\/[a-f0-9-]+\.png$/);assert.equal(input.sha256,createHash('sha256').update(bytes).digest('hex'));
 const data=path.join(dir,'media-inputs',input.id,'data');assert.deepEqual(fs.readFileSync(data),bytes);assert.equal(fs.statSync(data).mode&0o777,0o600);
 const spare=await(await call('/v1/video/inputs',Buffer.alloc(16))).json();assert.equal((await call('/v1/video/inputs',bytes)).status,507);
 assert.equal((await call('/v1/video/inputs/'+spare.id,undefined,'DELETE')).status,200);
 const payload={prompt:{'1':{class_type:'LoadImage',inputs:{image:input.name}}},input_files:[input.id]};
 assert.equal((await call('/v1/video/jobs',JSON.stringify(payload),'POST','application/json')).status,202);
 assert.equal((await call('/v1/video/inputs/'+input.id,undefined,'DELETE')).status,409);
 await core.close();core=createGateway(config);address=await core.start();assert.equal((await(await call(input.status_url)).json()).sha256,input.sha256);
 assert.equal(core.stats().media_uploads,0);assert.equal((await call('/v1/video/inputs/'+input.id,undefined,'GET','image/png','wrong')).status,401);
});
test('an in-flight input stays counted through draining, while new uploads are rejected',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sg-media-jobs-')),core=createGateway({host:'127.0.0.1',port:0,api_key:'fixture',model:'fixture',context_length:262144,nodes:[],state_file:path.join(dir,'state.json'),media_jobs:{enabled:true}}),address=await core.start();t.after(async()=>{await core.close();fs.rmSync(dir,{recursive:true,force:true});});
 let request;const response=new Promise((resolve,reject)=>{request=http.request({host:'127.0.0.1',port:address.port,path:'/v1/video/inputs',method:'POST',headers:{authorization:'Bearer fixture','content-type':'audio/wav','content-length':'8'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});request.on('error',reject);request.write('wave');});t.after(()=>request.destroy());
 for(let i=0;i<100&&core.stats().media_uploads!==1;i++)await delay(5);assert.equal(core.stats().media_uploads,1);core.drain();
 const rejected=await fetch(`http://127.0.0.1:${address.port}/v1/video/inputs`,{method:'POST',headers:{authorization:'Bearer fixture','content-type':'audio/wav'},body:'wave'});assert.equal(rejected.status,503);
 request.end('data');assert.equal(await response,201);assert.equal(core.stats().media_uploads,0);
});
test('saved ComfyUI execution failures expose the native node error without rewriting or replaying the job',t=>{
 const file=path.join(directory(t),'jobs.json'),q=new MediaJobs(file),id=q.enqueue('video',{prompt:{}},{key:'failed-video'}).job.id;
 q.update(id,{state:'failed',backend:'comfyui',detail:null,result:{status:{status_str:'error',messages:[['execution_error',{node_id:'7',node_type:'MiniMaxH3ReferenceToVideo',exception_message:"Unexpected argument 'ref_image_1'\n",traceback:['private traceback'],current_inputs:{prompt:'private prompt'}}]]}}});
 const before=fs.readFileSync(file),restarted=new MediaJobs(file),job=restarted.get(id);
 assert.equal(job.detail,"ComfyUI node 7 (MiniMaxH3ReferenceToVideo): Unexpected argument 'ref_image_1'");
 assert.equal(restarted.list()[0].detail,job.detail);assert.ok(fs.readFileSync(file).equals(before));
 assert.doesNotMatch(job.detail,/private prompt|private traceback/);assert.equal(restarted.queued().length,0);
 restarted.update(id,{detail:'Existing failure explanation'});assert.equal(restarted.get(id).detail,'Existing failure explanation');
});
test('durable queue preserves payload, priority, FIFO and idempotency across restart',t=>{
  const file=path.join(directory(t),'jobs.json'),q=new MediaJobs(file);
  const normal=q.enqueue('music',{prompt:'piano',audio_duration:30},{key:'one'}).job;
  const high=q.enqueue('video',{prompt:{'1':{class_type:'Example',inputs:{}}}},{key:'two',priority:'high'}).job;
  const second=q.enqueue('music',{prompt:'flute'},{key:'three'}).job;
  const restarted=new MediaJobs(file);
  assert.deepEqual(restarted.queued().map(j=>j.id),[high.id,normal.id,second.id]);
  assert.equal(restarted.enqueue('music',{audio_duration:30,prompt:'piano'},{key:'one'}).job.id,normal.id);
  assert.throws(()=>restarted.enqueue('music',{prompt:'changed'},{key:'one'}),e=>e.status===409);
  assert.deepEqual(restarted.get(normal.id).payload,{prompt:'piano',audio_duration:30});
  assert.equal(restarted.list()[0].payload,undefined);assert.equal(fs.statSync(file).mode&0o777,0o600);
});
test('persisted intent survives a crash and cannot dispatch twice',async t=>{
  const file=path.join(directory(t),'jobs.json'),q=new MediaJobs(file),id=q.enqueue('video',{prompt:{}},{key:'video'}).job.id;
  let release,calls=0;
  const backend={kind:'comfyui',submit:async(_payload,nativeId)=>{calls++;assert.equal(new MediaJobs(file).get(id).state,'uncertain');await new Promise(r=>release=r);return {native_id:nativeId};}};
  const running=q.dispatch(id,backend,'fixture-worker');
  await assert.rejects(q.dispatch(id,backend,'fixture-worker'),e=>e.status===409);
  const restored=new MediaJobs(file);assert.equal(restored.get(id).native_id,id);
  await assert.rejects(restored.dispatch(id,backend,'fixture-worker'),e=>e.status===409);
  release();await running;assert.equal(calls,1);
});
test('text video prompts freeze a native H3 workflow and seed once, preserving retries and raw workflows',async t=>{
  const file=path.join(directory(t),'jobs.json'),q=new MediaJobs(file),input={prompt:'A blue paper boat on a calm pond.'};
  const job=q.enqueue('video',input,{key:'text-video'}).job;
  assert.equal(job.payload.prompt['7'].inputs.prompt,input.prompt);
  assert.deepEqual(job.generation,{engine:'h3',input_format:'text',recipe_sha256:job.generation.recipe_sha256,width:608,height:352,frames:96,fps:24,steps:20,seed:job.generation.seed});
  assert.match(job.generation.recipe_sha256,/^[a-f0-9]{64}$/);assert.ok(Number.isSafeInteger(job.generation.seed));
  assert.equal(job.payload.prompt['9'].inputs.seed,job.generation.seed);
  const restarted=new MediaJobs(file),retry=restarted.enqueue('video',input,{key:'text-video'});
  assert.equal(retry.created,false);assert.equal(retry.job.id,job.id);assert.deepEqual(retry.job.payload,job.payload);assert.deepEqual(retry.job.generation,job.generation);
  assert.throws(()=>restarted.enqueue('video',{...input,seed:42},{key:'text-video'}),e=>e.status===409);
  let submitted;
  await restarted.dispatch(job.id,{kind:'comfyui',submit:async(payload,requestId)=>{submitted=payload;return {native_id:requestId};}},'fixture-worker');
  assert.deepEqual(submitted,job.payload,'dispatch uses the frozen graph, not another expansion');
  assert.doesNotMatch(JSON.stringify(restarted.list()),/blue paper boat/,'status exposes settings, not private prompts');
  const raw={prompt:{one:{class_type:'Custom',inputs:{seed:123}}},extra_data:{example:true}};
  const native=restarted.enqueue('video',raw,{key:'raw'}).job;assert.deepEqual(native.payload,raw);assert.equal(native.generation,undefined);
  const explicit=restarted.enqueue('video',{prompt:'Test',seed:0},{key:'seed-zero'}).job;assert.equal(explicit.generation.seed,0);
});
test('invalid text video options fail before creating a job or draining a worker',t=>{
  const q=new MediaJobs(path.join(directory(t),'jobs.json'));
  for(const input of [{prompt:' '},{prompt:'test',seed:-1},{prompt:'test',seed:1.5},{prompt:'test',seed:'42'},{prompt:'test',steps:1},{prompt:'test',input_files:[]}]){
    assert.throws(()=>q.enqueue('video',input,{key:'invalid'}),e=>e.status===400);
  }
  assert.equal(q.list().length,0);
});
test('lost ACE receipt stays uncertain, explicit rejection fails, neither is replayed',async t=>{
  const q=new MediaJobs(path.join(directory(t),'jobs.json'));
  for(const uncertain of [true,false]){
    const id=q.enqueue('music',{prompt:'music'},{key:String(uncertain)}).job.id;let calls=0;
    const backend={kind:'ace-step',submit:async()=>{calls++;throw new MediaBackendError('native receipt unavailable',{uncertain});}};
    assert.equal((await q.dispatch(id,backend,'fixture-worker')).state,uncertain?'uncertain':'failed');
    await assert.rejects(q.dispatch(id,backend,'fixture-worker'));assert.equal(calls,1);
  }
});
test('real HTTP native adapter completes one job and retains result metadata after restart',async t=>{
  let submits=0;
  const native=http.createServer(async(req,res)=>{for await(const _ of req){}res.setHeader('content-type','application/json');
    res.end(JSON.stringify(req.url==='/release_task'?(submits++,{data:{task_id:'native-job'}}):{data:[{task_id:'native-job',status:1,result:'[{"file":"/v1/audio?path=result.wav"}]'}]}));
  });native.listen(0,'127.0.0.1');await once(native,'listening');t.after(()=>{native.closeAllConnections();native.close();});
  const file=path.join(directory(t),'jobs.json'),q=new MediaJobs(file),id=q.enqueue('music',{prompt:'piano'},{key:'music'}).job.id;
  const backend=new MediaBackend({kind:'ace-step',url:`http://127.0.0.1:${native.address().port}`});
  await q.dispatch(id,backend,'fixture-worker');const restarted=new MediaJobs(file);
  assert.equal((await restarted.observe(id,backend)).state,'completed');
  assert.equal(new MediaJobs(file).get(id).result[0].file,'/v1/audio?path=result.wav');assert.equal(submits,1);
});
test('authenticated gateway media API is durable, isolated from LLM routes and respects draining',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sg-media-gateway-'));let inference=0;
  const native=http.createServer(async(req,res)=>{for await(const _ of req){}res.setHeader('content-type','application/json');if(req.url==='/v1/models')res.end(JSON.stringify({data:[{id:'fixture',context_length:262144}]}));else {inference++;res.end(JSON.stringify({choices:[{message:{content:'ok'},finish_reason:'stop'}]}));}});
  native.listen(0,'127.0.0.1');await once(native,'listening');t.after(()=>{native.closeAllConnections();native.close();});
  const config={host:'127.0.0.1',port:0,api_key:'fixture-key',model:'fixture',context_length:262144,state_file:path.join(dir,'affinity.json'),health_interval_ms:100000,media_jobs:{enabled:true},nodes:[{id:'fixture-worker',url:`http://127.0.0.1:${native.address().port}/v1`}]};
  let gateway=createGateway(config),address=await gateway.start();t.after(async()=>{await gateway.close();fs.rmSync(dir,{recursive:true,force:true});});
  const call=(route,body,headers={})=>fetch(`http://127.0.0.1:${address.port}${route}`,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer fixture-key','content-type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
  assert.equal((await call('/v1/music/jobs',{prompt:'piano'},{authorization:'Bearer wrong','idempotency-key':'music'})).status,401);
  assert.equal((await call('/v1/music/jobs',{prompt:'piano'})).status,400);
  const first=await call('/v1/music/jobs',{prompt:'piano'},{'idempotency-key':'music'});assert.equal(first.status,202);const job=await first.json();assert.equal(job.payload,undefined);assert.equal(inference,0);
  assert.equal((await call('/v1/music/jobs',{prompt:'piano'},{'idempotency-key':'music'})).status,200);
  const video=await call('/v1/video/jobs',{prompt:'A paper boat on a pond.',seed:42},{'idempotency-key':'text-video'});
  assert.equal(video.status,202);const videoJob=await video.json();assert.equal(videoJob.generation.seed,42);assert.equal(videoJob.generation.width,608);assert.equal(videoJob.payload,undefined);
  assert.equal((await call('/v1/video/jobs',{prompt:'A paper boat on a pond.',seed:42},{'idempotency-key':'text-video'})).status,200);
  assert.equal((await call('/v1/video/jobs',{prompt:' ',seed:42},{'idempotency-key':'invalid-text-video'})).status,400);
  assert.equal(inference,0,'media submission does not send an LLM inference request');
  await gateway.close();gateway=createGateway(config);address=await gateway.start();
  assert.equal((await (await call(job.status_url)).json()).id,job.id);
  assert.equal((await call('/v1/music/jobs',{prompt:'changed'},{'idempotency-key':'music'})).status,409);
  assert.equal((await call(`/v1/video/jobs/${job.id}`)).status,404);
  assert.equal((await call('/v1/chat/completions',{model:'fixture',messages:[{role:'user',content:'hello'}]})).status,200);assert.equal(inference,1);
  gateway.drain();assert.equal((await call('/v1/video/jobs',{prompt:{}},{'idempotency-key':'video'})).status,503);assert.equal((await call(job.status_url)).status,200);
});

test('H3 silent reference mistakes fail before queueing; valid graphs and existing retries remain intact',t=>{
 const q=new MediaJobs(path.join(directory(t),'jobs.json'));
 const workflow=inputs=>({prompt:{'5':{class_type:'EmptyImage',inputs:{}},'7':{class_type:'MiniMaxH3ReferenceToVideo',inputs}}});
 for(const inputs of [{ref_images:[['5',0]]},{ref_audios:[['5',0]]},{ref_image_0:['5',0]},{'ref_images.ref_image_0':['missing',0]},{'ref_images.ref_image_0':'picture.png'}]){
  assert.throws(()=>q.enqueue('video',workflow(inputs),{key:'invalid-reference'}),e=>e.status===400&&/H3 node 7.*No job was queued/.test(e.message));
 }
 assert.equal(q.list().length,0);
 const valid=workflow({'ref_images.ref_image_0':['5',0]}),job=q.enqueue('video',valid,{key:'valid'}).job;
 assert.deepEqual(job.payload,valid);
 // Replaying an already accepted legacy request remains observation, not new validation.
 const legacy=workflow({ref_images:[['5',0]]});
 q.update(job.id,{payload:legacy});
 assert.equal(q.enqueue('video',valid,{key:'valid'}).job.id,job.id);
 const custom={prompt:{'7':{class_type:'Custom',inputs:{ref_images:[['anything',0]]}}}};
 assert.deepEqual(q.enqueue('video',custom,{key:'custom'}).job.payload,custom);
});

test('uploaded file loaders must name a file included in the transfer list',async t=>{
 const q=new MediaJobs(path.join(directory(t),'jobs.json')),stream=Readable.from(['image']);stream.headers={'content-type':'image/png','content-length':'5'};
 const input=await q.inputs.receive(stream),payload={prompt:{'5':{class_type:'LoadImage',inputs:{image:input.name}}}};
 assert.throws(()=>q.enqueue('video',payload,{key:'missing-transfer'}),e=>e.status===400&&/node 5.*input_files/.test(e.message));
 assert.equal(q.list().length,0);
 assert.equal(q.enqueue('video',{...payload,input_files:[input.id]},{key:'transfer'}).created,true);
});

test('ACE-Step saved failure explains cause and next step without changing native settings or replaying',t=>{
 const file=path.join(directory(t),'jobs.json'),q=new MediaJobs(file),payload={prompt:'music',audio_duration:120,inference_steps:60};
 const job=q.enqueue('music',payload,{key:'music-error'}).job;
 q.update(job.id,{backend:'ace-step',state:'failed',result:[{error:'CUDA out of memory',traceback:'PRIVATE TRACE',prompt:'PRIVATE PROMPT'}]});
 const restarted=new MediaJobs(file),failed=restarted.get(job.id);
 assert.match(failed.detail,/ACE-Step generation failed: CUDA out of memory/);assert.match(failed.next_step,/not reduced automatically/);
 assert.doesNotMatch(failed.detail,/PRIVATE/);assert.deepEqual(failed.payload,payload);
 assert.equal(restarted.enqueue('music',payload,{key:'music-error'}).job.id,job.id);assert.equal(restarted.queued().length,0);
});

test('all H3 namespaced reference families pass unchanged, including video soundtracks and empty optional groups',t=>{
 const q=new MediaJobs(path.join(directory(t),'jobs.json'));
 const payload={prompt:{'5':{class_type:'Source'},'7':{class_type:'MiniMaxH3ReferenceToVideo',inputs:{'ref_images.ref_image_0':['5',0],'ref_audios.ref_audio_0':['5',1],'ref_videos.ref_video_0':['5',0],'ref_video_audios.ref_video_audio_0':['5',1],ref_images:{},ref_audios:[],ref_videos:null,ref_video_audios:{}}}}};
 assert.deepEqual(q.enqueue('video',payload,{key:'all-refs'}).job.payload,payload);
});

test('ACE-Step malformed effective parameters fail before queueing instead of silently changing the request',t=>{
 const q=new MediaJobs(path.join(directory(t),'jobs.json'));
 const bad=[{inference_steps:'careful'},{audio_duration:'30 seconds'},{thinking:'please'},{batch_size:[]},{guidance_scale:{}},{inference_steps:'2.5'},{audio_duration:'0x10'},{ref_audio:'song.wav'},{input_files:['a-file-id']},{param_obj:{inferenceSteps:'careful'}},{metadata:JSON.stringify({duration:'30 seconds'})},{metas:{},metadata:{inference_steps:'careful'}}];
 for(const params of bad)assert.throws(()=>q.enqueue('music',{prompt:'music',...params},{key:'bad-music'}),e=>e.status===400&&/ACE-Step:.*No job was queued/.test(e.message));
 assert.equal(q.list().length,0);
});

test('ACE-Step aliases, automatic values, native precedence and advanced options pass through unchanged',t=>{
 const q=new MediaJobs(path.join(directory(t),'jobs.json'));
 const inputs=[
  {caption:'music',duration:'30',inferenceSteps:'50',thinking:'yes',useRandomSeed:'off',seed:'42,43'},
  {prompt:'',sample_mode:true,audio_duration:-1,bpm:null,batch_size:'',guidance_scale:'7.0',inference_steps:1000},
  {prompt:'music',param_obj:JSON.stringify({inferenceSteps:'50',duration:'3e1'}),metadata:{thinking:'on'}},
  {prompt:'music',inference_steps:50,thinking:true,param_obj:{inferenceSteps:'ignored garbage',thinking:'also ignored'},metadata:{inference_steps:'also ignored'}},
  {prompt:'music',referenceAudioPath:'/engine/reference.wav',ctx_audio_path:'/engine/source.wav',task_type:'repaint',repainting_end:-1,custom_future_option:{preserve:true}},
  {prompt:'music',audio_duration:'1_000.5',bpm:'1_20',audio_code_string:'codes',lm_top_k:-1,thinking:'false',input_files:[]},
  {prompt:'music',metas:{},metadata:{inference_steps:'50',thinking:'yes'}},
 ];
 inputs.forEach((payload,i)=>assert.deepEqual(q.enqueue('music',payload,{key:'valid-music-'+i}).job.payload,payload));
});

test('previously accepted ACE-Step requests remain retrievable even if new preflight would reject them',t=>{
 const file=path.join(directory(t),'jobs.json'),q=new MediaJobs(file);
 const initial=q.enqueue('music',{prompt:'music'},{key:'legacy-music'}).job;
 const payload={inference_steps:'careful',prompt:'music'};
 const fingerprint=createHash('sha256').update(JSON.stringify({kind:'music',payload,priority:'normal'})).digest('hex');
 q.update(initial.id,{payload,fingerprint,state:'completed'});
 const saved=fs.readFileSync(file),restarted=new MediaJobs(file);
 const retry=restarted.enqueue('music',payload,{key:'legacy-music'});
 assert.equal(retry.created,false);assert.equal(retry.job.id,initial.id);assert.deepEqual(fs.readFileSync(file),saved);
 assert.throws(()=>restarted.enqueue('music',payload,{key:'new-music'}),e=>e.status===400);
});

test('prompt plus uploaded references freezes correct portable H3 wiring and preserves retries',async t=>{
 const file=path.join(directory(t),'jobs.json'),q=new MediaJobs(file);
 const upload=async(type,data)=>{const stream=Readable.from([data]);stream.headers={'content-type':type,'content-length':String(Buffer.byteLength(data))};return q.inputs.receive(stream);};
 const image=await upload('image/png','image-bytes'),audio=await upload('audio/wav','audio-bytes');
 for(const [i,refs]of [{reference_image:image.id},{reference_audio:audio.id},{reference_image:image.id,reference_audio:audio.id}].entries()){
  const input={prompt:'Animate <Picture 1> with <Audio 1>.',seed:42,...refs},job=q.enqueue('video',input,{key:'simple-reference-'+i}).job;
  const nodes=job.payload.prompt;
  assert.equal(nodes['7'].class_type,'MiniMaxH3ReferenceToVideo');assert.equal(nodes['7'].inputs.prompt,input.prompt);assert.equal(nodes['9'].inputs.seed,42);
  assert.equal(nodes['1'].inputs.unet_name,'minimax_h3_ref2va_pruned_int8_convrot.safetensors');
  assert.equal(job.generation.input_format,'references');assert.equal(job.generation.reference_sizing,'match');assert.equal(job.generation.frames,124);
  assert.equal(nodes['7'].inputs.ref_images,undefined);assert.equal(nodes['7'].inputs.ref_audios,undefined);
  if(refs.reference_image){assert.equal(nodes['5'].inputs.image,image.name);assert.deepEqual(nodes['7'].inputs['ref_images.ref_image_0'],['5',0]);}
  else{assert.equal(nodes['5'],undefined);assert.equal(nodes['7'].inputs['ref_images.ref_image_0'],undefined);}
  if(refs.reference_audio){assert.equal(nodes['15'].inputs.audio,audio.name);assert.deepEqual(nodes['7'].inputs['ref_audios.ref_audio_0'],['15',0]);}
  assert.deepEqual(job.payload.input_files,Object.values(refs));
  assert.deepEqual(job.generation.reference_inputs.map(r=>r.sha256),[...(refs.reference_image?[image.sha256]:[]),...(refs.reference_audio?[audio.sha256]:[])]);
  const restarted=new MediaJobs(file);assert.deepEqual(restarted.enqueue('video',input,{key:'simple-reference-'+i}).job.payload,job.payload);
 }
 const last=q.list().at(-1),input={prompt:'Animate <Picture 1> with <Audio 1>.',seed:42,reference_image:image.id,reference_audio:audio.id};
 q.update(last.id,{state:'completed'});q.inputs.remove(image.id);
 assert.equal(new MediaJobs(file).enqueue('video',input,{key:'simple-reference-2'}).job.id,last.id,'completed same-key retry does not resolve deleted inputs again');
});

test('reference shortcut rejects missing, mismatched and ambiguous inputs before queueing',async t=>{
 const q=new MediaJobs(path.join(directory(t),'jobs.json')),stream=Readable.from(['audio']);stream.headers={'content-type':'audio/wav','content-length':'5'};
 const audio=await q.inputs.receive(stream);
 for(const params of [{reference_image:audio.id},{reference_image:'image.jpg'},{reference_image:'https://example.com/image.png'},{reference_audio:null},{reference_image:['id']},{prompt:{},reference_image:audio.id}]){
  assert.throws(()=>q.enqueue('video',{prompt:'test',...params},{key:'bad-shortcut'}),e=>e.status===400&&/reference_image|reference_audio/.test(e.message));
 }
 assert.throws(()=>q.enqueue('video',{prompt:'test',reference_image:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'},{key:'missing-reference'}),e=>e.status===404&&/reference_image.*Upload/.test(e.message));
 assert.equal(q.list().length,0);
});


test('operation start survives changing runner receipt timestamps without rewriting saved jobs',t=>{
  const file=path.join(directory(t),'jobs.json'),q=new MediaJobs(file);
  const first=q.enqueue('video',{prompt:{}},{key:'first'}).job.id;
  const second=q.enqueue('video',{prompt:{}},{key:'second'}).job.id;
  const started='2026-01-01T01:00:00.000Z';
  q.assignExecution([first,second],{worker_id:'fixture',operation_id:first,phase:'starting',at:started,batch_job_ids:[first,second]});
  const folder=q.executionFolder(first);fs.mkdirSync(folder,{recursive:true});
  const original=fs.readFileSync(file);
  for(const heartbeat of ['2026-01-01T01:05:00.000Z','2026-01-01T01:10:00.000Z']){
    fs.writeFileSync(path.join(folder,'progress.json'),JSON.stringify({phase:'generating',active_job_id:second,at:heartbeat,heartbeat_at:heartbeat}));
    for(const job of q.list()){assert.equal(job.execution.started_at,started);assert.equal(job.execution.at,heartbeat);}
  }
  assert.ok(fs.readFileSync(file).equals(original));
});
