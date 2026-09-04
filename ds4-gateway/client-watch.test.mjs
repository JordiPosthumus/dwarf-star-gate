import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {test} from 'node:test';
import {ClientWatch,clientWatchForDisplay,validClientWatchId} from './client-watch.mjs';

const heartbeat=(watch_id,sequence=0,change={})=>({schema:1,watch_id,client:'pi',state:'waiting_for_model',sequence,process_alive:true,...change});

test('Client Watch accepts only a fixed privacy-safe heartbeat and exposes a pseudonym',()=>{
  let now=1_000_000;const watch=new ClientWatch({now:()=>now,salt:Buffer.alloc(32,7)}),id=randomUUID();
  const receipt=watch.heartbeat(heartbeat(id));assert.equal(receipt.accepted,true);assert.match(receipt.watch_ref,/^[a-f0-9]{12}$/);
  const snapshot=watch.snapshot(),run=snapshot.runs[0];
  assert.equal(run.client,'pi');assert.equal(run.state,'waiting_for_model');assert.equal(run.diagnosis,'waiting_to_reach_dsg');assert.equal(run.watch_ref,receipt.watch_ref);
  assert.ok(!JSON.stringify(snapshot).includes(id));
  for(const bad of [null,[],{...heartbeat(id),prompt:'PRIVATE'},{...heartbeat(id),watch_id:'bad'},{...heartbeat(id),client:'other'},{...heartbeat(id),state:'thinking'},{...heartbeat(id),sequence:-1},{...heartbeat(id),process_alive:'yes'}])assert.throws(()=>watch.heartbeat(bad),/Invalid/);
  assert.equal(validClientWatchId(id.toUpperCase()),id);assert.equal(validClientWatchId('PRIVATE'),null);
});

test('Client Watch correlates coarse gateway lifecycle without exporting request IDs',()=>{
  let now=1_000_000;const watch=new ClientWatch({now:()=>now,preGatewayMs:20_000,freshMs:45_000,salt:Buffer.alloc(32,8)}),id=randomUUID(),request=randomUUID();
  watch.heartbeat(heartbeat(id));now+=21_000;assert.equal(watch.snapshot().runs[0].diagnosis,'no_request_reached_dsg');
  assert.equal(watch.observeRequest(id,request,'received'),true);assert.equal(watch.snapshot().runs[0].diagnosis,'waiting_inside_dsg');
  watch.observeRequest(id,request,'queued');assert.equal(watch.snapshot().runs[0].request.state,'queued');
  watch.observeRequest(id,request,'dispatched');assert.equal(watch.snapshot().runs[0].diagnosis,'model_response_active');
  watch.observeRequest(id,request,'complete');const run=watch.snapshot().runs[0];assert.equal(run.diagnosis,'client_processing_after_dsg');assert.ok(!JSON.stringify(run).includes(request));
  assert.equal(watch.observeRequest(id,randomUUID(),'failed'),false,'an older/foreign terminal cannot replace the current request');
});
test('a request tag is not presented as a live client until an authenticated heartbeat arrives',()=>{
  const watch=new ClientWatch({salt:Buffer.alloc(32,10)}),id=randomUUID(),request=randomUUID();watch.observeRequest(id,request,'received');assert.equal(watch.snapshot().runs.length,0);
  watch.heartbeat(heartbeat(id));const run=watch.snapshot().runs[0];assert.equal(run.client,'pi');assert.equal(run.request.state,'received');
});

test('Client Watch is bounded, monotonic and treats silence as unknown rather than frozen',()=>{
  let now=5_000;const watch=new ClientWatch({now:()=>now,maxEntries:2,ttlMs:60_000,freshMs:10_000,salt:Buffer.alloc(32,9)}),one=randomUUID(),two=randomUUID(),three=randomUUID();
  watch.heartbeat(heartbeat(one,2));now++;assert.equal(watch.heartbeat(heartbeat(one,1)).accepted,false);assert.equal(watch.snapshot().runs[0].state,'waiting_for_model');
  now++;watch.heartbeat(heartbeat(two,0,{state:'local_tool'}));now++;watch.heartbeat(heartbeat(three));
  assert.equal(watch.snapshot().runs.length,2);assert.ok(!watch.snapshot().runs.some(run=>run.watch_ref===watch.ref(one)));
  now+=11_000;assert.ok(watch.snapshot().runs.every(run=>run.diagnosis==='heartbeat_stale_unknown'));
  now+=60_001;assert.equal(watch.snapshot().runs.length,0);
});

test('dashboard projection revalidates every Agent Watch field',()=>{
  const at=new Date().toISOString(),safe=clientWatchForDisplay({schema:1,mode:'advisory',fresh_after_seconds:45,pre_gateway_after_seconds:20,runs:[
    {watch_ref:'a'.repeat(12),client:'hermes',state:'local_tool',process_alive:true,fresh:true,last_seen_at:at,last_seen_seconds:1,state_seconds:2,diagnosis:'local_tool_active',request:{state:'complete',age_seconds:3},prompt:'PRIVATE'},
    {watch_ref:'BAD',client:'pi',state:'idle',process_alive:true,fresh:true,last_seen_at:at,last_seen_seconds:0,state_seconds:0,diagnosis:'idle'}]});
  assert.equal(safe.runs.length,1);assert.equal(safe.runs[0].client,'hermes');assert.ok(!JSON.stringify(safe).includes('PRIVATE'));
  assert.equal(clientWatchForDisplay({schema:1,mode:'powerful',runs:[]}),null);
});
