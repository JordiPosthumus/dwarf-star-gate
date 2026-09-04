import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {auditEvidence,readEvidence} from './audit.mjs';
let sequence=0;
const row=(kind,at=0,extra={})=>({schema:1,run_id:'run-a',event_id:'event-'+sequence++,request_id:'request-a',node:'worker-a',time:new Date(100000+at).toISOString(),kind,...extra});
const moved=()=>[
  row('decision',0,{session:'PRIVATE_SESSION'}),
  row('queue_relocation',2000,{node:'worker-b',relocation_schema:1,source:'worker-a',destination:'worker-b',actor:'scheduler',dispatch_state:'not_dispatched',body_replayed:false,deadline_preserved:true,cache_locality:'unknown',waiting_ms:2000}),
  row('dispatch',3000,{node:'worker-b',queue_ms:3000}),
  row('finish',7000,{node:'worker-b',outcome:'complete',finish_reason:'stop',service_ms:4000,usage:{prompt_tokens:100,cached_tokens:80,completion_tokens:10}})
];
test('applied handovers join observed outcomes without inventing counterfactual savings or cache transfer',()=>{
  const input=moved(),a=auditEvidence([...input,input[1]]),r=a.relocation_outcomes;
  assert.equal(a.duplicates,1);assert.equal(r.requests,1);assert.equal(r.joined,1);assert.equal(r.unresolved,0);
  assert.equal(r.counterfactual_wait_saved_seconds,null);assert.equal(r.scope,'applied_receipts_only');
  const g=r.groups[0];assert.equal(g.source,'worker-a');assert.equal(g.destination,'worker-b');assert.equal(g.actor,'scheduler');
  assert.deepEqual(g.queue_seconds,{requests:1,mean:3});assert.deepEqual(g.post_move_queue_seconds,{requests:1,mean:1});
  assert.deepEqual(g.service_seconds,{requests:1,mean:4});assert.equal(g.reported_reuse.fraction,.8);assert.equal(g.outcomes.normal_terminal,1);
  const text=JSON.stringify(r);for(const secret of ['PRIVATE_SESSION','request-a','event-','run-a'])assert.ok(!text.includes(secret));
});
test('handover evidence abstains on duplicate joins, changed workers, invalid guarantees and chronology',()=>{
  const cases=[
    ['ambiguous_join',r=>r.push({...r[3],event_id:'other'})],
    ['ambiguous_join',r=>r.push({...r[1],event_id:'other'})],
    ['ambiguous_join',r=>r.push(row('queued_cancel',6000,{node:'worker-b'}))],
    ['invalid_move_receipt',r=>r[1].body_replayed=true],
    ['invalid_move_receipt',r=>r[1].deadline_preserved=false],
    ['invalid_move_receipt',r=>r[1].waiting_ms=-1],
    ['worker_join_conflict',r=>r[3].node='worker-a'],
    ['noncausal_join',r=>r[1].time=new Date(99000).toISOString()],
    ['noncausal_join',r=>r[2].time=new Date(101000).toISOString()],
    ['noncausal_join',r=>r[3].time=new Date(102500).toISOString()],
    ['missing_dispatch',r=>r.splice(2,1)],
  ];
  for(const [reason,mutate] of cases){const rows=moved();mutate(rows);const r=auditEvidence(rows).relocation_outcomes;assert.equal(r.joined,0,reason);assert.equal(r.abstentions[reason],1,reason);assert.equal(r.groups.length,0);}
  const pending=auditEvidence(moved().slice(0,3)).relocation_outcomes;assert.equal(pending.unresolved,1);assert.equal(pending.joined,0);
});
test('handover summaries separate capped, failed and unknown outcomes with per-metric coverage',()=>{
  const rows=[];
  for(const [i,outcome,finish_reason] of [[0,'complete','length'],[1,'client_cancelled',null],[2,undefined,null]]){
    const r=moved();for(const e of r)e.request_id=`move-${i}`;
    Object.assign(r[3],{outcome,finish_reason,service_ms:null,usage:{prompt_tokens:10,cached_tokens:11}});
    r[2].queue_ms=i===0?1000:null;rows.push(...r);
  }
  const r=auditEvidence(rows).relocation_outcomes,g=r.groups[0];assert.equal(r.joined,3);
  assert.deepEqual({...g.outcomes},{output_limited:1,failed_or_cancelled:1,unknown_outcome:1});
  assert.deepEqual(g.queue_seconds,{requests:1,mean:1});assert.deepEqual(g.post_move_queue_seconds,{requests:0,mean:null});
  assert.deepEqual(g.service_seconds,{requests:0,mean:null});assert.equal(g.reported_reuse.requests,0);assert.equal(g.reported_reuse.fraction,null);
});
test('duration audit separates output-limited occupancy from normal terminal labels',()=>{
  const rows=[['stop',299999],['length',3600000],['tool_calls',300000],[null,4000000]].map(([finish_reason,service_ms],i)=>row('finish',i,{request_id:`duration-${i}`,outcome:'complete',finish_reason,service_ms}));
  rows.push(row('finish',5,{request_id:'failed',outcome:'client_cancelled',service_ms:3600000}));
  const d=auditEvidence(rows).duration_evidence;
  assert.equal(d.normal_terminal.under_5m.requests,1);assert.equal(d.normal_terminal['5m_to_1h'].requests,1);
  assert.equal(d.output_limited['1h_plus'].service_seconds,3600);
  assert.equal(d.unverified_terminal['1h_plus'].requests,1);assert.equal(d.failed_or_cancelled['1h_plus'].requests,1);
  const ambiguous=[row('finish',1,{service_ms:3600000,outcome:'complete',finish_reason:'stop'}),row('finish',2,{service_ms:4000000,outcome:'complete',finish_reason:'length'})];
  assert.deepEqual(auditEvidence(ambiguous).duration_evidence,{});
});
test('audit joins on run/request identity, counts missing labels and never emits vectors or sessions',()=>{
  const rows=[row('decision',0,{session:'PRIVATE_SESSION',client_metadata:{status:'ready'}}),row('dispatch',1),row('request_features',2,{status:'ready'}),row('embedding',3,{status:'ready',available_at:100003,vectors:{latest_user:{truncated:true,vector:[.123456789]},recent_conversation:{truncated:false}}}),row('finish',4,{outcome:'complete',usage:{prompt_tokens:12,completion_tokens:3}}),
    row('decision',5,{run_id:'run-b'}),row('dispatch',6,{run_id:'run-b'}),row('finish',7,{run_id:'run-b',outcome:'client_cancelled'})];
  const a=auditEvidence(rows);assert.equal(a.totals.requests,2);assert.equal(a.totals.finishes,2);assert.equal(a.totals.missing_usage,1);assert.equal(a.totals.complete_missing_usage,0);
  assert.equal(a.totals.embedding_before_finish,1);assert.equal(a.totals.ready_features_without_embedding,0);assert.equal(a.totals.early_metadata_present,1);assert.equal(a.totals.latest_embedding_truncated,1);
  const text=JSON.stringify(a);for(const secret of ['PRIVATE_SESSION','.123456789','event-','request-a'])assert.ok(!text.includes(secret));
});
test('late embeddings and unresolved work stay distinct from missing text and failures',()=>{
  const a=auditEvidence([row('decision'),row('dispatch',1),row('request_features',2,{status:'ready'}),row('finish',3,{outcome:'complete'}),row('embedding',4,{status:'ready',available_at:100004}),row('decision',6,{request_id:'open'}),row('request_features',7,{request_id:'open',status:'capture_limit'})]);
  assert.equal(a.totals.complete_missing_usage,1);assert.equal(a.totals.embedding_after_finish,1);assert.equal(a.totals.no_terminal_observed,1);assert.equal(a.feature_status.capture_limit,1);
  assert.equal(a.workers['worker-a'].failed_or_cancelled,0);
});
test('pre-admission rejection receipts are counted separately, not as orphan training requests',()=>{
  const a=auditEvidence([row('rejection',0,{node:null})]);assert.equal(a.invalid,0);assert.equal(a.counts.rejection,1);assert.equal(a.totals.requests,0);assert.equal(a.totals.orphan_events,0);
});
test('patient waiting and pre-admission cancellation are evidence, not corrupt or orphan model rows',()=>{
  const a=auditEvidence([row('waiting',0,{node:null}),row('queued_cancel',1,{node:null}),row('waiting',2,{request_id:'other'}),row('decision',3,{request_id:'other'}),row('dispatch',4,{request_id:'other'}),row('finish',5,{request_id:'other',outcome:'complete',usage:{prompt_tokens:1,completion_tokens:1}})]);
  assert.equal(a.invalid,0);assert.equal(a.counts.waiting,2);assert.equal(a.totals.requests,1);assert.equal(a.totals.orphan_events,0);
});
test('known pre-dispatch relocation is valid evidence, not a wrong-worker join or training label',()=>{
  const profileA='a'.repeat(64),profileB='b'.repeat(64),inventory={schema:1,workers:{'worker-a':{matching_profiles:[profileA],hardware_family:'synthetic',accelerator_family:'cpu',ram_gib:16},'worker-b':{matching_profiles:[profileB],hardware_family:'synthetic',accelerator_family:'cpu',ram_gib:16}}};
  const rows=[row('decision',0,{session:'a'.repeat(64),candidates:[{node:'worker-a',profile:profileA,context_length:1000,queued:1,active:1},{node:'worker-b',profile:profileB,context_length:1000,queued:0,active:0}]}),
    row('routing_tiebreak_shadow',1,{shadow_schema:1,mode:'active_with_abstention',policy:'validated_remaining_tiebreak',verdict:'would_change',selected:'worker-a',alternative:'worker-b'}),
    row('queue_relocation',2,{node:'worker-b',relocation_schema:1,source:'worker-a',destination:'worker-b',actor:'scheduler',dispatch_state:'not_dispatched',body_replayed:false,deadline_preserved:true,cache_locality:'unknown',waiting_ms:2}),
    row('dispatch',3,{node:'worker-b'}),row('request_features',4,{node:'worker-b',status:'ready'}),row('finish',5,{node:'worker-b',outcome:'complete',finish_reason:'stop',service_ms:2,usage:{prompt_tokens:1,completion_tokens:1}})];
  const a=auditEvidence(rows,inventory);assert.equal(a.invalid,0);assert.equal(a.counts.routing_tiebreak_shadow,1);assert.equal(a.counts.queue_relocation,1);
  assert.equal(a.totals.relocated_requests,1);assert.equal(a.totals.known_relocated_joins,1);assert.equal(a.totals.wrong_worker_joins,0);assert.equal(a.training.rows,0);
});
test('duplicate and conflicting IDs, wrong-worker and noncausal joins are explicit',()=>{
  const d=row('decision',10),s=row('dispatch',5),f=row('finish',4,{node:'worker-b',outcome:'complete'});
  const a=auditEvidence([d,d,s,f]);assert.equal(a.duplicates,1);assert.equal(a.totals.wrong_worker_joins,1);assert.equal(a.totals.noncausal_joins,1);
  assert.throws(()=>auditEvidence([d,{...d,node:'worker-b'}]),/Conflicting/);
  assert.equal(auditEvidence([d,{...d,event_id:'different'}]).totals.ambiguous_joins,1);
  assert.equal(auditEvidence([{...d,kind:'raw private text'}]).invalid,1);
  assert.throws(()=>auditEvidence([d],null,{maxEvents:0}),/event budget/);
  assert.throws(()=>auditEvidence([d],null,{maxRequests:0}),/request budget/);
});
test('shared replay establishes embedded features are not admission-time features',()=>{
  const profile='a'.repeat(64),inventory={schema:1,workers:{'worker-a':{matching_profiles:[profile],hardware_family:'synthetic',accelerator_family:'cpu',ram_gib:16}}};
  const rows=[row('decision',0,{session:'a'.repeat(64),candidates:[{node:'worker-a',profile,context_length:1000,queued:0,active:0}]}),row('dispatch',1),row('request_features',2,{status:'ready',available_at:100002}),row('embedding',3,{status:'ready',dimensions:384,available_at:100003,vectors:{latest_user:{vector:Array(384).fill(1/Math.sqrt(384))}}}),row('finish',4,{outcome:'complete',finish_reason:'stop',service_ms:3,usage:{prompt_tokens:1,completion_tokens:1}})];
  const a=auditEvidence(rows,inventory);assert.equal(a.training.stages.admission.embedding_present,0);assert.equal(a.training.stages.embedded.embedding_present,1);assert.equal(a.training.stages.admission.zero_history,1);
});
test('reader reports a partial last line, rejects malformed complete lines and respects byte budget',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dsg-audit-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'routing-2026-01-01.jsonl');fs.writeFileSync(file,JSON.stringify(row('decision'))+'\n{"partial":');
  const data=readEvidence(dir);assert.equal(data.events.length,1);assert.equal(data.source.incomplete_tails,1);
  assert.throws(()=>readEvidence(dir,{maxBytes:1}),/byte budget/);
  fs.writeFileSync(file,'invalid\n');assert.throws(()=>readEvidence(dir),/Malformed/);
});
