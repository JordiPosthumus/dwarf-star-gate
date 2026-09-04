import {test} from 'node:test';
import assert from 'node:assert/strict';
import {auditCacheContinuity} from './cache-continuity-audit.mjs';

let event=0;
const profile='a'.repeat(64),session='b'.repeat(64);
function request({id,at,node='spark1',affinity='existing',prompt=1000,cached=900,completion=100,turn=null,compaction=null,epoch=1,outcome='complete',finish_reason='stop',route='/v1/chat/completions',relocated=false}={}){
  const run_id='run';
  const client_metadata=turn===null?{schema:1,status:'missing',source:'client_header',prompt_tokens_estimate:null,turn_index:null,compaction_count:null,reasoning_effort:null}:{schema:1,status:'ready',source:'client_header',prompt_tokens_estimate:prompt,turn_index:turn,compaction_count:compaction,reasoning_effort:'xhigh'};
  const decision={schema:1,run_id,event_id:`e${++event}`,request_id:id,kind:'decision',time:new Date(at).toISOString(),node,session,affinity,client_metadata,candidates:[{node,profile,observation_epoch:epoch}]};
  const finish={schema:1,run_id,event_id:`e${++event}`,request_id:id,kind:'finish',time:new Date(at+1000).toISOString(),node,outcome,finish_reason,route,usage:{prompt_tokens:prompt,cached_tokens:cached,completion_tokens:completion}};
  const rows=[decision,finish];
  if(relocated)rows.splice(1,0,{schema:1,run_id,event_id:`e${++event}`,request_id:id,kind:'queue_relocation',time:new Date(at+100).toISOString(),node,source:node,destination:'spark2'});
  return rows;
}

test('measured continuity stays separate from strongly guarded low reuse',()=>{
  const rows=[
    ...request({id:'r1',at:10000,affinity:'new',cached:0,turn:1,compaction:0}),
    ...request({id:'r2',at:20000,cached:900,turn:2,compaction:0}),
    ...request({id:'r3',at:30000,prompt:1200,cached:100,turn:3,compaction:0}),
  ];
  const result=auditCacheContinuity(rows);
  assert.equal(result.assessed_pairs,2);assert.equal(result.strong_guard_pairs,2);
  assert.equal(result.classifications.reuse_observed,1);assert.equal(result.classifications.high_suspicion_low_reuse,1);
  assert.equal(result.workers.spark1.high_suspicion_low_reuse,1);assert.equal(result.authority,'none');
  assert.ok(!JSON.stringify(result).includes(session));assert.ok(!JSON.stringify(result).includes('r1'));assert.ok(!JSON.stringify(result).includes(profile));
});

test('missing client metadata makes low reuse unconfirmed, never a proved miss',()=>{
  const result=auditCacheContinuity([...request({id:'a',at:10000,affinity:'new',cached:0}),...request({id:'b',at:20000,prompt:1100,cached:0})]);
  assert.equal(result.classifications.unconfirmed_low_reuse,1);assert.equal(result.strong_guard_pairs,0);
  assert.match(result.evidence_boundary,/not prompt-prefix or engine-protocol proof/);
});

test('compaction, profile and epoch changes, relocation and failed evidence abstain',()=>{
  const changedProfile=request({id:'p2',at:20000,turn:2,compaction:0});changedProfile[0].candidates[0].profile='c'.repeat(64);
  const cases=[
    [[...request({id:'p1',at:10000,affinity:'new',turn:1,compaction:0}),...changedProfile],'worker_profile_changed'],
    [[...request({id:'e1',at:10000,affinity:'new',turn:1,compaction:0,epoch:1}),...request({id:'e2',at:20000,turn:2,compaction:0,epoch:2})],'observation_epoch_changed'],
    [[...request({id:'c1',at:10000,affinity:'new',turn:1,compaction:0}),...request({id:'c2',at:20000,turn:2,compaction:1})],'client_compaction_changed'],
    [[...request({id:'m1',at:10000,affinity:'new'}),...request({id:'m2',at:20000,relocated:true})],'queued_relocation_observed'],
    [[...request({id:'f1',at:10000,affinity:'new'}),...request({id:'f2',at:20000,outcome:'upstream_error'})],'incomplete_or_failed_request'],
  ];
  for(const [rows,reason] of cases){const result=auditCacheContinuity(rows);assert.equal(result.assessed_pairs,0,reason);assert.equal(result.abstention_reasons[reason],1,reason);}
});

test('pairing is consecutive, run-scoped, bounded and rejects conflicting evidence IDs',()=>{
  const first=request({id:'one',at:10000,affinity:'new'}),second=request({id:'two',at:20000});second.forEach(row=>row.run_id='new-run');
  const report=auditCacheContinuity([...first,...second]);assert.equal(report.abstention_reasons.gateway_run_changed,1);
  assert.throws(()=>auditCacheContinuity([], {maxAgeMs:1}),/one minute/);
  const duplicate={...first[0]},conflict={...first[0],node:'spark2'};
  assert.throws(()=>auditCacheContinuity([duplicate,conflict]),/Conflicting/);
});

test('stale, shrinking, route-changing and non-existing-affinity pairs abstain with exact reasons',()=>{
  const cases=[
    [[...request({id:'s1',at:10000,affinity:'new'}),...request({id:'s2',at:10000+25*60*60*1000})],'continuity_evidence_stale'],
    [[...request({id:'q1',at:10000,affinity:'new',prompt:2000}),...request({id:'q2',at:20000,prompt:1000})],'prompt_shrank_or_compacted'],
    [[...request({id:'r1',at:10000,affinity:'new'}),...request({id:'r2',at:20000,route:'/v1/responses'})],'request_route_changed_or_unknown'],
    [[...request({id:'n1',at:10000,affinity:'new'}),...request({id:'n2',at:20000,affinity:'new'})],'current_affinity_not_existing'],
  ];
  for(const [rows,reason] of cases){const report=auditCacheContinuity(rows);assert.equal(report.assessed_pairs,0);assert.equal(report.abstention_reasons[reason],1);}
});
