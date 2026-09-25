import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {PairPreparationWatch} from './recovery-pair-watch.mjs';
import {GenieChat} from './genie-chat.mjs';

const prepare=(row,state='complete')=>({tool:'prepare_pair_recovery',state,at:new Date().toISOString(),action_id:row.action_id,request:{worker_id:row.worker_id}});
const observation=rows=>({tool:'recovery_status',state:'complete',at:new Date().toISOString(),result:{pair_preparations:structuredClone(rows)}});
function fixture(t){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'pair-watch-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const rows=['pair-one','pair-two'].map(worker_id=>({worker_id,action_id:randomUUID(),state:'preparing'}));
  const conversation={id:randomUUID(),messages:[{role:'assistant',state:'complete',recovery:{events:rows.map(r=>prepare(r))}}]};
  const calls=[];let enabled=true,busy=false;
  const chat={status:()=>({available:true,conversations:[{id:conversation.id,busy,queue_paused:conversation.queue_paused}]}),get:()=>conversation,submit:(...args)=>calls.push(args)};
  const options={filename:path.join(directory,'watch.json'),chat,read:async()=>rows,isEnabled:()=>enabled};
  const finish=()=>rows.forEach(r=>Object.assign(r,{state:'prepared',finished_at:'2026-01-01T00:00:00Z',evidence_sha256:'a'.repeat(64)}));
  return {directory,rows,conversation,calls,options,finish,watch:()=>new PairPreparationWatch(options),enabled:v=>enabled=v,busy:v=>busy=v};
}
test('batch completion wakes the originating conversation once across watcher restart',async t=>{
  const f=fixture(t);await f.watch().tick();assert.equal(f.calls.length,0);
  f.rows[0].state='prepared';await f.watch().tick();assert.equal(f.calls.length,0);
  f.finish();await f.watch().tick();assert.equal(f.calls.length,1);assert.equal(f.calls[0][0],f.conversation.id);
  for(const r of f.rows)assert.ok(f.calls[0][1].includes(r.action_id));
  assert.match(f.calls[0][1],/Do not start or retry/);assert.deepEqual(f.calls[0][3],{research:false});
  await f.watch().tick();assert.equal(f.calls.length,1);assert.equal(f.watch().status().requests[0].state,'needs_attention');
  f.conversation.messages.push({role:'assistant',recovery:{events:[observation(f.rows)]}});
  await f.watch().tick();assert.equal(f.watch().status().requests[0].state,'observed');assert.equal(f.calls.length,1);
});
test('already observed native receipts need no follow-up; a partial observation only wakes the missing result',async t=>{
  const f=fixture(t);f.finish();f.conversation.messages[0].recovery.events.push(observation(f.rows.slice(0,1)));
  await f.watch().tick();assert.ok(!f.calls[0][1].includes(f.rows[0].action_id));assert.ok(f.calls[0][1].includes(f.rows[1].action_id));
  const g=fixture(t);g.finish();g.conversation.messages[0].recovery.events.push(observation(g.rows));await g.watch().tick();assert.equal(g.calls.length,0);
});
test('uncertain or missing receipt waits, wrong worker never binds and native failure never retries capture',async t=>{
  const f=fixture(t);f.finish();f.rows[1].state='unverified';await f.watch().tick();assert.equal(f.calls.length,0);
  f.rows[1].state='failed';f.rows[1].worker_id='wrong-pair';await f.watch().tick();assert.equal(f.calls.length,0);
  f.rows[1].worker_id='pair-two';await f.watch().tick();assert.equal(f.calls.length,1);
  const g=fixture(t);g.finish();g.rows.pop();await g.watch().tick();assert.equal(g.calls.length,0);
});
test('newer capture supersedes historical failed capture; retained reading handle survives lost acknowledgement',async t=>{
  const f=fixture(t),old={...f.rows[0],action_id:randomUUID(),state:'failed'};f.finish();
  f.conversation.messages.unshift({role:'assistant',recovery:{events:[prepare(old)]}});f.rows.push(old);
  f.conversation.messages[1].recovery.events[0].state='reading';await f.watch().tick();
  assert.equal(f.calls.length,1);assert.ok(!f.calls[0][1].includes(old.action_id));assert.ok(f.calls[0][1].includes(f.rows[0].action_id));
});
test('capability, active work, owner stop, queue pause and changes during inspection prevent wakeup',async t=>{
  const f=fixture(t);f.finish();f.enabled(false);await f.watch().tick();f.enabled(true);f.busy(true);await f.watch().tick();f.busy(false);
  f.conversation.queue_paused='owner-pause';await f.watch().tick();delete f.conversation.queue_paused;
  f.conversation.messages[0].stop_requested_at=1;await f.watch().tick();delete f.conversation.messages[0].stop_requested_at;
  f.options.read=async()=>{f.conversation.queue_paused='new-pause';return f.rows;};await f.watch().tick();assert.equal(f.calls.length,0);
  delete f.conversation.queue_paused;f.options.read=async()=>{f.enabled(false);return f.rows;};await f.watch().tick();assert.equal(f.calls.length,0);
});
test('status error and closure during read preserve operation identity without submission',async t=>{
  const f=fixture(t);f.finish();f.options.read=async()=>{throw Error('status unavailable');};const w=f.watch();await w.tick();assert.equal(w.status().error,'status unavailable');assert.equal(f.calls.length,0);
  let resolve;f.options.read=()=>new Promise(r=>resolve=r);const next=f.watch(),pending=next.tick();next.close();resolve(f.rows);await pending;assert.equal(f.calls.length,0);
});
test('a failed journal write cannot dispatch on a later tick until the write succeeds',async t=>{
  const f=fixture(t);f.finish();const w=f.watch(),save=w.save.bind(w);w.save=()=>{throw Error('disk full');};
  await w.tick();await w.tick();assert.equal(f.calls.length,0);w.save=save;await w.tick();assert.equal(f.calls.length,1);
});
test('real persisted Genie chat deduplicates lost submission acknowledgement after both services restart',async t=>{
  const f=fixture(t);f.finish();let generates=0;
  const provider={generate:async({onRecovery})=>{generates++;onRecovery(observation(f.rows));return 'Both native receipts were observed.';}};
  const directory=path.join(f.directory,'chat');let chat=new GenieChat({directory,provider,getSnapshot:()=>({gateway:{}})});
  const c=chat.create();const saved=chat.sessions.get(c.id);saved.messages=f.conversation.messages.map(m=>({...m,id:randomUUID(),text:'',at:Date.now()}));chat.save(saved);
  let actual=chat.submit.bind(chat);chat.submit=(...args)=>{actual(...args);throw Error('lost acknowledgement');};
  let watch=new PairPreparationWatch({...f.options,chat});await watch.tick();await chat.idle();assert.equal(generates,1);assert.equal(watch.status().requests[0].state,'pending');
  watch.close();chat.close();chat=new GenieChat({directory,provider,getSnapshot:()=>({gateway:{}})});t.after(()=>chat.close());
  watch=new PairPreparationWatch({...f.options,chat});await watch.tick();await chat.idle();await watch.tick();
  assert.equal(generates,1);assert.equal(chat.get(c.id).messages.filter(m=>m.request_id).length,1);assert.equal(watch.status().requests[0].state,'observed');
});
