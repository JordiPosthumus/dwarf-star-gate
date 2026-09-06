import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {randomUUID} from 'node:crypto';
import {PriorityClassifier,priorityProvider,priorityAdvice} from './priority-classifier.mjs';
import {PriorityLens} from './priority-lens.mjs';
import {PriorityIntents,priorityEnvelope} from './priority-intent.mjs';

const fixtureGenie=()=>({config:{url:'http://127.0.0.1:10001/v1',api_key:'fixture',fallback:{url:'http://127.0.0.1:10002/v1',api_key:'fixture'}},enabled:true,source:'primary',busy:false,providerAttempts:[]});
const snapshot=(now=100000)=>({gateway_at:now,gateway_error:null,gateway:{model:'deepseek-v4-flash',genie_admission_version:1,draining:false,workers:[{is_healthy:true,load:0,queued:0,drained:false}]}});
const response=advice=>({ok:true,body:Readable.from([JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(advice)}}]})])});
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function rig(fetchImpl){
  let now=100000;const lens=new PriorityLens(),intents=new PriorityIntents({lens,now:()=>now}),genie=fixtureGenie(),calls=[];
  const input={schema:1,id:randomUUID(),session:'fixture-session',client:'pi',title:'PRIVATE_TASK_TITLE',excerpt:'PRIVATE_RECENT_USER_EXCERPT'};
  intents.receive(input);intents.bind(input.id,{key:priorityEnvelope(input).chat,sequence:1});
  const control=async(route,value)=>{calls.push(route);if(route==='/priority-status')return {enabled:lens.enabled,intents:intents.status()};if(route==='/priority-review-next')return {review:intents.claim()};if(route==='/priority-review-result')return {accepted:intents.complete(value)};throw new Error('Unexpected control');};
  const classifier=new PriorityClassifier({genie,poolUrl:'http://127.0.0.1:10002/v1',snapshot:()=>snapshot(now),control,fetchImpl,now:()=>now});
  return {lens,intents,genie,classifier,calls,input,advance:ms=>{now+=ms;}};
}

test('classifier selects configured providers before dispatch using fresh free pool evidence',()=>{
  const genie=fixtureGenie();assert.equal(priorityProvider(genie,snapshot(),100000,'http://127.0.0.1:10002/v1').source,'dedicated');
  genie.busy=true;genie.activeProvider='dedicated';assert.equal(priorityProvider(genie,snapshot(),100000,'http://127.0.0.1:10002/v1').reason,'dedicated_busy');
  assert.equal(priorityProvider(genie,snapshot(),107000,'http://127.0.0.1:10002/v1'),null);
  const full=snapshot();full.gateway.workers[0].load=1;assert.equal(priorityProvider(genie,full,100000,'http://127.0.0.1:10002/v1'),null);
  genie.busy=false;genie.providerAttempts=[{provider:'dedicated',started_at:1000,finished_at:90000,outcome:'complete'}];assert.equal(priorityProvider(genie,snapshot(),100000,'http://127.0.0.1:10002/v1').source,'pool');
  assert.equal(priorityProvider(genie,snapshot(),100000,'http://127.0.0.1:9999/v1'),null,'unrelated fallback has no pool admission guarantee');
  genie.enabled=false;assert.equal(priorityProvider(genie,snapshot(),100000,'http://127.0.0.1:10002/v1'),null);
});

test('classifier accepts typed advice, keeps excerpt only in model input, and leaves ordinary Genie options unchanged',async()=>{
  const modelCalls=[],r=rig(async(url,init)=>{modelCalls.push({url,init});return response({priority:'High',reason:'urgent'});});
  r.genie.config.timeout_ms=7200000;r.genie.config.fallback.timeout_ms=7200000;
  await r.classifier.tick();assert.equal(modelCalls.length,1);assert.equal(r.classifier.completed,1);
  const body=JSON.parse(modelCalls[0].init.body);assert.equal(body.reasoning_effort,'low');assert.equal(body.max_tokens,8192);assert.equal(body.stream,false);
  assert.ok(body.messages[1].content.includes(r.input.excerpt));assert.equal(r.genie.config.timeout_ms,7200000);assert.equal(r.genie.config.fallback.timeout_ms,7200000);
  assert.equal(r.intents.entries.get(r.input.id).excerpt,null);assert.ok(!JSON.stringify(r.classifier.status()).includes('PRIVATE_'));
  assert.equal(r.lens.decision(priorityEnvelope(r.input).chat).priority,'High');
  await r.classifier.tick();assert.equal(modelCalls.length,1,'completed intent is never automatically replayed');
});

test('ambiguous model failure is not replayed on the fallback and clears optional excerpts',async()=>{
  let attempts=0;const r=rig(async()=>{attempts++;throw new Error('PRIVATE_TRANSPORT_ERROR');});
  await r.classifier.tick();await r.classifier.tick();assert.equal(attempts,1);assert.equal(r.classifier.failed,1);
  assert.equal(r.intents.entries.get(r.input.id).excerpt,null);assert.ok(!JSON.stringify(r.classifier.status()).includes('PRIVATE_'));
});

test('pool review skips occupied capacity without claiming and asks core for atomic no-wait admission',async()=>{
  const calls=[],r=rig(async(url,init)=>{calls.push({url,init});return response({priority:'Medium',reason:'uncertain'});});r.genie.source='pool';
  r.classifier.snapshot=()=>({...snapshot(),gateway_error:'stale'});await r.classifier.tick();assert.equal(r.calls.length,0);assert.equal(r.intents.status().pending,1);
  r.classifier.snapshot=()=>snapshot();await r.classifier.tick();assert.equal(calls[0].init.headers['x-dsg-review-no-wait'],'1');assert.equal(calls[0].init.headers['x-session-affinity'],undefined);
});

test('independent classifier deadline releases a hung provider even when the provider ignores abort',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});let signal;
  const r=rig(async(_url,init)=>{signal=init.signal;return new Promise(()=>{});});
  const running=r.classifier.tick();await flush();assert.equal(r.classifier.busy,true);
  r.advance(60000);t.mock.timers.tick(60000);await running;
  assert.equal(signal.aborted,true);assert.equal(r.classifier.busy,false);assert.equal(r.classifier.failed,1);
  assert.equal(r.intents.status().reviewing,0);assert.equal(r.intents.entries.get(r.input.id).excerpt,null);
  assert.equal(r.lens.decision(priorityEnvelope(r.input).chat).priority,'Medium');
});

test('classification output cannot carry arbitrary prose, rules, urgency or tool instructions',()=>{
  for(const value of [{priority:'High',reason:'uncertain'},{priority:'High',reason:'urgent',rules:['persist']},{priority:'Critical',reason:'urgent'},{priority:'High',reason:'run command'}])assert.throws(()=>priorityAdvice(value));
});
