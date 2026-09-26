import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {MediaJobs} from './media-jobs.mjs';
import {MediaBackend} from './media-backend.mjs';
import {runMediaGeneration} from './media-generation.mjs';

function fixture(t,kind='video'){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'sg-generation-resume-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const jobs=new MediaJobs(path.join(directory,'jobs.json'));
  const payload=kind==='video'?{prompt:{one:{class_type:'Fixture',inputs:{}}}}:{prompt:'instrumental',audio_duration:10};
  const job=jobs.enqueue(kind,payload,{key:'original'}).job;
  const plan={operation_id:job.id,worker_id:'worker-a',engine:{kind:kind==='video'?'comfyui':'ace-step'}};
  return {directory,jobs,job,plan};
}
const forbidden=()=>assert.fail('Accepted work must not pass new submission gates');
const baseIo=(jobs,backend)=>({jobs,backend,save:()=>{},progress:()=>{},delay:async()=>{},maintenance:forbidden,
  shouldContinue:()=>false,continueBatch:forbidden,watchProgress:()=>({snapshot:()=>null,close:()=>{}})});

test('saved submitted/running/uncertain jobs are observed despite a new-work veto, without another submission',async t=>{
  for(const kind of ['video','music'])for(const state of ['submitted','pending','running','uncertain']){
    const f=fixture(t,kind);let observations=0,collections=0;
    f.jobs.update(f.job.id,{state,worker:f.plan.worker_id,backend:f.plan.engine.kind,native_id:'original-native'});
    const backend={kind:f.plan.engine.kind,submit:forbidden,uploadInput:forbidden,request:forbidden,
      observe:async id=>{assert.equal(id,'original-native');observations++;return {state:observations===1?'unknown':'completed',result:{fixture:true}};}};
    f.jobs.collect=async id=>{assert.equal(id,f.job.id);collections++;};
    const next=f.jobs.enqueue(kind,f.job.payload,{key:'next'}).job;f.plan.job_ids=[f.job.id,next.id];
    const result=await runMediaGeneration(f.plan,baseIo(f.jobs,backend));
    assert.equal(observations,2);assert.equal(collections,1);assert.deepEqual(result.completed_job_ids,[f.job.id]);assert.deepEqual(result.unstarted_job_ids,[next.id]);
  }
});

test('completed output retention resumes after reconstruction without native submission or re-upload',async t=>{
  const f=fixture(t);f.jobs.update(f.job.id,{state:'completed',worker:f.plan.worker_id,backend:'comfyui',native_id:f.job.id,result:{outputs:{}}});
  const saved=new MediaJobs(f.jobs.filename);let collected=0;
  saved.collect=async id=>{assert.equal(id,f.job.id);collected++;};
  await runMediaGeneration(f.plan,baseIo(saved,{kind:'comfyui',submit:forbidden,request:forbidden,observe:forbidden,uploadInput:forbidden}));
  assert.equal(collected,1);
});

test('a failed native job is retained, and a changed worker or engine binding is rejected',async t=>{
  for(const change of [{state:'failed',detail:'native failed'},{worker:'other'},{backend:'ace-step'}]){
    const f=fixture(t);f.jobs.update(f.job.id,{state:'running',worker:f.plan.worker_id,backend:'comfyui',native_id:f.job.id,...change});
    const before=f.jobs.get(f.job.id);
    await assert.rejects(runMediaGeneration(f.plan,baseIo(f.jobs,{kind:'comfyui',submit:forbidden,observe:forbidden})),/native failed|originally assigned/);
    assert.deepEqual(f.jobs.get(f.job.id),before);
  }
});

test('lost ACE-Step identity and absent ComfyUI history stay uncertain without resubmission',async t=>{
  for(const kind of ['music','video']){
    const f=fixture(t,kind);let observations=0,waits=0;
    f.jobs.update(f.job.id,{state:'uncertain',worker:f.plan.worker_id,backend:f.plan.engine.kind,native_id:kind==='music'?null:f.job.id});
    const backend={kind:f.plan.engine.kind,submit:forbidden,request:forbidden,observe:async()=>{observations++;return {state:'unknown'};}};
    await assert.rejects(runMediaGeneration(f.plan,{...baseIo(f.jobs,backend),delay:async()=>{if(++waits===3)throw Error('fixture observation boundary');}}),/fixture observation boundary/);
    assert.equal(observations,kind==='music'?0:3);assert.equal(f.jobs.get(f.job.id).state,'uncertain');
  }
});

for(const lostAck of [false,true])test(`killed disposable generation runner resumes the original HTTP job${lostAck?' after lost submission acknowledgement':''}`,{timeout:30000},async t=>{
  const f=fixture(t),bytes=Buffer.from('retained fixture video bytes');let posts=0,downloads=0,accepted=false,completed=false,acceptedResolve;
  const acceptedPromise=new Promise(resolve=>acceptedResolve=resolve);
  const server=http.createServer((req,res)=>{
    res.setHeader('content-type','application/json');
    if(req.url==='/object_info'){res.end(JSON.stringify({Fixture:{input:{required:{}}}}));return;}
    if(req.url==='/queue'){res.end(JSON.stringify({queue_pending:[],queue_running:accepted&&!completed?[[1,f.job.id]]:[]}));return;}
    if(req.url==='/prompt'){
      let raw='';req.on('data',chunk=>raw+=chunk);req.on('end',()=>{
        const body=JSON.parse(raw);assert.equal(body.prompt_id,f.job.id);assert.deepEqual(body.prompt,f.job.payload.prompt);posts++;accepted=true;acceptedResolve();
        if(!lostAck)res.end(JSON.stringify({prompt_id:f.job.id}));
      });return;
    }
    if(req.url===`/history/${f.job.id}`){res.end(JSON.stringify(completed?{[f.job.id]:{status:{status_str:'success',completed:true},outputs:{one:{videos:[{filename:'clip.mp4',type:'output',subfolder:''}]}}}}:{}));return;}
    if(req.url?.startsWith('/view?')){downloads++;res.setHeader('content-type','video/mp4');res.setHeader('content-length',bytes.length);res.end(bytes);return;}
    res.writeHead(404);res.end('{}');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();server.close();});
  const url=`http://127.0.0.1:${server.address().port}`;
  const source=`import {MediaJobs} from ${JSON.stringify(new URL('./media-jobs.mjs',import.meta.url).href)};
    import {MediaBackend} from ${JSON.stringify(new URL('./media-backend.mjs',import.meta.url).href)};
    import {runMediaGeneration} from ${JSON.stringify(new URL('./media-generation.mjs',import.meta.url).href)};
    import {setTimeout as delay} from 'node:timers/promises';
    await runMediaGeneration(${JSON.stringify(f.plan)},{jobs:new MediaJobs(${JSON.stringify(f.jobs.filename)}),backend:new MediaBackend({kind:'comfyui',url:${JSON.stringify(url)}}),
      save:()=>{},maintenance:async()=>({owned:true}),delay:()=>delay(30),watchProgress:()=>({snapshot:()=>null,close:()=>{}}),
      progress:(phase,detail)=>{if(detail==='Native job: running.')process.send('observed-running');}});`;
  const child=spawn(process.execPath,['--input-type=module','-e',source],{stdio:['ignore','pipe','pipe','ipc']});let stderr='';child.stderr.on('data',b=>stderr+=b);
  const exited=once(child,'exit');t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');});
  const running=once(child,'message');
  const terminal=exited.then(()=>{throw Error(`Disposable runner exited before checkpoint: ${stderr}`);});
  await Promise.race([lostAck?acceptedPromise:running,terminal]);
  child.kill('SIGKILL');const [code,signal]=await exited;assert.equal(code,null);assert.equal(signal,'SIGKILL');
  assert.equal(posts,1);const before=JSON.parse(fs.readFileSync(f.jobs.filename)).jobs[0];assert.equal(before.state,lostAck?'submitting':'running');
  const restored=new MediaJobs(f.jobs.filename);assert.equal(restored.get(f.job.id).state,lostAck?'uncertain':'running');completed=true;
  const result=await runMediaGeneration(f.plan,{...baseIo(restored,new MediaBackend({kind:'comfyui',url})),delay:()=>delay(1)});
  assert.deepEqual(result.completed_job_ids,[f.job.id]);assert.equal(posts,1);assert.equal(downloads,1);
  const job=restored.get(f.job.id),file=job.outputs.files[0];assert.equal(job.native_id,f.job.id);assert.equal(job.outputs.state,'ready');
  assert.equal(file.sha256,createHash('sha256').update(bytes).digest('hex'));assert.deepEqual(fs.readFileSync(restored.results.file(job.id,file.id)),bytes);
  // Another reconstruction retains the same output identity without downloading again.
  const again=new MediaJobs(f.jobs.filename);await runMediaGeneration(f.plan,baseIo(again,new MediaBackend({kind:'comfyui',url})));
  assert.equal(posts,1);assert.equal(downloads,1);assert.deepEqual(again.get(job.id).outputs,job.outputs);
});
