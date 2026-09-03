import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createContinuityFetch,registerPiContinuity} from './continuity-client.mjs';
import {evidence} from './dataset.mjs';
import {continuityForDisplay} from './continuity.mjs';
const baseUrl='http://127.0.0.1:30000/v1';
function refusal(init,change={}){
  const id=randomUUID();return new Response(JSON.stringify({error:{type:'gateway_error',code:'home_unavailable',continuity:{schema:1,request_id:id,call_id:init.headers.get('x-dsg-call-id'),dispatch_state:'not_dispatched',retry_class:'wait_then_retry',reason:'same_session_active',...change}}}),{status:503,headers:{'x-dsg-dispatch-state':'not_dispatched','x-request-id':id}});
}
test('certified waits retry unchanged input beyond three attempts with one call ID',async()=>{
  const sent=[],states=[],waits=[];
  const f=createContinuityFetch({baseUrl,wait:async(ms)=>waits.push(ms),onWait:s=>states.push(s),fetchImpl:async(url,init)=>{
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
test('rejection dataset allowlists identifiers and refuses arbitrary reasons/text',()=>{
  const row=evidence('rejection',{request_id:randomUUID(),session:'a'.repeat(64),node:'one',code:'home_unavailable',reason:'same_session_queued',dispatch_state:'not_dispatched',call_id:randomUUID(),prompt:'PRIVATE'});
  assert.equal(row.retry_class,'wait_then_retry');assert.ok(!JSON.stringify(row).includes('PRIVATE'));
  assert.equal(evidence('rejection',{request_id:randomUUID(),reason:'PRIVATE',dispatch_state:'not_dispatched'}),null);
});
test('dashboard continuity projection is bounded and excludes private extra fields',()=>{
  const s=continuityForDisplay({schema:1,safe_retry_contract:true,recent_rejections:[{request_id:randomUUID(),time:new Date().toISOString(),reason:'same_session_queued',dispatch_state:'not_dispatched',node:'one',session:'SECRET',body:'SECRET'},{request_id:'INVALID'},{request_id:randomUUID(),time:new Date().toISOString(),reason:'same_session_queued',dispatch_state:'dispatched'}]});
  assert.equal(s.recent_rejections.length,1);assert.ok(!JSON.stringify(s).includes('SECRET'));
});
