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
