import test from 'node:test';
import assert from 'node:assert/strict';
import {createPiPriorityIntent} from './pi-priority-intent.mjs';
import {priorityEnvelope} from './priority-intent.mjs';

const baseUrl='http://127.0.0.1:12345/v1',provider='fixture-dsg';
const model={provider,baseUrl},options={sessionId:'pi-session'};
const request={method:'POST',headers:{authorization:'Bearer fixture','x-session-affinity':'pi-session'},body:'UNCHANGED INFERENCE'};
const endpoint=baseUrl+'/chat/completions';
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const userEntry=(id,content)=>({id,type:'message',message:{role:'user',content}});
function rig(){
  const calls=[];let branch=[{id:'user-1',type:'message',message:{role:'user',content:'Urgent: fix the actual user task.'}}];
  const reporter=createPiPriorityIntent({provider,baseUrl,fetchImpl:async(url,init)=>{calls.push({url,init});return new Response('{}');}});
  reporter.start({}, {sessionManager:{getSessionId:()=>options.sessionId,getBranch:()=>branch,getSessionName:()=>'<title> User task'}});
  return {calls,reporter,setBranch:rows=>{branch=rows;}};
}

test('Pi priority reports only the genuine latest user text, once, without changing inference bytes or affinity',async()=>{
  const r=rig();
  r.setBranch([{id:'user-1',type:'message',message:{role:'user',content:[{type:'text',text:'Urgent actual input'},{type:'image',data:'PRIVATE_IMAGE'}]}},{id:'assistant',type:'message',message:{role:'assistant',get content(){throw new Error('Do not read reasoning');}}},{id:'tool',type:'message',message:{role:'toolResult',get content(){throw new Error('Do not read tools');}}},{id:'cue',type:'custom_message',message:{role:'user',content:'PRIVATE_CUSTOM_CUE'}}]);
  const intent=r.reporter.snapshot(model,options),decorated=r.reporter.decorate(endpoint,request,intent);
  assert.equal(decorated.body,request.body);assert.equal(decorated.headers.get('x-session-affinity'),options.sessionId);
  assert.equal(r.calls.length,0,'dispatch decoration never waits for telemetry');
  await flush();assert.equal(r.calls.length,1);
  const sent=JSON.parse(r.calls[0].init.body);assert.equal(sent.excerpt,'Urgent actual input');assert.equal(sent.title,'<title> User task');
  priorityEnvelope(sent);assert.equal(new URL(r.calls[0].url).pathname,'/gateway/priority-intent');assert.equal(r.calls[0].init.redirect,'manual');
  assert.ok(!r.calls[0].init.body.includes('PRIVATE_'));assert.equal(intent.excerpt,null,'client drops its excerpt after submission');
  r.reporter.decorate(endpoint,request,r.reporter.snapshot(model,options));await flush();assert.equal(r.calls.length,1);
  r.reporter.stop();assert.equal(r.reporter.snapshot(model,options),null);
});

test('Pi priority honors exact provider, session, endpoint, existing hints',async()=>{
  const r=rig();assert.equal(r.reporter.snapshot({...model,provider:'other'},options),null);assert.equal(r.reporter.snapshot(model,{sessionId:'other'}),null);
  assert.equal(r.reporter.snapshot({...model,baseUrl:'http://127.0.0.1:54321/v1'},options),null);
  const intent=r.reporter.snapshot(model,options);
  for(const [url,init] of [[endpoint,{...request,headers:{...request.headers,'x-session-affinity':'another'}}],['http://127.0.0.1:54321/v1/chat/completions',request],[endpoint+'?query=1',request],[endpoint,{...request,headers:{...request.headers,'x-dsg-priority-intent':'caller-owned'}}],[endpoint,{...request,method:'GET'}]])assert.equal(r.reporter.decorate(url,init,intent),init);
  await flush();assert.equal(r.calls.length,0);
});

test('Pi priority bounds Unicode excerpts, changes intent on new user input and ignores missing user text',async()=>{
  const r=rig();r.setBranch([{id:'one',type:'message',message:{role:'user',content:'💡'.repeat(1000)}}]);
  const first=r.reporter.snapshot(model,options);assert.equal(Buffer.byteLength(first.excerpt),1024);assert.ok(!first.excerpt.includes('\ufffd'));
  r.reporter.decorate(endpoint,request,first);await flush();priorityEnvelope(JSON.parse(r.calls[0].init.body));
  r.setBranch([{id:'two',type:'message',message:{role:'user',content:'Next real instruction'}}]);
  const second=r.reporter.snapshot(model,options);assert.notEqual(second.id,first.id);assert.equal(r.reporter.decorate(endpoint,request,first),request);
  r.reporter.decorate(endpoint,request,second);await flush();assert.equal(r.calls.length,2);
  r.setBranch([{id:'three',type:'message',message:{role:'user',content:[{type:'image',data:'ignore'}]}}]);assert.equal(r.reporter.snapshot(model,options),null);
});

test('failed optional submissions are not retried and cannot reject inference decoration',async()=>{
  let calls=0;const reporter=createPiPriorityIntent({provider,baseUrl,fetchImpl:()=>{calls++;throw new Error('optional transport failed');}});
  reporter.start({}, {sessionManager:{getSessionId:()=>options.sessionId,getBranch:()=>[{id:'user',type:'message',message:{role:'user',content:'Actual user'}}]}});
  const intent=reporter.snapshot(model,options);assert.equal(reporter.decorate(endpoint,request,intent).body,request.body);await flush();
  reporter.decorate(endpoint,request,intent);await flush();assert.equal(calls,1);reporter.stop();
});

test('early Pi handoff identifies short follow-ups using genuine task context before inference starts',async()=>{
  const r=rig();
  r.setBranch([
    userEntry('task','Design a kite festival poster.'),
    {type:'message',message:{role:'assistant',get content(){throw new Error('Do not read reasoning');}}},
    {type:'message',message:{role:'toolResult',get content(){throw new Error('Do not read tool content');}}},
    {type:'custom_message',message:{role:'user',content:'PRIVATE_CUSTOM_TASK'}},
    userEntry('reply','Proceed.'),
  ]);
  const intent=r.reporter.snapshot(model,options);
  const decorated=r.reporter.decorate(endpoint,request,intent);
  assert.equal(decorated.body,request.body);
  assert.equal(decorated.headers.get('x-session-affinity'),options.sessionId);
  await flush();
  const envelope=JSON.parse(r.calls[0].init.body);
  assert.equal(envelope.excerpt,'Earlier user request: Design a kite festival poster.\nLatest user reply: Proceed.');
  assert.ok(!envelope.excerpt.includes('PRIVATE_'));
  priorityEnvelope(envelope);
  r.reporter.stop();
});

test('early Pi context does not cross an image-only user turn or exceed its user-history bound',()=>{
  const r=rig();
  r.setBranch([userEntry('task','Design a kite festival poster.'),userEntry('image',[{type:'image',data:'PRIVATE_IMAGE'}]),userEntry('reply','Proceed')]);
  assert.equal(r.reporter.snapshot(model,options).excerpt,'Proceed');
  r.setBranch([userEntry('task','Design a kite festival poster.'),...Array.from({length:9},(_,i)=>userEntry(`reply-${i}`,'Continue'))]);
  assert.equal(r.reporter.snapshot(model,options).excerpt,'Continue');
  r.reporter.stop();
});

 test('absent affinity uses request-bound metadata without adding routing identity',async()=>{
  const r=rig(),intent=r.reporter.snapshot(model,options);
  const init={...request,headers:{authorization:'Bearer fixture'}};
  const decorated=r.reporter.decorate(endpoint,init,intent);
  assert.equal(decorated.body,init.body);assert.equal(decorated.headers.get('x-session-affinity'),null);
  assert.equal(decorated.headers.get('x-dsg-priority-intent'),intent.id);
  await flush();const envelope=JSON.parse(r.calls[0].init.body);
  assert.equal(envelope.schema,2);assert.equal('session' in envelope,false);assert.equal(priorityEnvelope(envelope).chat,null);
});
