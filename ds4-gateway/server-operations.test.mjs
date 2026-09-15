import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {ServerOperations} from './server-operations.mjs';

function rig(t,overrides={}){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'sg-operations-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const calls={prepare:0,launch:0,observe:0};let revision='d'.repeat(64),runner={state:'running'};
  const options={directory,workers:['one','two'],recordRevision:async()=>revision,
    prepare:async(p,r)=>{calls.prepare++;return {plan:{record_revision:r,image:p.image,command:p.command},review:{before:['old'],after:p.command}};},
    launch:async input=>{calls.launch++;return {id:input.id,pid:123};},
    observe:async()=>{calls.observe++;return runner;},...overrides};
  const store=new ServerOperations(options);
  const input=(worker='one')=>({id:randomUUID(),worker_id:worker,image:'sha256:'+'a'.repeat(64),command:['serve','--context','262144'],reason:'Apply the reviewed serving recipe.'});
  async function prepared(worker='one'){const p=input(worker);store.propose(p);await store.idle();return store.status(p.id);}
  const approve=row=>store.change({action:'approve',id:row.id,plan_revision:row.plan_revision});
  return {directory,options,store,calls,input,prepared,approve,setRevision:r=>revision=r,setRunner:r=>runner=r};
}

test('a Genie proposal prepares evidence but cannot approve or launch it',async t=>{
  const r=rig(t),p=r.input(),first=r.store.propose(p,{conversation_id:randomUUID(),reply_id:randomUUID()});
  assert.equal(first.state,'preparing');await r.store.idle();const ready=r.store.status(p.id);
  assert.equal(ready.state,'awaiting_approval');assert.equal(r.calls.launch,0);assert.equal(ready.record_revision,'d'.repeat(64));
  assert.equal(r.store.read(p.id,'approved.json'),null);assert.deepEqual(ready.review.after,p.command);
});

test('only approval of exact saved plan launches once',async t=>{
  const r=rig(t),row=await r.prepared();
  await assert.rejects(r.store.change({action:'approve',id:row.id,plan_revision:'f'.repeat(64)}),/reviewed plan/);
  assert.equal(r.calls.launch,0);
  await Promise.all([r.approve(row),r.approve(row)]);await r.store.idle();
  assert.equal(r.calls.launch,1);assert.equal(r.store.status(row.id).state,'submitted');
  assert.equal(r.store.read(row.id,'approved.json').actor,'owner');
});

test('configuration record drift invalidates an unlaunched approval',async t=>{
  const r=rig(t),row=await r.prepared();r.setRevision('e'.repeat(64));
  await assert.rejects(r.approve(row),/record changed/);assert.equal(r.calls.launch,0);assert.equal(r.store.status(row.id).state,'awaiting_approval');
});

test('editing plan bytes cannot inherit approval for the old plan',async t=>{
  const r=rig(t),row=await r.prepared();fs.writeFileSync(path.join(r.directory,row.id,'plan.json'),JSON.stringify({different:true}));
  await assert.rejects(r.approve(row),/reviewed plan/);assert.equal(r.calls.launch,0);
});

test('declined proposals are retained and cannot be implicitly approved',async t=>{
  const r=rig(t),row=await r.prepared();await r.store.change({action:'decline',id:row.id,plan_revision:row.plan_revision});
  await assert.rejects(r.approve(row),/declined/);assert.equal(r.store.status(row.id).state,'declined');assert.ok(r.store.read(row.id,'plan.json'));
  const next=new ServerOperations(r.options);await next.resumeApproved();assert.equal(r.calls.launch,0);
});

test('dashboard restart observes an uncertain launch without resubmission',async t=>{
  let launches=0;const r=rig(t,{launch:async()=>{launches++;throw new Error('acknowledgement lost');}}),row=await r.prepared();
  await r.approve(row);await r.store.idle();assert.equal(r.store.status(row.id).state,'launch_uncertain');
  const restarted=new ServerOperations(r.options);await restarted.resumeApproved();
  await restarted.change({action:'approve',id:row.id,plan_revision:row.plan_revision});
  assert.equal((await restarted.current(row.id)).runner.state,'running');assert.equal(launches,1);
});

test('approval persisted before a pre-launch crash can resume without new approval',async t=>{
  const r=rig(t),row=await r.prepared(),write=r.store.write.bind(r.store);
  r.store.write=(id,name,value)=>{if(name==='launch-intent.json')throw new Error('fixture crash before launch intent');return write(id,name,value);};
  await assert.rejects(r.approve(row),/fixture crash/);assert.equal(r.calls.launch,0);
  const original=r.store.read(row.id,'approved.json'),restarted=new ServerOperations(r.options);
  assert.equal(restarted.status(row.id).state,'approved_unsubmitted');await restarted.resumeApproved();await restarted.idle();
  assert.equal(r.calls.launch,1);assert.deepEqual(restarted.read(row.id,'approved.json'),original);
});

test('closing chat-facing store does not signal or cancel an independent launch',async t=>{
  let complete;const r=rig(t,{launch:()=>new Promise(resolve=>complete=resolve)}),row=await r.prepared();
  await r.approve(row);r.store.close();complete({pid:123});await r.store.idle();
  assert.equal(r.store.status(row.id).state,'submitted');await assert.rejects(r.approve(row),/closed/);
});

test('observation failure preserves uncertainty and never restarts the operation',async t=>{
  const r=rig(t,{observe:async()=>{throw new Error('connection unavailable');}}),row=await r.prepared();await r.approve(row);await r.store.idle();
  assert.equal((await r.store.current(row.id)).runner.state,'observation_unavailable');assert.equal(r.calls.launch,1);
});

test('another active change on the same worker blocks launch but not proposals',async t=>{
  const r=rig(t),one=await r.prepared(),two=await r.prepared();await r.approve(one);await r.store.idle();
  await assert.rejects(r.approve(two),/existing operation/);assert.equal(r.calls.launch,1);
  r.setRunner({state:'completed'});await r.approve(two);await r.store.idle();assert.equal(r.calls.launch,2);
});

test('independent workers can proceed without waiting for each other',async t=>{
  const r=rig(t),one=await r.prepared('one'),two=await r.prepared('two');
  await r.approve(one);await r.approve(two);await r.store.idle();assert.equal(r.calls.launch,2);
});

test('corrupt operation evidence is preserved, reported and never interpreted as permission',async t=>{
  const r=rig(t),row=await r.prepared(),file=path.join(r.directory,row.id,'prepared.json');fs.writeFileSync(file,'invalid');
  assert.equal(r.store.list()[0].state,'unreadable');const other=await r.prepared('two');await assert.rejects(r.approve(other),/unreadable/);
  assert.equal(fs.readFileSync(file,'utf8'),'invalid');assert.equal(r.calls.launch,0);
});

test('duplicate proposal IDs do not create more preparation and reject changed content',async t=>{
  const r=rig(t),p=r.input();r.store.propose(p);await r.store.idle();r.store.propose(p);assert.equal(r.calls.prepare,1);
  assert.throws(()=>r.store.propose({...p,command:['different']}),/another proposal/);
});

test('failed preparation retains the request and cannot launch',async t=>{
  const r=rig(t,{prepare:async()=>{throw new Error('PRIVATE_RAW_ERROR');}}),p=r.input();r.store.propose(p);await r.store.idle();
  const row=r.store.status(p.id);assert.equal(row.state,'prepare_failed');assert.doesNotMatch(JSON.stringify(row),/PRIVATE_RAW_ERROR/);assert.ok(r.store.read(p.id,'proposal.json'));assert.equal(r.calls.launch,0);
});

test('caller mutation does not rewrite an accepted proposal',async t=>{
  const r=rig(t),p=r.input();r.store.propose(p);p.command.push('unreviewed');await r.store.idle();
  assert.ok(!r.store.read(p.id,'plan.json').command.includes('unreviewed'));
});
