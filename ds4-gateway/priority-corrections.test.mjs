import test from 'node:test';
import assert from 'node:assert/strict';
import {PriorityLens} from './priority-lens.mjs';
import {PriorityCorrections} from './priority-corrections.mjs';
const chat='a'.repeat(64);
function rig(){
  let now=1000;const lens=new PriorityLens(),calls=[];
  const read=async()=>({...lens.settings(),jobs:[{chat,title:'Synthetic project',...lens.decision(chat)}]});
  const act=async(action,input)=>{calls.push({action,input});if(action==='manual')lens.setManual(input);else lens.setRules(input);return read();};
  return {lens,calls,corrections:new PriorityCorrections({read,act,now:()=>now}),advance:ms=>{now+=ms;}};
}

test('chat correction changes only the identified conversation after explicit confirmation',async()=>{
  const r=rig(),context=await r.corrections.context('Make this project Low only for this conversation.');
  assert.equal(r.corrections.propose({scope:'chat',chat,priority:'Low',message:'Apply Low only to Synthetic project.'},context),true);
  const proposal=r.corrections.status().proposal;assert.equal(proposal.title,'Synthetic project');assert.equal(r.lens.decision(chat).priority,'Medium');assert.equal(r.calls.length,0);
  await r.corrections.confirm({proposal_id:proposal.id});assert.equal(r.lens.decision(chat).priority,'Low');assert.deepEqual(r.lens.state.rules,[]);
  await assert.rejects(r.corrections.confirm({proposal_id:proposal.id}),/current correction/);assert.equal(r.calls.length,1);
});

test('general consolidation previews exact removals and additions while retaining unrelated rules',async()=>{
  const r=rig();r.lens.setRules({expected_revision:0,rules:['Docs are background work','Routine docs are Low','Release blockers are High']});
  const context=await r.corrections.context('Consolidate the two docs rules, keeping release blockers.');
  assert.equal(r.corrections.propose({scope:'general',message:'Replace overlapping documentation rules.',remove_rules:[0,1],add_rules:['Routine documentation is Low unless urgent']},context),true);
  const proposal=r.corrections.status().proposal;assert.deepEqual(proposal.remove_rules,context.rules.slice(0,2));assert.equal(proposal.unchanged_rules,1);assert.equal(proposal.rules,undefined);
  assert.deepEqual(r.lens.state.rules,context.rules,'nothing is removed before confirmation');
  await r.corrections.confirm({proposal_id:proposal.id});assert.deepEqual(r.lens.state.rules,['Release blockers are High','Routine documentation is Low unless urgent']);
});

test('ambiguous scope asks a question and preserves its bounded context for the next chat reply',async()=>{
  const r=rig(),context=await r.corrections.context('PRIVATE_QUESTION: lower the docs work');
  assert.equal(r.corrections.propose({scope:'clarify',message:'Only this conversation, or all routine documentation?'},context),true);
  const proposal=r.corrections.status().proposal;assert.ok(!JSON.stringify(proposal).includes('PRIVATE_QUESTION'));
  await assert.rejects(r.corrections.confirm({proposal_id:proposal.id}),/explicit scope/);assert.equal(r.calls.length,0);
  const followup=await r.corrections.context('All routine documentation, generally Low.');
  assert.equal(followup.previous_correction.question,'PRIVATE_QUESTION: lower the docs work');assert.equal(r.corrections.status().proposal,null);
  assert.equal(r.corrections.propose({scope:'general',message:'General rule for documentation.',remove_rules:[],add_rules:['Routine documentation is Low']},followup),true);
});

test('stale revisions, newer questions, expiry and duplicate racing confirmations cannot apply old advice',async()=>{
  const r=rig(),old=await r.corrections.context('older'),current=await r.corrections.context('newer');
  const raw={scope:'chat',chat,priority:'High',message:'One chat only'};assert.equal(r.corrections.propose(raw,old),false);assert.equal(r.corrections.propose(raw,current),true);
  const proposal=r.corrections.status().proposal;
  r.lens.setManual({chat,priority:'Low',expected_revision:0});
  await assert.rejects(r.corrections.confirm({proposal_id:proposal.id}),/not confirmed/);assert.equal(r.lens.decision(chat).priority,'Low');assert.equal(r.corrections.status().proposal,null);
  const next=await r.corrections.context();r.corrections.propose(raw,next);r.advance(300000);assert.equal(r.corrections.status().proposal,null);
  const last=await r.corrections.context();r.corrections.propose(raw,last);const id=r.corrections.status().proposal.id;
  let release;let calls=0;r.corrections.act=()=>{calls++;return new Promise(resolve=>{release=resolve;});};
  const first=r.corrections.confirm({proposal_id:id});await assert.rejects(r.corrections.confirm({proposal_id:id}),/current correction/);release({});await first;assert.equal(calls,1);
});

test('invalid or oversized proposals cannot grant changes, drop hidden rules or name unknown chats',async()=>{
  const r=rig();r.lens.setRules({expected_revision:0,rules:Array.from({length:30},(_,i)=>`Rule ${i}`)});const context=await r.corrections.context();
  for(const raw of [{scope:'chat',chat:'b'.repeat(64),priority:'High',message:'unknown'},{scope:'chat',chat,priority:'Critical',message:'invalid'},{scope:'clarify',message:'Question?',priority:'High'},{scope:'general',message:'Too many',remove_rules:[],add_rules:['Overflow']},{scope:'general',message:'Unknown removal',remove_rules:[30],add_rules:[]},{scope:'general',message:'Duplicated removal',remove_rules:[0,0],add_rules:[]},{scope:'general',message:'Oversized text',remove_rules:[0],add_rules:['💡'.repeat(65)]}])assert.equal(r.corrections.propose(raw,context),false);
  assert.equal(r.calls.length,0);assert.equal(r.corrections.status().proposal,null);assert.equal(r.lens.state.rules.length,30);
});

test('ambiguous confirmation transport is consumed once and does not expose raw errors',async()=>{
  const r=rig(),context=await r.corrections.context();r.corrections.propose({scope:'chat',chat,priority:'High',message:'Proposed only'},context);const id=r.corrections.status().proposal.id;
  let calls=0;r.corrections.act=async()=>{calls++;throw new Error('PRIVATE_ENDPOINT_ERROR');};
  await assert.rejects(r.corrections.confirm({proposal_id:id}),/not confirmed/);await assert.rejects(r.corrections.confirm({proposal_id:id}),/current correction/);
  assert.equal(calls,1);assert.ok(!JSON.stringify(r.corrections.status()).includes('PRIVATE_'));
});

test('a chat reply can refine the previous concrete proposal while the original confirmation expires',async()=>{
  const r=rig(),context=await r.corrections.context('Make this conversation Low.');
  r.corrections.propose({scope:'chat',chat,priority:'Low',message:'One conversation only'},context);r.corrections.finish(context);
  const id=r.corrections.status().proposal.id,followup=await r.corrections.context('Actually, make it High instead.');
  assert.equal(followup.previous_correction.chat,chat);assert.equal(followup.previous_correction.priority,'Low');
  await assert.rejects(r.corrections.confirm({proposal_id:id}),/current correction/);
  r.corrections.propose({scope:'chat',chat,priority:'High',message:'Revised proposal, still one conversation'},followup);
  assert.equal(r.corrections.status().proposal.priority,'High');assert.equal(r.calls.length,0);
});
