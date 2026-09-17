import test from 'node:test';import assert from 'node:assert/strict';
import {hourglassReportSummary} from './hourglass-report.mjs';
import {compareHourglassReports} from './hourglass-comparison.mjs';
const row=(revision,score)=>({report_revision:revision.repeat(64),association:{worker_id:'example',route:'direct',contention:'owned-maintenance',approved_configuration_revision:'f'.repeat(64)},summary:hourglassReportSummary({format:'hourglass-public-report-v1',model:'example',run_key:revision,state:'final',is_current_run:false,score_version:'total-points-v1',hourglass_score:score,benchmark_version:'4.1.0',scoring:'net-hour-v3',timing_policy:'hour-v1',bank_fingerprint:'c'.repeat(64),configuration_key:revision.repeat(64),machine_key:'d'.repeat(64),window_seconds:3600,active_seconds:3600.05,clock_adjustment_seconds:0,question_timeout_policy:'question-900s-auto-advance-v1',execution:{question_timeout_s:900,repeat:1,stop_after_wrong:0,round_policy:'whole-bank-slowest-wrong-first-v1'}})});
const compare=(a,b)=>compareHourglassReports([a,b],a.report_revision,b.report_revision);
test('matching recorded methodology yields arithmetic, preserving different configurations and original scores',()=>{
 const a=row('a',20),b=row('b',25),before=structuredClone([a,b]),r=compare(a,b);
 assert.equal(r.state,'recorded_conditions_match');assert.deepEqual(r.difference,{value:5,unit:'points',direction:'higher'});assert.equal(r.configuration_key_changed,true);assert.deepEqual([a,b],before);assert.match(r.scope,/not proof/);
 for(const [base,next,expected] of [[0,0,0],[0,-2,-2],[-4,-2,2]])assert.equal(compare(row('a',base),row('b',next)).difference.value,expected);
});
test('different or incomplete benchmark protocols never receive a calculated difference',()=>{
 for(const [field,value] of [['bank_fingerprint','e'.repeat(64)],['window_seconds',1800],['benchmark_version','older'],['question_timeout_policy',null],['scoring_policy','net-hour-v2'],['timing_policy','different']]){
  const a=row('a',20),b=row('b',25);b.summary[field]=value;const r=compare(a,b);assert.equal(r.difference,null,field);assert.ok(r.protocol_issues.some(i=>i.field===field));
 }
 for(const change of [b=>b.summary.state='partial',b=>b.summary.score.value=null,b=>b.summary.score.version='unknown',b=>b.summary.execution.repeat=2]){const b=row('b',25);change(b);assert.equal(compare(row('a',20),b).difference,null);}
});
test('unknown traffic, missing stop policy and caveats remain explicit even when score arithmetic is valid',()=>{
 const a=row('a',39),b=row('b',28);a.association.route='unknown';a.association.contention='unknown';a.association.approved_configuration_revision=null;a.summary.execution.stop_after_wrong=null;b.summary.execution.stop_after_wrong=null;b.summary.clock_adjustment_seconds=5;b.summary.caveats=[{label:'Adjusted clock',attempts:1,message:'PRIVATE'}];
 const r=compare(a,b);assert.equal(r.state,'conditions_need_review');assert.equal(r.difference.value,-11);assert.ok(r.condition_issues.some(i=>i.field==='route'));assert.ok(r.condition_issues.some(i=>i.field==='baseline.contention'));assert.ok(r.condition_issues.some(i=>i.field==='execution.stop_after_wrong'));assert.ok(r.condition_issues.some(i=>i.field==='candidate.report_caveats'));assert.doesNotMatch(JSON.stringify(r),/PRIVATE/);
});
test('comparison requires two retained unambiguous revisions and strips raw payloads',()=>{
 const a=row('a',20),b=row('b',25);a.summary.raw_questions='PRIVATE';a.path='PRIVATE';a.association.secret='PRIVATE';assert.doesNotMatch(JSON.stringify(compare(a,b)),/PRIVATE/);
 for(const ids of [['a'.repeat(64),'a'.repeat(64)],['x','b'.repeat(64)],['a'.repeat(64),'e'.repeat(64)]])assert.throws(()=>compareHourglassReports([a,b],...ids));
 assert.throws(()=>compareHourglassReports([a,a,b],a.report_revision,b.report_revision),/ambiguous/);
});
