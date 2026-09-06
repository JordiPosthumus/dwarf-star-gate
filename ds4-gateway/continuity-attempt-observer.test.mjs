import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createContinuityAttemptObserver,createCorrelatedContinuityAttemptObserver} from './continuity-attempt-observer.mjs';
const baseUrl='http://127.0.0.1:19999/v1',url=baseUrl+'/chat/completions';
const init=()=>({method:'POST',body:'PRIVATE',headers:{'x-dsg-call-id':randomUUID(),authorization:'Bearer PRIVATE'}});
function rejection(options,change={}){
  const id=randomUUID();return new Response(JSON.stringify({error:{type:'gateway_error',code:'queue_full',continuity:{schema:1,call_id:options.headers['x-dsg-call-id'],request_id:id,dispatch_state:'not_dispatched',retry_class:'wait_then_retry',...change}}}),{status:429,headers:{'x-dsg-dispatch-state':'not_dispatched','x-request-id':id}});
}
async function done(observer){for(let i=0;i<100&&observer.snapshot().pending;i++)await new Promise(r=>setTimeout(r,2));assert.equal(observer.snapshot().pending,0);return observer.snapshot();}
test('explicit correlation adds only a missing scoped ID and leaves ordinary transport options intact',async()=>{
  const sent=[],signal=new AbortController().signal;
  const observer=createCorrelatedContinuityAttemptObserver({baseUrl,fetchImpl:async(input,options)=>{sent.push({input,options});return rejection({...options,headers:Object.fromEntries(new Headers(options.headers))});}});
  const options={method:'POST',body:'UNCHANGED',headers:{authorization:'Bearer fixture'},signal,redirect:'manual'};
  await(await observer.fetch(url,options)).text();
  const actual=sent[0].options;assert.equal(actual.body,options.body);assert.equal(actual.signal,signal);assert.equal(actual.redirect,options.redirect);assert.equal(actual.headers.get('authorization'),'Bearer fixture');
  assert.match(actual.headers.get('x-dsg-call-id'),/^[a-f0-9-]{36}$/);assert.equal(options.headers['x-dsg-call-id'],undefined);
  const existing={...options,headers:{...options.headers,'x-dsg-call-id':randomUUID()}};
  await(await observer.fetch(url,existing)).text();assert.equal(sent[1].options,existing);
  observer.seal();assert.equal((await done(observer)).state,'certified_not_dispatched');assert.equal(sent.length,2);
  observer.close();
  await(await observer.fetch(url,options)).text();assert.equal(sent.at(-1).options,options,'closed adapter stops adding correlation IDs');
});
test('correlation never rewrites caller-owned IDs or unsupported request forms',async()=>{
  const variants=[['https://other.invalid/v1/chat/completions',{method:'POST',body:'same'}],[url,{method:'POST',body:'same',headers:{'x-dsg-call-id':'caller-owned-invalid'}}],[url,{method:'GET'}],[new Request(url,{method:'POST',body:'same'}),{}]];
  for(const [input,options] of variants){
    const observer=createCorrelatedContinuityAttemptObserver({baseUrl,fetchImpl:async(actual,init)=>{assert.equal(actual,input);assert.equal(init,options);return new Response('unchanged');}});
    assert.equal(await(await observer.fetch(input,options)).text(),'unchanged');observer.seal();assert.equal(observer.snapshot().state,'unknown');observer.close();
  }
});
test('observes all retries without changing arguments, response ownership or request count',async()=>{
  const calls=[],observer=createContinuityAttemptObserver({baseUrl,fetchImpl:async(input,options)=>{calls.push({input,options});return rejection(options);}});
  for(let i=0;i<3;i++){const options=init(),response=await observer.fetch(url,options);assert.equal(calls.at(-1).input,url);assert.equal(calls.at(-1).options,options);assert.equal((await response.json()).error.code,'queue_full');}
  assert.equal((await done(observer)).state,'unsealed');observer.seal();const s=observer.snapshot();assert.equal(s.state,'certified_not_dispatched');assert.equal(s.attempts,3);assert.equal(s.certified,3);assert.equal(calls.length,3);assert.ok(!JSON.stringify(s).includes('PRIVATE'));
  s.receipts[0].call_id='mutated';assert.notEqual(observer.snapshot().receipts[0].call_id,'mutated');
});
test('unknown earlier attempts cannot be erased by later valid certificates',async()=>{
  for(const failure of ['network','success','unmatched','wrong_call','operator']){
    let calls=0;const observer=createContinuityAttemptObserver({baseUrl,fetchImpl:async(_url,options)=>{if(++calls>1)return rejection(options);if(failure==='network')throw new Error('Fixture network failure');if(failure==='success')return new Response('ok');return rejection(options,failure==='wrong_call'?{call_id:randomUUID()}:failure==='operator'?{retry_class:'operator_required'}:{});}});
    const first=observer.fetch(failure==='unmatched'?'https://unrelated.invalid/v1/chat/completions':url,init());
    if(failure==='network')await assert.rejects(first,/Fixture/);else await(await first).text();
    await(await observer.fetch(url,init())).text();observer.seal();const s=await done(observer);assert.equal(s.state,'unknown');assert.equal(s.certified,1);assert.equal(s.unknown,1);assert.equal(calls,2);
  }
});
test('observer never adds response delay and pending inspection is not positive evidence',async()=>{
  let finish;const options=init(),id=randomUUID();
  const response=new Response(new ReadableStream({start(controller){finish=()=>{controller.enqueue(new TextEncoder().encode(JSON.stringify({error:{type:'gateway_error',code:'queue_full',continuity:{schema:1,call_id:options.headers['x-dsg-call-id'],request_id:id,dispatch_state:'not_dispatched',retry_class:'wait_then_retry'}}})));controller.close();};}}),{status:429,headers:{'x-dsg-dispatch-state':'not_dispatched','x-request-id':id}});
  const observer=createContinuityAttemptObserver({baseUrl,fetchImpl:async()=>response});assert.equal(await observer.fetch(url,options),response);observer.seal();assert.equal(observer.snapshot().state,'pending');finish();assert.equal((await response.json()).error.code,'queue_full');assert.equal((await done(observer)).state,'certified_not_dispatched');
});
test('capture call identity before fetch awaits; malformed and oversized bodies stay unknown',async()=>{
  for(const variant of ['mutation','malformed','oversized']){
    const options=init(),observer=createContinuityAttemptObserver({baseUrl,fetchImpl:async()=>{const response=variant==='mutation'?rejection(options):new Response(variant==='malformed'?'{':'x'.repeat(8193),{status:429,headers:{'x-dsg-dispatch-state':'not_dispatched'}});options.headers['x-dsg-call-id']=randomUUID();return response;}});
    await(await observer.fetch(url,options)).text();observer.seal();assert.equal((await done(observer)).state,variant==='mutation'?'certified_not_dispatched':'unknown');
  }
});
test('inspection timeout, close and post-seal calls cannot manufacture certificates or stop transport',async()=>{
  for(const action of ['timeout','close','overflow','postseal']){
    let calls=0,finish;const observer=createContinuityAttemptObserver({baseUrl,maxAttempts:1,inspectionMs:10,fetchImpl:async(_url,options)=>{calls++;if(action==='timeout'||action==='close')return new Response(new ReadableStream({start(c){finish=()=>{c.enqueue(new TextEncoder().encode('late original'));c.close();};}}),{status:429,headers:{'x-dsg-dispatch-state':'not_dispatched'}});return rejection(options);}});
    const response=await observer.fetch(url,init());
    if(action==='close')observer.close();
    if(action==='postseal')observer.seal();
    if(action==='overflow'||action==='postseal'){await response.text();await(await observer.fetch(url,init())).text();}
    observer.seal();assert.equal((await done(observer)).state,'unknown');
    if(finish){finish();assert.equal(await response.text(),'late original');}
    assert.equal(calls,action==='overflow'||action==='postseal'?2:1);
  }
});

test('existing continuity waits expose every certified attempt and keep one immutable call',async()=>{
  const {createContinuityFetch}=await import('./continuity-client.mjs');let calls=0,waits=0;const sent=[];
  const observer=createContinuityAttemptObserver({baseUrl,fetchImpl:async(input,options)=>{calls++;sent.push({input,body:options.body,call:options.headers.get('x-dsg-call-id')});return rejection({...options,headers:Object.fromEntries(options.headers)});}});
  const transport=createContinuityFetch({baseUrl,fetchImpl:observer.fetch,wait:async()=>{if(++waits===3)throw new Error('Fixture caller ended its certified wait');}});
  await assert.rejects(transport(url,{method:'POST',body:'IMMUTABLE'}),/Fixture caller ended/);observer.seal();
  const snapshot=await done(observer);assert.equal(snapshot.state,'certified_not_dispatched');assert.equal(snapshot.attempts,3);assert.equal(calls,3);assert.equal(new Set(sent.map(r=>r.call)).size,1);assert.ok(sent.every(r=>r.body==='IMMUTABLE'&&r.input===url));
});


test('redirected responses cannot certify the original request even with matching IDs',async()=>{
  for(const field of ['redirected','url']){
    const observer=createContinuityAttemptObserver({baseUrl,fetchImpl:async(_url,options)=>{const response=rejection(options);Object.defineProperty(response,field,{value:field==='redirected'?true:'https://other.invalid/v1/chat/completions'});return response;}});
    await(await observer.fetch(url,init())).text();observer.seal();assert.equal((await done(observer)).state,'unknown');
  }
});
