import test from 'node:test';import assert from 'node:assert/strict';
import {hourglassReportSummary} from './hourglass-report.mjs';
import {compareHourglassReports} from './hourglass-comparison.mjs';
import {createHash} from 'node:crypto';
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

test('operation association checks the completed candidate, worker and both recorded configurations',()=>{
 const a=row('a',20),b=row('b',25),id='11111111-2222-4333-8444-555555555555';
 a.association.approved_configuration_revision='1'.repeat(64);b.association.approved_configuration_revision='2'.repeat(64);
 const operation={id,result:{id,worker_id:'example',state:'completed',private_path:'PRIVATE',evidence:{serving:'candidate',qualification:{state:'passed'},configuration:{previous_record_revision:'1'.repeat(64),record_revision:'2'.repeat(64)}}}};
 const compareLinked=op=>compareHourglassReports([a,b],a.report_revision,b.report_revision,op);
 const linked=compareLinked(operation);assert.equal(linked.operation_association.state,'recorded_revisions_match');assert.equal(linked.difference.value,5);assert.doesNotMatch(JSON.stringify(linked),/PRIVATE/);
 for(const change of [o=>o.result.worker_id='another',o=>o.result.evidence.configuration.previous_record_revision='3'.repeat(64),o=>o.result.evidence.configuration.record_revision='3'.repeat(64),o=>o.result.evidence.serving='previous',o=>o.result.state='running',o=>o.result.evidence.qualification.state='failed',o=>o.result.id='different']){
  const op=structuredClone(operation);change(op);const result=compareLinked(op);assert.equal(result.operation_association.state,'needs_review');assert.equal(result.difference.value,5,'Report arithmetic remains separate from operation association');
 }
 assert.equal(compareLinked({id,result:null}).operation_association.state,'needs_review');
 b.association.approved_configuration_revision=null;assert.ok(compareLinked(operation).operation_association.issues.some(i=>i.field==='candidate.approved_configuration_revision'&&i.state==='unknown'));
});

test('a restored trial links candidate job and signature without inventing an adopted revision',()=>{
 const a=row('a',20),b=row('b',25),id='11111111-2222-4333-8444-555555555555',job='e'.repeat(32),signature='3'.repeat(64);
 a.association.approved_configuration_revision='1'.repeat(64);
 b.summary.run_key=createHash('sha256').update(job).digest('hex').slice(0,24);
 b.association={...b.association,approved_configuration_revision:null,source:'Recorded serving trial job and native candidate identity; original restored afterward.',trial:{operation_id:id,job_id:job,candidate_signature_sha256:signature}};
 const operation={id,result:{id,worker_id:'example',state:'restored',evidence:{serving:'previous',qualification:{state:'passed'},configuration:{previous_record_revision:'1'.repeat(64),record_revision:'2'.repeat(64)},trial:{state:'completed',job_id:job,candidate_signature_sha256:signature}}}};
 const compareTrial=op=>compareHourglassReports([a,b],a.report_revision,b.report_revision,op);
 const result=compareTrial(operation);assert.equal(result.operation_association.state,'recorded_trial_identity_matches');assert.equal(result.difference.value,5);
 assert.equal(result.candidate.association.approved_configuration_revision,null);
 for(const change of[o=>o.result.evidence.trial.job_id='d'.repeat(32),o=>o.result.evidence.trial.candidate_signature_sha256='4'.repeat(64),o=>o.result.state='running',o=>o.result.evidence.configuration.previous_record_revision='5'.repeat(64)]){
  const altered=structuredClone(operation);change(altered);assert.equal(compareTrial(altered).operation_association.state,'needs_review');
 }
});
