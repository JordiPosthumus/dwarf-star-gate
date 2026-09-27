import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {SparkAccessWatch} from './spark-access-watch.mjs';
import {GenieChat} from './genie-chat.mjs';
function fixture(t){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'sg-access-watch-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const id=randomUUID(),state={enabled:true,busy:false,op:{access_id:id,state:'authorized',authorization_generation:1,credential_available:true,endpoints:[{state:'pending'}]}};
  const event={tool:'request_spark_access',state:'complete',at:new Date().toISOString(),result:{access_id:id,state:'credentials_required',authorization_generation:0}};
  const message={role:'assistant',spark_setup:{events:[event]}},conversation={id:'original',messages:[message]},calls=[];
  const summary={available:true,conversations:[{id:'original',busy:false,queued:0}]};
  const chat={status:()=>summary,get:()=>conversation,submit:(...args)=>calls.push(args)};
  const options={filename:path.join(directory,'watch.json'),chat,access:{status:input=>input?structuredClone(state.op):{busy:state.busy}},isEnabled:()=>state.enabled};
  return {directory,id,state,event,message,conversation,summary,calls,options,watch:new SparkAccessWatch(options)};
}
test('a local grant wakes the original conversation once with a durable accepted-length ID',async t=>{
  const f=fixture(t);await f.watch.tick();assert.equal(f.calls.length,1);assert.equal(f.calls[0][0],'original');assert.match(f.calls[0][1],new RegExp(f.id));assert.match(f.calls[0][1],/original owner request authorized onboarding/);assert.ok(f.calls[0][2].length<=80);
  await new SparkAccessWatch(f.options).tick();assert.equal(f.calls.length,1);
  f.state.op.authorization_generation++;await f.watch.tick();assert.equal(f.calls.length,2);assert.notEqual(f.calls[0][2],f.calls[1][2]);
});
test('ungranted, busy, paused, stopped or disabled work does not wake Genie',async t=>{
  for(const patch of [f=>f.state.op.authorization_generation=0,f=>f.state.busy=true,f=>f.state.enabled=false,f=>f.summary.available=false,f=>f.summary.conversations[0].busy=true,f=>f.summary.conversations[0].queued=1,f=>f.summary.conversations[0].queue_paused=true,f=>f.message.stop_requested_at='stopped']){
    const f=fixture(t);patch(f);await f.watch.tick();assert.equal(f.calls.length,0);
  }
});
test('terminal access outcome is reported once, retains original scope and does not reissue key work',async t=>{
  const f=fixture(t);await f.watch.tick();f.state.op={...f.state.op,state:'verification_pending',credential_available:false,endpoints:[{state:'verification_pending'}]};
  await f.watch.tick();assert.equal(f.calls.length,2);assert.match(f.calls[1][1],/without automatically replaying a key write/);
  await new SparkAccessWatch(f.options).tick();assert.equal(f.calls.length,2);
});
test('an outcome already read in the original answer produces no duplicate report',async t=>{
  const f=fixture(t);f.state.op.state='complete';f.state.op.credential_available=false;f.state.op.endpoints=[{state:'key_ready'}];
  f.message.spark_setup.events.push({tool:'spark_access_status',state:'complete',result:structuredClone(f.state.op)});
  await f.watch.tick();assert.equal(f.calls.length,0);
});
test('uncertain submission retries the same saved ID, while a later owner stop prevents retry',async t=>{
  const f=fixture(t);f.options.chat.submit=(...args)=>{f.calls.push(args);throw Error('unconfirmed acknowledgement');};
  await f.watch.tick();await new SparkAccessWatch(f.options).tick();assert.equal(f.calls.length,2);assert.equal(f.calls[0][2],f.calls[1][2]);
  f.message.stop_requested_at='stopped';await new SparkAccessWatch(f.options).tick();assert.equal(f.calls.length,2);
});
test('real GenieChat persists the request and accepts grant/result follow-ups without duplicate generations',async t=>{
  const f=fixture(t);let generations=0;
  const chat=new GenieChat({directory:path.join(f.directory,'chat'),provider:{info:{mode:'fixture'},generate:async input=>{
    generations++;
    input.onSparkSetup(generations===1?f.event:{tool:'spark_access_status',state:'complete',at:new Date().toISOString(),result:structuredClone(f.state.op)});
    return {text:generations===1?'Use the local credential form.':'Read the saved access status.'};
  }}});t.after(()=>chat.close());
  const conversation=chat.create();chat.submit(conversation.id,'Find and add my new Sparks.','access-fixture-owner');await chat.idle();
  const options={...f.options,chat},watch=new SparkAccessWatch(options);await watch.tick();await chat.idle();assert.equal(generations,2);
  f.state.op.state='complete';f.state.op.credential_available=false;f.state.op.endpoints=[{state:'key_ready'}];
  await watch.tick();await chat.idle();await new SparkAccessWatch(options).tick();await chat.idle();assert.equal(generations,3);
  assert.equal(chat.get(conversation.id).messages.length,6);
});
