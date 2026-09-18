import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {GenieChat,chatContext} from './genie-chat.mjs';
import {createChatDemo} from '../examples/genie-chat-demo.mjs';

function directory(t){const d=fs.mkdtempSync(path.join(os.tmpdir(),'dsg-chat-'));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));return d;}
test('saved chat context explains intentional maintenance without exporting private lock details or claiming tools are absent',async t=>{
  let supplied;const lock={id:'owned-test',name:'Music qualification',created_at:1000,review_at:null,control_channel:'approved_operation',reason:'PRIVATE_REASON'};
  const chat=new GenieChat({directory:directory(t),provider:{generate:async p=>{supplied=p.context;return {text:'The worker is reserved for its music test.'};}},getSnapshot:()=>({gateway:{workers:[{id:'one',is_healthy:false,drained:true,maintenance_locks:[lock]}],recovery:{automatic:true,workers:[{worker_id:'one',adapter:'docker',eligible:false}]}}})});
  const c=chat.create();chat.submit(c.id,'Why is this worker unavailable?','maintenance-question');await chat.idle();
  assert.equal(supplied.servers[0].maintenance_locks[0].name,'Music qualification');assert.equal(supplied.servers[0].is_healthy,false);assert.equal(supplied.recovery.workers[0].adapter,'docker');
  assert.doesNotMatch(JSON.stringify(supplied),/PRIVATE_REASON|No credentials, raw requests or server-control tools/);
  const restored=new GenieChat({directory:chat.directory});assert.deepEqual(restored.get(c.id).messages[1].context,supplied);
});
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

import {GenieMemory} from './genie-memory.mjs';
function notebookFixture(t){const memory=new GenieMemory(path.join(fs.realpathSync(directory(t)),'memory'));memory.setEnabled(true);const snapshot={time:1000,gateway:{workers:[{id:'worker-a'}]},genie:{memory:{enabled:true}}};const note=memory.saveOperatorNote({worker:'worker-a',text:'PRIVATE_OPERATIONAL_NOTE: preserve the existing configuration.'},snapshot);return {memory,snapshot,note};}
test('chat notebook access is explicit, shared between conversations, bounded, and saved with exact revisions',async t=>{
 const {memory,snapshot,note}=notebookFixture(t),calls=[];snapshot.genie.memory.notes=memory.retrieve(snapshot).notes;
 const provider={generate:async input=>{calls.push(input);return {text:'Historical context received.'};}};
 const disabled=new GenieChat({directory:directory(t),provider,getSnapshot:()=>snapshot});const off=disabled.create();disabled.submit(off.id,'What do you remember?','notebook-off');await disabled.idle();
 assert.equal(disabled.status().notebook_access,false);assert.doesNotMatch(JSON.stringify(calls[0]),/PRIVATE_OPERATIONAL_NOTE/);
 for(let i=0;i<15;i++)memory.saveOperatorNote({text:'Synthetic fleet preference '+i},snapshot);
 const before=fs.readFileSync(memory.file),chat=new GenieChat({directory:directory(t),provider,getSnapshot:()=>snapshot,notebook:memory});
 for(let i=0;i<2;i++){const session=chat.create();chat.submit(session.id,'What is recorded?','notebook-'+i);await chat.idle();const supplied=calls.at(-1).context.operational_notebook;assert.equal(supplied.included,true);assert.equal(supplied.truncated,true);assert.equal(supplied.notes.length,12);assert.ok(Buffer.byteLength(JSON.stringify(supplied.notes))<16384+24);assert.equal(calls.at(-1).context.operational_activity.storage.notebook_included,true);const reloaded=new GenieChat({directory:chat.directory,provider,notebook:memory});assert.deepEqual(reloaded.get(session.id).messages[1].context.operational_notebook,supplied);}
 assert.ok(fs.readFileSync(memory.file).equals(before));assert.equal(memory.notes.get(note.id).revision,1);
});
test('a queued chat uses corrected notebook revisions at dispatch and keeps earlier answer evidence',async t=>{
 const {memory,snapshot,note}=notebookFixture(t);let release;const gate=new Promise(r=>release=r),calls=[];
 const chat=new GenieChat({directory:directory(t),getSnapshot:()=>snapshot,notebook:memory,runQuestion:async answer=>{await gate;return answer();},provider:{generate:async input=>{calls.push(input);return {text:'A recorded preference.'};}}});
 const session=chat.create();chat.submit(session.id,'Check the current note.','notebook-wait');await Promise.resolve();
 memory.saveOperatorNote({id:note.id,expected_revision:1,worker:'worker-a',text:'Corrected synthetic preference.'},snapshot);release();await chat.idle();
 assert.equal(calls[0].context.operational_notebook.notes[0].revision,2);assert.equal(calls[0].context.operational_notebook.notes[0].verification,'operator_intent_not_authority');
 memory.saveOperatorNote({id:note.id,expected_revision:2,worker:'worker-a',text:'Corrected synthetic preference.',state:'archived'},snapshot);
 chat.submit(session.id,'Check again.','notebook-archived');await chat.idle();assert.deepEqual(calls[1].context.operational_notebook.notes,[]);assert.equal(chat.get(session.id).messages[1].context.operational_notebook.notes[0].revision,2);
 assert.ok(!JSON.stringify(calls[1].history).includes('Corrected synthetic preference'));
});
test('disabled or unavailable notebook does not block chat or reuse earlier notebook context',async t=>{
 const {memory,snapshot}=notebookFixture(t);let release;const gate=new Promise(r=>release=r),calls=[];
 const chat=new GenieChat({directory:directory(t),getSnapshot:()=>snapshot,notebook:memory,runQuestion:async answer=>{await gate;return answer();},provider:{generate:async input=>{calls.push(input);return {text:'Available without notebook.'};}}});
 const session=chat.create();chat.submit(session.id,'Question while waiting.','notebook-disable');await Promise.resolve();memory.setEnabled(false);release();await chat.idle();
 assert.equal(calls[0].context.operational_notebook.reason,'memory_disabled');assert.doesNotMatch(JSON.stringify(calls[0]),/PRIVATE_OPERATIONAL_NOTE/);
 memory.setEnabled(true);memory.error='PRIVATE_STORAGE_ERROR';chat.submit(session.id,'Still answer.','notebook-error');await chat.idle();assert.equal(calls[1].context.operational_notebook.reason,'notebook_unavailable');assert.doesNotMatch(JSON.stringify(calls[1]),/PRIVATE_STORAGE_ERROR|PRIVATE_OPERATIONAL_NOTE/);assert.equal(chat.get(session.id).messages.at(-1).state,'complete');
});

test('follow-ups are saved before dispatch and run in order with completed history and fresh context',async t=>{
 const calls=[];let finish,model='initial';
 const chat=new GenieChat({directory:directory(t),getSnapshot:()=>({gateway:{model,workers:[]}}),provider:{generate:p=>{calls.push(p);return calls.length===1?new Promise(r=>finish=r):Promise.resolve({text:'Answer '+calls.length});}}});
 const s=chat.create();chat.submit(s.id,'First','queued-first');await Promise.resolve();
 const second=chat.submit(s.id,'Second','queued-second');chat.submit(s.id,'Third','queued-third');chat.submit(s.id,'Second','queued-second');
 assert.equal(second.queued,1);assert.equal(calls.length,1);
 const disk=JSON.parse(fs.readFileSync(path.join(chat.directory,s.id+'.json')));assert.equal(disk.version,1);assert.deepEqual(disk.messages.filter(m=>m.role==='assistant').map(m=>m.state),['working','working','working']);assert.deepEqual(disk.messages.filter(m=>m.role==='assistant').map(m=>m.pending_dispatch??false),[false,true,true]);
 model='fresh';finish({text:'First answer'});await chat.idle();
 assert.deepEqual(calls.map(p=>p.message),['First','Second','Third']);
 assert.deepEqual(calls[1].history,[{role:'user',content:'First'},{role:'assistant',content:'First answer'}]);
 assert.deepEqual(calls[2].history.map(m=>m.content),['First','First answer','Second','Answer 2']);
 assert.equal(calls[1].context.gateway.model,'fresh');assert.equal(chat.get(s.id).queued,0);assert.equal(chat.get(s.id).busy,false);
});

test('a failed active answer pauses saved follow-ups; explicit continuation never replays it',async t=>{
 const calls=[];let reject;const chat=new GenieChat({directory:directory(t),provider:{generate:p=>{calls.push(p.message);if(calls.length===1){p.onDelta('Partial evidence');return new Promise((_,r)=>reject=r);}return Promise.resolve({text:'Following answer'});}}});
 const s=chat.create();chat.submit(s.id,'First','pause-first');await Promise.resolve();chat.submit(s.id,'Follow-up','pause-second');reject(new Error('PRIVATE_BACKEND_ERROR'));await chat.idle();
 const paused=chat.get(s.id);assert.equal(paused.messages[1].text,'Partial evidence');assert.equal(paused.messages[1].state,'failed');assert.equal(paused.queued,1);assert.equal(paused.queue_paused,paused.messages[1].id);assert.doesNotMatch(JSON.stringify(paused),/PRIVATE_BACKEND_ERROR/);
 const restored=new GenieChat({directory:chat.directory,provider:{generate:async p=>{calls.push(p.message);return {text:'Following answer'};}}});await restored.idle();assert.deepEqual(calls,['First']);
 assert.throws(()=>restored.resume(s.id,'stale-reply'),/changed/);restored.resume(s.id,paused.queue_paused);restored.resume(s.id,paused.queue_paused);await restored.idle();
 assert.deepEqual(calls,['First','Follow-up']);assert.equal(restored.get(s.id).messages[1].state,'failed');assert.equal(restored.get(s.id).queue_paused,undefined);
});

test('restart recovers undispatched queued work but holds it behind an interrupted answer',async t=>{
 for(const interrupted of [false,true]){
  const d=directory(t),calls=[];const chat=new GenieChat({directory:d,provider:{generate:()=>{throw new Error('must not dispatch before close');}}});const s=chat.create();chat.submit(s.id,'Queued','restart-queued');chat.close();await chat.idle();
  const file=path.join(d,s.id+'.json'),saved=JSON.parse(fs.readFileSync(file));assert.equal(saved.messages[1].state,'working');assert.equal(saved.messages[1].pending_dispatch,true);
  if(interrupted){saved.messages.unshift({id:'old-user',request_id:'prior-request',role:'user',text:'Earlier',state:'complete'},{id:'old-reply',role:'assistant',text:'Saved partial',state:'working'});fs.writeFileSync(file,JSON.stringify(saved));}
  const restored=new GenieChat({directory:d,provider:{generate:async p=>{calls.push(p.message);return {text:'Recovered pending answer'};}}});await restored.idle();
  if(interrupted){assert.deepEqual(calls,[]);assert.equal(restored.get(s.id).messages[1].state,'interrupted');assert.equal(restored.get(s.id).queued,1);assert.equal(restored.get(s.id).queue_paused,'old-reply');restored.resume(s.id,'old-reply');await restored.idle();}
  assert.deepEqual(calls,['Queued']);
 }
});

test('a failed follow-up save cannot detach the active answer or send the unsaved question',async t=>{
 let finish;const calls=[],chat=new GenieChat({directory:directory(t),provider:{generate:p=>{calls.push(p.message);return new Promise(r=>finish=r);}}});const s=chat.create();chat.submit(s.id,'First','save-first');await Promise.resolve();
 const save=chat.save.bind(chat);chat.save=()=>{throw new Error('disk full');};assert.throws(()=>chat.submit(s.id,'Unstored','save-unsent'),/Could not save/);chat.save=save;finish({text:'Still saved'});await chat.idle();
 assert.deepEqual(calls,['First']);assert.equal(chat.get(s.id).messages.length,2);assert.equal(chat.get(s.id).messages[1].text,'Still saved');assert.equal(JSON.parse(fs.readFileSync(path.join(chat.directory,s.id+'.json'))).messages[1].text,'Still saved');
});

test('testing holds an accepted follow-up without dropping it; the existing tick resumes after testing',async t=>{
 let suspended=false,finish;const calls=[];const chat=new GenieChat({directory:directory(t),isSuspended:()=>suspended,provider:{generate:p=>{calls.push(p.message);return calls.length===1?new Promise(r=>finish=r):Promise.resolve({text:'Second answer'});}}});const s=chat.create();
 chat.submit(s.id,'First','testing-first');await Promise.resolve();chat.submit(s.id,'Second','testing-second');suspended=true;finish({text:'First answer'});await chat.idle();chat.tick();assert.deepEqual(calls,['First']);assert.equal(chat.get(s.id).queued,1);
 suspended=false;chat.tick();await chat.idle();assert.deepEqual(calls,['First','Second']);
});

test('continuing a paused queue requires same-origin CSRF and exact control fields',async t=>{
 let reject;const calls=[];const {server,chat}=createChatDemo({directory:directory(t),provider:{generate:p=>{calls.push(p.message);return calls.length===1?new Promise((_,r)=>reject=r):Promise.resolve({text:'Next'});}}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close();});const origin=`http://127.0.0.1:${server.address().port}`,url=origin+'/api/genie/chat',state=await(await fetch(url)).json();
 const s=chat.create();chat.submit(s.id,'First','control-first');await Promise.resolve();chat.submit(s.id,'Second','control-second');reject(new Error('failed'));await chat.idle();const input={action:'continue-queue',conversation_id:s.id,expected_reply_id:chat.get(s.id).queue_paused};
 const post=(headers,value=input)=>fetch(url,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(value)});
 assert.equal((await post({})).status,403);const headers={origin,'x-dsg-csrf':state.csrf_token};assert.equal((await post(headers,{...input,authority:'restart'})).status,400);assert.deepEqual(calls,['First']);assert.equal((await post(headers)).status,202);await chat.idle();assert.deepEqual(calls,['First','Second']);
});

test('actual streamed answer chunks refresh activity and later reasoning can supersede them',async t=>{
 let now=1000,call,finish;const chat=new GenieChat({directory:directory(t),now:()=>now,provider:{generate:p=>{call=p;return new Promise(r=>finish=r);}}}),s=chat.create();
 chat.submit(s.id,'Hello','stream-activity');await Promise.resolve();
 call.onProgress({phase:'reasoning',step:3,reasoning_chars:100});now=40000;call.onDelta('Partial answer');
 let m=chat.get(s.id).messages[1];assert.equal(m.progress.at,40000);assert.equal(m.progress.phase,'answer');assert.equal(m.progress.step,3);
 now=42000;call.onProgress({phase:'reasoning',step:4,reasoning_chars:120});m=chat.get(s.id).messages[1];assert.equal(m.progress.phase,'reasoning');assert.equal(m.text,'Partial answer');
 finish({text:'Complete answer'});await chat.idle();
});

 test('recovery policy stays distinct from worker eligibility and missing policy is unknown',()=>{
  const c=chatContext({gateway:{recovery:{configured:true,automatic:true,profile_handback_automatic:true,token:'PRIVATE',workers:[{worker_id:'example',configured:true,eligible:false,reason:'service_identity_or_profile_unverified',enrollment:{secret:'PRIVATE'}}]}}});
  assert.equal(c.recovery.automatic,true);assert.equal(c.recovery.workers[0].eligible,false);assert.equal(c.recovery.workers[0].reason,'service_identity_or_profile_unverified');assert.doesNotMatch(JSON.stringify(c),/PRIVATE/);assert.equal(chatContext({}).recovery,null);assert.equal(chatContext({gateway:{recovery:{automatic:false}}}).recovery.automatic,false);
 });

test('progress checkpoints avoid rewriting long history and recover partial output after restart without replay',async t=>{
 const d=directory(t);let call,finish,calls=0;
 const chat=new GenieChat({directory:d,provider:{generate:async p=>{calls++;if(calls===1)return {text:'x'.repeat(4_000_000)};call=p;return new Promise(r=>finish=r);}}});
 const c=chat.create();chat.submit(c.id,'First','checkpoint-first');await chat.idle();
 chat.submit(c.id,'Next','checkpoint-second');await Promise.resolve();
 const main=path.join(d,`${c.id}.json`),before=fs.readFileSync(main);let written=0;
 const write=chat.writePrivate.bind(chat);chat.writePrivate=(file,value)=>{written+=Buffer.byteLength(JSON.stringify(value));write(file,value);};
 call.onDelta('Retained partial');
 for(let step=0;step<100;step++)call.onProgress({phase:'reasoning',step,reasoning_chars:step*10});
 assert.ok(fs.readFileSync(main).equals(before));assert.ok(written<100_000,`100 updates wrote ${written} bytes`);t.diagnostic(`100 progress updates: ${written} checkpoint bytes versus at least ${before.length*100} bytes rewriting the conversation`);
 assert.equal(chat.get(c.id).messages.at(-1).progress.step,99);
 const checkpoint=path.join(d,`${c.id}.progress.json`);assert.equal(fs.statSync(checkpoint).mode&0o777,0o600);
 const recoveredDirectory=directory(t);fs.copyFileSync(main,path.join(recoveredDirectory,path.basename(main)));fs.copyFileSync(checkpoint,path.join(recoveredDirectory,path.basename(checkpoint)));
 let replay=0;const recovered=new GenieChat({directory:recoveredDirectory,provider:{generate:()=>{replay++;}}});
 const m=recovered.get(c.id).messages.at(-1);assert.equal(m.state,'interrupted');assert.equal(m.text,'Retained partial');assert.equal(m.progress.step,99);assert.equal(replay,0);
 finish({text:'Complete answer'});await chat.idle();
 const reopened=new GenieChat({directory:d});assert.equal(reopened.get(c.id).messages.at(-1).text,'Complete answer');assert.equal(reopened.get(c.id).messages.at(-1).state,'complete');
});

test('tool receipts supersede checkpoints and later progress recovers against the new revision',async t=>{
 const d=directory(t);let call,finish;
 const chat=new GenieChat({directory:d,provider:{generate:p=>{call=p;return new Promise(r=>finish=r);}}});const c=chat.create();chat.submit(c.id,'Inspect setup','checkpoint-tool');await Promise.resolve();
 call.onProgress({phase:'reasoning',step:1,reasoning_chars:10});
 const checkpoint=path.join(d,`${c.id}.progress.json`),stale=fs.readFileSync(checkpoint);
 call.onSparkSetup({tool:'spark_setup_status',state:'complete',at:'2026-09-18T00:00:00Z',result:{targets:[]}});
 call.onDelta('New partial');call.onProgress({phase:'reasoning',step:2,reasoning_chars:20});
 const copy=directory(t);for(const name of fs.readdirSync(d))fs.copyFileSync(path.join(d,name),path.join(copy,name));
 const recovered=new GenieChat({directory:copy});const m=recovered.get(c.id).messages.at(-1);assert.equal(m.text,'New partial');assert.equal(m.progress.step,2);assert.equal(m.spark_setup.events.length,1);
 finish({text:'Finished'});await chat.idle();fs.writeFileSync(checkpoint,stale);
 const final=new GenieChat({directory:d}).get(c.id).messages.at(-1);assert.equal(final.text,'Finished');assert.equal(final.spark_setup.events.length,1);
});

test('unreadable progress is preserved and reported without hiding its healthy conversation',async t=>{
 const d=directory(t),seed=new GenieChat({directory:d}),c=seed.create(),name=`${c.id}.progress.json`;fs.writeFileSync(path.join(d,name),'{broken');
 let call,finish;const chat=new GenieChat({directory:d,provider:{generate:p=>{call=p;return new Promise(r=>finish=r);}}});
 assert.deepEqual(chat.status().unreadable_conversations,[name]);assert.equal(chat.get(c.id).id,c.id);
 chat.submit(c.id,'Hello','checkpoint-corrupt');await Promise.resolve();call.onProgress({phase:'model_wait',step:0,reasoning_chars:0});
 const preserved=chat.status().unreadable_conversations[0];assert.match(preserved,/progress.unreadable/);assert.equal(fs.readFileSync(path.join(d,preserved),'utf8'),'{broken');
 finish({text:'Hello back'});await chat.idle();assert.equal(chat.get(c.id).messages.at(-1).state,'complete');
 assert.deepEqual(new GenieChat({directory:d}).status().unreadable_conversations,[preserved]);
});
