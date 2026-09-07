import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {setImmediate as turn} from 'node:timers/promises';
import {QueuedBodyBudget,QueuedRequestBody} from './queued-request-body.mjs';

async function bytes(stream){const chunks=[];for await(const chunk of stream)chunks.push(chunk);return Buffer.concat(chunks);}

test('complete queued JSON is visible before dispatch and forwarded byte for byte once',async()=>{
  const req=new PassThrough(),budget=new QueuedBodyBudget(1024),seen=[];
  const body=Buffer.from(' { "messages": [{"role":"user","content":"Repair café export ☕"}] }\n');
  const queue=new QueuedRequestBody(req,{budget,limit:1024,onBody:x=>seen.push(x)});
  for(let i=0;i<body.length;i+=3)req.write(body.subarray(i,i+3));req.end();await turn();
  assert.equal(seen.length,1);assert.equal(seen[0].messages[0].content,'Repair café export ☕');
  assert.equal(budget.used,body.length);assert.deepEqual(await bytes(queue.stream()),body);assert.equal(budget.used,0);
});

test('dispatch does not wait for upload completion and switches from prefix to live streaming',async()=>{
  const req=new PassThrough(),budget=new QueuedBodyBudget(1024),seen=[];
  const queue=new QueuedRequestBody(req,{budget,onBody:x=>seen.push(x)});
  req.write('first');await turn();const output=queue.stream();const received=[];
  output.on('data',chunk=>received.push(chunk));await turn();
  assert.equal(Buffer.concat(received).toString(),'first');assert.equal(req.writableEnded,false);
  req.end(' second');await new Promise((resolve,reject)=>{output.once('end',resolve);output.once('error',reject);});
  assert.equal(Buffer.concat(received).toString(),'first second');assert.equal(seen.length,0);assert.equal(budget.used,0);
});

test('read-ahead cap and shared budget apply backpressure without truncating oversized uploads',async()=>{
  const budget=new QueuedBodyBudget(32),requests=[new PassThrough(),new PassThrough()],seen=[];
  const queues=requests.map(req=>new QueuedRequestBody(req,{budget,limit:24,onBody:x=>seen.push(x)}));
  const bodies=[Buffer.alloc(128,65),Buffer.alloc(96,66)];requests.forEach((req,i)=>req.end(bodies[i]));await turn();
  assert.equal(budget.used,32);assert.ok(queues.every(q=>q.bytes<=24));
  assert.deepEqual(await bytes(queues[0].stream()),bodies[0]);await turn();
  assert.equal(queues[1].bytes,24);assert.deepEqual(await bytes(queues[1].stream()),bodies[1]);
  assert.equal(budget.used,0);assert.equal(seen.length,0);
});

test('cancelled queued bodies release memory and waiting readers resume without dispatch',async()=>{
  const budget=new QueuedBodyBudget(16),one=new PassThrough(),two=new PassThrough();let observed=0;
  const a=new QueuedRequestBody(one,{budget,limit:16,onBody:()=>assert.fail('cancelled body inspected')});
  one.write('x'.repeat(16));await turn();
  const b=new QueuedRequestBody(two,{budget,limit:16,onBody:()=>observed++});two.end('{"ok":true}');await turn();
  assert.equal(observed,0);a.dispose();await turn();assert.equal(observed,1);
  assert.equal(one.listenerCount('readable'),0);b.dispose();assert.equal(budget.used,0);one.destroy();two.destroy();
});

test('dispatch preserves downstream backpressure and bounded buffering',async()=>{
  const req=new PassThrough({highWaterMark:1024}),budget=new QueuedBodyBudget(4096);
  const queue=new QueuedRequestBody(req,{budget,limit:4096});
  req.write(Buffer.alloc(128*1024,67));await turn();const output=queue.stream();
  output.read(0);await turn();const remaining=req.readableLength;
  assert.ok(remaining>0,'unconsumed upload stays backpressured');await turn();assert.equal(req.readableLength,remaining);
  req.end();assert.equal((await bytes(output)).length,128*1024);assert.equal(budget.used,0);
});

test('a complete body exactly at the observation limit is inspected without waiting for dispatch',async()=>{
  const req=new PassThrough(),body=Buffer.from('{"task":"exact boundary"}'),budget=new QueuedBodyBudget(body.length);let seen;
  const queue=new QueuedRequestBody(req,{budget,limit:body.length,onBody:x=>{seen=x;}});
  req.end(body);await turn();assert.equal(seen.task,'exact boundary');
  assert.deepEqual(await bytes(queue.stream()),body);assert.equal(budget.used,0);
});

test('opt-out stops early reads and parsing but preserves an already consumed prefix',async()=>{
  const req=new PassThrough(),budget=new QueuedBodyBudget(1024);
  const queue=new QueuedRequestBody(req,{budget,onBody:()=>assert.fail('opted-out body inspected')});
  req.write('{"task":');await turn();const prefix=budget.used;queue.stopInspection();
  req.end('"private"}');await turn();assert.equal(budget.used,prefix);
  assert.equal((await bytes(queue.stream())).toString(),'{"task":"private"}');assert.equal(budget.used,0);
});
