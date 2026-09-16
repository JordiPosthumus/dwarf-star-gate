import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createSparkMediaQualification} from './spark-media-qualification.mjs';
test('first-host qualification needs no existing gateway fleet and never repeats an accepted operation',async t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'sg-media-qualify-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));let launched=0,read=0;
 const service=createSparkMediaQualification({directory,transport:async()=>{read++;return {state:'prepared_stopped'};},launchRunner:async()=>{launched++;return {pid:process.pid};}});
 assert.equal((await service.start('new-spark',{})).state,'running');await service.start('new-spark',{});assert.equal(launched,1);assert.equal(read,1);
 fs.writeFileSync(path.join(directory,'new-spark/progress.json'),JSON.stringify({state:'qualified_stopped'}));assert.equal(service.read('new-spark').state,'qualified_stopped');
});
test('uncertain launch is visible and never automatically relaunched',async t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'sg-media-qualify-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));let launched=0;
 const service=createSparkMediaQualification({directory,transport:async()=>({state:'prepared_stopped'}),launchRunner:async()=>{launched++;throw Error('ack lost');}});
 await assert.rejects(service.start('new-spark',{}),/ack lost/);assert.equal(service.read('new-spark').state,'needs_attention');await service.start('new-spark',{});assert.equal(launched,1);
});
test('enrollment requires completed native files and unchanged target, LLM and media identities',async t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'sg-media-enroll-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const target={ssh:'new-spark',directory:'/srv/setup'},folder=path.join(directory,'new-spark');fs.mkdirSync(folder);
 const engines=Object.fromEntries([['h3','comfyui',8188],['ace-step','ace-step',8002]].map(([key,kind,port])=>[key,{container:key,image:'sha256:'+key,kind,port,inspection:{Id:key,Image:'sha256:'+key,Config:{Cmd:['serve']},HostConfig:{},Mounts:[]}}]));
 const preparation={llm_container:'llm',engines};
 fs.writeFileSync(path.join(folder,'plan.json'),JSON.stringify({target,preparation}));
 const result={state:'qualified_stopped',engines:Object.fromEntries(Object.entries(engines).map(([key,e])=>[key,{container:e.container,image:e.image,outputs:{state:'ready'},decoded:[{full_decode:true,streams:[{codec_type:'audio'},...(key==='h3'?[{codec_type:'video'}]:[])]}]}]))};
 fs.writeFileSync(path.join(folder,'progress.json'),JSON.stringify(result));
 const service=createSparkMediaQualification({directory,transport:async(_target,input)=>{assert.equal(input.action,'media_state');return structuredClone(preparation);}});
 assert.deepEqual(Object.keys(await service.enrollment('new-spark',target,'llm')),['video','music']);
 await assert.rejects(service.enrollment('new-spark',target,'different'),/different LLM/);
 await assert.rejects(service.enrollment('new-spark',{...target,ssh:'other'},'llm'));
 preparation.engines.h3.inspection.Config.Cmd.push('--different');await assert.rejects(service.enrollment('new-spark',target,'llm'),/configuration changed/);preparation.engines.h3.inspection.Config.Cmd.pop();
 result.engines.h3.decoded[0].full_decode=false;fs.writeFileSync(path.join(folder,'progress.json'),JSON.stringify(result));await assert.rejects(service.enrollment('new-spark',target,'llm'));
});
