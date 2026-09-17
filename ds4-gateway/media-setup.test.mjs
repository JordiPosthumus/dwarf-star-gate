import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createMediaSetup} from './media-setup.mjs';import {saveMediaReceipt} from './media-execution.mjs';
import http from 'node:http';import {once} from 'node:events';
import {createGateway} from './gateway.mjs';import {workerControl} from './worker-client.mjs';
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
