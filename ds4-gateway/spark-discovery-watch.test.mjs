import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {SparkDiscoveryWatch} from './spark-discovery-watch.mjs';
import {GenieChat} from './genie-chat.mjs';
const scan='11111111-1111-4111-8111-111111111111';
function fixture(t){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'sg-discovery-watch-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const message={role:'assistant',spark_setup:{events:[{tool:'discover_sparks',state:'complete',result:{state:'running',scan_id:scan}}]}};
  const conversation={id:'original',messages:[message]},calls=[];
  const summary={available:true,conversations:[{id:'original',busy:false,queued:0}]};
  const state={enabled:true,result:{state:'complete',scan_id:scan},reads:0};
  const chat={status:()=>summary,get:id=>{assert.equal(id,'original');return conversation;},submit:(...args)=>calls.push(args)};
  const options={filename:path.join(directory,'watch.json'),chat,isEnabled:()=>state.enabled,read:async id=>{assert.equal(id,scan);state.reads++;return state.result;}};
  return {options,state,summary,conversation,message,calls,watch:new SparkDiscoveryWatch(options)};
}
test('terminal discovery wakes the original chat once with a durable ID and exact scan read',async t=>{
  const f=fixture(t);await f.watch.tick();assert.equal(f.calls.length,1);
  const [id,text,requestId]=f.calls[0];assert.equal(id,'original');assert.match(text,new RegExp(scan));assert.match(text,/Do not start another scan/);
  await f.watch.tick();assert.equal(f.calls.length,1);
  const restored=new SparkDiscoveryWatch(f.options);await restored.tick();assert.equal(f.calls.length,1);
  assert.equal(Object.values(restored.records).find(r=>r.request_id===requestId).state,'dispatched');
  f.message.spark_setup.events.push({tool:'spark_discovery_status',state:'complete',result:f.state.result});
  await restored.tick();assert.equal(Object.values(restored.records).find(r=>r.request_id===requestId).state,'observed');
});
test('running, absent and mismatched scan results never claim completion',async t=>{
  for(const result of [null,{state:'running',scan_id:scan},{state:'complete',scan_id:'other'},{state:'unavailable',scan_id:scan}]){
    const f=fixture(t);f.state.result=result;await f.watch.tick();assert.equal(f.calls.length,0);
  }
});
test('failed and lost observation produce one report without rescanning',async t=>{
  for(const state of ['failed','observation_lost']){const f=fixture(t);f.state.result.state=state;await f.watch.tick();assert.equal(f.calls.length,1);assert.match(f.calls[0][1],new RegExp(state));}
});
test('disabled inspection, unavailable chat, active work, pause and owner stop prevent automatic follow-up',async t=>{
  const patches=[f=>f.state.enabled=false,f=>f.summary.available=false,f=>f.summary.conversations[0].busy=true,f=>f.summary.conversations[0].queued=1,f=>f.summary.conversations[0].queue_paused=true,f=>f.message.stop_requested_at='owner stopped'];
  for(const patch of patches){const f=fixture(t);patch(f);await f.watch.tick();assert.equal(f.calls.length,0);assert.equal(f.state.reads,0);}
});
test('owner stop arriving during receipt read is honored before submit',async t=>{
  const f=fixture(t);f.options.read=async()=>{f.message.stop_requested_at='owner stopped';return f.state.result;};
  await new SparkDiscoveryWatch(f.options).tick();assert.equal(f.calls.length,0);
});
test('uncertain submission reuses its durable request ID after restart',async t=>{
  const f=fixture(t),accepted=new Set();let attempts=0;
  f.options.chat.submit=(_id,_text,requestId)=>{attempts++;accepted.add(requestId);if(attempts===1)throw Error('acknowledgment lost');};
  await f.watch.tick();assert.equal(Object.values(f.watch.records)[0].state,'pending');
  const restored=new SparkDiscoveryWatch(f.options);await restored.tick();assert.equal(attempts,2);assert.equal(accepted.size,1);assert.equal(Object.values(restored.records)[0].state,'dispatched');
});
test('a scan already read to terminal in the originating answer gets no redundant follow-up',async t=>{
  const f=fixture(t);f.message.spark_setup.events.push({tool:'spark_discovery_status',state:'complete',result:f.state.result});
  await f.watch.tick();assert.equal(f.calls.length,0);assert.equal(f.state.reads,0);
});
test('the real Genie chat accepts the follow-up and records the exact scan without duplicate generations',async t=>{
  const f=fixture(t);let generations=0;
  const chat=new GenieChat({directory:path.join(path.dirname(f.options.filename),'chat'),provider:{info:{mode:'fixture'},generate:async input=>{
    generations++;input.onSparkSetup({tool:generations===1?'discover_sparks':'spark_discovery_status',state:'complete',at:new Date().toISOString(),result:{scan_id:scan,state:generations===1?'running':'complete'}});
    return {text:generations===1?'Discovery is running.':'Saved scan is complete; no enrollment occurred.'};
  }}});t.after(()=>chat.close());
  const conversation=chat.create();chat.submit(conversation.id,'Find the connected Sparks.','native-chat-fixture');await chat.idle();
  const options={...f.options,chat},watch=new SparkDiscoveryWatch(options);await watch.tick();await chat.idle();await watch.tick();
  assert.equal(generations,2);assert.equal(chat.get(conversation.id).messages.length,4);
  assert.equal(Object.values(watch.records)[0].state,'observed');assert.ok(Object.values(watch.records)[0].request_id.length<=80);
  await new SparkDiscoveryWatch(options).tick();await chat.idle();assert.equal(generations,2);
});
test('a legacy impossible pending ID is repaired while a valid uncertain ID stays unchanged',async t=>{
  const f=fixture(t);f.options.chat.submit=()=>{throw Error('not acknowledged');};await f.watch.tick();
  const [key,record]=Object.entries(f.watch.records)[0];record.request_id=key;assert.equal(key.length,81);f.watch.save();
  const accepted=[];f.options.chat.submit=(_id,_text,id)=>{assert.match(id,/^[a-zA-Z0-9-]{8,80}$/);accepted.push(id);throw Error('uncertain acknowledgment');};
  const repaired=new SparkDiscoveryWatch(f.options);await repaired.tick();const stable=accepted[0];assert.notEqual(stable,key);
  await new SparkDiscoveryWatch(f.options).tick();assert.deepEqual(accepted,[stable,stable]);
});
