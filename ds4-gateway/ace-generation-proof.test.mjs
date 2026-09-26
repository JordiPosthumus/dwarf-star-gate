import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {MediaJobs} from './media-jobs.mjs';
import {MediaBackend} from './media-backend.mjs';
import {verifyAceGeneration,decodeAceFlac} from './ace-generation-proof.mjs';
const descriptor={schema:1,source:'acestep.inference.audio.params',per_audio:true,query_paths:['cache','store']};
const decoded={format:{duration:'12.5'},streams:[{codec_type:'audio',codec_name:'flac',sample_rate:'48000',channels:2}],full_decode:true};
async function fixture(t){
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'sg-ace-proof-'));t.after(()=>fs.rmSync(folder,{recursive:true,force:true}));
 const payload={prompt:'Requested caption',lyrics:'Fixture words',seed:11,use_random_seed:false,batch_size:1,audio_format:'flac',audio_duration:-1,inference_steps:80,guidance_scale:3.0,sampler_mode:'heun',dcw_enabled:false,thinking:true,infer_method:'ode'};
 const receipt={schema:1,source:'acestep.inference.audio.params',parameters:{caption:'Native caption',lyrics:'Fixture words',seed:11,duration:12.5,audio_format:'flac',inference_steps:80,guidance_scale:3.0,sampler_mode:'heun',dcw_enabled:false,thinking:true,infer_method:'ode',lora_loaded:false},reported_models:{dit:'fixture-dit',lm:'fixture-lm'}};
 const bytes=Buffer.from('synthetic retained-byte fixture; decoder is injected'),native=[{file:'/v1/audio?path=%2Foutput%2Ftrack.flac',status:1,generation_receipt:receipt}];
 const filename=path.join(folder,'jobs.json'),queue=new MediaJobs(filename),job=queue.enqueue('music',payload,{key:'qualification'}).job;
 const calls=[];const backend=new MediaBackend({kind:'ace-step',url:'http://127.0.0.1:1'},{fetchImpl:async(url,options)=>{calls.push(new URL(url).pathname);
  if(new URL(url).pathname==='/release_task')return Response.json({data:{task_id:'native-1'}});
  if(new URL(url).pathname==='/query_result')return Response.json({data:[{task_id:'native-1',status:1,result:JSON.stringify(native)}]});
  return new Response(bytes,{headers:{'content-length':String(bytes.length)}});
 }});
 await queue.dispatch(job.id,backend,'fixture');await queue.observe(job.id,backend);await queue.collect(job.id,backend);
 const engine={container:'a'.repeat(64),image:'sha256:'+'b'.repeat(64)},sourceProof={state:'verified',container_state_unchanged:true,...engine,generation_receipt:descriptor,receipt_sha256:'c'.repeat(64)};
 const options={engine,sourceProof,backend,results:queue.results,decode:async()=>structuredClone(decoded)};
 return {queue,job:queue.get(job.id),receipt,options,filename,calls,bytes};
}
test('native receipt survives gateway observation, collection and restart without rewriting request or parameters',async t=>{
 const f=await fixture(t),restarted=new MediaJobs(f.filename),job=restarted.get(f.job.id);
 const before=structuredClone(job),proof=await verifyAceGeneration(job,f.options);
 assert.equal(proof.state,'audio_verified');assert.equal(proof.requested_duration,-1);assert.equal(proof.generation_receipt.parameters.duration,12.5);
 assert.equal(proof.generation_receipt.parameters.caption,'Native caption');assert.equal(job.payload.prompt,'Requested caption');
 assert.equal(proof.output.sha256,createHash('sha256').update(f.bytes).digest('hex'));assert.deepEqual(job,before);
 assert.deepEqual(f.calls,['/release_task','/query_result','/v1/audio']);assert.match(proof.scope,/not.*LLM-return/);
});
test('ingress echo, missing receipt, wrong source and old source witness cannot qualify',async t=>{
 const f=await fixture(t);
 for(const receipt of [undefined,{schema:1,source:'request',parameters:f.job.payload},{...f.receipt,parameters:{...f.receipt.parameters,sampler_mode:'euler'}}]){
  const job=structuredClone(f.job);job.result[0].generation_receipt=receipt;await assert.rejects(verifyAceGeneration(job,f.options));
 }
 await assert.rejects(verifyAceGeneration(f.job,{...f.options,sourceProof:{...f.options.sourceProof,generation_receipt:undefined}}),/unverified/);
});
test('each established recipe field and actual seed are checked before decoding',async t=>{
 const f=await fixture(t);let decodes=0;
 const options={...f.options,decode:async()=>{decodes++;return decoded;}};
 for(const [key,value] of Object.entries({inference_steps:8,guidance_scale:7,sampler_mode:'euler',dcw_enabled:true,thinking:false,infer_method:'sde',audio_format:'wav',seed:12})){
  const job=structuredClone(f.job);job.result[0].generation_receipt.parameters[key]=value;await assert.rejects(verifyAceGeneration(job,options),/differs/);
 }
 assert.equal(decodes,0);
});
test('automatic duration may resolve natively; an explicit duration may not be substituted',async t=>{
 const f=await fixture(t);await verifyAceGeneration(f.job,f.options);
 const job=structuredClone(f.job);job.payload.audio_duration=30;
 await assert.rejects(verifyAceGeneration(job,f.options),/duration differs/);
 job.payload.audio_duration=-1;job.result[0].generation_receipt.parameters.duration=null;
 await assert.rejects(verifyAceGeneration(job,f.options),/duration is unverified/);
});
test('wrong engine identity, missing outputs and multiple results cannot qualify',async t=>{
 const f=await fixture(t);
 await assert.rejects(verifyAceGeneration(f.job,{...f.options,sourceProof:{...f.options.sourceProof,image:'sha256:'+'d'.repeat(64)}}),/Exact/);
 for(const changed of [{native_id:null},{outputs:{state:'failed'}},{result:[...f.job.result,...f.job.result]}])await assert.rejects(verifyAceGeneration({...f.job,...changed},f.options));
});
test('byte substitution, symlink and modification during decode are rejected',async t=>{
 const f=await fixture(t),file=f.job.outputs.files[0],local=f.queue.results.file(f.job.id,file.id);
 fs.writeFileSync(local,Buffer.alloc(f.bytes.length,42));await assert.rejects(verifyAceGeneration(f.job,f.options),/bytes changed/);
 fs.writeFileSync(local,f.bytes);await assert.rejects(verifyAceGeneration(f.job,{...f.options,decode:async()=>{fs.writeFileSync(local,Buffer.alloc(f.bytes.length,43));return decoded;}}),/bytes changed/);
 const other=local+'.other';fs.renameSync(local,other);fs.symlinkSync(other,local);await assert.rejects(verifyAceGeneration(f.job,f.options));
});
test('native completion cannot replace full decode or qualify a different codec',async t=>{
 const f=await fixture(t);
 for(const result of [{...decoded,full_decode:false},{...decoded,streams:[{codec_type:'audio',codec_name:'mp3'}]}])await assert.rejects(verifyAceGeneration(f.job,{...f.options,decode:async()=>result}),/decoding/);
 await assert.rejects(verifyAceGeneration(f.job,{...f.options,decode:async()=>{throw Error('corrupt frame');}}),/corrupt frame/);
 assert.equal(f.queue.get(f.job.id).state,'completed','qualification failure retains native result');
});
test('decoder fully traverses original audio and refuses non-FLAC probe before ffmpeg',async()=>{
 const calls=[];await decodeAceFlac('/fixture/retained.flac',{run:async(command,args)=>{calls.push({command,args});return {stdout:JSON.stringify(decoded)};}});
 assert.deepEqual(calls[1],{command:'ffmpeg',args:['-v','error','-xerror','-i','/fixture/retained.flac','-map','0','-f','null','-']});
 let count=0;await assert.rejects(decodeAceFlac('/fixture/renamed.flac',{run:async()=>{count++;return {stdout:JSON.stringify({...decoded,streams:[{codec_type:'audio',codec_name:'mp3'}]})};}}),/real FLAC/);assert.equal(count,1);
});
