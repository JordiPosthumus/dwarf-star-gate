import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {Dataset,evidence} from './dataset.mjs';
import {Genie,briefing,parseGenieReview,tickerStatus} from './genie.mjs';
import {safeQuarantine} from './generation-health.mjs';

test('Genie receives an allowlisted quarantine fact, not raw backend text or credentials',()=>{
  const bad={reason:'fatal_accelerator_error',at:'2026-09-02T00:00:00Z',request_id:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',raw:'PRIVATE'};
  assert.equal(safeQuarantine({reason:'PRIVATE'}),null);assert.ok(!JSON.stringify(safeQuarantine(bad)).includes('PRIVATE'));
  const report=briefing({gateway:{workers:[{id:'spark1',quarantine:bad}]},devices:[],events:[]});
  assert.equal(report.workers[0].quarantine.reason,'fatal_accelerator_error');assert.ok(!JSON.stringify(report).includes('PRIVATE'));
});
import {createDashboard,genieRuntimeConfig} from './dashboard.mjs';
import {capacity,phase,Activity} from './ui/activity.js';
const snapshot=()=>({time:Date.now(),devices:[],events:[],gateway:{workers:[],context_length:262144,active:0,queued:0}});
const authoredReview=()=>({assessment:'The fleet has no demonstrated fault in this snapshot.',ticker:[{severity:'info',text:'No current failure is evidenced.',recommendation:null,evidence_refs:['fleet']}]});
test('Genie uses the DSG pool by default and an explicit dedicated endpoint gains pool fallback',()=>{
  const base={port:30000,api_key:'PRIVATE',model:'deepseek-v4-flash'};
  const pool=genieRuntimeConfig(base);assert.equal(pool.default_source,'pool');assert.equal(pool.enabled,true);assert.equal(pool.url,'http://127.0.0.1:30000/v1');assert.equal(pool.fallback.api_key,'PRIVATE');
  const dedicated=genieRuntimeConfig({...base,genie:{url:'http://127.0.0.1:8001/v1',model:'deepseek-v4-flash'}});assert.equal(dedicated.url,'http://127.0.0.1:8001/v1');assert.equal(dedicated.fallback.url,'http://127.0.0.1:30000/v1');
  assert.equal(genieRuntimeConfig({...base,genie:false}),null);
});
test('Genie sees bounded attribution evidence without mistaking a candidate for protocol proof',()=>{
  const s=snapshot();s.attribution={schema:1,mode:'shadow',request_identity:'heuristic_not_protocol_proof',counts:{corroborated:1,candidate:0,abstained:2},recent:[{node:'spark1',status:'corroborated',reason:'usage_match',request_id:'PRIVATE',prompt:'PRIVATE'}],secret:'PRIVATE'};
  const b=briefing(s);assert.equal(b.attribution.counts.corroborated,1);assert.match(b.semantics.join(' '),/at best a high-confidence candidate/);
  assert.ok(!JSON.stringify(b).includes('PRIVATE'));
});
test('Genie queue briefing preserves measured age versus allowance and grants no timeout power',()=>{
  const s=snapshot();s.gateway.queue_timeout_ms=72000000000;s.gateway.request_timeout_ms=360000000;s.gateway.workers=[{id:'one',oldest_queue_seconds:125,oldest_queue_remaining_seconds:71999875}];
  const b=briefing(s);assert.equal(b.queue_timeout_ms,72000000000);assert.equal(b.workers[0].oldest_queue_seconds,125);assert.equal(b.workers[0].oldest_queue_remaining_seconds,71999875);
  assert.match(b.semantics.join(' '),/NOT predicted time to service/);assert.match(b.semantics.join(' '),/cannot change timeout/);assert.match(b.semantics.join(' '),/NOT 0.3 seconds/);assert.equal(briefing(snapshot()).queue_timeout_ms,null);
});
test('Genie sees current patient waiting without inventing migration or replay authority',()=>{
  const s=snapshot();s.gateway.queued=3;s.gateway.continuity={patient_wait:true,waiting:2,oldest_wait_seconds:120,waiting_reasons:{worker_quarantined:2}};
  const b=briefing(s);assert.equal(b.continuity.waiting,2);assert.equal(b.continuity.oldest_wait_seconds,120);assert.equal(b.queued,3);
  assert.match(b.semantics.join(' '),/INCLUDED in fleet queued/);assert.match(b.semantics.join(' '),/do not survive socket loss/);
});
test('Genie sees bounded Continuity Door state and its non-replay boundary',()=>{
  const s=snapshot();s.continuity_door={schema:1,holding:true,hold_kind:'manual',reason:'planned_gateway_core_restart',held:2,active:1,core_ready:false,body_spooling:false,replay:false};
  const b=briefing(s);assert.equal(b.continuity_door.held,2);assert.ok(b.evidence_refs.includes('continuity-door'));
  assert.match(b.semantics.join(' '),/paused unread/);assert.match(b.semantics.join(' '),/does not recover an already-dispatched stream/);
});
test('Genie accepts only an exact deterministic relocation offer and records its executor receipt',async()=>{
  const offer={schema:1,request_id:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',source:'spark1',destination:'studio',evidence_id:'a'.repeat(64),waiting_seconds:90,destination_immediately_free:true,cache_locality:'unknown'};
  const s=snapshot();s.gateway.continuity={relocation:{genie_enabled:true,genie_offers:[offer]}};
  const answer={assessment:'The queued request can use the idle server.',ticker:[{severity:'info',text:'One mature relocation is offered.',recommendation:null,evidence_refs:['fleet']}],relocation_requests:[Object.fromEntries(['request_id','source','destination','evidence_id'].map(k=>[k,offer[k]]))]};
  const evidence=briefing(s);assert.equal(parseGenieReview(JSON.stringify(answer),evidence).relocation_requests.length,1);
  assert.equal(parseGenieReview(JSON.stringify({...answer,relocation_requests:[{...answer.relocation_requests[0],destination:'invented'}]}),evidence).relocation_requests.length,0);
  const actions=[],g=new Genie({url:'http://127.0.0.1:9001/v1'},()=>s,{rebalance:async input=>{actions.push(input);return {state:'relocated',actor:'genie'};},fetchImpl:async()=>Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(answer)}}]})});
  await g.ask();assert.equal(actions.length,1);assert.equal(g.status().reports[0].actions_taken[0].state,'relocated');g.close();
});
test('Genie promptly reviews a new mature action offer without polling it repeatedly',async()=>{
  const offer={schema:1,request_id:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',source:'spark1',destination:'studio',evidence_id:'b'.repeat(64),waiting_seconds:90,destination_immediately_free:true,cache_locality:'unknown'};
  const s=snapshot();s.gateway.continuity={relocation:{genie_enabled:true,genie_offers:[offer]}};let calls=0;
  const g=new Genie({url:'http://127.0.0.1:9001/v1'},()=>s,{rebalance:async()=>({}),fetchImpl:async()=>{calls++;return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(authoredReview())}}]});}});
  g.attempt=Date.now();g.tick();while(g.busy)await new Promise(r=>setImmediate(r));assert.equal(calls,1);
  g.tick();await new Promise(r=>setImmediate(r));assert.equal(calls,1,'same offer is not reviewed again immediately');g.close();
});
test('Genie sees typed continuity evidence without client/session identifiers or arbitrary fields',()=>{
  const s=snapshot();s.gateway.continuity={recent_rejections:[{time:new Date().toISOString(),request_id:'fixture',node:'one',code:'home_unavailable',reason:'same_session_queued',dispatch_state:'not_dispatched',retry_class:'wait_then_retry',session:'PRIVATE',call_id:'PRIVATE',prompt:'PRIVATE'}]};
  const b=briefing(s);assert.equal(b.continuity.recent_rejections[0].reason,'same_session_queued');assert.ok(!JSON.stringify(b).includes('PRIVATE'));
});
test('Genie briefing distinguishes an empty waiting queue from genuinely free capacity',()=>{
  const worker={id:'one',is_healthy:true,load:0,queued:0},s=snapshot();s.gateway.workers=[worker];
  assert.equal(briefing(s).workers[0].immediately_free,true);
  for(const change of [{load:1},{queued:1},{drained:true},{is_healthy:false},{load:undefined},{queued:undefined},{quarantine:{reason:'fatal_accelerator_error'}}]) {
    s.gateway.workers=[{...worker,...change}];assert.equal(briefing(s).workers[0].immediately_free,false);
  }
  s.gateway.workers=[worker];s.gateway.draining=true;assert.equal(briefing(s).workers[0].immediately_free,false);
  assert.match(briefing(s).semantics.join(' '),/queued=0.*NOT idle/);
  assert.match(briefing(s).semantics.join(' '),/still-undispatched.*affinity-wait escape threshold.*Genie-authorized executor/);
});
test('Genie parses bounded model-written ticker entries and rejects unknown evidence references',()=>{
  const evidence=briefing(snapshot()),data=authoredReview();
  let result=parseGenieReview(JSON.stringify(data),evidence);assert.equal(result.ticker[0].text,data.ticker[0].text);assert.equal(result.ticker_error,null);
  assert.equal(parseGenieReview('```json\n'+JSON.stringify(data)+'\n```',evidence).ticker.length,1);
  for(const mutate of [d=>d.ticker[0].evidence_refs=['worker:invented'],d=>d.ticker[0].recommendation='x'.repeat(181),d=>d.ticker[0].text='x'.repeat(281),d=>d.ticker[0].severity='invented',d=>d.ticker=[],d=>d.ticker=Array(5).fill(d.ticker[0])]) {
    const bad=structuredClone(data);mutate(bad);result=parseGenieReview(JSON.stringify(bad),evidence);
    assert.equal(result.ticker.length,0);assert.equal(result.ticker_error,'invalid_structured_review');
  }
  result=parseGenieReview('An ordinary unstructured assessment.',evidence);
  assert.equal(result.text,'An ordinary unstructured assessment.');assert.equal(result.ticker.length,0);
});
test('one Genie call supplies assessment and ticker; unchanged budgets, evidence time and no action authority',async()=>{
  const s=snapshot();s.gateway_at=s.time-2500;let sent,calls=0;
  const g=new Genie({url:'http://127.0.0.1:9001/v1'},()=>s,{fetchImpl:async(_u,o)=>{
    calls++;sent=JSON.parse(o.body);return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(authoredReview())}}]});}});
  g.setEnabled(true);await g.ask();const status=g.status();
  assert.equal(calls,1);assert.equal(sent.max_tokens,8192);assert.equal(sent.reasoning_effort,'low');assert.equal(sent.tools,undefined);
  assert.match(sent.messages[0].content,/No humour/);assert.match(sent.messages[0].content,/Recommendations are advice/);
  assert.match(sent.messages[0].content,/Choose severity per item/);assert.match(sent.messages[0].content,/never recovery permission/);
  assert.equal(status.reports[0].evidence_at,s.gateway_at);assert.deepEqual(status.reports[0].actions_taken,[]);
  assert.equal(status.ticker.state,'ready');assert.equal(status.ticker.entries[0].text,authoredReview().ticker[0].text);
  assert.ok(JSON.parse(sent.messages[1].content).evidence.semantics.some(v=>v.includes('complete request is forwarded unchanged')));
  const report=status.reports[0];
  assert.equal(tickerStatus(report,s,{now:report.evidence_at+600001}).state,'stale');
  assert.equal(tickerStatus(report,s,{now:report.evidence_at-1}).state,'stale');
  assert.equal(tickerStatus(report,s,{enabled:false}).state,'off');
  assert.equal(tickerStatus(report,{...s,gateway_error:'lost'}).state,'unavailable');
  assert.equal(tickerStatus(report,s,{source:'pool'}).state,'pending');
  s.gateway.workers.push({id:'new',is_healthy:true});assert.equal(g.status().ticker.state,'changed');
  s.gateway.workers=[];s.gateway.queued=10;assert.equal(g.status().ticker.state,'ready','ordinary queue churn remains a timestamped snapshot, not perpetual invalidation');
  s.gateway.draining=true;assert.equal(g.status().ticker.state,'changed');g.close();
});
test('all four ticker severities are accepted but none grants recovery permission',()=>{
  const evidence=briefing(snapshot()),data=authoredReview();
  for(const severity of ['good','info','warning','critical']) {
    data.ticker[0].severity=severity;const parsed=parseGenieReview(JSON.stringify(data),evidence);
    assert.equal(parsed.ticker[0].severity,severity);assert.deepEqual(parsed.recovery_requests,[]);
    const bad={...data,recovery_requests:[{worker_id:'invented',evidence_id:'invented'}]};
    assert.equal(parseGenieReview(JSON.stringify(bad),evidence).ticker_error,'invalid_structured_review');
  }
});
test('Genie withholds malformed headlines and never falls back to invented or older ticker text',async()=>{
  let content=JSON.stringify(authoredReview());const g=new Genie({url:'http://127.0.0.1:9001/v1'},snapshot,{fetchImpl:async()=>Response.json({choices:[{finish_reason:'stop',message:{content}}]})});
  g.setEnabled(true);await g.ask();assert.equal(g.status().ticker.state,'ready');
  content='A report without the required JSON.';await g.ask();assert.equal(g.status().ticker.state,'invalid');assert.deepEqual(g.status().ticker.entries,[]);
  assert.equal(g.status().reports[0].text,content);g.close();
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
test('configured Genie is on by default, can be explicitly disabled, has no tools, strips secrets and supports pool use',async()=>{
  let sent,calls=0,url,headers;
  const g=new Genie({url:'http://127.0.0.1:9001/v1',fallback:{url:'http://127.0.0.1:9002/v1',api_key:'TEST'}},snapshot,{fetchImpl:async(u,o)=>{
    calls++;url=u;sent=JSON.parse(o.body);headers=o.headers;return Response.json({choices:[{finish_reason:'stop',message:{content:'No confirmed issue.'}}]});}});
  assert.equal(g.status().enabled,true);await g.ask();assert.equal(calls,1);assert.equal(sent.tools,undefined);assert.equal(headers.authorization,undefined);
  assert.equal(g.status().reports[0].actions_taken.length,0);
  g.setSource('pool');await g.ask('Explain capacity');assert.equal(url,'http://127.0.0.1:9002/v1/chat/completions');assert.equal(headers.authorization,'Bearer TEST');
  assert.equal(headers['x-session-affinity'],undefined);assert.equal(g.status().last_served_by,'pool');
  assert.ok(!JSON.stringify(g.status()).includes('TEST'));assert.ok(!JSON.stringify(briefing({...snapshot(),secret:'PRIVATE'})).includes('PRIVATE'));g.close();
  const disabled=new Genie({enabled:false,url:'http://127.0.0.1:9001/v1'},snapshot,{fetchImpl:async()=>{calls++;return Response.json({});}});
  assert.equal(disabled.status().enabled,false);await assert.rejects(disabled.ask(),/Enable/);disabled.tick();assert.equal(calls,2);disabled.close();
});

test('a manual Genie question preempts a routine review and exposes a stable in-memory receipt',async()=>{
  const calls=[];
  const g=new Genie({url:'http://127.0.0.1:9001/v1'},snapshot,{fetchImpl:async(_u,o)=>{
    const body=JSON.parse(o.body);calls.push(JSON.parse(body.messages[1].content).question);
    if(calls.length===1)await new Promise((resolve,reject)=>{o.signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true});});
    return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(authoredReview())}}]});
  }});
  g.setEnabled(true);const scheduled=g.ask(undefined,{kind:'scheduled'});await new Promise(r=>setImmediate(r));
  const accepted=g.submit('Why is Spark 2 unavailable?');assert.equal(accepted.state,'queued');assert.equal(g.status().question.state,'queued');
  assert.throws(()=>g.submit('Another question'),/already pending/);
  await scheduled;
  while(g.status().question.state==='queued'||g.status().question.state==='answering')await new Promise(r=>setImmediate(r));
  assert.equal(g.status().question.state,'answered');assert.equal(calls[1],'Why is Spark 2 unavailable?');assert.ok(g.status().question.report_id);
  assert.equal(g.status().error,null);
  assert.ok(!JSON.stringify(g.status().question).includes('Why is'));
  g.close();
});

test('manual questions wait behind action reviews rather than preempting authority decisions',async()=>{
  let release;const blocked=new Promise(r=>{release=r;}),calls=[];
  const g=new Genie({url:'http://127.0.0.1:9001/v1'},snapshot,{fetchImpl:async(_u,o)=>{
    calls.push(JSON.parse(JSON.parse(o.body).messages[1].content).question);
    if(calls.length===1)await blocked;
    return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(authoredReview())}}]});
  }});
  const action=g.ask('Review exact offer',{kind:'action'});await new Promise(r=>setImmediate(r));
  assert.equal(g.submit('What happened?').state,'queued');assert.equal(g.status().review_kind,'action');release();await action;
  while(['queued','answering'].includes(g.status().question?.state))await new Promise(r=>setImmediate(r));
  assert.equal(g.status().question.state,'answered');assert.deepEqual(calls,['Review exact offer','What happened?']);g.close();
});

test('Genie question failures remain visible and an off Genie never silently accepts a question',async()=>{
  const g=new Genie({enabled:false,url:'http://127.0.0.1:9001/v1'},snapshot,{fetchImpl:async()=>{throw new Error('private transport details');}});
  assert.throws(()=>g.submit('hello'),/off/);g.setEnabled(true);g.submit('hello');
  while(['accepted','answering'].includes(g.status().question?.state))await new Promise(r=>setImmediate(r));
  assert.equal(g.status().question.state,'failed');assert.match(g.status().question.error,/Observation failed/);
  assert.ok(!JSON.stringify(g.status()).includes('private transport details'));g.close();
});
test('Genie automatically borrows one unpinned pool slot after dedicated-provider failure',async()=>{
  assert.throws(()=>new Genie({url:'http://example.com/v1'},snapshot),/loopback/);
  const memory={retrieve:()=>({notes:[{id:'private-note',revision:1,data:{text:'PRIVATE_NOTE'}}],truncated:false}),status:()=>({available:true,enabled:true})};
  const calls=[];const g=new Genie({url:'http://127.0.0.1:9001/v1',fallback:{url:'http://127.0.0.1:9002/v1'}},snapshot,{memory,fetchImpl:async(url,options)=>{
    calls.push({url,headers:options.headers,body:JSON.parse(options.body)});if(calls.length===1)throw new Error('private details');
    return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(authoredReview())}}]});
  }});
  g.setEnabled(true);await g.ask();assert.equal(calls.length,2);assert.match(calls[0].url,/9001/);assert.match(calls[1].url,/9002/);
  assert.equal(calls[1].headers['x-session-affinity'],undefined);assert.equal(calls[1].headers['x-dsg-observer'],'gate-genie');
  assert.deepEqual(JSON.parse(calls[1].body.messages[1].content).notebook_history.notes,[]);assert.ok(!JSON.stringify(calls[1]).includes('PRIVATE_NOTE'));
  assert.equal(g.status().last_served_by,'pool_fallback');assert.equal(g.status().reports[0].served_by,'pool_fallback');assert.deepEqual(g.status().reports[0].memory_used,[]);g.close();
});
test('a bounded dedicated timeout aborts that attempt and borrows the pool',async()=>{
  const calls=[];const g=new Genie({url:'http://127.0.0.1:9001/v1',timeout_ms:1000,fallback:{url:'http://127.0.0.1:9002/v1'}},snapshot,{fetchImpl:async(url,options)=>{
    calls.push(url);if(calls.length===1)await new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true}));
    return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(authoredReview())}}]});
  }});
  await g.ask();assert.equal(calls.length,2);assert.equal(g.status().last_served_by,'pool_fallback');assert.equal(g.status().error,null);g.close();
});
test('Genie endpoint deadlines are bounded, default to two hours and expose live progress without endpoint details',()=>{
  assert.throws(()=>new Genie({url:'http://127.0.0.1:9001/v1',timeout_ms:999},snapshot),/timeout_ms/);
  assert.throws(()=>new Genie({url:'http://127.0.0.1:9001/v1',fallback:{url:'http://127.0.0.1:9002/v1',timeout_ms:86400001}},snapshot),/timeout_ms/);
  const defaults=new Genie({url:'http://127.0.0.1:9001/v1',fallback:{url:'http://127.0.0.1:9002/v1'}},snapshot);assert.equal(defaults.status().primary_timeout_ms,7200000);assert.equal(defaults.status().fallback_timeout_ms,7200000);defaults.close();
  const g=new Genie({url:'http://127.0.0.1:9001/v1',timeout_ms:5000,fallback:{url:'http://127.0.0.1:9002/v1',timeout_ms:7000}},snapshot);
  const status=g.status();assert.equal(status.primary_timeout_ms,5000);assert.equal(status.fallback_timeout_ms,7000);assert.ok(!JSON.stringify(status).includes('9001'));g.close();
});
test('Genie reports failure only after both dedicated and pool providers fail',async()=>{
  let calls=0;const g=new Genie({url:'http://127.0.0.1:9001/v1',fallback:{url:'http://127.0.0.1:9002/v1'}},snapshot,{fetchImpl:async()=>{calls++;throw new Error('private details');}});
  g.setEnabled(true);await g.ask();assert.equal(calls,2);assert.equal(g.status().error,'Observation failed; gateway unaffected');g.close();
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
