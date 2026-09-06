import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {PriorityLens} from './priority-lens.mjs';
import {PriorityIntents,priorityEnvelope} from './priority-intent.mjs';

const envelope=(session='fixture-session')=>({schema:1,id:randomUUID(),session,client:'pi',title:'Current task',excerpt:'Please finish this urgent change today.'});
const job=(input,sequence)=>({key:createHash('sha256').update(input.session).digest('hex'),sequence});
const advice={priority:'High',reason:'urgent'};
const reply=lease=>({lease:lease.lease,intent_id:lease.intent_id,advice});
function rig(options={}){let now=0;const lens=new PriorityLens(),intents=new PriorityIntents({lens,now:()=>now,...options});return {lens,intents,advance:ms=>{now+=ms;}};}

test('priority intent accepts either arrival order, preserves advice across same-turn calls and consumes a lease once',()=>{
  for(const first of ['envelope','request']){
    const {lens,intents}=rig(),input=envelope(),request=job(input,1);
    if(first==='envelope'){assert.equal(intents.receive(input),true);assert.equal(intents.claim(),null);intents.bind(input.id,request);}
    else{assert.equal(intents.bind(input.id,request),true);assert.equal(intents.claim(),null);intents.receive(input);}
    const lease=intents.claim();assert.equal(lease.excerpt,input.excerpt);assert.equal(intents.claim(),null);
    intents.bind(input.id,job(input,2));
    assert.equal(intents.complete(reply(lease)),true);assert.equal(intents.complete(reply(lease)),false);
    assert.equal(lens.decision(request.key).priority,'High');
    assert.equal(intents.entries.get(input.id).excerpt,null);
    intents.bind(input.id,job(input,3));assert.equal(lens.decision(request.key).priority,'High');
  }
});

test('core deadline rejects late advice and erases the excerpt independently of the caller',()=>{
  const {lens,intents,advance}=rig(),input=envelope();intents.receive(input);intents.bind(input.id,job(input,1));
  const lease=intents.claim();advance(59999);assert.equal(intents.status().reviewing,1);
  advance(1);assert.equal(intents.status().reviewing,0);assert.equal(intents.entries.get(input.id).excerpt,null);
  assert.equal(intents.complete(reply(lease)),false);assert.equal(lens.decision(job(input,1).key).priority,'Medium');
  assert.equal(intents.status().expired_reviews,1);assert.equal(intents.status().genie_wait_ms,0);
});

test('newer admission supersedes older advice, delayed envelopes and cross-conversation reuse',()=>{
  const {lens,intents}=rig(),old=envelope(),next=envelope(),other=envelope('another');
  intents.bind(old.id,job(old,1));intents.receive(old);const lease=intents.claim();
  intents.bind(next.id,job(next,2));intents.receive(next);
  assert.equal(intents.complete(reply(lease)),false);
  assert.equal(intents.bind(old.id,job(old,1)),false);
  assert.equal(intents.receive({...old,excerpt:'rewrite'}),true);assert.equal(intents.entries.get(old.id).excerpt,null);
  assert.equal(intents.bind(next.id,job(other,3)),false);
  assert.equal(intents.receive({...other,id:next.id}),false);
  const current=intents.claim();assert.equal(current.intent_id,next.id);
  assert.equal(intents.complete(reply(current)),true);assert.equal(lens.decision(job(next,2).key).priority,'High');
});

test('manual edits and opt-out revoke leases without overriding the user or persisting excerpts',()=>{
  const {lens,intents}=rig(),input=envelope();intents.receive(input);intents.bind(input.id,job(input,1));const lease=intents.claim();
  lens.setManual({chat:job(input,1).key,priority:'Low',expected_revision:0});
  assert.equal(intents.complete(reply(lease)),false);assert.equal(intents.entries.get(input.id).excerpt,null);
  assert.equal(lens.decision(job(input,1).key).priority,'Low');
  const next=envelope('new-session');intents.receive(next);intents.bind(next.id,job(next,2));
  lens.configure({expected_revision:1,enabled:false,weights:{High:3,Medium:1,Low:.5},max_eligible_wait_ms:null});
  assert.equal(intents.claim(),null);assert.equal(intents.entries.get(next.id).excerpt,null);
  assert.equal(intents.receive(envelope('later')),false);
  assert.ok(!JSON.stringify(lens.state).includes(input.excerpt));assert.ok(!JSON.stringify(intents.status()).includes(input.title));
});

test('bounded TTL store declines excess intents and expires transient decisions without touching manual preferences',()=>{
  const {lens,intents,advance}=rig({capacity:1}),input=envelope();intents.receive(input);intents.bind(input.id,job(input,1));
  assert.equal(intents.complete(reply(intents.claim())),true);
  assert.equal(intents.receive(envelope('excess')),false);
  advance(600000);assert.equal(intents.status().pending,0);assert.equal(intents.entries.size,0);assert.equal(intents.current.size,0);
  assert.equal(lens.decisions.size,0);assert.equal(intents.receive(envelope('space-now')),true);
});

test('strict envelopes and typed replies reject oversize text and arbitrary model explanations',()=>{
  const input=envelope();
  for(const invalid of [{...input,extra:true},{...input,client:'other'},{...input,excerpt:'x'.repeat(1025)},{...input,title:'💡'.repeat(65)},{...input,session:'x'.repeat(257)},{...input,excerpt:'bad\u0000text'}])assert.throws(()=>priorityEnvelope(invalid));
  const {intents,lens}=rig();intents.receive(input);intents.bind(input.id,job(input,1));const lease=intents.claim();
  assert.equal(intents.complete({...reply(lease),advice:{priority:'High',reason:'urgent',explanation:input.excerpt}}),false);
  assert.equal(intents.entries.get(input.id).excerpt,null);assert.equal(lens.decisions.size,0);
});

test('capacity rejection of a new intent cannot retain stale urgency from a previous user turn',()=>{
  const {lens,intents}=rig({capacity:1}),old=envelope(),next=envelope();
  intents.receive(old);intents.bind(old.id,job(old,1));intents.complete(reply(intents.claim()));
  assert.equal(lens.decision(job(old,1).key).priority,'High');
  assert.equal(intents.receive(next),false);assert.equal(intents.bind(next.id,job(next,2)),false);
  assert.equal(lens.decision(job(old,1).key).source,'default');assert.equal(intents.current.size,0);
});
