import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createPairPreparation} from './recovery-pair-preparation.mjs';
import {createRecoveryTools} from './genie-recovery.mjs';

function fixture(t){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'pair-prepare-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const worker={id:'custom-pair',url:'http://192.0.2.10:8888/v1',backend:'openai',context_length:400000,max_concurrent_requests:2,is_healthy:true};
  const config={state_file:path.join(directory,'state.json'),genie_chat:{python:'/usr/bin/python3',inspection:{workers:{'custom-pair':{ssh:['head'],container:'head-container'}}}},
    media_jobs:{pairs:{'custom-pair':{kind:'glm53-docker-pair',model:'fixture-model',worker_binding:{id:worker.id,url:worker.url},members:[{ssh:'head',container:'head-container',recipe_root:'/fixture/recipe'},{ssh:'rank',container:'rank-container'}]}}}};
  const calls=[];const spawnFn=(python,args,options)=>{calls.push({python,args,options});return {on(){},unref(){}};};
  const inspect=async folder=>({state:'prepared',worker_id:worker.id,action_id:path.basename(folder),members:2,private_host:'hidden',enrollment:{secret:'hidden'}});
  const make=()=>createPairPreparation({config,readWorkers:async()=>({workers:[worker]}),spawnFn,inspect});
  return {directory,worker,config,calls,make};
}

test('preparation uses configured pair targets, preserves direct route and dispatches once across reconstruction',async t=>{
  const f=fixture(t),p=f.make(),input={worker_id:f.worker.id,action_id:randomUUID()};
  assert.equal((await p.prepare(input)).state,'submitted');assert.equal(f.calls.length,1);
  const call=f.calls[0];assert.equal(call.options.detached,true);assert.equal(call.options.shell,false);
  assert.deepEqual(call.args.slice(0,2),['-I','-B']);
  const request=JSON.parse(fs.readFileSync(path.join(call.args.at(-1),'request.json'),'utf8'));
  assert.equal(request.binding.port,8888);assert.equal(request.binding.context_length,400000);assert.equal(request.binding.concurrency,2);
  assert.equal(request.binding.members[1].recipe_root,null);assert.equal(request.route.url,f.worker.url);
  assert.equal((await f.make().prepare(input)).state,'prepared');assert.equal(f.calls.length,1);
  await assert.rejects(p.prepare({...input,worker_id:'other'}),/another worker/);
  const status=await p.status();assert.equal(status.length,1);assert.equal(status[0].members,2);assert.equal(status[0].enrollment,undefined);assert.equal(status[0].private_host,undefined);
});

test('unregistered pair, route drift and unsupported input cannot launch native capture',async t=>{
  const f=fixture(t),p=f.make();
  await assert.rejects(p.prepare({worker_id:f.worker.id,action_id:randomUUID(),ssh:'injected'}),/Specify/);
  await assert.rejects(p.prepare({worker_id:'unknown',action_id:randomUUID()}),/configured/);
  f.worker.url='http://192.0.2.11:8888/v1';await assert.rejects(p.prepare({worker_id:f.worker.id,action_id:randomUUID()}),/configured/);
  assert.equal(f.calls.length,0);
});

test('an unavailable optional capture interpreter does not prevent dashboard construction or empty status',async t=>{
  const f=fixture(t);f.config.genie_chat.python=path.join(f.directory,'missing-python');
  const p=f.make();assert.deepEqual(await p.status(),[]);
  await assert.rejects(p.prepare({worker_id:f.worker.id,action_id:randomUUID()}),/ENOENT/);assert.equal(f.calls.length,0);
  assert.deepEqual(await p.status(),[]);
});

test('Genie preparation respects inspection capability and testing without granting recovery mutation',async()=>{
  let enabled=true,testing=false,calls=0;
  const q=createRecoveryTools({read:async()=>({version:1,recovery:{workers:[],operations:[]}}),recover:()=>assert.fail('recovery invoked'),
    isEnabled:()=>false,isInspectionEnabled:()=>enabled,isTesting:()=>testing,
    preparation:{prepare:async input=>{calls++;return {...input,state:'submitted'};},status:async()=>[{state:'prepared'}]}});
  const input={action:'prepare-pair',worker_id:'pair',action_id:randomUUID()};
  assert.equal((await q.tool(input)).state,'submitted');enabled=false;await assert.rejects(q.tool(input),/inspection/);
  enabled=true;testing=true;await assert.rejects(q.tool(input),/suspended/);assert.equal(calls,1);
  assert.equal((await q.tool({action:'status'})).pair_preparations[0].state,'prepared');
});
