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
  assert.doesNotMatch(JSON.stringify(context),/SECRET|private\.invalid|api_key|PROMPT/);assert.equal(context.servers[0].context_length,65536);assert.equal(chatContext({}).unavailable,true);
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

// Exercise the actual chat acceptance path against the existing fleet reviewer.
import {Genie} from './genie.mjs';
const reviewReply=()=>Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({assessment:'Synthetic healthy fleet.',ticker:[{severity:'info',text:'Synthetic observation.',evidence_refs:['fleet']}]})}}]});
const nextTurn=()=>new Promise(resolve=>setImmediate(resolve));
function chatReviewer(t,fetchImpl){const g=new Genie({url:'http://127.0.0.1:9001/v1'},()=>({time:Date.now(),gateway:{workers:[]}}),{fetchImpl});t.after(()=>g.close());return g;}
test('accepted conversational questions yield only the routine review; duplicate and rejected messages do nothing',async t=>{
 let aborts=0,answers=0;
 const g=chatReviewer(t,(_url,{signal})=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>{aborts++;reject(new DOMException('Aborted','AbortError'));},{once:true})));
 const chat=new GenieChat({directory:directory(t),runQuestion:(answer,wait)=>g.answerChat(answer,wait),provider:{generate:async()=>{answers++;return {text:'Owner answer'};}}});
 const s=chat.create(),routine=g.ask(undefined,{kind:'scheduled'});
 assert.throws(()=>chat.submit(s.id,'','request-rejected'),/Enter a message/);assert.equal(aborts,0);
 const originalSave=chat.save.bind(chat);chat.save=()=>{throw new Error('disk unavailable');};assert.throws(()=>chat.submit(s.id,'Not saved','request-unsaved'),/Could not save/);assert.equal(aborts,0);chat.save=originalSave;
 chat.submit(s.id,'Hello','request-accepted');chat.submit(s.id,'Hello','request-accepted');await routine;await chat.idle();
 assert.equal(aborts,1);assert.equal(answers,1);assert.equal(g.error,null);assert.equal(g.chatQuestions,0);assert.equal(chat.get(s.id).messages[1].state,'complete');
});
test('chat waits for an action review, then uses fresh setup; another conversation remains active',async t=>{
 let finishReview,signal,finishOther,questionInput;
 const g=chatReviewer(t,(_url,opts)=>{signal=opts.signal;return new Promise(r=>finishReview=()=>r(reviewReply()));});
 let model='before';
 const chat=new GenieChat({directory:directory(t),getSnapshot:()=>({gateway:{model,workers:[]}}),runQuestion:(answer,wait)=>g.answerChat(answer,wait),provider:{generate:input=>input.message==='Other conversation'?new Promise(r=>finishOther=r):(questionInput=input,Promise.resolve({text:'Fresh answer'}))}});
 const other=chat.create(),s=chat.create();chat.submit(other.id,'Other conversation','request-other');await nextTurn();
 const action=g.ask('Review action offers',{kind:'action'});chat.submit(s.id,'What happened?','request-question');await nextTurn();
 assert.equal(signal.aborted,false);assert.equal(questionInput,undefined);assert.equal(chat.get(s.id).messages[1].waiting_for_review,'action');assert.equal(chat.get(other.id).busy,true);
 model='after';finishReview();await action;await nextTurn();assert.equal(questionInput.context.gateway.model,'after');assert.equal(chat.get(s.id).messages[1].state,'complete');assert.equal(chat.get(other.id).busy,true);
 finishOther({text:'Other answer'});await chat.idle();assert.equal(g.chatQuestions,0);assert.equal(chat.get(s.id).messages[1].waiting_for_review,undefined);
});
test('chat waiting behind a review cannot dispatch after shutdown or testing begins',async t=>{
 for(const stop of ['close','testing']){
  let finishReview,calls=0,suspended=false;
  const g=chatReviewer(t,()=>new Promise(r=>finishReview=()=>r(reviewReply())));
  const chat=new GenieChat({directory:directory(t),isSuspended:()=>suspended,runQuestion:(answer,wait)=>g.answerChat(answer,wait),provider:{generate:async()=>{calls++;return {text:'Unexpected'};}}}),s=chat.create();
  const action=g.ask('Action review',{kind:'action'});chat.submit(s.id,'Wait','request-waiting');await nextTurn();
  if(stop==='close')chat.close();else suspended=true;
  finishReview();await action;await chat.idle();assert.equal(calls,0);assert.equal(g.chatQuestions,0);assert.equal(chat.get(s.id).messages[1].state,'failed');
 }
});
test('active chat defers routine reviews without blocking urgent action offers or changing a disabled reviewer',async t=>{
 let finish;const g=chatReviewer(t,async()=>reviewReply());
 const question=g.answerChat(()=>new Promise(r=>finish=r));const asked=[];g.ask=async(_question,{kind})=>{asked.push(kind);};
 g.attempt=0;g.tick();assert.deepEqual(asked,[]);
 g.getSnapshot=()=>({gateway:{recovery:{automatic:true,workers:[{worker_id:'example',eligible:true,evidence_id:'offered-proof'}]}}});g.tick();assert.deepEqual(asked,['action']);
 finish('done');await question;assert.equal(g.chatQuestions,0);g.getSnapshot=()=>({gateway:{workers:[]}});g.attempt=0;g.tick();assert.deepEqual(asked,['action','scheduled']);
 g.setEnabled(false);assert.equal(await g.answerChat(async()=> 'Chat remains available'),'Chat remains available');assert.equal(g.enabled,false);
});

import {activityForChat} from './genie-chat-activity.mjs';
const activityId='11111111-1111-4111-8111-111111111111';
function activityFixture(){return {time:2000,gateway:{workers:[],recovery:{operations:[{id:activityId,worker_id:'worker-a',updated_at:1500,actor:'operator',state:'verified_paused',service_action:'restart',service_action_issued:true,proof:{secret:'PRIVATE_PROOF'},command:'PRIVATE_COMMAND',api_key:'SECRET'}]}},
 genie:{busy:false,reports:[{id:activityId,time:1400,evidence_at:1200,served_by:'dedicated',served_on:null,ticker_error:null,ticker:[{text:'PRIVATE_HEADLINE'}],text:'PRIVATE_REVIEW',actions_taken:[{shell:'PRIVATE_COMMAND'}]}],provider_actions:[{id:activityId,time:1300,served_by:'pool_fallback',served_on:'worker-b',text:'PRIVATE_TEXT'}],memory:{enabled:true,notes:[{text:'PRIVATE_NOTE'}]},provider_action_storage:{available:true},provider_assignment_storage:{available:true}},
 genie_handovers:{rows:[{actor:'genie',source:'worker-a',destination:'worker-b',at:1600,service_state:'complete',waiting_before_move_ms:50,prompt:'PRIVATE_PROMPT',request_id:'PRIVATE_REQUEST'}]}};}
test('chat operational evidence shares only attributed receipt fields, never notebook or report prose',()=>{
 const a=activityForChat(activityFixture());assert.equal(a.available,true);assert.equal(a.reviews.length,1);assert.equal(a.reviews[0].retention,'dashboard_session');assert.equal(a.reviews[0].valid_assessment,true);
 assert.deepEqual(a.actions.map(r=>r.kind),['queue_move','recovery','review_placement']);assert.equal(a.actions[1].actor,'operator');assert.equal(a.actions[1].state,'verified_paused');assert.equal(a.actions[2].placement,'pool_fallback');
 assert.equal(a.storage.notebook_enabled,true);assert.equal(a.storage.notebook_included,false);assert.doesNotMatch(JSON.stringify(a),/PRIVATE_|SECRET|shell|api_key/);assert.match(a.scope,/not.*current health/);
});
test('operational projection preserves failures and missing evidence instead of inventing success',()=>{
 const s=activityFixture();s.genie.reports[0].ticker_error='invalid_structured_review';s.gateway.recovery.operations[0].state='failed';s.genie.provider_action_storage.available=false;
 const a=activityForChat(s);assert.equal(a.reviews[0].valid_assessment,false);assert.equal(a.actions[1].state,'failed');assert.equal(a.storage.pool_receipts_available,false);
 assert.equal(activityForChat({}).available,false);assert.match(activityForChat({}).scope,/do not infer/);
 s.gateway.recovery.operations[0].state='PRIVATE_STATE';s.genie_handovers.rows[0].source='/private/path';s.genie.provider_actions[0].served_on='http://private.invalid';const clean=activityForChat(s);assert.equal(clean.actions.length,1);assert.equal(clean.actions[0].worker,null);
});
test('chat activity keeps the newest bounded receipts and attributes automatic actions accurately',()=>{
 const s=activityFixture();s.genie.provider_actions=Array.from({length:40},(_,n)=>({id:activityId,time:n,served_by:'pool_assigned',served_on:'worker-a'}));s.gateway.recovery.operations[0].actor='detector';s.genie_handovers.rows[0].actor='scheduler';
 const a=activityForChat(s);assert.equal(a.actions.length,30);assert.equal(a.truncated,true);assert.equal(a.actions[0].actor,'scheduler');assert.equal(a.actions[1].actor,'detector');assert.equal(a.actions[2].at,39);
});
test('the exact operational evidence supplied to a chat answer survives conversation reload',async t=>{
 let received;const d=directory(t),s=activityFixture(),chat=new GenieChat({directory:d,getSnapshot:()=>s,provider:{generate:async input=>{received=input;return {text:'The operator recovery remained paused.'};}}}),c=chat.create();
 chat.submit(c.id,'What happened?','activity-question');await chat.idle();const saved=new GenieChat({directory:d}).get(c.id);
 assert.deepEqual(saved.messages[1].context.operational_activity,received.context.operational_activity);assert.equal(received.context.operational_activity.actions[1].state,'verified_paused');assert.doesNotMatch(JSON.stringify(received),/PRIVATE_|SECRET/);
});
