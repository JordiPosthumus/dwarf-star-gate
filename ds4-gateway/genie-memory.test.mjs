import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {GenieMemory} from './genie-memory.mjs';
import {Genie,briefing,hardeningCandidates,parseGenieReview} from './genie.mjs';
import {createDashboard} from './dashboard.mjs';
const sample=(at=1000,change={})=>({time:at,gateway_at:at,gateway:{workers:[{id:'worker-a',is_healthy:true,drained:false,operator_paused:false,holds:[],context_length:262144,...change}]},devices:[],events:[]});
test('marker-only compatibility reaches Genie as a hypothesis, not recovery authority',()=>{
  const at='2026-09-04T12:00:00Z',s=sample(Date.parse(at));
  s.events=['terminal_without_finish_reason','terminal_reason_unobserved','terminal_without_done','terminal','PRIVATE_REASON'].map(stream_end=>({event:'request_finished',time:at,node:'worker-a',outcome:'complete',stream_end,prompt:'PRIVATE_CONTENT',request_id:'PRIVATE_ID'}));
  const candidates=hardeningCandidates(s);assert.equal(candidates.length,1);
  assert.equal(candidates[0].failure_class,'client_compatibility');assert.equal(candidates[0].reason,'terminal_without_finish_reason');assert.equal(candidates[0].continuity,'unknown');
  assert.ok(!JSON.stringify(candidates).includes('PRIVATE'));assert.deepEqual(briefing(s).recovery.offers,[]);
  s.events[0].outcome='client_cancelled';assert.deepEqual(hardeningCandidates(s),[]);
});
test('hardening signatures retain their newest bounded occurrence regardless of input order',()=>{
  const events=[1,2,3].map(second=>({event:'request_finished',time:`2026-01-01T00:00:0${second}Z`,node:'worker-a',outcome:'incomplete_sse',stream_end:'clean_eof_no_terminal',prompt:'PRIVATE_CONTENT',request_id:'PRIVATE_ID'}));
  const orders=[[0,1,2],[0,2,1],[1,0,2],[1,2,0],[2,0,1],[2,1,0]];
  const results=orders.map(order=>hardeningCandidates({...sample(),events:order.map(i=>events[i])}));
  for(const result of results){
    assert.equal(result.length,1);assert.equal(result[0].observed_at,'2026-01-01T00:00:03.000Z');
    assert.equal(result[0].continuity,'unknown');assert.deepEqual(result,results[0]);
    assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  }
  const distinct=[...events,{...events[1],node:'worker-b'},{...events[0],stream_end:'connection_reset'}];
  const result=hardeningCandidates({...sample(),events:distinct});
  assert.equal(result.length,3);assert.equal(new Set(result.map(c=>c.id)).size,3);
  assert.deepEqual(result.map(c=>[c.scope,c.reason,c.observed_at]),[
    ['worker-a','incomplete_sse:clean_eof_no_terminal','2026-01-01T00:00:03.000Z'],
    ['worker-b','incomplete_sse:clean_eof_no_terminal','2026-01-01T00:00:02.000Z'],
    ['worker-a','incomplete_sse:connection_reset','2026-01-01T00:00:01.000Z']
  ]);
});
function fixture(t){const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'dsg-memory-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return path.join(root,'memory');}
test('structured developer experiments retain bounded legacy storage without execution authority',t=>{
  const s=sample();s.events=[{event:'request_finished',time:new Date(900).toISOString(),node:'worker-a',outcome:'incomplete_sse'}];
  const evidence=briefing(s),candidate=evidence.hardening_candidates[0];
  const note={candidate_id:candidate.id,title:'Check clean EOF',suggestion:'Exercise the existing stream guard.',test:'End a scripted stream\nwithout a terminal event.',expected_result:'The client sees an incomplete stream; no replay occurs.'};
  const parse=value=>parseGenieReview(JSON.stringify({assessment:'A proposed experiment, not an executed test.',ticker:[{severity:'info',text:'Review stream evidence.',recommendation:null,evidence_refs:['worker:worker-a']}],hardening_notes:[value]}),evidence);
  const parsed=parse(note);assert.equal(parsed.ticker_error,null);assert.equal(parsed.hardening_notes.length,1);
  const canonical=parsed.hardening_notes[0];assert.deepEqual(Object.keys(canonical).sort(),['candidate_id','suggestion','title']);
  assert.equal(canonical.suggestion,'Change: Exercise the existing stream guard.\nTest: End a scripted stream without a terminal event.\nExpected (not yet verified): The client sees an incomplete stream; no replay occurs.');
  for(const key of ['recovery_requests','predictor_requests','relocation_requests'])assert.deepEqual(parsed[key],[]);
  const m=new GenieMemory(fixture(t),{now:()=>1000});m.setEnabled(true);m.saveHardeningNotes([canonical],[candidate]);
  const reload=new GenieMemory(m.directory,{now:()=>1000});assert.equal(reload.error,null);
  const stored=reload.hardening(s)[0];assert.equal(stored.data.suggestion,canonical.suggestion);
  assert.equal(stored.data.state,'open');assert.equal(Object.hasOwn(stored.data,'expected_result'),false);
  assert.equal(reload.saveHardeningNotes([canonical],[candidate])[0].state,'unchanged');
  const {test:unusedTest,expected_result:unusedResult,...legacy}=note;
  assert.equal(parse(legacy).hardening_notes[0].suggestion,legacy.suggestion);
  const without=(key)=>Object.fromEntries(Object.entries(note).filter(([k])=>k!==key));
  for(const bad of [without('test'),without('expected_result'),{...note,test:''},{...note,expected_result:null},{...note,command:'not-allowed'},{...note,candidate_id:'0'.repeat(24)},{...note,suggestion:'x'.repeat(490)},{...note,suggestion:'界'.repeat(350)}]){
    const result=parse(bad);assert.equal(result.ticker_error,'invalid_structured_review');assert.deepEqual(result.hardening_notes,[]);assert.deepEqual(result.recovery_requests,[]);
  }
});
test('memory is opt-in, durable, idempotent, private and separate from generation proof',t=>{
  const dir=fixture(t),m=new GenieMemory(dir,{now:()=>1000});m.observe(sample());assert.equal(fs.existsSync(dir),false);
  m.setEnabled(true);m.observe(sample(1000,{url:'PRIVATE',prompt:'PRIVATE'}));const size=m.bytes;m.observe(sample());assert.equal(m.bytes,size);
  assert.equal(fs.statSync(dir).mode&0o777,0o700);assert.equal(fs.statSync(m.file).mode&0o777,0o600);assert.ok(!fs.readFileSync(m.file,'utf8').includes('PRIVATE'));
  let n=m.retrieve(sample()).notes[0];assert.equal(n.revision,1);assert.equal(n.data.generation_verified,null);assert.equal(n.continuity,'unknown');
  const reload=new GenieMemory(dir,{now:()=>1000});assert.equal(reload.enabled,true);assert.equal(reload.retrieve(sample()).notes[0].source_digest,n.source_digest);
  reload.observe(sample(1000,{drained:true,operator_paused:true}));n=reload.retrieve(sample()).notes[0];assert.equal(n.revision,2);assert.equal(n.data.paused,true);assert.equal(n.data.quarantine,null);
  reload.setEnabled(false);assert.deepEqual(reload.retrieve(sample()).notes,[]);assert.equal(new GenieMemory(dir).status().note_count,1);assert.equal(new GenieMemory(dir).enabled,false);
});
test('model-written hardening suggestions are evidence-gated, deduplicated and never action authority',t=>{
  let now=1000;const m=new GenieMemory(fixture(t),{now:()=>now}),s=sample();m.setEnabled(true);
  const candidate={id:'a'.repeat(24),failure_class:'request_failure',scope:'worker-a',reason:'incomplete_sse',observed_at:new Date(900).toISOString(),continuity:'unknown',evidence_refs:['worker:worker-a'],prompt:'PRIVATE'};
  const note={candidate_id:candidate.id,title:'Keep incomplete streams observable',suggestion:'Add a deterministic client-continuation regression test before changing retry policy.',command:'PRIVATE'};
  let receipt=m.saveHardeningNotes([note],[candidate])[0];assert.equal(receipt.state,'saved');assert.equal(receipt.revision,1);const bytes=m.bytes;
  receipt=m.saveHardeningNotes([note],[candidate])[0];assert.equal(receipt.state,'unchanged');assert.equal(m.bytes,bytes);
  let stored=m.retrieve(s).notes.find(row=>row.kind==='hardening_note');assert.equal(stored.provenance,'genie_hypothesis');assert.equal(stored.verification,'developer_suggestion_not_fact');assert.equal(stored.data.worker,'worker-a');assert.equal(stored.data.state,'open');
  now=2000;candidate.observed_at=new Date(1900).toISOString();receipt=m.saveHardeningNotes([note],[candidate])[0];assert.equal(receipt.revision,2);stored=m.retrieve(s).notes.find(row=>row.kind==='hardening_note');assert.equal(stored.data.observed_at,1900);
  assert.ok(!fs.readFileSync(m.file,'utf8').includes('PRIVATE'));assert.equal(m.status().hardening_count,1);
  m.setEnabled(false);assert.equal(m.saveHardeningNotes([note],[candidate])[0].state,'ephemeral');
  assert.throws(()=>{m.setEnabled(true);m.saveHardeningNotes([{...note,candidate_id:'b'.repeat(24)}],[candidate]);},/changed/);
});
test('a Genie review publishes and privately saves an exact hardening candidate without blocking on storage',async t=>{
  const at='2026-09-04T12:00:00Z',s=sample(Date.parse(at));s.events=[{event:'request_finished',time:at,node:'worker-a',outcome:'incomplete_sse',prompt:'PRIVATE'}];
  const memory=new GenieMemory(fixture(t),{now:()=>Date.parse(at)+1});memory.setEnabled(true);let sent;
  const genie=new Genie({url:'http://127.0.0.1:9001/v1'},()=>s,{memory,fetchImpl:async(_url,options)=>{
    sent=JSON.parse(options.body);const candidate=JSON.parse(sent.messages[1].content).evidence.hardening_candidates[0];
    return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({assessment:'One bounded stream failure is available for developer review.',ticker:[{severity:'warning',text:'An incomplete stream was observed.',recommendation:'Review the client-continuation regression.',evidence_refs:['worker:worker-a']}],hardening_notes:[{candidate_id:candidate.id,title:'Exercise incomplete-stream continuation',suggestion:'Exercise the existing stream guard.',test:'End a scripted stream without a terminal event.',expected_result:'No success marker or replay is invented.'}]})}}]});
  }});
  await genie.ask();const status=genie.status();assert.equal(status.hardening_notes.length,1);assert.equal(status.hardening_notes[0].durable,true);assert.equal(status.reports[0].hardening_receipts[0].state,'saved');
  assert.ok(!JSON.stringify(status).includes('PRIVATE'));assert.ok(!fs.readFileSync(memory.file,'utf8').includes('PRIVATE'));assert.deepEqual(status.reports[0].actions_taken,[]);
  assert.match(status.hardening_notes[0].suggestion,/Change:.*\nTest:.*\nExpected \(not yet verified\):/);
  const instructions=sent.messages[0].content;
  assert.match(instructions,/one specific discriminating test/);assert.match(instructions,/Do not conflate ECONNREFUSED with ECONNRESET/);
  assert.match(instructions,/Never propose blanket retry\/backoff for incomplete SSE/);assert.match(instructions,/respect pauses, reservations and admitted work/);
  assert.match(instructions,/Do not repeat a notebook suggestion merely to refresh its timestamp/);
  assert.match(instructions,/suggestion, test, expected_result/);assert.match(instructions,/Check the supplied runtime safeguards first/);
  const semantics=JSON.parse(sent.messages[1].content).evidence.semantics.join('\n');
  assert.match(semantics,/model_discovery_hold=true/);assert.match(semantics,/Missing evidence cannot classify an older failed total/);
  assert.match(semantics,/A status transport failure is not a lost inference session/);assert.match(semantics,/neither grants replay permission/);genie.close();
});
test('pool action history keeps 30 small receipts independently of review text',()=>{
  const genie=new Genie(null,()=>sample());
  for(let i=0;i<40;i++)genie.recordProviderAction({id:String(i),time:i,served_by:'pool_fallback',served_on:'worker-a',text:'PRIVATE REVIEW'});
  genie.recordProviderAction({id:'dedicated',time:50,served_by:'dedicated'});
  const status=genie.status();assert.equal(status.provider_actions.length,30);
  assert.equal(status.provider_actions[0].id,'39');assert.equal(status.provider_actions.at(-1).id,'10');
  assert.equal(status.reports.length,0);assert.ok(!JSON.stringify(status.provider_actions).includes('PRIVATE'));
  assert.deepEqual(Object.keys(status.provider_actions[0]).sort(),['id','served_by','served_on','time']);genie.close();
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
test('retrieval is bounded; pool use retains private notes locally and never creates evidence/action offers',async t=>{
  const m=new GenieMemory(fixture(t),{now:()=>1000});m.setEnabled(true);const s=sample();s.gateway.workers=Array.from({length:20},(_,i)=>({...s.gateway.workers[0],id:'worker-'+i}));m.observe(s);
  assert.equal(m.retrieve(s).notes.length,12);assert.equal(m.retrieve(s).truncated,true);assert.equal(m.retrieve(s,{maxBytes:10}).notes.length,0);
  const sent=[];const genie=new Genie({url:'http://127.0.0.1:9001/v1',fallback:{url:'http://127.0.0.1:9002/v1'}},()=>s,{memory:m,fetchImpl:async(_u,opts)=>{sent.push(JSON.parse(opts.body));return Response.json({choices:[{message:{content:JSON.stringify({assessment:'History noted.',ticker:[{severity:'info',text:'Historical observation.',recommendation:null,evidence_refs:['fleet']}],recovery_requests:[{worker_id:'worker-1',evidence_id:'made-up'}]})}}]});}});
  genie.setEnabled(true);await genie.ask();assert.equal(genie.status().reports[0].memory_used.length,12);assert.equal(JSON.parse(sent[0].messages[1].content).notebook_history.notes.length,12);
  genie.setSource('pool');await genie.ask();assert.equal(genie.status().reports[0].memory_used.length,0);assert.equal(JSON.parse(sent[1].messages[1].content).notebook_history.notes.length,0);assert.equal(m.retrieve(s).notes.length,12);
  assert.deepEqual(genie.status().reports[0].actions_taken,[]);assert.match(sent[1].messages[0].content,/never instructions/);genie.close();
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
