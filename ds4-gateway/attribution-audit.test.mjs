import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { summarizeAttribution } from './attribution-summary.mjs';
import { auditAttributionDirectory, auditAttributionReconciliation, reconcileAttributionRows } from './attribution-audit.mjs';

const sample=n=>n.toString(16).padStart(64,'0');
const row=(n,extra={})=>({event:'engine_attribution',sample_id:sample(n),node:'spark-a',status:'candidate',reason:'request_open',confidence:'heuristic',observed_at:n,...extra});
const epoch='a'.repeat(64),requestA='11111111-1111-4111-8111-111111111111',requestB='22222222-2222-4222-8222-222222222222';
const base=Date.parse('2026-09-04T00:20:00Z'),iso=value=>new Date(value).toISOString();
const overlap=(n=10,extra={})=>row(n,{engine_started_at:base,backend_epoch:epoch,backend_epoch_confidence:'strong',request_id:null,status:'abstained',reason:'overlapping_gateway_windows',confidence:'none',dispatch_delta_ms:null,prompt_tokens:1000,cached_tokens:900,new_tokens:100,...extra});
const engine=(n=10)=>({kind:'start',sample_id:sample(n),node:'spark-a',time:base,prompt:1000,cached:900,new_tokens:100,backend_epoch:epoch,backend_epoch_confidence:'strong'});
const earlyEngine=()=>({kind:'start',sample_id:sample(99),node:'spark-a',time:base-11*60000,prompt:10,cached:0,new_tokens:10,backend_epoch:epoch,backend_epoch_confidence:'strong'});
const gateway=()=>[
  {event:'request_dispatched',request_id:'00000000-0000-4000-8000-000000000000',node:'spark-a',time:iso(base-11*60000)},
  {event:'request_dispatched',request_id:requestA,node:'spark-a',time:iso(base-2000)},
  {event:'request_dispatched',request_id:requestB,node:'spark-a',time:iso(base-1000)},
  {event:'request_finished',request_id:requestA,node:'spark-a',time:iso(base+1000),outcome:'complete',usage:{prompt_tokens:800,cached_tokens:700}},
  {event:'request_finished',request_id:requestB,node:'spark-a',time:iso(base+2000),outcome:'complete',usage:{prompt_tokens:1000,cached_tokens:900}}
];

test('attribution quality uses final revisions and resolved starts as its honest denominator',()=>{
  const summary=summarizeAttribution([
    row(1),
    row(1,{observed_at:2,status:'corroborated',reason:'usage_match',confidence:'high_candidate'}),
    row(2,{node:'mac-a',status:'abstained',reason:'backend_epoch_unavailable',confidence:'none'}),
    row(3,{status:'corroborated',reason:'usage_match',confidence:'bounded_candidate'}),
    row(4),
    {...row(5),request_id:'private-is-ignored'},
    {...row(6),reason:'invented_reason'}
  ]);
  assert.deepEqual(summary.counts,{corroborated:2,candidate:2,abstained:1});
  assert.equal(summary.resolved_starts,3);assert.equal(summary.corroboration_rate_pct,66.7);
  assert.equal(summary.high_confidence,1);assert.equal(summary.bounded_confidence,1);assert.equal(summary.invalid_records,1);
  assert.deepEqual(summary.reason_counts,{backend_epoch_unavailable:1});
  assert.deepEqual(summary.by_worker.map(w=>[w.node,w.corroboration_rate_pct]),[['mac-a',0],['spark-a',100]]);
  assert.ok(!JSON.stringify(summary).includes('private-is-ignored'));
});

test('read-only audit is bounded, deduplicated and returns no paths or event identifiers',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dsg-attribution-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'metrics-2026-09-04.jsonl');
  fs.writeFileSync(file,[
    JSON.stringify(row(1)),
    JSON.stringify(row(1,{observed_at:2,status:'corroborated',reason:'usage_match',confidence:'high_candidate'})),
    JSON.stringify({event:'unrelated',secret:'private'}),
    '{bad json',
    JSON.stringify(row(2,{node:'mac-a',status:'abstained',reason:'backend_epoch_unavailable',confidence:'none'}))
  ].join('\n')+'\n');
  const report=auditAttributionDirectory(dir);
  assert.equal(report.files_read,1);assert.equal(report.malformed_lines,1);assert.equal(report.total_starts,2);
  assert.equal(report.corroboration_rate_pct,50);assert.deepEqual(report.reason_counts,{backend_epoch_unavailable:1});
  const output=JSON.stringify(report);assert.ok(!output.includes(dir));assert.ok(!output.includes(sample(1)));assert.ok(!output.includes('private'));
});

test('audit rejects symlink roots and skips symlinked metric files',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dsg-attribution-')),other=fs.mkdtempSync(path.join(os.tmpdir(),'dsg-attribution-other-'));
  t.after(()=>{fs.rmSync(dir,{recursive:true,force:true});fs.rmSync(other,{recursive:true,force:true});});
  const target=path.join(other,'target.jsonl');fs.writeFileSync(target,JSON.stringify(row(1))+'\n');
  fs.symlinkSync(target,path.join(dir,'metrics-2026-09-04.jsonl'));
  const report=auditAttributionDirectory(dir);assert.equal(report.files_read,0);assert.equal(report.skipped_files,1);assert.equal(report.total_starts,0);
  const rootLink=path.join(other,'root-link');fs.symlinkSync(dir,rootLink);assert.throws(()=>auditAttributionDirectory(rootLink),/real directory/);
});

test('audit validates exported bounds instead of relying on CLI validation',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dsg-attribution-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  for(const maxFiles of [0,8,NaN,1.5])assert.throws(()=>auditAttributionDirectory(dir,{maxFiles}),/maxFiles/);
  for(const maxBytesPerFile of [0,1023,8*1024*1024+1,NaN,2048.5])assert.throws(()=>auditAttributionDirectory(dir,{maxBytesPerFile}),/maxBytesPerFile/);
});

test('later exact usage safely reconciles an overlap without rewriting the recorded row',()=>{
  const original=overlap(),result=reconcileAttributionRows([original],[engine()],gateway(),{complete:true});
  assert.equal(result.reconciled_overlaps,1);assert.equal(result.remaining_overlap_abstentions,0);
  assert.deepEqual(result.summary.counts,{corroborated:1,candidate:0,abstained:0});
  assert.equal(original.status,'abstained');assert.equal(original.reason,'overlapping_gateway_windows');
  assert.ok(!JSON.stringify(result).includes(requestB));
});
test('reconciliation requires exact engine-start identity and rejects conflicting duplicate samples',()=>{
  const original=overlap(),start=engine();
  const changes=[{time:base+1},{backend_epoch:'b'.repeat(64)},{backend_epoch:null},{backend_epoch_confidence:'bounded'},
    {prompt:800,cached:700,new_tokens:100}];
  for(const change of changes){
    const result=reconcileAttributionRows([original],[{...start,...change}],gateway(),{complete:true});
    assert.equal(result.reconciled_overlaps,0,JSON.stringify(change));
    assert.equal(result.reconciliation_block_reasons.engine_start_conflict,1);
  }
  for(const values of [[start,{...start,time:base+1}],[{...start,time:base+1},start]]){
    const result=reconcileAttributionRows([original],values,gateway(),{complete:true});
    assert.equal(result.reconciled_overlaps,0);assert.equal(result.reconciliation_block_reasons.engine_start_conflict,1);
  }
  assert.equal(reconcileAttributionRows([original],[start,{...start}],gateway(),{complete:true}).reconciled_overlaps,1);
  assert.equal(reconcileAttributionRows([{...original,backend_epoch_confidence:'unavailable'}],[{...start,backend_epoch_confidence:'unavailable'}],gateway(),{complete:true}).reconciled_overlaps,0);
  assert.equal(original.status,'abstained');
});
test('conflicting gateway candidates cannot disappear and manufacture a unique overlap match',()=>{
  const log=gateway(),requestC='33333333-3333-4333-8333-333333333333';
  log.push({event:'request_dispatched',node:'spark-a',request_id:requestC,time:iso(base-500)},
    {event:'request_finished',node:'spark-a',request_id:requestC,time:iso(base+2000),outcome:'complete',usage:{prompt_tokens:1000,cached_tokens:900}},
    {event:'request_finished',node:'spark-a',request_id:requestC,time:iso(base+3000),outcome:'complete',usage:{prompt_tokens:800,cached_tokens:700}});
  const result=reconcileAttributionRows([overlap()],[engine()],log,{complete:true});
  assert.equal(result.reconciled_overlaps,0);assert.equal(result.reconciliation_block_reasons.gateway_evidence_conflict,1);
  assert.ok(!JSON.stringify(result).includes(requestC));
  const duplicate=gateway();duplicate.push({...duplicate.at(-1)});
  assert.equal(reconcileAttributionRows([overlap()],[engine()],duplicate,{complete:true}).reconciled_overlaps,1);
  const backwards=gateway();backwards.at(-1).time=iso(base-1500);
  const negative=reconcileAttributionRows([overlap()],[engine()],backwards,{complete:true});
  assert.equal(negative.reconciled_overlaps,0,'a finish before its own dispatch cannot corroborate an owner');
  assert.equal(negative.reconciliation_block_reasons.gateway_evidence_conflict,1);
});

test('malformed lifecycle timestamps cannot erase a possible competing request',()=>{
  const requestC='33333333-3333-4333-8333-333333333333';
  for(const time of [undefined,null,'not-a-time',0,'1970-01-01T00:00:00.000Z']){
    const log=[...gateway(),
      {event:'request_dispatched',node:'spark-a',request_id:requestC,time},
      {event:'request_finished',node:'spark-a',request_id:requestC,time:iso(base+2500),outcome:'complete',usage:{prompt_tokens:1000,cached_tokens:900}}];
    const before=structuredClone(log),original=overlap();
    const report=reconcileAttributionRows([original],[engine()],log,{complete:true});
    assert.equal(report.reconciled_overlaps,0,`invalid dispatch ${String(time)} cannot remove a competing window`);
    assert.equal(report.reconciliation_block_reasons.source_incomplete,1);
    assert.deepEqual(report.summary.counts,{corroborated:0,candidate:0,abstained:1});
    assert.deepEqual(log,before);assert.equal(original.status,'abstained');
    assert.ok(!JSON.stringify(report).includes(requestC));
  }
  const noFinishTime=gateway();delete noFinishTime.at(-1).time;
  assert.equal(reconcileAttributionRows([overlap()],[engine()],noFinishTime,{complete:true}).reconciliation_block_reasons.source_incomplete,1);
});

test('file reconciliation counts invalid lifecycle timestamps as incomplete evidence',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dsg-attribution-time-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const metricFile=path.join(dir,'metrics-2026-09-04.jsonl'),gatewayLog=path.join(dir,'gateway.log');
  fs.writeFileSync(metricFile,[earlyEngine(),engine(),overlap()].map(JSON.stringify).join('\n')+'\n');
  const log=[...gateway(),{event:'request_dispatched',node:'spark-a',request_id:'33333333-3333-4333-8333-333333333333',time:'invalid'}];
  fs.writeFileSync(gatewayLog,log.map(JSON.stringify).join('\n')+'\n');
  const report=auditAttributionReconciliation(dir,gatewayLog);
  assert.equal(report.source_complete,false);assert.equal(report.gateway_invalid_records,1);
  assert.equal(report.reconciled_overlaps,0);assert.equal(report.reconciliation_block_reasons.source_incomplete,1);
  assert.deepEqual(report.with_later_gateway_evidence,report.recorded);
  assert.equal(fs.readFileSync(gatewayLog,'utf8'),log.map(JSON.stringify).join('\n')+'\n');
});

test('fresh-start cohorts retain earlier ownership and competing-start evidence',()=>{
  const original=overlap(),old=overlap(11,{engine_started_at:base-1,request_id:requestB,status:'corroborated',reason:'usage_match',confidence:'high_candidate'});
  const options={complete:true,sinceMs:base};
  const clear=reconcileAttributionRows([original],[earlyEngine(),engine()],gateway(),options);
  assert.equal(clear.reconciled_overlaps,1);assert.equal(clear.summary.total_starts,1);
  const owned=reconcileAttributionRows([old,original],[earlyEngine(),engine()],gateway(),options);
  assert.equal(owned.reconciled_overlaps,0);assert.equal(owned.summary.total_starts,1);
  assert.equal(owned.reconciliation_block_reasons.request_collision,1);
  const competing=reconcileAttributionRows([original],[earlyEngine(),engine(),{...engine(12),time:base-1}],gateway(),options);
  assert.equal(competing.reconciled_overlaps,0);assert.equal(competing.reconciliation_block_reasons.competing_engine_start,1);
  assert.equal(competing.competing_start_details.identified_start,1);
  assert.ok(Object.keys(competing.competing_start_details).every(k=>['identified_start','anonymous_start','same_prompt_cache_usage','different_prompt_cache_usage','corroborated_other_owner','unresolved_competing_owner'].includes(k)));
  assert.equal(reconcileAttributionRows([old],[],gateway(),options).summary.total_starts,0);
  for(const sinceMs of [NaN,-1,1.5,'today'])assert.throws(()=>reconcileAttributionRows([],[],[],{sinceMs}),/sinceMs/);
});

test('independently corroborated other ownership can resolve an overlap without circular proposals',()=>{
  const other={...engine(11),time:base-500,prompt:800,cached:700};
  const owner=overlap(11,{engine_started_at:other.time,request_id:requestA,status:'corroborated',reason:'usage_match',confidence:'high_candidate',prompt_tokens:800,cached_tokens:700});
  const run=(o=owner,e=other,g=gateway())=>reconcileAttributionRows([overlap(),o],[earlyEngine(),engine(),e],g,{complete:true});
  assert.equal(run().reconciled_overlaps,1);
  const duplicateOwner=reconcileAttributionRows([overlap(),owner],[earlyEngine(),engine(),other,{...other,backend_epoch_confidence:'bounded'}],gateway(),{complete:true});
  assert.equal(duplicateOwner.reconciled_overlaps,0,'a conflicting duplicate cannot establish independent ownership');
  for(const change of [{status:'candidate',reason:'request_open'},{request_id:requestB},{backend_epoch:'b'.repeat(64)},{engine_started_at:base-501},{prompt_tokens:801,new_tokens:101}])assert.equal(run({...owner,...change}).reconciled_overlaps,0);
  assert.equal(run(owner,{...other,sample_id:undefined}).reconciled_overlaps,0);
  const failed=gateway();failed[3].outcome='client_cancelled';assert.equal(run(owner,other,failed).reconciled_overlaps,0);
  assert.equal(run({...owner,confidence:'none'}).reconciled_overlaps,0);
  const conflict=gateway();conflict.push({...conflict[3],time:iso(base+1500)});assert.equal(run(owner,other,conflict).reconciled_overlaps,0);
  assert.equal(run({...owner,status:'abstained',reason:'overlapping_gateway_windows',request_id:null}).reconciled_overlaps,0,'proposals may not corroborate one another');
});

test('contradictory latest attribution revisions cannot establish ownership by input order',()=>{
  const other={...engine(11),time:base-500,prompt:800,cached:700};
  const owner=overlap(11,{observed_at:base+3000,engine_started_at:other.time,request_id:requestA,status:'corroborated',reason:'usage_match',confidence:'high_candidate',prompt_tokens:800,cached_tokens:700});
  const conflict={...owner,request_id:null,status:'abstained',reason:'usage_conflict',confidence:'none'};
  const run=revisions=>reconcileAttributionRows([overlap(),...revisions],[earlyEngine(),engine(),other],gateway(),{complete:true});
  for(const revisions of [[owner,conflict],[conflict,owner],[owner,conflict,owner]]){
    const before=structuredClone(revisions),result=run(revisions);
    assert.equal(result.reconciled_overlaps,0);
    assert.equal(result.reconciliation_block_reasons.competing_engine_start,1);
    assert.deepEqual(revisions,before);
    assert.ok(!JSON.stringify(result).includes(requestA));
  }
  assert.equal(run([owner,{...owner}]).reconciled_overlaps,1,'identical duplicate receipts remain usable');
  const later={...owner,observed_at:owner.observed_at+1};
  for(const revisions of [[owner,conflict,later],[later,conflict,owner],[conflict,later,owner]]){
    assert.equal(run(revisions).reconciled_overlaps,1,'a unique strictly later revision supersedes an older tie');
  }
});

test('tied revisions block their target and every possible owner without suppressing unrelated matches',()=>{
  const target=overlap(),conflict={...target,confidence:'heuristic'};
  const run=revisions=>reconcileAttributionRows(revisions,[earlyEngine(),engine()],gateway(),{complete:true});
  for(const revisions of [[target,conflict],[conflict,target]]){
    assert.equal(run(revisions).reconciliation_block_reasons.attribution_evidence_conflict,1);
  }
  const unrelated=overlap(12,{node:'other-worker',engine_started_at:base-1000000,request_id:null,status:'abstained',reason:'usage_conflict'});
  assert.equal(run([target,unrelated,{...unrelated,confidence:'heuristic'}]).reconciled_overlaps,1);
  const claiming={...unrelated,request_id:requestB};
  for(const revisions of [[unrelated,claiming],[claiming,unrelated]]){
    const result=run([target,...revisions]);
    assert.equal(result.reconciled_overlaps,0);
    assert.equal(result.reconciliation_block_reasons.request_collision,1,'all tied owner claims remain vetoes even outside the cohort/window');
  }
  assert.equal(run([target,claiming,unrelated,{...unrelated,observed_at:unrelated.observed_at+1}]).reconciled_overlaps,1);
});

test('incomplete evidence, missing coverage, missing usage and request collisions keep overlap abstention',()=>{
  const original=overlap();
  assert.equal(reconcileAttributionRows([original],[engine()],gateway(),{complete:false}).reconciled_overlaps,0);
  assert.equal(reconcileAttributionRows([original],[engine()],gateway().slice(1),{complete:true}).reconciled_overlaps,0);
  const missingUsage=gateway();delete missingUsage.at(-1).usage;
  assert.equal(reconcileAttributionRows([original],[engine()],missingUsage,{complete:true}).reconciled_overlaps,0);
  assert.equal(reconcileAttributionRows([original],[{...engine(),sample_id:'bad'}],gateway(),{complete:true}).reconciled_overlaps,0);
  assert.equal(reconcileAttributionRows([original],[engine(),{...engine(12),sample_id:undefined,time:base+500}],gateway(),{complete:true}).reconciled_overlaps,0);
  const owner=overlap(11,{sample_id:sample(11),request_id:requestB,status:'corroborated',reason:'usage_match',confidence:'high_candidate',observed_at:base+3000});
  assert.equal(reconcileAttributionRows([original,owner],[engine()],gateway(),{complete:true}).reconciled_overlaps,0);
});

test('bounded reconciliation audit reports recorded and later-evidence views without identifiers or writes',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dsg-attribution-reconcile-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const metrics=path.join(dir,'metrics-2026-09-04.jsonl'),gatewayLog=path.join(dir,'gateway.log');
  fs.writeFileSync(metrics,[JSON.stringify(earlyEngine()),JSON.stringify(engine()),JSON.stringify(overlap())].join('\n')+'\n');
  fs.writeFileSync(gatewayLog,gateway().map(value=>JSON.stringify(value)).join('\n')+'\n');
  const report=auditAttributionReconciliation(dir,gatewayLog);
  assert.equal(report.source_complete,true);assert.equal(report.invalid_metric_records,0);assert.equal(report.anonymous_metric_starts,0);assert.equal(report.gateway_invalid_records,0);assert.equal(report.reconciled_overlaps,1);assert.equal(report.remaining_overlap_abstentions,0);
  assert.equal(report.recorded.reason_counts.overlapping_gateway_windows,1);assert.equal(report.with_later_gateway_evidence.counts.corroborated,1);
  const output=JSON.stringify(report);assert.ok(!output.includes(dir));assert.ok(!output.includes(requestA));assert.ok(!output.includes(requestB));assert.ok(!output.includes(sample(10)));
  const link=path.join(dir,'gateway-link.log');fs.symlinkSync(gatewayLog,link);assert.throws(()=>auditAttributionReconciliation(dir,link),/regular file/);
});

test('reconciliation supports the full source-record budget without argument-stack overflow',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dsg-attribution-budget-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const metrics=path.join(dir,'metrics-2026-09-04.jsonl'),gatewayLog=path.join(dir,'gateway.log');
  const line=JSON.stringify({kind:'start',node:'a',time:base,prompt:1,cached:0,new_tokens:1})+'\n';
  assert.ok(Buffer.byteLength(line)*250000<32*1024*1024);
  fs.writeFileSync(metrics,line.repeat(250000));fs.writeFileSync(gatewayLog,'');
  const report=auditAttributionReconciliation(dir,gatewayLog);
  assert.equal(report.source_complete,true);
  assert.equal(report.anonymous_metric_starts,250000);
  assert.equal(report.truncated_records,0);
  assert.equal(report.reconciled_overlaps,0);
});
