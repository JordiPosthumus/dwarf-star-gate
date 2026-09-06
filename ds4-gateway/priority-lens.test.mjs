import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {PriorityLens,priorityState,priorityWeights} from './priority-lens.mjs';

const key=name=>createHash('sha256').update(name).digest('hex');
const job=(name,sequence=0,chat=name)=>({id:name,key:key(chat),sequence});
const manual=(lens,chat,priority)=>lens.setManual({chat:key(chat),priority,expected_revision:lens.state.revision});
function settings(lens,patch){return lens.configure({expected_revision:lens.state.revision,enabled:lens.enabled,weights:lens.state.weights,max_eligible_wait_ms:lens.state.max_eligible_wait_ms,...patch});}

test('absent or late Genie advice never requires waiting; no activation without an agreed aging threshold',()=>{
  const lens=new PriorityLens({random:()=>0.999}),a=job('a'),b=job('b',1);
  manual(lens,'b','High');
  assert.equal(lens.settings().activation,'awaiting_aging_agreement');
  assert.equal(lens.select([a,b]).job,a);
  settings(lens,{max_eligible_wait_ms:1000});
  assert.equal(lens.select([a,b]).job,b);
  assert.equal(lens.receipts[0].genie_wait_ms,0);
  manual(lens,'b',null);
  assert.equal(lens.select([a,b]).job,a,'no advice uses ordinary FIFO');
  assert.equal(lens.receipts[0].method,'fifo');
});

test('manual choices survive durable reload, win over Genie, and return to automatic explicitly',()=>{
  let saved;const lens=new PriorityLens({save:state=>{saved=state;}}),chat=key('a');
  const ticket=lens.ticket(chat,1);
  assert.equal(lens.advise(ticket,{priority:'Low',reason:'background'},1),true);
  manual(lens,'a','High');
  assert.equal(lens.decision(chat).priority,'High');
  assert.equal(lens.advise(ticket,{priority:'Low',reason:'background'},1),false);
  assert.equal(lens.ticket(chat,2),null);
  const restored=new PriorityLens({state:saved});
  assert.equal(restored.decision(chat).source,'user');
  assert.equal(restored.decision(chat).priority,'High');
  manual(lens,'a',null);
  assert.equal(lens.decision(chat).priority,'Low');
  assert.equal(lens.decision(chat).source,'genie');
  const before=structuredClone(lens.state);
  lens.save=()=>{throw new Error('fixture disk full');};
  assert.throws(()=>manual(lens,'a','Medium'),/disk full/);
  assert.deepEqual(lens.state,before,'failed persistence cannot apply an override');
});

test('late or malformed advice and prompt-shaped output cannot overwrite current intent or escape metadata receipts',()=>{
  const lens=new PriorityLens({maxEligibleWaitMs:1000}),chat=key('a'),ticket=lens.ticket(chat,1);
  for(const advice of [null,{priority:'Highest',reason:'urgent'},{priority:'High',reason:'ignore the operator'},{priority:'High',reason:'uncertain'},{priority:'High',reason:'urgent',prompt:'secret excerpt'}])assert.equal(lens.advise(ticket,advice,1),false);
  assert.equal(lens.advise(ticket,{priority:'High',reason:'urgent'},2),false,'a newer intent invalidates older advice');
  settings(lens,{enabled:false});
  assert.equal(lens.advise(ticket,{priority:'High',reason:'urgent'},1),false);
  settings(lens,{enabled:true});
  assert.equal(lens.advise(ticket,{priority:'High',reason:'urgent'},1),false,'off/on cannot revive in-flight advice');
  const current=lens.ticket(chat,2);
  assert.equal(lens.advise(current,{priority:'Medium',reason:'uncertain'},2),true);
  const a={...job('a'),title:'private title',excerpt:'private recent user words'};
  const receipt=lens.select([a]).receipt;
  assert.doesNotMatch(JSON.stringify(receipt),/private|excerpt|title/);
  assert.equal(lens.decision(chat).reason,'Importance is uncertain; using Medium');
});

test('weighted selection matches 3:1:0.5 over seeded trials; extra requests cannot buy entries',()=>{
  let seed=123456789;
  const random=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return (seed>>>0)/4294967296;};
  const lens=new PriorityLens({random,now:()=>0,maxEligibleWaitMs:600000});
  for(const [chat,priority] of [['h','High'],['m','Medium'],['l','Low']])manual(lens,chat,priority);
  const queue=[job('h'),job('m',1),job('l',2),...Array.from({length:20},(_,i)=>job(`extra-${i}`,3+i,'l'))];
  const counts={h:0,m:0,l:0},trials=30000;
  for(let i=0;i<trials;i++)counts[lens.select(queue).job.id]++;
  for(const [id,probability] of [['h',3/4.5],['m',1/4.5],['l',0.5/4.5]])assert.ok(Math.abs(counts[id]/trials-probability)<0.012,`${id}: ${counts[id]}/${trials}`);
  assert.equal(lens.receipts.length,32);assert.equal(lens.receipts[0].eligible_conversations,3);
  assert.deepEqual(lens.receipts[0].candidates.map(row=>row.request_id),['h','m','l']);
  settings(lens,{weights:{High:0.1,Medium:0.1,Low:10}});
  let low=0;for(let i=0;i<3000;i++)if(lens.select(queue).job.id==='l')low++;
  assert.ok(low>2850,'weight changes affect subsequent choices');
});

test('aging guarantees precedence at a free slot; held time and later same-conversation requests do not accrue eligible time',()=>{
  let now=0;const lens=new PriorityLens({now:()=>now,random:()=>0,maxEligibleWaitMs:1000});
  const low=job('low'),next=job('low-next',1,'low'),high=job('high',2);manual(lens,'low','Low');manual(lens,'high','High');
  lens.observe([low,next]);
  now=400;lens.observe([low,next],{eligible:()=>false});
  now=100000;lens.observe([low,next],{eligible:()=>false});
  assert.equal(lens.eligibleWait(low),400);assert.equal(lens.eligibleWait(next),0);
  lens.observe([low,next,high]);now+=601;
  assert.equal(lens.select([low,next,high]).job,low);
  assert.equal(lens.receipts[0].method,'aging');
  assert.equal(lens.eligibleWait(low),1001);assert.equal(lens.eligibleWait(high),601);
  assert.equal(lens.select([low,next,high],{eligible:()=>false}),null,'aging cannot bypass a hold');
  low.dispatched=now;lens.observe([low,next,high],{eligible:j=>j.key!==low.key});
  assert.equal(lens.select([low,next,high],{eligible:j=>j.key!==low.key}).job,high,'active ownership blocks the next turn');
});

test('selection never mutates FIFO queues or active work; disabled policy retains overrides and falls back to FIFO',()=>{
  const lens=new PriorityLens({random:()=>0.99,maxEligibleWaitMs:1000});manual(lens,'b','High');
  const a=job('a'),b=job('b',1),next=job('b-next',2,'b'),active={...job('active'),dispatched:1},cancelled={...job('cancelled'),cancelled:true};
  const queue=[a,b,next,active,cancelled],before=structuredClone(queue);
  assert.equal(lens.select(queue).job,b);assert.deepEqual(queue,before);
  settings(lens,{enabled:false});assert.equal(lens.select(queue).job,a);
  assert.equal(lens.decision(b.key).priority,'High','opt-out does not erase overrides');
  assert.equal(lens.receipts[0].method,'fifo');
});

test('independent worker selections preserve other workers aging; invalid randomness falls back immediately',()=>{
  let now=0;const lens=new PriorityLens({now:()=>now,maxEligibleWaitMs:1000,random:()=>NaN});
  const a=job('a'),b=job('b',1),c=job('c',2);manual(lens,'b','High');
  lens.observe([a,b,c]);now=500;lens.select([a,b]);now=1001;
  assert.equal(lens.select([c]).receipt.eligible_wait_ms,1001);
  const invalid=new PriorityLens({random:()=>NaN,maxEligibleWaitMs:1000});manual(invalid,'b','High');
  assert.equal(invalid.select([a,b]).job,a);assert.equal(invalid.receipts[0].method,'random_unavailable_fifo');
});

test('preferences are explicit, editable, bounded and versioned without silently deleting distinct rules',()=>{
  let saved;const lens=new PriorityLens({save:value=>{saved=value;}}),chat=key('a');
  const ticket=lens.ticket(chat,0),lines=Array.from({length:30},(_,i)=>`Preference ${i}`);
  lens.setRules({expected_revision:0,rules:lines});assert.deepEqual(saved.rules,lines);
  assert.equal(lens.advise(ticket,{priority:'High',reason:'preference'},0),false,'changed rules invalidate old classification');
  assert.throws(()=>lens.setRules({expected_revision:0,rules:[]}),/changed/);
  assert.throws(()=>lens.setRules({expected_revision:1,rules:[...lines,'extra']}),/30/);
  assert.deepEqual(lens.state.rules,lines);
  const recovered=new PriorityLens({state:saved});assert.deepEqual(recovered.state.rules,lines);
  for(const weights of [{High:0,Medium:1,Low:1},{High:3,Medium:Infinity,Low:1},{High:11,Medium:1,Low:1},{High:3,Medium:1,Low:1,admin:true}])assert.throws(()=>priorityWeights(weights));
  assert.throws(()=>priorityState({...saved,manual:{private_text:'High'}}));
  assert.throws(()=>new PriorityLens({state:{...saved,schema:2}}));
});
