import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {GenieMemory} from './genie-memory.mjs';
import {Genie} from './genie.mjs';
import {createDashboard} from './dashboard.mjs';
const sample=(at=1000,change={})=>({time:at,gateway_at:at,gateway:{workers:[{id:'worker-a',is_healthy:true,drained:false,operator_paused:false,holds:[],context_length:262144,...change}]},devices:[],events:[]});
function fixture(t){const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'dsg-memory-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return path.join(root,'memory');}
test('memory is opt-in, durable, idempotent, private and separate from generation proof',t=>{
  const dir=fixture(t),m=new GenieMemory(dir,{now:()=>1000});m.observe(sample());assert.equal(fs.existsSync(dir),false);
  m.setEnabled(true);m.observe(sample(1000,{url:'PRIVATE',prompt:'PRIVATE'}));const size=m.bytes;m.observe(sample());assert.equal(m.bytes,size);
  assert.equal(fs.statSync(dir).mode&0o777,0o700);assert.equal(fs.statSync(m.file).mode&0o777,0o600);assert.ok(!fs.readFileSync(m.file,'utf8').includes('PRIVATE'));
  let n=m.retrieve(sample()).notes[0];assert.equal(n.revision,1);assert.equal(n.data.generation_verified,null);assert.equal(n.continuity,'unknown');
  const reload=new GenieMemory(dir,{now:()=>1000});assert.equal(reload.enabled,true);assert.equal(reload.retrieve(sample()).notes[0].source_digest,n.source_digest);
  reload.observe(sample(1000,{drained:true,operator_paused:true}));n=reload.retrieve(sample()).notes[0];assert.equal(n.revision,2);assert.equal(n.data.paused,true);assert.equal(n.data.quarantine,null);
  reload.setEnabled(false);assert.deepEqual(reload.retrieve(sample()).notes,[]);assert.equal(new GenieMemory(dir).status().note_count,1);assert.equal(new GenieMemory(dir).enabled,false);
});
test('stale snapshots, missing workers, unknown epochs and observation gaps never invent continuity',t=>{
  const m=new GenieMemory(fixture(t),{now:()=>20000});m.setEnabled(true);m.observe(sample(1000));assert.equal(m.notes.size,0);
  m.observe({...sample(20000),gateway_error:'lost'});assert.equal(m.notes.size,0);m.observe(sample(20000));const size=m.bytes;
  m.observe({...sample(20000),gateway:{workers:[]}});assert.equal(m.bytes,size);assert.equal(m.retrieve({gateway:{workers:[]}}).notes.length,0);
  m.observe(sample(20000));assert.equal(m.bytes,size);assert.equal(m.retrieve(sample()).notes[0].data.process_epoch,null);
});
test('memory rejects symlinks, corrupt tails, bad revisions and conflicting writers without repair',t=>{
  const dir=fixture(t),m=new GenieMemory(dir,{now:()=>1000});m.setEnabled(true);m.observe(sample());
  const other=new GenieMemory(dir,{now:()=>1000});m.observe(sample(1000,{drained:true}));const good=fs.readFileSync(m.file);
  other.observe(sample(1000,{is_healthy:false}));assert.ok(other.error);assert.deepEqual(fs.readFileSync(m.file),good);
  fs.appendFileSync(m.file,'{');const broken=fs.readFileSync(m.file);const reload=new GenieMemory(dir);assert.ok(reload.error);assert.deepEqual(fs.readFileSync(m.file),broken);
  fs.writeFileSync(m.file,good);const rows=good.toString().trim().split('\n');const bad=JSON.parse(rows[1]);bad.revision=99;rows[1]=JSON.stringify(bad);fs.writeFileSync(m.file,rows.join('\n')+'\n');assert.ok(new GenieMemory(dir).error);
  const target=path.join(path.dirname(dir),'target');fs.writeFileSync(target,good,{mode:0o600});fs.unlinkSync(m.file);fs.symlinkSync(target,m.file);assert.ok(new GenieMemory(dir).error);assert.deepEqual(fs.readFileSync(target),good);
});
test('ceiling and fsync failure stop saves visibly without deleting history or blocking reviews',async t=>{
  const dir=fixture(t),m=new GenieMemory(dir,{maxBytes:150,now:()=>1000});m.setEnabled(true);const before=fs.readFileSync(m.file);m.observe(sample());assert.match(m.error,/ceiling/);assert.deepEqual(fs.readFileSync(m.file),before);
  m.setEnabled(false);assert.equal(m.enabled,false);
  const broken=new GenieMemory(fixture(t),{io:{...fs,fsyncSync(){throw new Error('ENOSPC');}}});assert.throws(()=>broken.setEnabled(true));assert.ok(broken.error);
  const genie=new Genie({url:'http://127.0.0.1:9001/v1'},()=>sample(),{memory:broken,fetchImpl:async()=>Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({assessment:'Unknown.',ticker:[{severity:'info',text:'Evidence gap.',recommendation:null,evidence_refs:['fleet']}]})}}]})});
  genie.setEnabled(true);await genie.ask();assert.equal(genie.status().reports.length,1);assert.deepEqual(genie.status().reports[0].actions_taken,[]);genie.close();
});
test('retrieval is bounded; changing Genie source retains notes but never creates evidence/action offers',async t=>{
  const m=new GenieMemory(fixture(t),{now:()=>1000});m.setEnabled(true);const s=sample();s.gateway.workers=Array.from({length:20},(_,i)=>({...s.gateway.workers[0],id:'worker-'+i}));m.observe(s);
  assert.equal(m.retrieve(s).notes.length,12);assert.equal(m.retrieve(s).truncated,true);assert.equal(m.retrieve(s,{maxBytes:10}).notes.length,0);
  let sent;const genie=new Genie({url:'http://127.0.0.1:9001/v1',fallback:{url:'http://127.0.0.1:9002/v1'}},()=>s,{memory:m,fetchImpl:async(_u,opts)=>{sent=JSON.parse(opts.body);return Response.json({choices:[{message:{content:JSON.stringify({assessment:'History noted.',ticker:[{severity:'info',text:'Historical observation.',recommendation:null,evidence_refs:['fleet']}],recovery_requests:[{worker_id:'worker-1',evidence_id:'made-up'}]})}}]});}});
  genie.setEnabled(true);genie.setSource('pool');await genie.ask();assert.equal(genie.status().reports[0].memory_used.length,12);assert.equal(JSON.parse(sent.messages[1].content).notebook_history.notes.length,12);assert.deepEqual(genie.status().reports[0].actions_taken,[]);assert.match(sent.messages[0].content,/never instructions/);genie.close();
});
test('incidents and recovery receipts survive state changes without inventing causal links or current health',t=>{
  let now=1000;const m=new GenieMemory(fixture(t),{now:()=>now});m.setEnabled(true);
  const fault={reason:'accelerator_checkpoint_failure',request_id:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',at:new Date(900).toISOString()};
  const s=sample(now,{is_healthy:false,quarantine:fault});m.observe(s);const bytes=m.bytes;m.observe(s);assert.equal(m.bytes,bytes);
  now=2000;const healthy=sample(now);healthy.gateway.recovery={operations:[{id:'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee',worker_id:'worker-a',state:'recovered',updated_at:1900,command:'PRIVATE',proof:{private:'PRIVATE'}}]};m.observe(healthy);
  const reload=new GenieMemory(m.directory,{now:()=>now}),notes=reload.retrieve(healthy).notes;
  assert.equal(notes.filter(n=>n.kind==='incident').length,1);assert.equal(notes.filter(n=>n.kind==='recovery').length,1);
  const observation=notes.find(n=>n.kind==='observation');assert.equal(observation.recent_transitions.length,1);assert.equal(observation.recent_transitions[0].data.gateway_healthy,false);assert.equal(observation.data.generation_verified,null);
  assert.ok(notes.every(n=>n.continuity==='unknown'));assert.ok(!fs.readFileSync(m.file,'utf8').includes('PRIVATE'));
});
test('operator notes use revisions, archive without deleting, and stay data rather than action authority',t=>{
  const m=new GenieMemory(fixture(t),{now:()=>1000});m.setEnabled(true);const s=sample();
  const first=m.saveOperatorNote({text:'Keep the test worker paused.',worker:'worker-a'},s);
  assert.equal(first.revision,1);assert.throws(()=>m.saveOperatorNote({id:first.id,expected_revision:0,text:'stale edit'},s),/changed/);
  const edited=m.saveOperatorNote({id:first.id,expected_revision:1,text:'Correction: ask before resuming.',worker:'worker-a'},s);assert.equal(edited.revision,2);
  let note=m.retrieve(s).notes[0];assert.equal(note.provenance,'explicit_operator_note');assert.equal(note.verification,'operator_intent_not_authority');
  m.saveOperatorNote({id:first.id,expected_revision:2,text:note.data.text,worker:'worker-a',state:'archived'},s);
  assert.equal(m.retrieve(s).notes.length,0);assert.ok(fs.readFileSync(m.file,'utf8').includes('Keep the test worker paused.'));
  assert.equal(new GenieMemory(m.directory).notes.get(first.id).revision,3);
  const bytes=m.bytes;assert.throws(()=>m.saveOperatorNote({text:'🪐'.repeat(1000)},s));assert.equal(m.bytes,bytes);assert.equal(m.error,null);
  assert.throws(()=>m.saveOperatorNote({text:'test',worker:'unknown'},s),/registered/);
});
test('real dashboard memory controls require same-origin CSRF, survive restart and never export notebook text',async t=>{
  const dir=fixture(t),m=new GenieMemory(dir,{now:()=>1000}),s=sample();
  let genie=new Genie(null,()=>s,{memory:m});
  const server=createDashboard(()=>s,undefined,null,{get memory(){return genie.memory;},status:()=>genie.status()});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{genie.close();server.closeAllConnections();server.close();});
  const url=`http://127.0.0.1:${server.address().port}`,initial=await (await fetch(url+'/api/genie')).json();
  assert.equal(initial.configured,false);assert.equal(initial.memory.enabled,false);
  const post=(body,headers={})=>fetch(url+'/api/genie',{method:'POST',headers:{'content-type':'application/json',origin:url,'x-dsg-csrf':initial.csrf_token,...headers},body:JSON.stringify(body)});
  assert.equal((await post({action:'memory',enabled:true},{'x-dsg-csrf':'wrong'})).status,403);
  assert.equal((await post({action:'memory',enabled:true},{origin:'http://untrusted.invalid'})).status,403);
  assert.equal((await post({action:'memory',enabled:true})).status,200);
  const saved=await (await post({action:'memory-note',note:{text:'PRIVATE_NOTE <script>not HTML</script> restart everything'}})).json();
  assert.equal(saved.memory_receipt.revision,1);assert.equal(saved.enabled,false);assert.equal(saved.configured,false);
  genie.close();genie=new Genie(null,()=>s,{memory:new GenieMemory(dir,{now:()=>1000})});
  const after=await (await fetch(url+'/api/genie')).json();assert.equal(after.memory.enabled,true);assert.match(after.memory.notes[0].data.text,/PRIVATE_NOTE/);
  assert.equal((await post({action:'memory-note',note:{id:saved.memory_receipt.id,expected_revision:0,text:'stale'}})).status,400);
  for(const endpoint of ['/api/status','/api/diagnostics'])assert.ok(!(await (await fetch(url+endpoint)).text()).includes('PRIVATE_NOTE'));
  const off=await (await post({action:'memory',enabled:false})).json();assert.equal(off.memory.enabled,false);assert.deepEqual(off.memory.notes,[]);
  assert.match(fs.readFileSync(m.file,'utf8'),/PRIVATE_NOTE/);assert.equal(new GenieMemory(dir).enabled,false);
});
