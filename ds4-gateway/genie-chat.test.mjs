import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {GenieChat,chatContext} from './genie-chat.mjs';
import {createChatDemo} from '../examples/genie-chat-demo.mjs';

function directory(t){const d=fs.mkdtempSync(path.join(os.tmpdir(),'dsg-chat-'));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));return d;}
test('follow-ups receive their own history, survive reload and never leak into another conversation',async t=>{
  const d=directory(t),calls=[];
  const provider={generate:async p=>{calls.push(p);return {text:p.history.length?'I remember your first question.':'First answer.'};}};
  let chat=new GenieChat({directory:d,provider}),a=chat.create(),b=chat.create();
  chat.submit(a.id,'My name is Example.','request-0001');await chat.idle();
  chat=new GenieChat({directory:d,provider});
  chat.submit(a.id,'What did I tell you?','request-0002');await chat.idle();
  assert.deepEqual(calls[1].history,[{role:'user',content:'My name is Example.'},{role:'assistant',content:'First answer.'}]);
  chat.submit(b.id,'Hello','request-0003');await chat.idle();assert.deepEqual(calls[2].history,[]);
  assert.equal(chat.get(a.id).messages.length,4);
  assert.equal(fs.statSync(path.join(d,`${a.id}.json`)).mode&0o777,0o600);
});
test('duplicate transport delivery produces one model call; a conflicting identifier is refused',async t=>{
  let calls=0,finish;const provider={generate:()=>{calls++;return new Promise(r=>finish=r);}};
  const chat=new GenieChat({directory:directory(t),provider}),s=chat.create();
  chat.submit(s.id,'Hello','request-duplicate');chat.submit(s.id,'Hello','request-duplicate');await Promise.resolve();
  assert.equal(calls,1);assert.throws(()=>chat.submit(s.id,'Changed','request-duplicate'),/already used/);
  assert.throws(()=>chat.submit(s.id,'Second','request-another'),/draft has not been sent/);
  finish({text:'Hello back'});await chat.idle();assert.equal(chat.get(s.id).messages.length,2);
});
test('failed providers keep the question and partial answer without exposing private error text or replaying',async t=>{
  const chat=new GenieChat({directory:directory(t),provider:{generate:async p=>{p.onDelta('Partial');throw new Error('credential=DO_NOT_SHOW');}}}),s=chat.create();
  chat.submit(s.id,'Question','request-failure');await chat.idle();const saved=chat.get(s.id);
  assert.equal(saved.messages[1].state,'failed');assert.equal(saved.messages[1].text,'Partial');assert.doesNotMatch(JSON.stringify(saved),/DO_NOT_SHOW/);
  let calls=0;const restored=new GenieChat({directory:chat.directory,provider:{generate:()=>{calls++;}}});assert.equal(calls,0);assert.equal(restored.get(s.id).messages[0].text,'Question');
});
test('startup preserves interrupted acceptance and never silently retries',t=>{
  const d=directory(t),chat=new GenieChat({directory:d}),s=chat.create();
  const file=path.join(d,`${s.id}.json`),saved=JSON.parse(fs.readFileSync(file));saved.messages=[{role:'user',text:'Kept',state:'complete'},{role:'assistant',text:'',state:'working'}];fs.writeFileSync(file,JSON.stringify(saved));
  const reopened=new GenieChat({directory:d});assert.equal(reopened.get(s.id).messages[1].state,'interrupted');assert.equal(reopened.get(s.id).messages[0].text,'Kept');
});
test('setup projection excludes credentials, private endpoints and request bodies, labels missing evidence',()=>{
  const context=chatContext({gateway:{api_key:'SECRET',workers:[{id:'example',url:'http://private.invalid',api_key_file:'/private/secret',context_length:65536,body:'PROMPT'}]}});
  assert.doesNotMatch(JSON.stringify(context),/SECRET|private|PROMPT/);assert.equal(context.servers[0].context_length,65536);assert.equal(chatContext({}).unavailable,true);
});
test('testing pauses new questions without cancelling a reply, and the next question gets fresh setup',async t=>{
  let suspended=false,model='example-before',finish;
  const calls=[];
  const chat=new GenieChat({directory:directory(t),isSuspended:()=>suspended,
    getSnapshot:()=>({gateway:{model,workers:[]}}),
    provider:{generate:input=>{calls.push(input);return new Promise(resolve=>finish=resolve);}}});
  const s=chat.create();chat.submit(s.id,'What is running?','request-before');await Promise.resolve();
  suspended=true;assert.equal(chat.status().available,false);
  assert.throws(()=>chat.submit(s.id,'Another question','request-paused'),/paused/);
  assert.equal(chat.get(s.id).messages[1].state,'working');
  finish({text:'The first answer.'});await chat.idle();assert.equal(chat.get(s.id).messages[1].state,'complete');
  suspended=false;model='example-after';chat.submit(s.id,'And now?','request-after');await Promise.resolve();
  assert.equal(calls[0].context.gateway.model,'example-before');assert.equal(calls[1].context.gateway.model,'example-after');
  finish({text:'The updated answer.'});await chat.idle();
});
test('dashboard chat requires same-origin CSRF and exposes persistent conversations only on its private endpoint',async t=>{
  const {server,chat}=createChatDemo({directory:directory(t),provider:{info:{engine:'test'},generate:async()=>({text:'A real saved reply.'})}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close();});
  const origin=`http://127.0.0.1:${server.address().port}`,url=`${origin}/api/genie/chat`;
  const state=await(await fetch(url)).json();
  assert.equal((await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:'{"action":"new"}'})).status,403);
  const headers={'content-type':'application/json',origin,'x-dsg-csrf':state.csrf_token};
  const s=await(await fetch(url,{method:'POST',headers,body:'{"action":"new"}'})).json();
  const accepted=await fetch(url,{method:'POST',headers,body:JSON.stringify({action:'send',conversation_id:s.id,text:'PRIVATE_CHAT_EXAMPLE',request_id:'request-http'})});assert.equal(accepted.status,202);
  await chat.idle();const saved=await(await fetch(`${url}/${s.id}`)).json();assert.equal(saved.messages[1].text,'A real saved reply.');
  assert.doesNotMatch(await(await fetch(`${origin}/api/status`)).text(),/PRIVATE_CHAT_EXAMPLE/);
  assert.equal((await fetch(`${url}/../../config.local.json`)).status,404);
});

test('one corrupt conversation is preserved without taking healthy chats offline',t=>{
  const d=directory(t),first=new GenieChat({directory:d}),saved=first.create();
  const bad='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.json';fs.writeFileSync(path.join(d,bad),'{truncated');
  const next=new GenieChat({directory:d});assert.equal(next.get(saved.id).id,saved.id);
  assert.deepEqual(next.status().unreadable_conversations,[bad]);assert.equal(fs.readFileSync(path.join(d,bad),'utf8'),'{truncated');
  assert.ok(next.create().id);
});
