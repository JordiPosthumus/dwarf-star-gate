import test from 'node:test';import assert from 'node:assert/strict';
import {runServingCheck} from './serving-checks.mjs';
const worker={id:'fixture-worker',url:'http://127.0.0.1:1234/v1',served_model:'fixture-model',is_healthy:true,drained:false};
function fixture({wrongNode=false,warmHit=true,toolError=false}={}){
 const requests=[];
 const fetchImpl=async(url,options)=>{
  const body=JSON.parse(options.body);requests.push({url,options,body});
  const last=body.messages.at(-1).content;
  let content=last.match(/(?:CANARY|COLD_[AB]|WARM_[AB])_7319/)?.[0]??'7319',finish='stop',message={role:'assistant',content};
  if(last.includes('Call report_value')){finish='tool_calls';message={role:'assistant',content:null,tool_calls:[{id:'fixture-call',type:'function',function:{name:'report_value',arguments:JSON.stringify({value:toolError?2:7319})}}]};}
  const warm=last.includes('WARM_');
  return Response.json({model:'fixture-model',choices:[{message,finish_reason:finish}],usage:{prompt_tokens:warm?8100:8000,completion_tokens:12,prompt_tokens_details:{cached_tokens:warm&&warmHit?7000:0}}},{headers:{'x-ds4-node':wrongNode?'wrong-worker':worker.id}});
 };
 const args={worker,config:{port:30000,api_key:'synthetic-key'},registry:{model_routes:{'fixture-model':[worker.id]}},readDoor:async()=>({holding:false,core_ready:true,held:0}),fetchImpl};
 return {requests,args};
}
test('Door proof requires real generation, exact route and worker header',async()=>{
 const f=fixture();const result=await runServingCheck({...f.args,check:'gateway'});assert.equal(result.state,'passed');assert.equal(f.requests.length,1);assert.equal(f.requests[0].options.method,'POST');assert.equal(f.requests[0].options.headers['x-dsg-model'],'fixture-model');assert.equal(f.requests[0].body.model,'PoolModel');
 await assert.rejects(runServingCheck({...fixture({wrongNode:true}).args,check:'gateway'}),/requested worker/);
 await assert.rejects(runServingCheck({...f.args,check:'gateway',worker:{...worker,drained:true}}),/already be healthy and admitted/);
 await assert.rejects(runServingCheck({...f.args,check:'gateway',registry:{model_routes:{'fixture-model':[worker.id,'other']}}}),/exclusive model route/);
 assert.equal(f.requests.length,1,'failed preflight never generates');
});
test('cache proof uses real cold/warm usage with interleaved histories and never resets cache',async()=>{
 const f=fixture(),r=await runServingCheck({...f.args,check:'cache'});assert.equal(r.state,'passed');assert.deepEqual(r.samples.map(s=>s.label),['cold-A','cold-B','warm-A','warm-B']);assert.deepEqual(r.samples.map(s=>s.cached_tokens),[0,0,7000,7000]);
 assert.equal(f.requests[2].body.messages[0].content,f.requests[0].body.messages[0].content);assert.equal(f.requests[3].body.messages[0].content,f.requests[1].body.messages[0].content);assert.equal(f.requests[2].body.messages[1].content,'COLD_A_7319');
 assert.ok(f.requests.every(r=>r.url.endsWith('/v1/chat/completions')));assert.ok(f.requests.every(r=>r.body.max_tokens===4096));
 await assert.rejects(runServingCheck({...fixture({warmHit:false}).args,check:'cache'}),/substantial real prefix reuse/);
});
test('tool proof checks the actual arguments and sends the actual tool call into follow-up',async()=>{
 const f=fixture(),r=await runServingCheck({...f.args,check:'tools'});assert.equal(r.state,'passed');assert.equal(f.requests[1].body.messages[2].tool_call_id,'fixture-call');
 await assert.rejects(runServingCheck({...fixture({toolError:true}).args,check:'tools'}),/function\/argument boundary/);
});
test('GLM diagnostic uses the recovery verifier only for the exactly configured pair and retains incremental samples',async()=>{
 const target={...worker,ssh:'fixture-head',remote_port:8000,context_length:400000};
 const binding=Object.fromEntries(['id','url','ssh','remote_port'].map(k=>[k,target[k]]));
 const config={media_jobs:{pairs:{[target.id]:{kind:'glm53-docker-pair',model:target.served_model,worker_binding:binding,members:[{ssh:'fixture-head',container:'a'.repeat(64)},{ssh:'fixture-rank',container:'b'.repeat(64)}]}}},genie_chat:{inspection:{workers:{[target.id]:{ssh:['fixture-head'],container:'a'.repeat(64)}}}}};
 const calls=[],samples=[];
 const fetchImpl=async(url,options)=>{
  calls.push({url,options});
  if(url.pathname==='/v1/models')return Response.json({data:[{id:target.served_model,max_model_len:400000}]});
  const body=JSON.parse(options.body),warm=body.messages.length===3,id=body.messages[0].content.includes('-A.')?'A':'B';
  assert.equal(body.chat_template_kwargs,undefined);assert.equal(body.thinking,undefined);assert.equal(body.max_tokens,4096);
  return Response.json({choices:[{finish_reason:'stop',message:{role:'assistant',content:`${warm?'WARM':'CHECK'}_${id}_OK`}}],usage:{prompt_tokens:warm?22100:22000,prompt_tokens_details:{cached_tokens:warm?14336:0}}});
 };
 const result=await runServingCheck({worker:target,config,check:'glm-cache',fetchImpl,onSample:s=>samples.push(s)});
 assert.equal(result.state,'passed');assert.equal(result.proof.check,'glm53_vllm_two_conversations_cold_to_warm');assert.deepEqual(samples,result.samples);assert.equal(calls.length,5);
 assert.match(result.scope,/No recovery enrollment/);
 for(const patch of [{url:'http://127.0.0.1:1235/v1'},{served_model:'changed'},{ssh:'other'},{context_length:null}]){
  await assert.rejects(runServingCheck({worker:{...target,...patch},config,check:'glm-cache',fetchImpl}),/exact configured pair/);
 }
 assert.equal(calls.length,5,'binding failures send no diagnostic requests');
});

function contextFixture({node=worker.id,usage={prompt_tokens:8191,completion_tokens:1,total_tokens:8192},finish='length',requestId='fixture-request',status=200}={}){
 const calls=[],samples=[],config={port:30000,api_key:'fixture-key',request_timeout_ms:360000000},target={...worker,context_length:8192};
 const args={worker:target,check:'routed-context',config,registry:{model_routes:{[worker.served_model]:[worker.id,'other']}},
  readDoor:async()=>({holding:false,core_ready:true,held:0}),onSample:s=>samples.push(s),
  fetchImpl:async(url,options)=>{calls.push({url,options,body:JSON.parse(options.body)});return Response.json({choices:[{text:'x',finish_reason:finish}],usage},{status,headers:{...(node?{'x-ds4-node':node}:{}),...(requestId?{'x-request-id':requestId}:{})}});}};
 return {calls,samples,args};
}
test('routed context proves native usage through a shared route with no direct traffic or production changes',async()=>{
 const f=contextFixture(),before=JSON.stringify(f.args.config),r=await runServingCheck(f.args),call=f.calls[0];
 assert.equal(r.state,'passed');assert.equal(r.observed_worker,worker.id);assert.equal(r.proof.requested_worker_verified,true);
 assert.deepEqual(r.samples,f.samples);assert.equal(f.calls.length,1);assert.equal(call.url,'http://127.0.0.1:30000/v1/completions');
 assert.deepEqual(Object.keys(call.body).sort(),['max_tokens','model','prompt','stream']);assert.equal(call.body.model,'PoolModel');
 assert.equal(call.body.prompt.length,8191);assert.ok(call.body.prompt.every(t=>t===42));assert.equal(call.body.max_tokens,1);
 assert.equal(call.options.headers['x-dsg-priority'],'idle-only');assert.equal(call.options.headers['x-dsg-model'],worker.served_model);
 assert.equal(call.options.headers['x-dsg-call-id'],r.proof.call_id);assert.equal(JSON.stringify(f.args.config),before);
 assert.equal(f.samples[0].label,'context-request-intent');assert.equal(f.samples[1].request_id,'fixture-request');
});
test('shared-route selection of another worker preserves that evidence without qualifying the requested worker or retrying',async()=>{
 const f=contextFixture({node:'other'}),r=await runServingCheck(f.args);
 assert.equal(r.state,'unverified');assert.equal(r.worker,worker.id);assert.equal(r.observed_worker,'other');assert.equal(r.proof.requested_worker_verified,false);
 assert.equal(r.proof.native_boundary_accepted,true);assert.equal(f.calls.length,1);assert.match(r.reason,/Do not automatically repeat/);
});
test('context proof rejects truncated, missing, inconsistent and unattributable native evidence',async()=>{
 for(const change of [{usage:{}},{usage:{prompt_tokens:8190,completion_tokens:1,total_tokens:8191}},
  {usage:{prompt_tokens:8191,completion_tokens:0,total_tokens:8191}},{usage:{prompt_tokens:8191,completion_tokens:1,total_tokens:9999}},
  {finish:null},{node:null},{node:'unknown'},{requestId:null},{status:500}]){
  const f=contextFixture(change);await assert.rejects(runServingCheck(f.args),/did not prove|attributable|HTTP 500/);
  assert.equal(f.calls.length,1);assert.ok(f.samples.some(s=>s.label==='context-response-headers'),'receipt survives rejection');
 }
});
test('routed context requires current route, observed capacity and ready Door before issuing any request',async()=>{
 for(const patch of [{registry:{model_routes:{}}},{worker:{...worker,context_length:NaN}},
  {worker:{...worker,context_length:8192,drained:true}},{worker:{...worker,context_length:2000001}},
  {readDoor:null},{readDoor:async()=>({holding:true,core_ready:true})}]){
  const f=contextFixture();await assert.rejects(runServingCheck({...f.args,...patch}));assert.equal(f.calls.length,0);
 }
 const f=contextFixture();let reads=0;f.args.readDoor=async()=>({holding:++reads>1,core_ready:true});
 const r=await runServingCheck(f.args);assert.equal(r.state,'unverified');assert.equal(r.proof.native_boundary_accepted,true);assert.match(r.reason,/readiness changed/);
});
