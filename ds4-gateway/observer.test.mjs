import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {Dataset,evidence} from './dataset.mjs';
import {Genie,briefing} from './genie.mjs';
import {safeQuarantine} from './generation-health.mjs';

test('Genie receives an allowlisted quarantine fact, not raw backend text or credentials',()=>{
  const bad={reason:'fatal_accelerator_error',at:'2026-09-02T00:00:00Z',request_id:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',raw:'PRIVATE'};
  assert.equal(safeQuarantine({reason:'PRIVATE'}),null);assert.ok(!JSON.stringify(safeQuarantine(bad)).includes('PRIVATE'));
  const report=briefing({gateway:{workers:[{id:'spark1',quarantine:bad}]},devices:[],events:[]});
  assert.equal(report.workers[0].quarantine.reason,'fatal_accelerator_error');assert.ok(!JSON.stringify(report).includes('PRIVATE'));
});
import {createDashboard} from './dashboard.mjs';
import {capacity,phase,Activity} from './ui/activity.js';
const snapshot=()=>({time:Date.now(),devices:[],events:[],gateway:{workers:[],context_length:262144,active:0,queued:0}});
test('dataset allowlist excludes raw data; unknown timings stay null',()=>{
  const e=evidence('finish',{request_id:'abc',node:'one',service_ms:NaN,usage:{prompt_tokens:0},prompt:'SECRET',answer:'SECRET',authorization:'SECRET'});
  assert.equal(e.service_ms,null);assert.equal(e.usage.prompt_tokens,0);assert.equal(e.usage.cached_tokens,null);assert.ok(!JSON.stringify(e).includes('SECRET'));
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
test('Genie is off by default, has no tools, strips snapshot secrets, uses explicit fallback only',async()=>{
  let sent,calls=0,url,headers;
  const g=new Genie({url:'http://127.0.0.1:9001/v1',fallback:{url:'http://127.0.0.1:9002/v1',api_key:'TEST'}},snapshot,{fetchImpl:async(u,o)=>{
    calls++;url=u;sent=JSON.parse(o.body);headers=o.headers;return Response.json({choices:[{finish_reason:'stop',message:{content:'No confirmed issue.'}}]});}});
  await assert.rejects(g.ask(),/Enable/);g.tick();assert.equal(calls,0);
  g.setEnabled(true);await g.ask();assert.equal(calls,1);assert.equal(sent.tools,undefined);assert.equal(headers.authorization,undefined);
  assert.equal(g.status().reports[0].actions_taken.length,0);
  g.setSource('pool');await g.ask('Explain capacity');assert.equal(url,'http://127.0.0.1:9002/v1/chat/completions');assert.equal(headers.authorization,'Bearer TEST');
  assert.ok(!JSON.stringify(g.status()).includes('TEST'));assert.ok(!JSON.stringify(briefing({...snapshot(),secret:'PRIVATE'})).includes('PRIVATE'));g.close();
});
test('Genie does not auto-replay on failure and rejects nonloopback endpoint',async()=>{
  assert.throws(()=>new Genie({url:'http://example.com/v1'},snapshot),/loopback/);
  let calls=0;const g=new Genie({url:'http://127.0.0.1:9001/v1',fallback:{url:'http://127.0.0.1:9002/v1'}},snapshot,{fetchImpl:async()=>{calls++;throw new Error('private details');}});
  g.setEnabled(true);await g.ask();assert.equal(calls,1);assert.equal(g.status().error,'Observation failed; gateway unaffected');g.close();
});
test('legacy gateway absence is explicit; LLM output-limited reviews are not accepted',async()=>{
  assert.equal(briefing(snapshot()).dataset.enabled,false);
  const g=new Genie({url:'http://127.0.0.1:9001/v1'},snapshot,{fetchImpl:async()=>Response.json({choices:[{finish_reason:'length',message:{content:'unfinished'}}]})});
  g.setEnabled(true);await g.ask();assert.equal(g.status().reports.length,0);assert.ok(g.status().error);g.close();
});
test('Genie APIs enforce same-origin CSRF and reject mutation tools',async t=>{
  const g=new Genie({url:'http://127.0.0.1:9001/v1'},snapshot);const server=createDashboard(snapshot,undefined,null,g);
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{g.close();server.closeAllConnections();server.close();});
  const url=`http://127.0.0.1:${server.address().port}`;
  const read=await(await fetch(url+'/api/genie')).json();assert.ok(read.csrf_token);
  assert.equal((await fetch(url+'/api/genie',{method:'POST',body:'{}'})).status,403);
  const headers={'content-type':'application/json','origin':url,'x-dsg-csrf':read.csrf_token};
  assert.equal((await fetch(url+'/api/genie',{method:'POST',headers,body:JSON.stringify({action:'enable',enabled:true})})).status,200);
  assert.equal((await fetch(url+'/api/genie',{method:'POST',headers,body:JSON.stringify({action:'drain'})})).status,400);
  assert.ok(!(await(await fetch(url+'/api/status')).text()).includes('csrf_token'));
});
