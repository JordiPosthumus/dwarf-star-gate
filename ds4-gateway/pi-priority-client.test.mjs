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
