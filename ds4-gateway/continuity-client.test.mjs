import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {createClientWatchReporter,createContinuityFetch,registerPiContinuity} from './continuity-client.mjs';
import {evidence} from './dataset.mjs';
import {continuityForDisplay,continuityDoorForDisplay,fallbackTieBreakForDisplay} from './continuity.mjs';
import {dsgReport,invalidHttp} from './report.mjs';

test('DSG error labeling is idempotent and malformed HTTP receives an identified error',()=>{
  assert.equal(dsgReport('bad'),'DSG Report: bad');assert.equal(dsgReport(dsgReport('bad')),'DSG Report: bad');
  let wire='';invalidHttp({code:'HPE_HEADER_OVERFLOW'},{writable:true,end:s=>wire=s});
  assert.match(wire,/^HTTP\/1.1 431/);assert.match(JSON.parse(wire.split('\r\n\r\n')[1]).error.message,/^DSG Report: /);
});
const baseUrl='http://127.0.0.1:30000/v1';
test('native fetch cannot redirect scoped inference or Agent Watch outside its exact endpoint',async t=>{
  const arrivals=[];
  const target=createServer((req,res)=>{let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{arrivals.push({url:req.url,body});res.end('unexpected redirect');});});
  let redirectStatus=307,location,firstArrivals=0;
  const origin=createServer((req,res)=>{
    if(req.url==='/redirected'){arrivals.push({url:req.url});return res.end('unexpected same-origin redirect');}
    req.resume();req.on('end',()=>{firstArrivals++;res.writeHead(redirectStatus,{location});res.end('fixture redirect body');});
  });
  t.after(async()=>{for(const server of [origin,target]){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}});
  for(const server of [origin,target])await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const endpoint=`http://127.0.0.1:${origin.address().port}`,remote=`http://127.0.0.1:${target.address().port}/redirected`;
  const continuity=createContinuityFetch({baseUrl:endpoint+'/v1',wait:async()=>assert.fail('redirect is not a retry certificate')});
  for(const status of [301,302,303,307,308])for(const destination of [endpoint+'/redirected',remote])await t.test(`${status} to ${destination===remote?'another':'same'} origin`,async()=>{
    arrivals.length=0;redirectStatus=status;location=destination;
    const before=firstArrivals;
    const response=await continuity(endpoint+'/v1/chat/completions',{method:'POST',body:'{"messages":[{"role":"user","content":"private fixture"}]}',headers:{authorization:'Bearer fixture'},signal:AbortSignal.timeout(10000)});
    assert.equal(await response.text(),'fixture redirect body');
    assert.equal(arrivals.length,0,'no redirected request, even without a body, is authorized');
    assert.equal(response.status,status);assert.equal(response.headers.get('location'),destination);assert.equal(firstArrivals,before+1);
  });
  await t.test('explicit error redirect mode remains stricter',async()=>{
    arrivals.length=0;redirectStatus=307;location=remote;
    await assert.rejects(continuity(endpoint+'/v1/chat/completions',{method:'POST',body:'{}',redirect:'error'}));
    assert.equal(arrivals.length,0);
  });
  await t.test('Agent Watch does not forward credentials or private watch metadata through redirects',async()=>{
    arrivals.length=0;redirectStatus=307;location=remote;
    const watch=createClientWatchReporter({baseUrl:endpoint+'/v1',schedule:()=>({unref(){}}),unschedule(){}});
    watch.start();watch.decorate(endpoint+'/v1/chat/completions',{method:'POST',body:'{}',headers:{authorization:'Bearer fixture'}});
    // stop cancels any first heartbeat and awaits its own final attempt.
    assert.equal(await watch.stop(),false);assert.equal(arrivals.length,0);
  });
});
test('scoped redirect protection covers every inference route and preserves unscoped fetch options',async()=>{
  const received=[],f=createContinuityFetch({baseUrl,fetchImpl:async(url,init)=>{received.push({url,init});return new Response('fixture');}});
  for(const route of ['chat/completions','completions','messages','responses'])for(const [input,expected] of [[undefined,'manual'],['follow','manual'],['manual','manual'],['error','error'],['invalid','invalid']]){
    const init={method:'POST',body:'{}',redirect:input};await f(baseUrl+'/'+route,init);
    assert.equal(received.at(-1).init.redirect,expected);assert.equal(init.redirect,input);
  }
  for(const [url,init] of [[baseUrl+'/models',{redirect:'follow'}],['http://unrelated.example/v1/chat/completions',{method:'POST',body:'{}',redirect:'follow'}],[new Request(baseUrl+'/chat/completions',{method:'POST',body:'{}'}),{redirect:'follow'}]]){
    await f(url,init);assert.equal(received.at(-1).init,init);
  }
});
test('Agent Watch disposes redirected and rejected response bodies without following or retrying',async()=>{
  for(const status of [307,503]){
    let calls=0,cancelled=0;
    const watch=createClientWatchReporter({baseUrl,schedule:()=>({unref(){}}),unschedule(){},fetchImpl:async(_url,init)=>{
      calls++;assert.equal(init.redirect,'manual');
      return new Response(new ReadableStream({cancel(){cancelled++;}}),{status});
    }});
    watch.start();watch.decorate(baseUrl+'/chat/completions',{method:'POST',body:'{}',headers:{authorization:'Bearer fixture'}});
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(await watch.stop(),false);assert.equal(calls,2);assert.equal(cancelled,2);
  }
});
function refusal(init,change={}){
  const id=randomUUID();return new Response(JSON.stringify({error:{type:'gateway_error',code:'home_unavailable',continuity:{schema:1,request_id:id,call_id:init.headers.get('x-dsg-call-id'),dispatch_state:'not_dispatched',retry_class:'wait_then_retry',reason:'same_session_active',...change}}}),{status:503,headers:{'x-dsg-dispatch-state':'not_dispatched','x-request-id':id}});
}
test('certified waits retry unchanged input beyond three attempts with one call ID',async()=>{
  const sent=[],states=[],waits=[];
  const f=createContinuityFetch({baseUrl,wait:async(ms)=>waits.push(ms),onWait:s=>states.push(s),fetchImpl:async(url,init)=>{
    assert.equal(init.redirect,'manual','certified retries must also forbid implicit redirects');
    sent.push({url,body:init.body,call:init.headers.get('x-dsg-call-id'),auth:init.headers.get('authorization')});
    return sent.length<5?refusal(init):new Response('complete');
  }});
  const body=JSON.stringify({messages:[{role:'user',content:'input'}],max_tokens:262144,reasoning_effort:'xhigh'});
  assert.equal(await(await f(baseUrl+'/chat/completions',{method:'POST',body,headers:{authorization:'Bearer fixture'}})).text(),'complete');
  assert.equal(sent.length,5);assert.equal(new Set(sent.map(s=>s.call)).size,1);assert.ok(sent.every(s=>s.body===body&&s.auth==='Bearer fixture'));
  assert.deepEqual(waits,[5000,10000,15000,20000]);assert.equal(states.at(-1).state,'finished_waiting');
});
test('no automatic replay of dispatched, uncertified, malformed or operator-required failures',async()=>{
  for(const variant of ['dispatched','no_header','invalid_json','call_mismatch','operator_required','network']){
    let calls=0;const f=createContinuityFetch({baseUrl,wait:async()=>assert.fail('must not retry'),fetchImpl:async(_url,init)=>{
      ++calls;if(variant==='network')throw new Error('ambiguous connection');
      const response=variant==='invalid_json'?new Response('{',{status:503,headers:{'x-dsg-dispatch-state':'not_dispatched'}}):refusal(init,variant==='operator_required'?{retry_class:'operator_required'}:variant==='call_mismatch'?{call_id:randomUUID()}:{});
      if(variant==='dispatched')response.headers.set('x-dsg-dispatch-state','dispatched');
      if(variant==='no_header')response.headers.delete('x-dsg-dispatch-state');return response;
    }});
    if(variant==='network')await assert.rejects(f(baseUrl+'/chat/completions',{method:'POST',body:'{}'}),/ambiguous/);
    else assert.equal((await f(baseUrl+'/chat/completions',{method:'POST',body:'{}'})).status,503);
    assert.equal(calls,1);
  }
});

test('certified retry snapshots URL, method, body and signal before caller mutation',async()=>{
  const url=new URL(baseUrl+'/chat/completions'),originalUrl=url.href,controller=new AbortController();
  const init={method:'POST',body:'{"original":true}',headers:{authorization:'Bearer fixture'},signal:controller.signal},sent=[];
  const f=createContinuityFetch({baseUrl,wait:async()=>{
    url.hostname='unrelated.example';init.method='DELETE';init.body='{"changed":true}';init.signal=new AbortController().signal;
  },fetchImpl:async(input,options)=>{
    sent.push({url:String(input),method:options.method,body:options.body,signal:options.signal});
    return sent.length===1?refusal(options):new Response('complete');
  }});
  assert.equal(await(await f(url,init)).text(),'complete');
  assert.equal(sent.length,2);
  for(const request of sent)assert.deepEqual(request,{url:originalUrl,method:'POST',body:'{"original":true}',signal:controller.signal});
});
test('replacing caller options cannot detach the original cancellation signal during a wait',async()=>{
  const controller=new AbortController(),init={method:'POST',body:'{}',signal:controller.signal};let calls=0;
  const f=createContinuityFetch({baseUrl,wait:async(_ms,signal)=>{
    assert.equal(signal,controller.signal);init.signal=new AbortController().signal;controller.abort();
  },fetchImpl:async(_input,options)=>{calls++;return refusal(options);}});
  await assert.rejects(f(baseUrl+'/chat/completions',init),{name:'AbortError'});
  assert.equal(calls,1);
});
test('cancellation stops waiting without another dispatch; other endpoints and stream bodies are untouched',async()=>{
  const controller=new AbortController();let calls=0;
  const f=createContinuityFetch({baseUrl,fetchImpl:async(_u,i)=>{++calls;return refusal(i);},onWait:()=>controller.abort()});
  await assert.rejects(f(baseUrl+'/chat/completions',{method:'POST',body:'{}',signal:controller.signal}),{name:'AbortError'});assert.equal(calls,1);
  const other=createContinuityFetch({baseUrl,fetchImpl:async(_u,i)=>{assert.equal(i.headers,undefined);return new Response('untouched');}});
  for(const [url,init] of [['http://127.0.0.1:30001/v1/chat/completions',{method:'POST',body:'{}'}],[baseUrl+'/models',{}],[baseUrl+'/chat/completions',{method:'POST',body:new ReadableStream()}]])assert.equal(await(await other(url,init)).text(),'untouched');
});
test('Pi registration preserves model/options and scopes transport to one explicit provider',()=>{
  let config;const pi={on(){},registerProvider(id,c){assert.equal(id,'fixture-dsg');config=c;}};
  const model={api:'openai-completions',baseUrl,contextWindow:262144,maxTokens:262144,reasoning:true,input:['text','image']},context={messages:[]},options={reasoning:'xhigh',maxTokens:200000,apiKey:'fixture',sessionId:'one'};
  registerPiContinuity(pi,{provider:'fixture-dsg',baseUrl,streamSimple:(m,c,o)=>{assert.equal(m,model);assert.equal(c,context);assert.deepEqual({...o,fetch:undefined},{...options,fetch:undefined});return 'stream';}});
  assert.equal(config.models,undefined);assert.equal(config.baseUrl,undefined);assert.equal(config.streamSimple(model,context,options),'stream');
  assert.throws(()=>config.streamSimple({...model,baseUrl:'http://127.0.0.1:1/v1'},context,options),/mismatch/);
});
test('opt-in Agent Watch sends coarse heartbeat state and never event or request content',async()=>{
  const heartbeats=[],scheduled=[];
  const reporter=createClientWatchReporter({baseUrl,intervalMs:15_000,schedule:fn=>{scheduled.push(fn);return {unref(){}};},unschedule(){},fetchImpl:async(url,init)=>{heartbeats.push({url:String(url),headers:init.headers,body:init.body});return new Response('{}');}});
  const first=reporter.start(),body=JSON.stringify({messages:[{role:'user',content:'PRIVATE PROMPT'}]});
  const decorated=reporter.decorate(baseUrl+'/chat/completions',{method:'POST',headers:{authorization:'Bearer fixture'},body});
  assert.equal(decorated.headers.get('x-dsg-client-watch-id'),first);assert.equal(decorated.body,body);
  await new Promise(resolve=>setImmediate(resolve));
  reporter.update('local_tool');await new Promise(resolve=>setImmediate(resolve));
  reporter.update('waiting_for_model');await new Promise(resolve=>setImmediate(resolve));scheduled[0]();
  await new Promise(resolve=>setImmediate(resolve));
  assert.ok(heartbeats.length>=4);const payloads=heartbeats.map(item=>JSON.parse(item.body));
  assert.deepEqual(new Set(payloads.map(item=>item.state)),new Set(['idle','local_tool','waiting_for_model']));
  assert.ok(payloads.every(item=>item.watch_id===first&&item.client==='pi'&&item.process_alive===true));
  assert.ok(!JSON.stringify(heartbeats).includes('PRIVATE PROMPT'));
  const untouched={method:'POST',headers:{authorization:'Bearer fixture'},body};assert.equal(reporter.decorate('http://127.0.0.1:39999/v1/chat/completions',untouched),untouched);
  assert.equal(await reporter.stop(),true);assert.equal(JSON.parse(heartbeats.at(-1).body).state,'done');assert.equal(JSON.parse(heartbeats.at(-1).body).process_alive,false);
});
test('Pi Agent Watch maps lifecycle events without inspecting their payloads',async()=>{
  const handlers=new Map(),heartbeats=[];let provider;
  const pi={on(name,fn){handlers.set(name,fn);},registerProvider(_id,value){provider=value;}},model={api:'openai-completions',baseUrl};
  const registered=registerPiContinuity(pi,{provider:'fixture-dsg',baseUrl,agentWatch:true,watchFetchImpl:async(_url,init)=>{heartbeats.push(JSON.parse(init.body));return new Response('{}');},streamSimple:async(_model,_context,options)=>options.fetch(baseUrl+'/chat/completions',{method:'POST',headers:{authorization:'Bearer fixture'},body:'{"safe":true}'})});
  for(const event of ['session_start','session_shutdown','agent_start','before_provider_request','tool_execution_start','tool_execution_end','agent_settled'])assert.equal(typeof handlers.get(event),'function');
  handlers.get('session_start')({prompt:'PRIVATE'},{ui:{setStatus(){}}});
  assert.equal(handlers.get('before_provider_request')({get payload(){assert.fail('advisory hook must not inspect payload');}}),undefined,'Pi treats any return value as a replacement request payload');
  handlers.get('agent_start')({prompt:'PRIVATE'});await provider.streamSimple(model,{}, {fetch:async()=>new Response('complete')});
  await new Promise(resolve=>setImmediate(resolve));
  handlers.get('tool_execution_start')({toolName:'PRIVATE',args:{secret:'PRIVATE'}});await new Promise(resolve=>setImmediate(resolve));handlers.get('tool_execution_end')({result:'PRIVATE'});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(registered.agentWatch.state,'waiting_for_model');assert.ok(heartbeats.some(item=>item.state==='local_tool'));assert.ok(!JSON.stringify(heartbeats).includes('PRIVATE'));
  await registered.agentWatch.stop();
});
test('Pi reports a settled failed turn only after retries, without reading message content',async()=>{
  const handlers=new Map(),heartbeats=[];let registration;
  const pi={on:(name,fn)=>handlers.set(name,fn),registerProvider:(_name,value)=>registration=value};
  const watch=registerPiContinuity(pi,{provider:'fixture-dsg',baseUrl,agentWatch:true,watchFetchImpl:async(_url,init)=>{heartbeats.push(JSON.parse(init.body));return new Response('{}');},streamSimple:async(_m,_c,o)=>o.fetch(baseUrl+'/chat/completions',{method:'POST',headers:{authorization:'Bearer fixture'},body:'{}'})}).agentWatch;
  const begin=async()=>{handlers.get('agent_start')({});await registration.streamSimple({api:'openai-completions',baseUrl}, {},{fetch:async()=>new Response('fixture')});await new Promise(r=>setImmediate(r));};
  const terminal=stopReason=>({message:{role:'assistant',provider:'fixture-dsg',api:'openai-completions',stopReason,get content(){assert.fail('message content must not be inspected');},get errorMessage(){assert.fail('raw error must not be inspected');}}});
  handlers.get('session_start')({}, {ui:{setStatus(){}}});
  try{
    await begin();assert.equal(typeof handlers.get('message_end'),'function');handlers.get('message_end')(terminal('error'));
    assert.equal(watch.state,'waiting_for_model','agent-end error is not a fully settled failure');
    handlers.get('agent_settled')({});assert.equal(watch.state,'needs_attention');await new Promise(r=>setImmediate(r));
    await begin();handlers.get('message_end')(terminal('error'));handlers.get('message_end')(terminal('stop'));handlers.get('agent_settled')({});assert.equal(watch.state,'idle','successful retry clears failure');
    await begin();handlers.get('message_end')(terminal('aborted'));handlers.get('agent_settled')({});assert.equal(watch.state,'idle','intentional abort is not a model failure');
    await begin();handlers.get('message_end')({message:{role:'assistant',provider:'other',api:'openai-completions',stopReason:'error'}});handlers.get('agent_settled')({});assert.equal(watch.state,'idle','other provider errors are not DSG failure reports');
    handlers.get('agent_start')({});handlers.get('message_end')(terminal('error'));handlers.get('agent_settled')({});assert.equal(watch.state,'idle','no scoped transport attempt means no DSG error claim');
    assert.ok(heartbeats.some(row=>row.state==='needs_attention'));assert.ok(heartbeats.every(row=>Object.keys(row).sort().join(',')==='client,process_alive,schema,sequence,state,watch_id'));
  }finally{await watch.stop();}
});
test('a held heartbeat cannot accumulate more calls and session changes cancel obsolete telemetry',async()=>{
  const calls=[],ticks=[];
  const reporter=createClientWatchReporter({baseUrl,schedule:fn=>{ticks.push(fn);return {unref(){}};},unschedule(){},fetchImpl:(_url,init)=>new Promise((resolve,reject)=>{
    calls.push({init,resolve});init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true});
  })});
  const init={method:'POST',headers:{authorization:'Bearer fixture'},body:'{}'};
  reporter.start();reporter.decorate(baseUrl+'/chat/completions',init);
  for(let i=0;i<100;i++){ticks[0]();reporter.update('waiting_for_model');}
  assert.equal(calls.length,1);
  reporter.start();assert.equal(calls[0].init.signal.aborted,true);
  reporter.decorate(baseUrl+'/chat/completions',init);
  await new Promise(resolve=>setImmediate(resolve));ticks[1]();
  assert.equal(calls.length,2,'old request cleanup cannot clear the new request guard');
  const stopped=reporter.stop();assert.equal(calls[1].init.signal.aborted,true);
  assert.equal(calls.length,3);assert.equal(JSON.parse(calls[2].init.body).state,'done');
  assert.equal(reporter.decorate(baseUrl+'/chat/completions',init),init);
  ticks[1]();assert.equal(calls.length,3);
  calls[2].resolve(new Response('{}'));assert.equal(await stopped,true);
});
test('rejection dataset allowlists identifiers and refuses arbitrary reasons/text',()=>{
  const row=evidence('rejection',{request_id:randomUUID(),session:'a'.repeat(64),node:'one',code:'home_unavailable',reason:'same_session_queued',dispatch_state:'not_dispatched',call_id:randomUUID(),prompt:'PRIVATE'});
  assert.equal(row.retry_class,'wait_then_retry');assert.ok(!JSON.stringify(row).includes('PRIVATE'));
  assert.equal(evidence('rejection',{request_id:randomUUID(),reason:'PRIVATE',dispatch_state:'not_dispatched'}),null);
});
test('patient-wait evidence is bounded metadata and keeps the pre-admission delay explicit',()=>{
  const request_id=randomUUID(),waiting=evidence('waiting',{request_id,node:null,reason:'no_ready_worker',prompt:'PRIVATE'});
  assert.deepEqual(waiting,{kind:'waiting',request_id,node:null,reason:'no_ready_worker',dispatch_state:'not_dispatched'});
  assert.equal(evidence('waiting',{request_id,node:null,reason:'PRIVATE'}),null);
  const decision=evidence('decision',{request_id,node:'one',admission_wait_ms:123,client_metadata:{schema:1,status:'missing'}});
  assert.equal(decision.admission_wait_ms,123);assert.ok(!JSON.stringify([waiting,decision]).includes('PRIVATE'));
});
test('dashboard continuity projection is bounded and excludes private extra fields',()=>{
  const s=continuityForDisplay({schema:1,safe_retry_contract:true,patient_wait:true,waiting:2,oldest_wait_seconds:5,waiting_reasons:{worker_unhealthy:2,SECRET:999},recent_rejections:[{request_id:randomUUID(),time:new Date().toISOString(),reason:'same_session_queued',dispatch_state:'not_dispatched',node:'one',session:'SECRET',body:'SECRET'},{request_id:'INVALID'},{request_id:randomUUID(),time:new Date().toISOString(),reason:'same_session_queued',dispatch_state:'dispatched'}]});
  assert.equal(s.recent_rejections.length,1);assert.equal(s.waiting,2);assert.deepEqual(s.waiting_reasons,{worker_unhealthy:2});assert.ok(!JSON.stringify(s).includes('SECRET'));
});
test('relocation diagnostics projection retains allowlisted reasons and drops private fields',()=>{
  const request_id=randomUUID(),s=continuityForDisplay({schema:1,automatic_relocation:true,automatic_relocation_scope:'first_unaffined_or_affinity_wait_expired',automatic_affinity_rebalance_min_wait_ms:300000,relocation:{diagnostics:{schema:1,gateway_reason:null,idle_destinations:['two','BAD ID'],sources:[
    {source:'one',request_id,affinity:'existing',waiting_seconds:12,reason:'same_session_active',destination:null,conflicting_worker:'one',automatic_reason:'same_session_active',genie_reason:'same_session_active',session:'PRIVATE',body:'PRIVATE'},
    {source:'one',request_id:randomUUID(),affinity:'existing',waiting_seconds:12,reason:'PRIVATE'}],secret:'PRIVATE'}}});
  assert.deepEqual(s.relocation.diagnostics.idle_destinations,['two']);assert.equal(s.relocation.diagnostics.sources.length,1);
  assert.equal(s.automatic_relocation_scope,'first_unaffined_or_affinity_wait_expired');assert.equal(s.automatic_affinity_rebalance_min_wait_ms,300000);
  assert.equal(s.relocation.diagnostics.sources[0].reason,'same_session_active');assert.ok(!JSON.stringify(s).includes('PRIVATE'));
});
test('fallback tie-break projection exposes bounded active-with-abstention receipts',()=>{
  const request_id=randomUUID(),s=fallbackTieBreakForDisplay({schema:1,mode:'active_with_abstention',policy:'validated_remaining_tiebreak',evaluations:3,comparable:1,would_change:1,applied:1,insufficient_evidence:2,errors:0,secret:'PRIVATE',last:{request_id,verdict:'would_change',applied:true,selected:'one',alternative:'two',minimum_load:1,prompt:'PRIVATE',candidates:[{node:'one',load:1,status:'supported',predicted_wait_seconds:20,evidence:['active_remaining'],session:'PRIVATE'}]}});
  assert.equal(s.mode,'active_with_abstention');assert.equal(s.applied,1);assert.equal(s.last.applied,true);assert.equal(s.last.candidates.length,1);assert.ok(!JSON.stringify(s).includes('PRIVATE'));
});
test('dashboard continuity-door projection exposes state but not ports or arbitrary reasons',()=>{
  const s=continuityDoorForDisplay({service:'dwarf-star-gate-continuity-door',version:1,holding:true,hold_kind:'manual',reason:'PRIVATE',since:new Date().toISOString(),held:2,active:3,core_ready:false,core_failures:4,body_spooling:false,replay:false,core_port:30001,secret:'PRIVATE'});
  assert.equal(s.held,2);assert.equal(s.active,3);assert.equal(s.reason,null);assert.equal(s.body_spooling,false);assert.equal(s.replay,false);assert.ok(!JSON.stringify(s).includes('PRIVATE'));assert.equal(s.core_port,undefined);
  assert.equal(continuityDoorForDisplay({service:'other',version:1}),null);
  assert.equal(s.failed,null);assert.equal(s.failure_evidence,null);assert.equal(s.model_discovery_hold,null,'old Door is not credited with new protection');
});
test('Door failure projection preserves fixed diagnostics without payloads or invented replay authority',()=>{
  const base={service:'dwarf-star-gate-continuity-door',version:1,failed:40,model_discovery_hold:true};
  const row={sequence:40,at:'2026-09-05T00:00:00Z',request_class:'status',phase:'before_response_headers',holding:true,hold_kind:'manual',backend_dispatch:'unknown',url:'/PRIVATE',error:'PRIVATE'};
  const failure_evidence={schema:1,scope:'door_process',by_request_class:{inference:1,model_discovery:1,status:37,other:1,PRIVATE:5},recent:Array.from({length:40},()=>({...row}))};
  const s=continuityDoorForDisplay({...base,failure_evidence});
  assert.equal(s.failed,40);assert.equal(s.model_discovery_hold,true);assert.equal(s.failure_evidence.recent.length,30);
  assert.equal(s.failure_evidence.by_request_class.status,37);assert.equal(s.failure_evidence.recent[0].backend_dispatch,'unknown');
  assert.equal(s.failure_evidence.recent[0].at,'2026-09-05T00:00:00.000Z');assert.ok(!JSON.stringify(s).includes('PRIVATE'));
  for(const invalid of [null,{...row,request_class:'PRIVATE'},{...row,phase:'PRIVATE'},{...row,at:'PRIVATE'},{...row,backend_dispatch:'not_dispatched'},{...row,sequence:-1}]){
    assert.deepEqual(continuityDoorForDisplay({...base,failure_evidence:{...failure_evidence,recent:[invalid]}}).failure_evidence.recent,[]);
  }
  for(const invalid of [{...failure_evidence,schema:2},{...failure_evidence,scope:'PRIVATE'},{...failure_evidence,by_request_class:{status:-1}}]){
    assert.equal(continuityDoorForDisplay({...base,failure_evidence:invalid}).failure_evidence,null);
  }
});
