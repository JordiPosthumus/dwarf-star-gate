import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {MediaJobs} from './media-jobs.mjs';
import {MediaBackend} from './media-backend.mjs';
import {mediaOutputFiles} from './media-results.mjs';
import {createGateway} from './gateway.mjs';

const fixture=Buffer.concat([Buffer.from('RIFF fixture audio bytes '),Buffer.alloc(256*1024,42)]);
const digest=createHash('sha256').update(fixture).digest('hex');
function directory(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sg-media-results-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
async function nativeServer(t,handler){const server=http.createServer(handler);server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});return {server,url:`http://127.0.0.1:${server.address().port}`};}
function completed(queue,kind='music',result=[{file:'/v1/audio?path=%2Foutputs%2Fsample.wav'}]){
  const {job}=queue.enqueue(kind,{prompt:'fixture'},{key:kind});return queue.update(job.id,{state:'completed',backend:kind==='music'?'ace-step':'comfyui',native_id:'native',worker:'fixture-worker',result});
}
test('ACE and Comfy output descriptors use only the enrolled engine and real output files',()=>{
  const ace=new MediaBackend({kind:'ace-step',url:'http://127.0.0.1:1'});
  assert.equal(mediaOutputFiles(ace,[{file:'/outputs/a b.wav'}])[0].url,'http://127.0.0.1:1/v1/audio?path=%2Foutputs%2Fa+b.wav');
  assert.throws(()=>mediaOutputFiles(ace,[{file:'http://example.invalid/v1/audio?path=audio.wav'}]),/outside/);
  const comfy=new MediaBackend({kind:'comfyui',url:'http://127.0.0.1:2'}),result={outputs:{'1':{images:[{filename:'movie.mp4',type:'output',subfolder:'folder'}]},'2':{audio:[{filename:'sound.flac',type:'output'}]},'3':{images:[{filename:'preview.png',type:'temp'}]}}};
  const files=mediaOutputFiles(comfy,result);assert.equal(files.length,2);assert.equal(files[0].content_type,'video/mp4');assert.equal(new URL(files[0].url).searchParams.get('subfolder'),'folder');assert.equal(files[1].content_type,'audio/flac');
});
test('copies streamed files once, preserves bytes and receipts across queue restart',async t=>{
  let calls=0,authorization;
  const e=await nativeServer(t,(req,res)=>{calls++;authorization=req.headers.authorization;res.writeHead(200,{'content-type':'audio/wav','content-length':fixture.length});res.write(fixture.subarray(0,100));res.end(fixture.subarray(100));});
  const file=path.join(directory(t),'jobs.json'),q=new MediaJobs(file),job=completed(q),backend=new MediaBackend({kind:'ace-step',url:e.url,token:'native-fixture-key'});
  const [a,b]=await Promise.all([q.collect(job.id,backend),q.collect(job.id,backend)]);
  assert.equal(calls,1);assert.equal(authorization,'Bearer native-fixture-key');assert.deepEqual(a.outputs,b.outputs);assert.equal(a.outputs.files[0].sha256,digest);
  const restored=new MediaJobs(file),saved=restored.get(job.id),target=restored.results.file(job.id,saved.outputs.files[0].id);
  assert.deepEqual(fs.readFileSync(target),fixture);assert.equal(fs.statSync(target).mode&0o777,0o600);
  await restored.collect(job.id,backend);assert.equal(calls,1);
});
test('failed copy remains visible and retry copies the same native result without generation',async t=>{
  let ready=false,calls=0;
  const e=await nativeServer(t,(_req,res)=>{calls++;res.writeHead(ready?200:503);res.end(ready?fixture:'unavailable');});
  const q=new MediaJobs(path.join(directory(t),'jobs.json')),job=completed(q),backend=new MediaBackend({kind:'ace-step',url:e.url});
  await assert.rejects(q.collect(job.id,backend),/HTTP 503/);assert.equal(q.get(job.id).outputs.state,'failed');assert.equal(q.get(job.id).state,'completed');
  ready=true;await q.collect(job.id,backend);assert.equal(calls,2);assert.equal(q.get(job.id).outputs.state,'ready');
});
test('native redirects are not followed when retaining media',async t=>{
  let redirected=0;
  const e=await nativeServer(t,(req,res)=>{if(req.url==='/redirected'){redirected++;res.end(fixture);}else{res.writeHead(302,{location:'/redirected'});res.end();}});
  const q=new MediaJobs(path.join(directory(t),'jobs.json')),job=completed(q),backend=new MediaBackend({kind:'ace-step',url:e.url});
  await assert.rejects(q.collect(job.id,backend));assert.equal(redirected,0);assert.equal(q.get(job.id).outputs.state,'failed');
});
test('gateway authenticates retained downloads after native engine shutdown and core restart',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sg-media-download-'));
  const engine=await nativeServer(t,(_req,res)=>{res.writeHead(200,{'content-type':'audio/wav'});res.end(fixture);});
  const llm=await nativeServer(t,(_req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{id:'fixture',context_length:262144}]}));});
  const config={host:'127.0.0.1',port:0,api_key:'fixture-key',model:'fixture',context_length:262144,state_file:path.join(dir,'affinity.json'),health_interval_ms:100000,media_jobs:{enabled:true},nodes:[{id:'fixture-worker',url:`${llm.url}/v1`}]};
  let gateway=createGateway(config),address=await gateway.start();t.after(async()=>{await gateway.close();fs.rmSync(dir,{recursive:true,force:true});});
  const job=completed(gateway.mediaJobs),backend=new MediaBackend({kind:'ace-step',url:engine.url});await gateway.mediaJobs.collect(job.id,backend);
  engine.server.closeAllConnections();await new Promise(resolve=>engine.server.close(resolve));
  await gateway.close();gateway=createGateway(config);address=await gateway.start();
  const base=`http://127.0.0.1:${address.port}`,headers={authorization:'Bearer fixture-key'};
  const saved=await (await fetch(`${base}/v1/music/jobs/${job.id}`,{headers})).json(),route=saved.outputs.files[0].url;
  assert.equal((await fetch(base+route)).status,401);
  const response=await fetch(base+route,{headers});assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'audio/wav');assert.deepEqual(Buffer.from(await response.arrayBuffer()),fixture);
  assert.equal((await fetch(base+route.replace('/music/','/video/'),{headers})).status,404);
});
