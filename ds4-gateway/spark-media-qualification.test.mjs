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
