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

function directory(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sg-media-jobs-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
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
