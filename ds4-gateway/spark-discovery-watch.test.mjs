import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {SparkDiscoveryWatch} from './spark-discovery-watch.mjs';
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
  assert.equal(restored.records[requestId].state,'dispatched');
  f.message.spark_setup.events.push({tool:'spark_discovery_status',state:'complete',result:f.state.result});
  await restored.tick();assert.equal(restored.records[requestId].state,'observed');
});
test('running, absent and mismatched scan results never claim completion',async t=>{
  for(const result of [null,{state:'running',scan_id:scan},{state:'complete',scan_id:'other'},{state:'unavailable',scan_id:scan}]){
    const f=fixture(t);f.state.result=result;await f.watch.tick();assert.equal(f.calls.length,0);
  }
});
test('failed and lost observation produce one report without rescanning',async t=>{
  for(const state of ['failed','observation_lost']){const f=fixture(t);f.state.result.state=state;await f.watch.tick();assert.equal(f.calls.length,1);assert.match(f.calls[0][1],new RegExp(state));}
});
test('disabled setup, unavailable chat, active work, pause and owner stop prevent automatic follow-up',async t=>{
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
