import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID,createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createGateway} from './gateway.mjs';

const exec=promisify(execFile),script=fileURLToPath(new URL('../examples/hermes/stargate-media/scripts/media_client.py',import.meta.url));
async function fixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sg-hermes-media-'));
  const config={host:'127.0.0.1',port:0,api_key:'fixture',model:'fixture',context_length:262144,nodes:[],state_file:path.join(dir,'state.json'),media_jobs:{enabled:true}};
  let core=createGateway(config),address=await core.start(),drop=null,redirect=null;
  const requests=[];
  const proxy=http.createServer(async(req,res)=>{
    try{
      requests.push({route:req.url,method:req.method,key:req.headers['idempotency-key'],priority:req.headers['x-dsg-priority']});
      if(redirect){res.writeHead(302,{location:redirect});res.end();return;}
      const chunks=[];for await(const chunk of req)chunks.push(chunk);
      const headers={...req.headers};delete headers.host;delete headers.connection;
      const response=await fetch(`http://127.0.0.1:${address.port}${req.url}`,{method:req.method,headers,...(req.method==='POST'?{body:Buffer.concat(chunks)}:{})});
      const body=Buffer.from(await response.arrayBuffer());
      if(req.method==='POST'&&req.url===drop){drop=null;res.destroy();return;}
      res.writeHead(response.status,{'content-type':response.headers.get('content-type')??'application/octet-stream'});res.end(body);
    }catch{res.destroy();}
  });
  proxy.listen(0,'127.0.0.1');await once(proxy,'listening');
  t.after(async()=>{proxy.closeAllConnections();await new Promise(r=>proxy.close(r));await core.close();fs.rmSync(dir,{recursive:true,force:true});});
  const url=`http://127.0.0.1:${proxy.address().port}`;
  const run=async(...args)=>{
    try{const r=await exec(process.env.PYTHON??'python3',[script,'--gateway',url+'/v1',...args],{env:{...process.env,SG_API_KEY:'fixture'},timeout:15000});return {code:0,value:JSON.parse(r.stdout)};}
    catch(e){if(!e.stdout)throw e;return {code:e.code,value:JSON.parse(e.stdout)};}
  };
  return {dir,url,requests,run,get core(){return core;},dropNext:route=>{drop=route;},redirectTo:url=>{redirect=url;},restart:async()=>{await core.close();core=createGateway(config);address=await core.start();}};
}
function retain(f,job,filename,bytes){
  const id=randomUUID(),file=f.core.mediaJobs.results.file(job.id,id);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes);
  return {id,filename,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),content_type:filename.endsWith('.wav')?'audio/wav':'video/mp4'};
}
test('Hermes client keeps one sixteen-clip batch through lost acknowledgement and core restart, then retrieves partial video and audio',async t=>{
  const f=await fixture(t),request=path.join(f.dir,'film.json'),receipt=path.join(f.dir,'receipt.json');
  fs.writeFileSync(request,JSON.stringify({name:'Fixture film',defaults:{seed:42},clips:Array.from({length:16},(_,i)=>({clip_id:`scene-${i}`,payload:{prompt:`Scene ${i}`}}))}));
  const command=['submit','--kind','batch','--request',request,'--receipt',receipt,'--priority','high'];
  f.dropNext('/v1/video/batches');assert.equal((await f.run(...command)).code,1);
  const intent=fs.readFileSync(receipt),saved=JSON.parse(intent);assert.ok(saved.key);assert.equal(saved.id,undefined);assert.equal(fs.statSync(receipt).mode&0o777,0o600);
  assert.equal(f.core.mediaJobs.data.jobs.length,16);
  await f.restart();
  const accepted=await f.run(...command);assert.equal(accepted.code,0);assert.equal(accepted.value.clips.length,16);assert.equal(f.core.mediaJobs.data.jobs.length,16);
  assert.equal(JSON.parse(fs.readFileSync(receipt)).key,saved.key);
  const posts=f.requests.filter(r=>r.method==='POST');assert.equal(posts.length,2);assert.ok(posts.every(r=>r.key===saved.key&&r.priority==='high'));
  assert.ok(f.core.mediaJobs.data.jobs.every(j=>j.priority==='high'));
  assert.equal((await f.run(...command)).code,0);assert.equal(f.requests.filter(r=>r.method==='POST').length,2,'acknowledged repeat only observes');
  const changed=[...command];changed[changed.length-1]='normal';const before=fs.readFileSync(receipt);
  assert.equal((await f.run(...changed)).code,1);assert.deepEqual(fs.readFileSync(receipt),before);
  assert.equal((await f.run('wait','--receipt',receipt,'--seconds','0')).value.counts.queued,16);
  const job=f.core.mediaJobs.data.jobs[0],video=Buffer.from('fixture video bytes'),audio=Buffer.from('fixture generated audio bytes');
  const files=[retain(f,job,'clip.mp4',video),retain(f,job,'generated.wav',audio)];
  f.core.mediaJobs.update(job.id,{state:'completed',outputs:{state:'ready',files}});
  const output=path.join(f.dir,'output'),result=await f.run('download','--receipt',receipt,'--directory',output);
  assert.equal(result.code,0);assert.equal(result.value.downloaded.length,2);assert.equal(result.value.status.counts.completed,1);
  assert.equal(result.value.status.restoration_complete,false);assert.equal(result.value.status.generation_complete,false);
  assert.deepEqual(result.value.downloaded.map(x=>fs.readFileSync(x.path)),[video,audio]);
  const first=result.value.downloaded[0].path;fs.writeFileSync(first,'owner edit');
  const refused=await f.run('download','--receipt',receipt,'--directory',output);assert.equal(refused.code,1);assert.equal(fs.readFileSync(first,'utf8'),'owner edit');
  fs.writeFileSync(f.core.mediaJobs.results.file(job.id,files[0].id),Buffer.alloc(video.length,120));
  const corrupted=path.join(f.dir,'corrupt');assert.equal((await f.run('download','--receipt',receipt,'--directory',corrupted)).code,1);
  assert.deepEqual(fs.readdirSync(corrupted),[],'corrupt output never becomes a retained result');
});
test('Hermes uploads shared inputs once and preserves uncertain uploads without duplicate attempts',async t=>{
  const f=await fixture(t),file=path.join(f.dir,'reference.png'),receipt=path.join(f.dir,'input.json');fs.writeFileSync(file,'fixture reference');
  const command=['upload','--file',file,'--receipt',receipt];
  const first=await f.run(...command);assert.equal(first.code,0);assert.match(first.value.name,/^stargate\//);
  assert.equal((await f.run(...command)).value.id,first.value.id);
  assert.equal(f.requests.filter(r=>r.method==='POST').length,1);
  const uncertain=path.join(f.dir,'uncertain.json');f.dropNext('/v1/video/inputs');
  assert.equal((await f.run('upload','--file',file,'--receipt',uncertain)).code,1);
  const before=fs.readFileSync(uncertain),count=f.requests.length;
  const retry=await f.run('upload','--file',file,'--receipt',uncertain);assert.equal(retry.code,1);assert.match(retry.value.error,/uncertain/);
  assert.deepEqual(fs.readFileSync(uncertain),before);assert.equal(f.requests.length,count);
});
test('music submission retains exact recipe through lost acknowledgement and streams a large retained artifact',async t=>{
 const f=await fixture(t),request=path.join(f.dir,'music.json'),receipt=path.join(f.dir,'music-receipt.json');
 const payload={prompt:'Fixture song',lyrics:'Fixture lyrics',model:'fixture-xl-sft',seed:11,use_random_seed:false,batch_size:1,thinking:false,inference_steps:80,guidance_scale:3,sampler_mode:'heun',dcw_enabled:false,audio_duration:-1,audio_format:'flac',infer_method:'ode'};
 fs.writeFileSync(request,JSON.stringify(payload));const args=['submit','--kind','music','--request',request,'--receipt',receipt];
 f.dropNext('/v1/music/jobs');assert.equal((await f.run(...args)).code,1);await f.restart();const submitted=await f.run(...args);assert.equal(submitted.code,0);
 assert.equal(f.core.mediaJobs.data.jobs.length,1);const job=f.core.mediaJobs.data.jobs[0];assert.deepEqual(job.payload,payload);
 const posts=f.requests.filter(r=>r.method==='POST');assert.equal(posts.length,2);assert.equal(posts[0].key,posts[1].key);
 // Binary transport fixture only; codec validity is tested by the publisher.
 const bytes=Buffer.alloc(32*1024*1024,37),file=retain(f,job,'song.flac',bytes);file.content_type='audio/flac';
 f.core.mediaJobs.update(job.id,{state:'completed',outputs:{state:'ready',files:[file]},execution:{phase:'restoring_llm'}});
 const result=await f.run('download','--receipt',receipt,'--directory',path.join(f.dir,'music-output'));assert.equal(result.code,0);assert.equal(result.value.downloaded.length,1);
 assert.equal(result.value.status.restoration_phase,'restoring_llm');assert.deepEqual(fs.readFileSync(result.value.downloaded[0].path),bytes);
 assert.equal((await f.run(...args)).code,0);assert.equal(f.requests.filter(r=>r.method==='POST').length,2,'an accepted song is only observed on retry');
});
test('Hermes client does not forward gateway credentials through redirects',async t=>{
  const f=await fixture(t);let hits=0;
  const other=http.createServer((_req,res)=>{hits++;res.end('{}');});other.listen(0,'127.0.0.1');await once(other,'listening');t.after(()=>other.close());
  f.redirectTo(`http://127.0.0.1:${other.address().port}/capture`);
  const r=await f.run('capabilities');assert.equal(r.code,1);assert.match(r.value.error,/302/);assert.equal(hits,0);
});
