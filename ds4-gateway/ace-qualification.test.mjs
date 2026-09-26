import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createAceQualification,aceQualificationPayload} from './ace-qualification.mjs';
import {verifyAceGeneration} from './ace-generation-proof.mjs';
import {verifyRecovery} from './recovery-verify.mjs';
import {MediaJobs} from './media-jobs.mjs';
import {MediaBackend} from './media-backend.mjs';
import {pairedMediaReturn} from './media-pair.mjs';
import {runMediaCycle} from './media-cycle.mjs';

function fixture(t){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'sg-ace-qualify-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const jobs=new MediaJobs(path.join(directory,'media-jobs.json')),job=jobs.enqueue('music',aceQualificationPayload(),{key:'fixture'}).job;
 const container=(id,running)=>({Id:id.repeat(64),Image:'sha256:'+'e'.repeat(64),Config:{Env:['MAX_MODEL_LEN=400000','MAX_NUM_SEQS=2','PRESERVE=original']},HostConfig:{Memory:0},Mounts:[],State:{Running:running,StartedAt:'old-'+id,FinishedAt:'never'}});
 const native={head:container('a',true),rank:container('b',true),candidate:container('c',false)},events=[],receipts={};let steps=0;
 const inspect=async id=>structuredClone(Object.values(native).find(c=>c.Id===id)??native[id]);
 const command=async(action,id)=>{const c=Object.values(native).find(c=>c.Id===id);events.push(action+':'+id[0]);c.State.Running=action==='start';c.State[action==='start'?'StartedAt':'FinishedAt']='step-'+ ++steps;};
 const engine={kind:'ace-step',container:native.candidate.Id,image:native.candidate.Image,port:8002};
 const source={state:'verified',container:engine.container,image:engine.image,container_state_unchanged:true,receipt_sha256:'d'.repeat(64),generation_receipt:{schema:1,source:'acestep.inference.audio.params',per_audio:true,query_paths:['cache','store']}};
 const plan={operation_id:job.id,command_journal_version:1,worker_id:'pair',engine,llm_container:'rank',context_length:400000,model:'glm',endpoint:{url:'http://llm'},recovery:{profile:'glm53-docker-pair',url:'http://llm'},llm_pair:{model:'glm',media_member:1,members:[{ssh:'host1',container:'head'},{ssh:'host2',container:'rank'}]},ace_qualification:{schema:1,candidate_operation_id:'11111111-1111-4111-8111-111111111111',source_proof:source,prepared_result:{state:'prepared_stopped',original_preserved:true}}};
 const save=(name,value)=>receipts[name]=structuredClone(value);
 const pair=pairedMediaReturn(plan.llm_pair,{save,inspectRemote:(_host,id)=>inspect(id),startRemote:(_host,id)=>command('start',id),stopRemote:(_host,id)=>command('stop',id),request:async(route)=>route==='/v1/models'?{data:[{id:'glm',max_model_len:400000}]}:{choices:[{finish_reason:'stop',message:{content:'RESTORED_7319'}}]}});
 const f={jobs,job,plan,source,native,events,receipts,audioMismatch:false,cacheFailure:false,decodeFailure:false};
 const backend=new MediaBackend({kind:'ace-step',url:'http://ace'},{fetchImpl:async(url,options)=>{
  const route=new URL(url).pathname;
  if(route==='/v1/audio')return new Response(Buffer.from('fixture FLAC bytes'));
  let value;
  if(route==='/health')value={data:{status:'ok',models_initialized:true}};
  else if(route==='/v1/stats')value={data:{jobs:{queued:0,running:0},queue_size:0}};
  else if(route==='/release_task'){events.push('submit');assert.deepEqual(JSON.parse(options.body),aceQualificationPayload());value={data:{task_id:'native-song'}};}
  else if(route==='/query_result')value={data:[{task_id:'native-song',status:1,result:[{file:'/v1/audio?path=sample.flac',generation_receipt:{schema:1,source:'acestep.inference.audio.params',parameters:{...aceQualificationPayload(),sampler_mode:f.audioMismatch?'euler':'heun',duration:123}}}]}]};
  else throw Error('Unexpected '+route);
  return Response.json(value);
 }});
 const qualification=createAceQualification(plan,{read:name=>receipts[name],save,pair,verifyPrepared:async()=>plan.ace_qualification.prepared_result,
  verifyAudio:(job,options)=>verifyAceGeneration(job,{...options,decode:async()=>{events.push('decode');if(f.decodeFailure)throw Error('decode failed');return {full_decode:true,format:{duration:123},streams:[{codec_name:'flac',codec_type:'audio',sample_rate:48000,channels:2}]};}}),
  verifyCache:(url,model,context,options)=>verifyRecovery(url,model,context,{...options,fetchImpl:async(_url,request)=>{
   if(!request.body)return Response.json({data:[{id:'glm',max_model_len:400000}]});
   const body=JSON.parse(request.body),warm=body.messages.length>1,id=body.messages[0].content.includes('CHECK_A_OK')?'A':'B';
   events.push('cache-'+(warm?'warm':'cold')+id);
   return Response.json({choices:[{finish_reason:'stop',message:{content:(warm?'WARM_':'CHECK_')+id+'_OK'}}],usage:{prompt_tokens:warm?20100:20000,prompt_tokens_details:{cached_tokens:warm&&!f.cacheFailure?14336:0}}});
  }})});
 let maintenance=false;
 const io={jobs,pair,save,inspect,start:id=>command('start',id),stop:id=>command('stop',id),delay:async()=>{},watchProgress:()=>({snapshot:()=>null,close:()=>{}}),
  prepareCommands:async()=>save('media-recipe-contracts.json',{proofs:{'media-1':f.source}}),preflight:qualification.preflight,verifyOutputs:qualification.verifyOutputs,
  maintenance:async action=>{events.push('maintenance-'+action);if(action==='prepare')maintenance=true;return {owned:true,state:action==='finish'?'readmitted':undefined};},hasMaintenanceIntent:()=>maintenance,
  connect:async()=>({backend,close:()=>events.push('disconnect')}),recoveryInspect:pair.recoveryInspect,verify:qualification.verifyReturn,progress:phase=>events.push('phase-'+phase)};
 return {...f,io,qualification,run:()=>runMediaCycle(plan,io),settings:JSON.stringify(Object.values(native).map(c=>c.Config)),set:(key,value)=>f[key]=value};
}
test('candidate song retains native parameters/audio then restores both GLM ranks and checks interleaved caches before readmission',async t=>{
 const f=fixture(t),result=await f.run();assert.equal(result.llm_return_verified,true);
 const proof=f.qualification.completion();assert.equal(proof.state,'qualified_returned');assert.equal(proof.enrollment_changed,false);
 assert.deepEqual(f.events.filter(x=>/^(start|stop):/.test(x)),['stop:a','stop:b','start:c','stop:c','start:b','start:a']);
 assert.ok(f.events.indexOf('decode')<f.events.indexOf('stop:c'));
 assert.ok(f.events.indexOf('cache-warmB')<f.events.indexOf('maintenance-finish'));
 assert.equal(f.receipts['ace-audio-proof.json'].requested_duration,-1);
 assert.equal(f.receipts['llm-proof.json'].cache.samples[2].cached_tokens,14336);
 assert.equal(JSON.stringify(Object.values(f.native).map(c=>c.Config)),f.settings);
});
test('old/mismatched source receipt is refused before capturing or draining the pair',async t=>{
 const f=fixture(t);delete f.source.generation_receipt;
 await assert.rejects(f.run(),/receipt support/);assert.equal(f.receipts['llm-pair-before.json'],undefined);
 assert.equal(f.events.some(x=>x.startsWith('maintenance-')||x.startsWith('stop:')||x==='submit'),false);
});
test('generation parameter mismatch or decode failure still restores unchanged LLM and retains completed song',async t=>{
 for(const [key,pattern] of [['audioMismatch',/sampler_mode/],['decodeFailure',/decode failed/]]){
  const f=fixture(t);f.set(key,true);await assert.rejects(f.run(),pattern);
  assert.equal(f.jobs.get(f.job.id).state,'completed');assert.equal(f.jobs.get(f.job.id).outputs.state,'ready');
  assert.ok(f.events.includes('phase-failed_returned'));assert.ok(f.events.includes('maintenance-finish'));
  assert.throws(()=>f.qualification.completion(),/both pass/);
 }
});
test('readiness without real warm cache hits cannot qualify or readmit the pair',async t=>{
 const f=fixture(t);f.set('cacheFailure',true);await assert.rejects(f.run(),/warm_cache/);
 assert.equal(f.native.head.State.Running,true);assert.equal(f.native.rank.State.Running,true);
 assert.equal(f.events.includes('maintenance-finish'),false);assert.ok(f.events.includes('phase-needs_attention'));
 assert.throws(()=>f.qualification.completion(),/both pass/);
});
