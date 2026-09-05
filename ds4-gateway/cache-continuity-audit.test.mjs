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

test('malformed relevant evidence cannot erase an intervening request or move',()=>{
  for(const kind of ['decision','finish','queue_relocation'])for(const field of ['time','run_id','event_id','request_id','schema']){
    const first=request({id:'first',at:10000,turn:1,compaction:0});
    const middle=request({id:'middle',at:20000,relocated:kind==='queue_relocation'});
    const third=request({id:'third',at:30000,cached:0,turn:2,compaction:0});
    const broken=middle.find(row=>row.kind===kind);broken[field]=field==='schema'?2:'private invalid value';
    const rows=[...first,...middle,...third],before=JSON.stringify(rows);
    for(const input of [rows,[...rows].reverse()])assert.throws(()=>auditCacheContinuity(input),{
      message:'Invalid cache-continuity evidence; consecutive requests cannot be established',
    },`${kind}.${field}`);
    assert.equal(JSON.stringify(rows),before,'Audit must not rewrite the evidence');
  }
});

test('malformed unrelated records remain outside the cache-continuity evidence contract',()=>{
  const rows=[...request({id:'a',at:10000}),...request({id:'b',at:20000})];
  assert.deepEqual(auditCacheContinuity([...rows,{kind:'embedding',time:'invalid'}]),auditCacheContinuity(rows));
});

test('finish-before-admission evidence cannot claim reuse or strongly guarded cache loss',()=>{
  for(const bad of ['previous','current'])for(const cached of [0,900]){
    const first=request({id:'first',at:10000,affinity:'new',turn:1,compaction:0});
    const second=request({id:'second',at:20000,cached,turn:2,compaction:0});
    const target=bad==='previous'?first:second;
    target[1].time=new Date(Date.parse(target[0].time)-1).toISOString();
    const rows=[...first,...second],before=JSON.stringify(rows);
    const report=auditCacheContinuity(rows);
    assert.equal(report.assessed_pairs,0,bad);assert.equal(report.strong_guard_pairs,0);
    assert.equal(report.abstention_reasons.noncausal_request_evidence,1);
    assert.deepEqual(report.classifications,{});assert.equal(JSON.stringify(rows),before);
    assert.deepEqual(auditCacheContinuity([...rows].reverse()),report,'Input order must not hide contradictory time evidence');
  }
});

test('cache audit rejects invalid event-budget overrides rather than removing its bound',()=>{
  for(const maxEvents of [NaN,Infinity,-1,0,1.5,'200000',null,200001])
    assert.throws(()=>auditCacheContinuity([],{maxEvents}),/event budget/);
  assert.equal(auditCacheContinuity([],{maxEvents:1}).source_quality.relevant_events,0);
  const rows=request({id:'bounded',at:10000});
  assert.throws(()=>auditCacheContinuity(rows,{maxEvents:1}),/event budget/);
});

test('a contradictory middle request is not skipped to invent a consecutive pair',()=>{
  const first=request({id:'first',at:10000,affinity:'new',turn:1,compaction:0});
  const middle=request({id:'middle',at:20000,turn:2,compaction:0});
  middle[1].time=new Date(19999).toISOString();
  const third=request({id:'third',at:30000,turn:3,compaction:0});
  const fourth=request({id:'fourth',at:40000,turn:4,compaction:0});
  const result=auditCacheContinuity([...first,...middle,...third,...fourth]);
  assert.equal(result.candidate_pairs,3);assert.equal(result.assessed_pairs,1);
  assert.equal(result.abstention_reasons.noncausal_request_evidence,2);
  assert.equal(result.classifications.reuse_observed,1);
  // Millisecond timestamps cannot distinguish a zero-duration boundary. Do not
  // label equality contradictory or silently invent sub-millisecond precision.
  third[1].time=third[0].time;fourth[1].time=fourth[0].time;
  assert.equal(auditCacheContinuity([...third,...fourth]).assessed_pairs,1);
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
