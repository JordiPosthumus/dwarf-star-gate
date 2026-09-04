import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { summarizeAttribution } from './attribution-summary.mjs';
import { auditAttributionDirectory } from './attribution-audit.mjs';

const sample=n=>n.toString(16).padStart(64,'0');
const row=(n,extra={})=>({event:'engine_attribution',sample_id:sample(n),node:'spark-a',status:'candidate',reason:'request_open',confidence:'heuristic',observed_at:n,...extra});

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
