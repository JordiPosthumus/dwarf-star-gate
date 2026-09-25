import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createMediaSetup} from './media-setup.mjs';import {saveMediaReceipt} from './media-execution.mjs';
import http from 'node:http';import {once} from 'node:events';
import {createGateway} from './gateway.mjs';import {workerControl} from './worker-client.mjs';
import {mediaReuse,selectedMediaPreparation,mediaPreparationRequest} from './media-reuse.mjs';
function fixture(t){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'sg-media-setup-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const llm='a'.repeat(64),engine={container:'b'.repeat(64),image:'sha256:'+'c'.repeat(64),kind:'ace-step',port:8002,inspection:{Id:'b'.repeat(64),Image:'sha256:'+'c'.repeat(64),Config:{Cmd:['serve']},HostConfig:{},Mounts:[]}};
 const video={container:'d'.repeat(64),image:'sha256:'+'e'.repeat(64),kind:'comfyui',port:8188};
 const baseline={model:'fixture',context_length:262144,control_socket:'/fixture.sock',media_jobs:{enabled:true,workers:{one:{engines:{video}}}},genie_chat:{python:'/fixture/python',inspection:{workers:{one:{container:llm,ssh:['fixture-host']}}}},recovery:{workers:[{id:'one',url:'http://127.0.0.1:38999',ssh:'fixture-host',adapter:'docker',verification:'qwen_vllm',profile:'original-profile'}]}};
 const config=structuredClone(baseline),workers=[{id:'one',url:'http://127.0.0.1:38999',ssh:'fixture-host',context_length:262144}],store={filename:path.join(directory,'state.json'),data:{media_host_eligibility:{one:{music:true,video:false}},other:{keep:true}},save(data){this.data=data;fs.writeFileSync(this.filename,JSON.stringify(data));}};store.save(store.data);
 let allowed=true,enabled=true,launches=0;
 const fresh={llm_container:llm,engines:{'ace-step':engine}};
 const options={directory:path.join(directory,'operations'),workers:()=>workers,binding:()=>true,isEnabled:()=>enabled,isAllowed:()=>allowed,bundle:()=>({bundle:'fixture',bundle_sha256:'f'.repeat(64)}),transport:async()=>fresh,launchRunner:async()=>{launches++;return {pid:process.pid};}};
 const service=createMediaSetup(config,store,options);
 function complete(id){const folder=path.join(options.directory,id),plan=JSON.parse(fs.readFileSync(path.join(folder,'plan.json')));plan.target.directory='/fixture/media/'+id;saveMediaReceipt(folder,'plan.json',plan);saveMediaReceipt(folder,'progress.json',{phase:'qualified_returned'});saveMediaReceipt(folder,'readmission.json',{state:'readmitted'});saveMediaReceipt(folder,'completion.json',{state:'qualified_returned',preparation:fresh,proof:{state:'qualified_stopped',engines:{'ace-step':{container:engine.container,image:engine.image,outputs:{state:'ready'},decoded:[{full_decode:true,streams:[{codec_type:'audio'}]}]}}}});}
 return {service,config,baseline,store,workers,options,fresh,directory,complete,launches:()=>launches,allow:v=>allowed=v,enable:v=>enabled=v};
}
test('setup choices and capability gate new starts; repeated request never launches again',async t=>{
 const f=fixture(t),input={worker_id:'one',engine:'ace-step'};f.allow(false);await assert.rejects(f.service.start(input),/Allow this engine/);f.allow(true);f.enable(false);await assert.rejects(f.service.start(input),/switched off/);f.enable(true);
 const row=await f.service.start(input);f.enable(false);assert.equal((await f.service.start(input)).operation_id,row.operation_id);assert.equal(f.launches(),1);
 assert.equal(f.store.data.media_host_eligibility.one.video,false);assert.deepEqual(f.store.data.other,{keep:true});assert.ok(fs.existsSync(path.join(f.options.directory,row.operation_id,'recipe-bundle.json')));
});
test('named Docker inspection enrollment offers setup without rewriting the installation reference',async t=>{
 const f=fixture(t);f.config.genie_chat.inspection.workers.one.container='qwen-serving';
 assert.equal(f.service.status().hosts[0].available,true);
 const row=await f.service.start({worker_id:'one',engine:'ace-step'});
 const plan=JSON.parse(fs.readFileSync(path.join(f.options.directory,row.operation_id,'plan.json')));
 assert.equal(plan.llm_container,'qwen-serving');assert.equal(f.launches(),1);
 assert.equal(f.config.genie_chat.inspection.workers.one.container,'qwen-serving');
});
test('finished proof adds only the selected engine and survives restart with choices intact',async t=>{
 const f=fixture(t),row=await f.service.start({worker_id:'one',engine:'ace-step'});f.complete(row.operation_id);f.enable(false);
 assert.equal((await f.service.finish({operation_id:row.operation_id})).phase,'enrolled');assert.equal(f.config.media_jobs.workers.one.engines.music.container,'b'.repeat(64));assert.deepEqual(f.config.media_jobs.workers.one.engines.video,f.baseline.media_jobs.workers.one.engines.video);
 const restart=structuredClone(f.baseline),again=createMediaSetup(restart,f.store,f.options);assert.equal(restart.media_jobs.workers.one.engines.music.container,'b'.repeat(64));assert.equal(again.status().operations[0].phase,'enrolled');assert.equal(f.store.data.media_host_eligibility.one.video,false);assert.equal(f.store.data.other.keep,true);
 assert.ok(fs.readdirSync(f.directory).some(n=>n.includes('.media-setup-')));
});
test('completion rejects changed media, mismatched return binding and incomplete native proof',async t=>{
 for(const which of ['media','binding','proof']){
  const f=fixture(t),row=await f.service.start({worker_id:'one',engine:'ace-step'});f.complete(row.operation_id);
  if(which==='media')f.fresh.engines['ace-step'].inspection.Config.Cmd=['different'];
  if(which==='binding')f.workers[0].url='http://127.0.0.1:39999';
  if(which==='proof'){const file=path.join(f.options.directory,row.operation_id,'completion.json'),proof=JSON.parse(fs.readFileSync(file));proof.proof.engines['ace-step'].decoded=[];fs.writeFileSync(file,JSON.stringify(proof));}
  await assert.rejects(f.service.finish({operation_id:row.operation_id}));assert.equal(f.config.media_jobs.workers.one.engines.music,undefined);assert.equal(f.store.data.media_engine_enrollments,undefined);
 }
});
test('existing engines are never replaced, and stale saved additions are reported without blocking the gateway',async t=>{
 const f=fixture(t);await assert.rejects(f.service.start({worker_id:'one',engine:'h3'}),/already enrolled/);
 const row=await f.service.start({worker_id:'one',engine:'ace-step'});f.complete(row.operation_id);await f.service.finish({operation_id:row.operation_id});f.workers[0].url='http://127.0.0.1:39999';
 const config=structuredClone(f.baseline),service=createMediaSetup(config,f.store,f.options);assert.equal(config.media_jobs.workers.one.engines.music,undefined);assert.match(service.status().hosts[0].error,/binding changed/);assert.ok(f.store.data.media_engine_enrollments.one);
});
test('lost launch acknowledgement remains visible and is never retried',async t=>{
 const f=fixture(t);let launches=0;const service=createMediaSetup(f.config,f.store,{...f.options,launchRunner:async()=>{launches++;throw Error('lost acknowledgement');}});
 await assert.rejects(service.start({worker_id:'one',engine:'ace-step'}));assert.equal((await service.start({worker_id:'one',engine:'ace-step'})).phase,'needs_attention');assert.equal(launches,1);
});
test('retained media survives LLM and tunnel updates on the same machine, but not a replacement or removed worker',async t=>{
 const f=fixture(t);f.config.recovery.workers[0].machine='1'.repeat(64);
 const row=await f.service.start({worker_id:'one',engine:'ace-step'});f.complete(row.operation_id);await f.service.finish({operation_id:row.operation_id});
 const upgraded=structuredClone(f.baseline);upgraded.recovery.workers[0].machine='1'.repeat(64);upgraded.recovery.workers[0].profile='upgraded-profile';upgraded.genie_chat.inspection.workers.one.container='2'.repeat(64);f.workers[0].url='http://127.0.0.1:39999';
 const same=createMediaSetup(upgraded,f.store,f.options);assert.equal(upgraded.media_jobs.workers.one.engines.music.container,'b'.repeat(64));assert.equal(same.status().hosts[0].error,null);
 const replaced=structuredClone(f.baseline);replaced.recovery.workers[0].machine='3'.repeat(64);
 const other=createMediaSetup(replaced,f.store,f.options);assert.equal(replaced.media_jobs.workers.one.engines.music,undefined);assert.match(other.status().hosts[0].error,/physical-machine binding changed/);
 const removed=structuredClone(f.baseline);removed.recovery.workers[0].machine='1'.repeat(64);f.workers.length=0;createMediaSetup(removed,f.store,f.options);assert.equal(removed.media_jobs.workers.one.engines.music,undefined);
});
test('new enrollment never carries a previous machine engine into the new host binding',async t=>{
 const f=fixture(t);f.config.recovery.workers[0].machine='1'.repeat(64);
 f.store.save({...f.store.data,media_engine_enrollments:{one:{binding:'old-binding',host_binding:'9'.repeat(64),engines:{video:f.baseline.media_jobs.workers.one.engines.video}}}});
 const row=await f.service.start({worker_id:'one',engine:'ace-step'});f.complete(row.operation_id);await f.service.finish({operation_id:row.operation_id});
 assert.deepEqual(Object.keys(f.store.data.media_engine_enrollments.one.engines),['music']);
 assert.deepEqual(f.config.media_jobs.workers.one.engines.video,f.baseline.media_jobs.workers.one.engines.video);
 const backups=fs.readdirSync(f.directory).filter(n=>n.includes('.media-setup-')).map(n=>JSON.parse(fs.readFileSync(path.join(f.directory,n))));assert.ok(backups.some(b=>b.media_engine_enrollments?.one?.engines.video));
});
test('legacy enrollment requires its original exact binding and is not silently migrated',async t=>{
 const f=fixture(t),row=await f.service.start({worker_id:'one',engine:'ace-step'});f.complete(row.operation_id);await f.service.finish({operation_id:row.operation_id});
 delete f.store.data.media_engine_enrollments.one.host_binding;
 const unchanged=structuredClone(f.baseline);createMediaSetup(unchanged,f.store,f.options);assert.equal(unchanged.media_jobs.workers.one.engines.music.container,'b'.repeat(64));
 const changed=structuredClone(f.baseline);changed.recovery.workers[0].profile='different';const service=createMediaSetup(changed,f.store,f.options);assert.equal(changed.media_jobs.workers.one.engines.music,undefined);assert.ok(service.status().hosts[0].error);assert.equal(f.store.data.media_engine_enrollments.one.host_binding,undefined);
});
test('real core exposes setup status on its private socket and refuses unenrolled machines without changing inference',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sg-setup-core-'));
 const native=http.createServer((req,res)=>res.end(JSON.stringify({data:[{id:'fixture',context_length:262144}]})));native.listen(0,'127.0.0.1');await once(native,'listening');
 const config={host:'127.0.0.1',port:0,api_key:'fixture-key',model:'fixture',context_length:262144,state_file:path.join(dir,'state.json'),control_socket:path.join(dir,'control.sock'),health_interval_ms:100000,media_jobs:{enabled:true},nodes:[{id:'one',url:`http://127.0.0.1:${native.address().port}`}]};
 const gateway=createGateway(config),address=await gateway.start();t.after(async()=>{await gateway.close();native.closeAllConnections();native.close();fs.rmSync(dir,{recursive:true,force:true});});
 const state=await workerControl(config.control_socket,'/media-jobs');assert.equal(state.setup.connected,true);assert.equal(state.setup.hosts[0].available,false);
 await workerControl(config.control_socket,'/media-host-eligibility',{worker_id:'one',kind:'music',allowed:true});
 await assert.rejects(workerControl(config.control_socket,'/genie-media-setup',{worker_id:'one',engine:'ace-step'}),/switched off/);
 await workerControl(config.control_socket,'/genie-capability',{key:'media',enabled:true});
 await assert.rejects(workerControl(config.control_socket,'/genie-media-setup',{worker_id:'one',engine:'ace-step'}),/matching Docker/);
 const publicAttempt=await fetch(`http://127.0.0.1:${address.port}/genie-media-setup`,{method:'POST',headers:{authorization:'Bearer fixture-key','content-type':'application/json'},body:JSON.stringify({worker_id:'one',engine:'ace-step'})});assert.equal(publicAttempt.status,404);
 assert.equal((await workerControl(config.control_socket,'/workers')).workers[0].drained,false);assert.equal((await workerControl(config.control_socket,'/media-jobs')).setup.operations.length,0);
});

test('explicit GLM pair enrollment prepares media without pretending to be a single Qwen recovery',async t=>{
 const f=fixture(t),w=f.workers[0];f.config.recovery.workers=[];
 const pair={kind:'glm53-docker-pair',model:'GLM',worker_binding:{id:w.id,url:w.url,ssh:w.ssh},members:[{ssh:'fixture-host',container:'a'.repeat(64)},{ssh:'fixture-rank',container:'rank'}]};
 f.config.media_jobs.pairs={one:pair};
 const service=createMediaSetup(f.config,f.store,{...f.options,binding:()=>false});assert.equal(service.status().hosts[0].available,true);
 const row=await service.start({worker_id:'one',engine:'ace-step'}),plan=JSON.parse(fs.readFileSync(path.join(f.options.directory,row.operation_id,'plan.json')));
 assert.deepEqual(plan.llm_pair,{...pair,media_member:0});assert.equal(plan.recovery.profile,'glm53-docker-pair');assert.equal(plan.endpoint.url,w.url);assert.deepEqual(f.config.recovery.workers,[]);
 f.workers[0].url='http://changed';assert.equal(service.status().hosts[0].available,false);
});

test('paired setup assigns ACE to rank and saves its host member with native qualification',async t=>{
 const f=fixture(t),w=f.workers[0];f.config.recovery.workers=[];
 f.config.media_jobs.pairs={one:{kind:'glm53-docker-pair',model:'GLM',worker_binding:{id:w.id,url:w.url,ssh:w.ssh},members:[{ssh:'fixture-host',container:'a'.repeat(64)},{ssh:'fixture-rank',container:'rank'}],engine_members:{music:1,video:0}}};
 const service=createMediaSetup(f.config,f.store,f.options),row=await service.start({worker_id:'one',engine:'ace-step'});
 const plan=JSON.parse(fs.readFileSync(path.join(f.options.directory,row.operation_id,'plan.json')));assert.equal(plan.target.ssh,'fixture-rank');assert.equal(plan.llm_container,'rank');assert.equal(plan.llm_pair.media_member,1);
 f.complete(row.operation_id);await service.finish({operation_id:row.operation_id});assert.equal(f.config.media_jobs.workers.one.engines.music.member,1);
 const again=createMediaSetup(f.config,f.store,f.options);assert.equal(again.status().hosts[0].error,null);
});

test('each physical member can qualify the same engine without replacing the default or replaying work',async t=>{
 const f=fixture(t),w=f.workers[0];f.config.recovery.workers=[];
 f.config.media_jobs.pairs={one:{kind:'glm53-docker-pair',model:'GLM',worker_binding:{id:w.id,url:w.url,ssh:w.ssh},members:[{ssh:'fixture-host',container:'a'.repeat(64)},{ssh:'fixture-rank',container:'rank'}],engine_members:{music:1,video:0}}};
 const baseline=structuredClone(f.config),service=createMediaSetup(f.config,f.store,f.options);
 const first=await service.start({worker_id:'one',engine:'ace-step',member:0});
 await assert.rejects(service.start({worker_id:'one',engine:'ace-step',member:1}),/already owns/);
 f.complete(first.operation_id);await service.finish({operation_id:first.operation_id});
 assert.equal(f.config.media_jobs.workers.one.engines.music.member,0);
 const second=await service.start({worker_id:'one',engine:'ace-step',member:1});
 assert.notEqual(second.operation_id,first.operation_id);
 const plan=JSON.parse(fs.readFileSync(path.join(f.options.directory,second.operation_id,'plan.json')));assert.equal(plan.target.ssh,'fixture-rank');
 f.complete(second.operation_id);await service.finish({operation_id:second.operation_id});
 assert.equal(f.config.media_jobs.workers.one.engines.music.member,0,'First default remains intact');
 assert.equal(f.config.media_jobs.workers.one.member_engines[1].music.member,1);
 for(const member of [0,1])assert.equal((await service.start({worker_id:'one',engine:'ace-step',member})).phase,'enrolled');
 assert.equal(f.launches(),2);
 const restarted=createMediaSetup(baseline,f.store,f.options);assert.equal(restarted.status().hosts[0].error,null);
 for(const member of [0,1])assert.equal(baseline.media_jobs.workers.one.member_engines[member].music.member,member);
 await assert.rejects(service.start({worker_id:'one',engine:'h3',member:2}));
});

test('retained preparation is pinned to its exact engine and still requires native proof',async t=>{
 const f=fixture(t),e=f.fresh.engines['ace-step'];
 f.config.media_jobs.reuse={one:{0:{'ace-step':{directory:'/retained/setup',...Object.fromEntries(['container','image','kind','port'].map(k=>[k,e[k]]))}}}};
 const reuse=mediaReuse(f.config,'one','ace-step');assert.equal(reuse.directory,'/retained/setup');
 const service=createMediaSetup(f.config,f.store,f.options),row=await service.start({worker_id:'one',engine:'ace-step'});
 const file=path.join(f.options.directory,row.operation_id,'plan.json'),plan=JSON.parse(fs.readFileSync(file));assert.equal(plan.target.directory,reuse.directory);assert.equal(plan.reuse.container,e.container);
 assert.equal(f.config.media_jobs.workers.one.engines.music,undefined,'A retained container is not qualification');
 const source={...f.fresh,state:'prepared_stopped',llm_container:'9'.repeat(64)},selected=selectedMediaPreparation(source,{...reuse,llm_container:'a'.repeat(64)});
 assert.equal(selected.llm_container,'a'.repeat(64));assert.equal(source.llm_container,'9'.repeat(64));assert.equal(selected.source_llm_container,source.llm_container);
 assert.throws(()=>selectedMediaPreparation(source,{...reuse,container:'0'.repeat(64),llm_container:'a'.repeat(64)}),/changed/);
 assert.throws(()=>selectedMediaPreparation(source,{...reuse,llm_container:'name'}));
 f.complete(row.operation_id);
 // A source-preparation or current return-binding change still blocks enrollment.
 f.config.media_jobs.reuse.one[0]['ace-step'].image='sha256:'+'0'.repeat(64);
 await assert.rejects(service.finish({operation_id:row.operation_id}),/binding changed/);
});

 test('retry archives only a confirmed pre-maintenance failure under the same operation ID',async t=>{
  const f=fixture(t),input={worker_id:'one',engine:'ace-step'},row=await f.service.start(input),folder=path.join(f.options.directory,row.operation_id),at='2026-01-01T01:02:03.000Z';
  saveMediaReceipt(folder,'progress.json',{phase:'failed_unchanged',at,detail:'Retained original LLM no longer exists'});
  assert.equal((await f.service.start(input)).phase,'failed_unchanged');assert.equal(f.launches(),1);
  await assert.rejects(f.service.start({...input,expected_failed_at:'2026-01-01T01:02:04.000Z'}),/current confirmed/);
  await assert.rejects(f.service.start({...input,expected_failed_at:at}),/may still be active/);
  saveMediaReceipt(folder,'launched.json',{pid:2147483647});fs.mkdirSync(path.join(folder,'gateway'));
  fs.writeFileSync(path.join(folder,'gateway/acquire.intent.json'),'{}');
  await assert.rejects(f.service.start({...input,expected_failed_at:at}),/past read-only preflight/);assert.equal(f.launches(),1);
  fs.unlinkSync(path.join(folder,'gateway/acquire.intent.json'));
  const next=await f.service.start({...input,expected_failed_at:at});assert.equal(next.operation_id,row.operation_id);assert.equal(next.attempt,2);assert.equal(f.launches(),2);
  const old=JSON.parse(fs.readFileSync(path.join(f.options.directory,'history',row.operation_id,'attempt-1','progress.json')));assert.equal(old.at,at);assert.equal(old.phase,'failed_unchanged');
  await assert.rejects(f.service.start({...input,expected_failed_at:at}),/current confirmed/);assert.equal(f.launches(),2);
 });
 test('retained directory requests pin the current LLM while preserving the old LLM provenance',()=>{
  const reuse={engine:'ace-step',directory:'/retained',llm_container:'a'.repeat(64),container:'b'.repeat(64),image:'sha256:'+'c'.repeat(64),kind:'ace-step',port:8002};
  assert.deepEqual(mediaPreparationRequest(reuse,false),{action:'retained_media',engine:'ace-step',llm_container:reuse.llm_container,require_idle:false});
  const current={state:'prepared_stopped',llm_container:reuse.llm_container,source_llm_container:'old-removed-llm',engines:{'ace-step':reuse}};
  assert.equal(selectedMediaPreparation(current,reuse).source_llm_container,'old-removed-llm');
 });

test('corrected reuse selection can retry unchanged preflight only, with every other binding preserved',async t=>{
 for(const changed of ['candidate','fresh','route','other-engine','intent','runner']){
  const f=fixture(t),e=f.fresh.engines['ace-step'];
  f.config.media_jobs.reuse={one:{0:{'ace-step':{directory:'/retained',...Object.fromEntries(['container','image','kind','port'].map(k=>[k,e[k]]))},h3:null}}};
  const service=createMediaSetup(f.config,f.store,f.options),input={worker_id:'one',engine:'ace-step'},first=await service.start(input),folder=path.join(f.options.directory,first.operation_id),at='2026-01-01T00:00:00.000Z';
  saveMediaReceipt(folder,'progress.json',{phase:'failed_unchanged',at});saveMediaReceipt(folder,'launched.json',{pid:2147483647});
  f.config.media_jobs.reuse.one[0]['ace-step']=changed==='fresh'?null:{source:'docker',container:'8'.repeat(64),image:'sha256:'+'9'.repeat(64),kind:'ace-step',port:8002};
  if(changed==='route')f.workers[0].url='http://changed';
  if(changed==='other-engine')f.config.media_jobs.reuse.one[0].h3={source:'docker'};
  if(changed==='intent')saveMediaReceipt(folder,'prepare-intent.json',{});
  if(changed==='runner')saveMediaReceipt(folder,'launched.json',{pid:process.pid});
  const ready=service.status().operations[0].retry_ready===true;
  if(['candidate','fresh'].includes(changed)){
   assert.equal(ready,true);const next=await service.start({...input,expected_failed_at:at});assert.equal(next.operation_id,first.operation_id);assert.equal(next.attempt,2);
   assert.ok(fs.existsSync(path.join(f.options.directory,'history',first.operation_id,'attempt-1','plan.json')));
  }else {assert.equal(ready,false);await assert.rejects(service.start({...input,expected_failed_at:at}));assert.equal(f.launches(),1);}
 }
});

test('unchanged failures identify media separately from the inspected current LLM',async t=>{
 const f=fixture(t),e=f.fresh.engines['ace-step'];f.config.media_jobs.reuse={one:{0:{'ace-step':{source:'docker',...Object.fromEntries(['container','image','kind','port'].map(k=>[k,e[k]]))}}}};
 const row=await f.service.start({worker_id:'one',engine:'ace-step'}),folder=path.join(f.options.directory,row.operation_id);
 saveMediaReceipt(folder,'progress.json',{phase:'failed_unchanged',at:'2026-01-01T00:00:00Z'});saveMediaReceipt(folder,'llm-resolution.json',{container:'a'.repeat(64)});
 const evidence=f.service.status().operations[0].failure_context;assert.equal(evidence.current_llm_container,'a'.repeat(64));assert.equal(evidence.selected_media_container,'b'.repeat(64));assert.equal(evidence.llm_stop_started,false);
 saveMediaReceipt(folder,'prepare-intent.json',{});assert.equal(f.service.status().operations[0].failure_context,undefined);
});
