import fs from 'node:fs';import path from 'node:path';import {spawn} from 'node:child_process';import {fileURLToPath} from 'node:url';
import {saveMediaReceipt} from './media-execution.mjs';
import assert from 'node:assert/strict';
import {mediaPlanIdentity} from './spark-media-cycle.mjs';
const script=fileURLToPath(new URL('./spark-media-runner.mjs',import.meta.url));
const launch=async folder=>{
 const fd=fs.openSync(path.join(folder,'runner.log'),'ax',0o600);
 try{const child=spawn(process.execPath,[script,folder],{detached:true,stdio:['ignore',fd,fd]});await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});child.unref();return {pid:child.pid};}finally{fs.closeSync(fd);}
};
export function createSparkMediaQualification({directory,transport,launchRunner=launch}){
 const read=id=>{
  const folder=path.join(directory,id);if(!fs.existsSync(folder))return null;
  const file=path.join(folder,'progress.json');const value=fs.existsSync(file)?JSON.parse(fs.readFileSync(file)):{state:'accepted',phase:'starting'};
  if(['qualified_stopped','needs_attention'].includes(value.state))return value;
  try{const {pid}=JSON.parse(fs.readFileSync(path.join(folder,'launched.json')));process.kill(pid,0);return {...value,state:'running'};}catch{return {...value,state:'needs_attention',error:'Runner liveness not confirmed; inspect the retained operation before retrying.'};}
 };
 return {read,async enrollment(id,target,llmContainer){
  const result=read(id);if(!result)return {};
  assert.equal(result.state,'qualified_stopped','Media qualification must pass before enrollment');
  const plan=JSON.parse(fs.readFileSync(path.join(directory,id,'plan.json')));
  assert.equal(plan.target.ssh,target.ssh);assert.equal(plan.target.directory,target.directory);
  assert.equal(plan.preparation.llm_container,llmContainer,'Media proof belongs to a different LLM preparation');
  const current=await transport(target,{action:'media_state'});
  assert.deepEqual(mediaPlanIdentity(current),mediaPlanIdentity(plan.preparation),'Qualified media configuration changed');
  return Object.fromEntries([['h3','video'],['ace-step','music']].map(([key,kind])=>{
   const e=current.engines[key],proof=result.engines?.[key];
   assert.equal(proof?.container,e.container);assert.equal(proof?.image,e.image);
   assert.equal(proof?.outputs?.state,'ready');assert.ok(proof.decoded?.length&&proof.decoded.every(p=>p.full_decode===true));
   const types=new Set(proof.decoded.flatMap(p=>p.streams.map(s=>s.codec_type)));assert.ok(types.has('audio'));if(kind==='video')assert.ok(types.has('video'));
   return [kind,Object.fromEntries(['container','image','kind','port'].map(k=>[k,e[k]]))];
  }));
 },async start(id,target){
  if(read(id))return read(id);
  const preparation=await transport(target,{action:'media_plan'});const folder=path.join(directory,id);fs.mkdirSync(folder,{recursive:true,mode:0o700});
  saveMediaReceipt(folder,'plan.json',{target_id:id,target,preparation});saveMediaReceipt(folder,'progress.json',{state:'accepted',phase:'starting',at:new Date().toISOString()});
  try{saveMediaReceipt(folder,'launched.json',await launchRunner(folder));}catch(error){saveMediaReceipt(folder,'progress.json',{state:'needs_attention',error:'Launch uncertain: '+error.message});throw error;}
  return read(id);
 }};
}
