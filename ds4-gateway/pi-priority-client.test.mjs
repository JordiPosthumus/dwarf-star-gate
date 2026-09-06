import test from 'node:test';
import assert from 'node:assert/strict';
import {registerPiPriorityLens} from './pi-priority-client.mjs';

test('title-only adapter preserves inference transport and offers visible opt-out',async()=>{
  const events=new Map(),commands=new Map(),requests=[],intents=[],statuses=[];let registered;
  const pi={on:(name,fn)=>events.set(name,fn),registerCommand:(name,value)=>commands.set(name,value),registerProvider:(name,value)=>{registered={name,...value};}};
  const baseUrl='http://127.0.0.1:19999/v1',model={provider:'fixture',api:'openai-completions',baseUrl,contextWindow:262144,maxTokens:262144};
  const ctx={sessionManager:{getSessionId:()=> 'session',getSessionName:()=> 'Named synthetic task',getBranch:()=>[{type:'message',id:'user',message:{role:'user',content:'Complete this synthetic task'}}]},ui:{setStatus:(_key,text)=>statuses.push(text),notify:()=>{}}};
  let serialized;
  registerPiPriorityLens(pi,{provider:'fixture',baseUrl,fetchImpl:async(_url,init)=>{intents.push(JSON.parse(init.body));return new Response('{}');},streamSimple:(m,c,o)=>{serialized={m,c,o};return o.fetch(baseUrl+'/chat/completions',{method:'POST',headers:{authorization:'Bearer fixture','x-session-affinity':'session'},body:'{"unchanged":true}',redirect:'follow'});}});
  events.get('session_start')({},ctx);
  const originalFetch=async(url,init)=>{requests.push({url,init});return new Response('{}');};
  const options={sessionId:'session',fetch:originalFetch,maxTokens:262144,reasoning:'xhigh'};
  await registered.streamSimple(model,{},options);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(intents.length,1);assert.equal(intents[0].title,'Named synthetic task');
  assert.equal(serialized.m,model);assert.equal(serialized.o.maxTokens,262144);assert.equal(serialized.o.reasoning,'xhigh');
  assert.equal(requests[0].init.body,'{"unchanged":true}');assert.equal(requests[0].init.redirect,'follow');
  assert.equal(new Headers(requests[0].init.headers).has('x-dsg-call-id'),false);
  assert.match(statuses.at(-1),/on.*\/priority-lens off/);
  await commands.get('priority-lens').handler('off',ctx);
  await registered.streamSimple(model,{},options);
  assert.equal(serialized.o.maxTokens,options.maxTokens);assert.equal(serialized.o.reasoning,options.reasoning);assert.equal(new Headers(requests[1].init.headers).get('x-dsg-priority-intent'),'off');assert.equal(requests[1].init.body,requests[0].init.body);assert.equal(intents.length,1);assert.match(statuses.at(-1),/off/);
});

test('one visible opt-out controls every explicitly enrolled provider without crossing endpoints',async()=>{
  const events=new Map(),commands=new Map(),registered=new Map(),envelopes=[];
  const pi={on:(name,fn)=>{assert.ok(!events.has(name));events.set(name,fn);},registerCommand:(name,value)=>{assert.ok(!commands.has(name));commands.set(name,value);},registerProvider:(name,value)=>registered.set(name,value)};
  const providers=[{provider:'fixture-one',baseUrl:'http://127.0.0.1:19001/v1'},{provider:'fixture-two',baseUrl:'http://127.0.0.1:19002/v1'}];
  const ctx={sessionManager:{getSessionId:()=> 'session',getBranch:()=>[{type:'message',id:'user',message:{role:'user',content:'Design a kite festival poster.'}}]},ui:{setStatus:()=>{},notify:()=>{}}};
  registerPiPriorityLens(pi,{providers,fetchImpl:async(url,init)=>{envelopes.push({url,body:JSON.parse(init.body)});return new Response('{}');},streamSimple:(model,_context,options)=>options.fetch(model.baseUrl+'/chat/completions',{method:'POST',headers:{authorization:'Bearer fixture'},body:'UNCHANGED'})});
  events.get('session_start')({},ctx);
  const dispatch=async(model)=>{
    let observed;
    await registered.get(model.provider).streamSimple(model,{}, {sessionId:'session',fetch:async(_url,init)=>{observed=init;return new Response('{}');}});
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(observed.body,'UNCHANGED');
    return new Headers(observed.headers);
  };
  for(const model of providers)assert.ok((await dispatch(model)).get('x-dsg-priority-intent'));
  assert.equal(envelopes.length,2);
  assert.deepEqual(envelopes.map(e=>new URL(e.url).origin),providers.map(p=>new URL(p.baseUrl).origin));
  assert.equal((await dispatch({...providers[0],baseUrl:'http://127.0.0.1:19999/v1'})).get('x-dsg-priority-intent'),null);
  await commands.get('priority-lens').handler('off',ctx);
  for(const model of providers)assert.equal((await dispatch(model)).get('x-dsg-priority-intent'),'off');
  assert.equal(envelopes.length,2,'one opt-out stops sharing on both scopes');
  await commands.get('priority-lens').handler('on',ctx);
  for(const model of providers)assert.notEqual((await dispatch(model)).get('x-dsg-priority-intent'),'off');
  assert.equal(envelopes.length,4);
  events.get('session_shutdown')();
  for(const model of providers)assert.equal((await dispatch(model)).get('x-dsg-priority-intent'),null);
});

test('invalid provider sets fail before registering any provider or control',()=>{
  const pi=new Proxy({}, {get(){throw new Error('No registrations allowed');}});
  for(const providers of [[],[null],[{provider:'same'},{provider:'same'}]])assert.throws(()=>registerPiPriorityLens(pi,{providers,streamSimple:()=>{}}),/scope|provider/i);
});
