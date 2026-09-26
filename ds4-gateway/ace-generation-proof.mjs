import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mediaOutputFiles} from './media-results.mjs';
const execute=promisify(execFile);
const descriptor={schema:1,source:'acestep.inference.audio.params',per_audio:true,query_paths:['cache','store']};
const fields=['inference_steps','guidance_scale','sampler_mode','dcw_enabled','thinking','infer_method','audio_format'];

export async function decodeAceFlac(file,{run=execute}={}){
 const probe=JSON.parse((await run('ffprobe',['-v','error','-show_entries','format=duration:stream=codec_type,codec_name,sample_rate,channels','-of','json',file],{maxBuffer:1024*1024})).stdout);
 assert.ok(Number.isFinite(Number(probe.format?.duration))&&Number(probe.format.duration)>0,'Audio duration is unverified');
 assert.ok(probe.streams?.length===1&&probe.streams[0].codec_type==='audio'&&probe.streams[0].codec_name==='flac'&&Number(probe.streams[0].sample_rate)>0&&Number(probe.streams[0].channels)>0,'A real FLAC audio stream is required');
 await run('ffmpeg',['-v','error','-xerror','-i',file,'-map','0','-f','null','-'],{maxBuffer:1024*1024});
 return {...probe,full_decode:true};
}
function retainedBytes(file,expected){
 const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 try{
  const before=fs.fstatSync(fd);assert.ok(before.isFile()&&before.size===expected.bytes,'Retained FLAC size changed');
  const hash=createHash('sha256'),buffer=Buffer.alloc(1024*1024);let length;
  while((length=fs.readSync(fd,buffer,0,buffer.length,null)))hash.update(buffer.subarray(0,length));
  const after=fs.fstatSync(fd);assert.equal(after.mtimeMs,before.mtimeMs);assert.equal(after.ctimeMs,before.ctimeMs);assert.equal(after.size,before.size);
  assert.equal(hash.digest('hex'),expected.sha256,'Retained FLAC bytes changed');
  return {device:before.dev,inode:before.ino,bytes:before.size,mtime:before.mtimeMs,ctime:before.ctimeMs};
 }finally{fs.closeSync(fd);}
}

// Qualification of one explicit seeded song. This does not enroll an engine,
// restore an LLM, infer model quality, or turn an ingress echo into runtime proof.
export async function verifyAceGeneration(job,{engine,sourceProof,backend,results,decode=decodeAceFlac}){
 assert.ok(job.kind==='music'&&job.backend==='ace-step'&&job.state==='completed'&&job.native_id,'Completed native ACE job required');
 assert.ok(sourceProof?.state==='verified'&&sourceProof.container===engine.container&&sourceProof.image===engine.image&&sourceProof.container_state_unchanged===true&&/^[a-f0-9]{64}$/.test(sourceProof.receipt_sha256),'Exact candidate source proof required');
 assert.deepEqual(sourceProof.generation_receipt,descriptor,'Generation-receipt source support is unverified');
 assert.ok(backend.kind==='ace-step'&&job.outputs?.state==='ready','Retained native music outputs required');
 const request=job.payload;
 assert.ok(request&&request.batch_size===1&&request.use_random_seed===false&&Number.isSafeInteger(request.seed)&&request.seed>=0&&request.audio_format==='flac','Qualification needs one explicit seeded FLAC request');
 assert.ok(Number.isFinite(request.audio_duration)&&(request.audio_duration===-1||request.audio_duration>0),'Explicit duration or automatic sentinel required');
 for(const field of fields)assert.ok(Object.hasOwn(request,field),'Explicit qualification recipe field missing: '+field);
 assert.ok(Array.isArray(job.result)&&job.result.length===1&&job.outputs.files.length===1,'Exactly one generated and retained audio result required');
 const audio=job.result[0],receipt=audio.generation_receipt;
 assert.ok(receipt?.schema===1&&receipt.source==='acestep.inference.audio.params'&&receipt.parameters&&typeof receipt.parameters==='object','Native per-audio parameter receipt missing');
 for(const field of fields)assert.deepEqual(receipt.parameters[field],request[field],'Native generation differs for '+field);
 assert.equal(receipt.parameters.seed,request.seed,'Native seed differs');
 assert.ok(Number.isFinite(receipt.parameters.duration)&&(receipt.parameters.duration===-1||receipt.parameters.duration>0),'Native duration is unverified');
 if(request.audio_duration>0)assert.equal(receipt.parameters.duration,request.audio_duration,'Native duration differs');
 const sources=mediaOutputFiles(backend,job.result),file=job.outputs.files[0];
 assert.equal(sources.length,1);assert.equal(sources[0].extension,'.flac');assert.equal(sources[0].filename,file.filename);assert.equal(file.content_type,'audio/flac');
 const local=results.file(job.id,file.id),before=retainedBytes(local,file),decoded=await decode(local);
 assert.ok(decoded?.full_decode===true&&Number(decoded.format?.duration)>0&&decoded.streams?.length===1&&decoded.streams[0].codec_name==='flac'&&decoded.streams[0].codec_type==='audio','Complete FLAC decoding is unverified');
 assert.deepEqual(retainedBytes(local,file),before,'Retained audio changed during decoding');
 return {schema:1,state:'audio_verified',job_id:job.id,native_id:job.native_id,container:engine.container,image:engine.image,source_receipt_sha256:sourceProof.receipt_sha256,
  requested_duration:request.audio_duration,generation_receipt:structuredClone(receipt),output:{...file,decoded},
  scope:'Generator-returned parameters match the explicit one-song recipe; retained FLAC bytes and full decode verified. Automatic duration may resolve natively. This is not model-quality, exact-model identity, LLM-return or promotion proof.'};
}
