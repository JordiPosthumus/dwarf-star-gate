import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

import {Dataset,evidence} from './dataset.mjs';

import {safeQuarantine} from './generation-health.mjs';
import {safeGatewayEvent} from './telemetry.mjs';
import {continuityForDisplay} from './continuity.mjs';






import {createDashboard} from './dashboard.mjs';
import {capacity,phase,Activity} from './ui/activity.js';
const snapshot=()=>({time:Date.now(),devices:[],events:[],gateway:{workers:[],context_length:262144,active:0,queued:0}});
const authoredReview=()=>({assessment:'The fleet has no demonstrated fault in this snapshot.',ticker:[{severity:'info',text:'No current failure is evidenced.',recommendation:null,evidence_refs:['fleet']}]});


test('gateway event keeps only the bounded incomplete-stream classification',()=>{
  const event=safeGatewayEvent({event:'request_finished',time:'2026-09-04T12:00:00Z',node:'spark1',outcome:'incomplete_sse',stream_end:'partial_sse_event',detail:'PRIVATE',prompt:'PRIVATE'});
  assert.equal(event.stream_end,'partial_sse_event');assert.ok(!JSON.stringify(event).includes('PRIVATE'));
  assert.equal(safeGatewayEvent({event:'request_finished',stream_end:'invented'}).stream_end,undefined);
});

















test('dataset allowlist excludes raw data; unknown timings stay null',()=>{
  const e=evidence('finish',{request_id:'abc',node:'one',service_ms:NaN,usage:{prompt_tokens:0},prompt:'SECRET',answer:'SECRET',authorization:'SECRET'});
  assert.equal(e.service_ms,null);assert.equal(e.usage.prompt_tokens,0);assert.equal(e.usage.cached_tokens,null);assert.ok(!JSON.stringify(e).includes('SECRET'));
  const move=evidence('queue_relocation',{request_id:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',node:'two',source:'one',destination:'two',actor:'scheduler',waiting_ms:42,dispatch_state:'not_dispatched',body_replayed:false,deadline_preserved:true,body:'SECRET',session:'SECRET'});
  assert.deepEqual({...move,request_id:undefined,node:undefined},{kind:'queue_relocation',request_id:undefined,node:undefined,relocation_schema:1,source:'one',destination:'two',actor:'scheduler',dispatch_state:'not_dispatched',body_replayed:false,deadline_preserved:true,cache_locality:'unknown',waiting_ms:42});
  assert.ok(!JSON.stringify(move).includes('SECRET'));
  assert.equal(evidence('queue_relocation',{...move,body_replayed:true}),null);
  assert.equal(evidence('queue_relocation',{...move,actor:'genie'})?.actor,'genie');
});
test('private dataset persists across runs, counts bytes, and never deletes on budget exhaustion',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'dsg-dataset-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const d=new Dataset(dir,{enabled:true});d.record('decision',{request_id:'abc',node:'one',candidates:[]});await d.close();
  assert.equal(d.snapshot().written,1);const files=await fs.readdir(dir),file=path.join(dir,files[0]);const original=await fs.readFile(file,'utf8');
  assert.equal((await fs.stat(file)).mode&0o777,0o600);assert.equal(JSON.parse(original).schema,1);
  const next=new Dataset(dir,{enabled:true,maxBytes:1});next.record('finish',{request_id:'abc',node:'one'});await next.close();
  assert.match(next.snapshot().error,/budget/);assert.equal(next.snapshot().dropped,1);assert.equal(await fs.readFile(file,'utf8'),original);
});
test('disabled collector writes nothing; queue overflow is reported',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'dsg-dataset-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const off=new Dataset(dir);off.record('finish',{request_id:'abc'});await off.close();assert.deepEqual(await fs.readdir(dir),[]);
  const bounded=new Dataset(dir,{enabled:true,maxPending:0});bounded.record('finish',{request_id:'abc'});await bounded.close();assert.equal(bounded.snapshot().dropped,1);
});
test('capacity distinguishes eligible busy slots, paused work, free slots, and stale state',()=>{
  const g={workers:[{is_healthy:true,load:1},{is_healthy:true,load:0,queued:0},{is_healthy:true,drained:true,load:1}]};
  assert.deepEqual(capacity(g),{eligible:2,occupied:1,free:1,percent:50});assert.equal(capacity(g,true),null);
  assert.equal(capacity({...g,draining:true}).free,0);assert.equal(capacity({workers:[]}).percent,null);
});
test('active work remains visible while drained; stale engine events are not current decode',()=>{
  assert.equal(phase({connected:true,last_event:1000,phase:'decode'},{is_healthy:true,drained:true,load:1},2000),'decode');
  assert.equal(phase({connected:true,last_event:1000,phase:'decode'},{is_healthy:true,load:1},40000),'working');
});
test('activity uses elapsed durations and explicitly marks observation gaps',()=>{
  const a=new Activity(),w=[{id:'one',is_healthy:true,load:0}];a.update([],w,1000);a.update([],w,3000);a.update([],w,30000);
  assert.equal(a.get('one')[0].end,9000);assert.ok(a.get('one').some(r=>r.phase==='unknown'&&r.end-r.start===21000));
});


















async function refusedGenieConnection(){
  const server=http.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));
  try{await genieLoopbackFetch(`http://127.0.0.1:${port}/v1/chat/completions`,{body:'{}'});assert.fail('Expected refusal');}
  catch(error){assert.equal(genieNotDispatched(error),true);return error;}
}












test('capacity counts configured concurrent slots and retains serial defaults',()=>{
  const g={workers:[{is_healthy:true,load:2,queued:0,max_concurrent_requests:4},{is_healthy:true,load:1,queued:0},{is_healthy:true,drained:true,load:2,max_concurrent_requests:8}]};
  assert.deepEqual(capacity(g),{eligible:5,occupied:3,free:2,percent:60});g.workers[0].queued=1;assert.equal(capacity(g).free,0);
});


test('capacity excludes quarantine even if a last readiness check remains healthy',()=>{
 assert.deepEqual(capacity({workers:[{is_healthy:true,drained:false,quarantine:{reason:'fault'},load:1,max_concurrent_requests:2}]}),{eligible:0,occupied:0,free:0,percent:null});
});
