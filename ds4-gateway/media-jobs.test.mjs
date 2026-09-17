import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {MediaJobs} from './media-jobs.mjs';
import {MediaBackend,MediaBackendError} from './media-backend.mjs';
import {createGateway} from './gateway.mjs';

function directory(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sg-media-jobs-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
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
  await gateway.close();gateway=createGateway(config);address=await gateway.start();
  assert.equal((await (await call(job.status_url)).json()).id,job.id);
  assert.equal((await call('/v1/music/jobs',{prompt:'changed'},{'idempotency-key':'music'})).status,409);
  assert.equal((await call(`/v1/video/jobs/${job.id}`)).status,404);
  assert.equal((await call('/v1/chat/completions',{model:'fixture',messages:[{role:'user',content:'hello'}]})).status,200);assert.equal(inference,1);
  gateway.drain();assert.equal((await call('/v1/video/jobs',{prompt:{}},{'idempotency-key':'video'})).status,503);assert.equal((await call(job.status_url)).status,200);
});
