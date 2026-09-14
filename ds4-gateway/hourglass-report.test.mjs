import test from 'node:test';
import assert from 'node:assert/strict';
import {hourglassReportSummary} from './hourglass-report.mjs';

const report=()=>({format:'hourglass-public-report-v1',model:'example-model',run_key:'example-run',
  run_date:'2026-01-01T12:00:00Z',created_at:'2026-01-02T12:00:00Z',state:'final',is_current_run:false,
  score_version:'total-points-v1',hourglass_score:12,benchmark_version:'4.0.0',scoring:'net-hour-v3',
  timing_policy:'hour-v1',bank_fingerprint:'a'.repeat(64),configuration_key:'b'.repeat(64),machine_key:'c'.repeat(64),
  active_seconds:3600.035,window_seconds:3600,clock_adjustment_seconds:0,
  execution:{question_timeout_s:900,stop_after_wrong:0,repeat:1,round_policy:'recorded-round-policy'},
  hardware:{label:'Example hardware',source:'owner supplied'}});

test('native Hourglass scores retain metric, protocol, dates and zero or negative points without recalculation',()=>{
  for(const value of [12,0,-4]){
    const input={...report(),hourglass_score:value},before=structuredClone(input),summary=hourglassReportSummary(input);
    assert.deepEqual(input,before);assert.deepEqual(summary.score,{value,version:'total-points-v1',unit:'points',recognized:true,final:true});
    assert.equal(summary.run_date,input.run_date);assert.equal(summary.report_created_at,input.created_at);
    assert.equal(summary.active_seconds,3600.035);assert.equal(summary.window_seconds,3600);
    assert.equal(summary.execution.stop_after_wrong,0);assert.equal(summary.scoring_policy,'net-hour-v3');
    assert.equal(summary.configuration_key,input.configuration_key);assert.match(summary.scope,/not Star Gate approval/);
  }
});

test('legacy and unknown metrics are not relabelled as current points',()=>{
  const old=hourglassReportSummary({...report(),score_version:'linear-auc-100-v1',hourglass_score:8.106353,
    benchmark_version:'2.7.1',scoring:'net-hour-v2',auc:{point_minutes:540.22085},weighted_points:14.972222});
  assert.equal(old.score.value,8.106353);assert.equal(old.score.unit,'legacy AUC score');assert.equal(old.benchmark_version,'2.7.1');
  assert.equal(old.scoring_policy,'net-hour-v2');assert.equal(old.auc,undefined);
  const future=hourglassReportSummary({...report(),score_version:'future-metric',hourglass_score:91});
  assert.equal(future.score.value,91);assert.equal(future.score.version,'future-metric');
  assert.equal(future.score.recognized,false);assert.equal(future.score.unit,null);
});

test('partial, missing, unavailable and contradictory states do not become final scores',()=>{
  for(const state of ['partial','unavailable','running','unknown'])assert.equal(hourglassReportSummary({...report(),state}).score.final,false);
  assert.equal(hourglassReportSummary({...report(),is_current_run:true}).state,'unknown');
  for(const value of [undefined,null,'12',NaN,Infinity])assert.equal(hourglassReportSummary({...report(),hourglass_score:value}).score.final,false);
  const unknown=hourglassReportSummary({format:'hourglass-public-report-v1',model:'example'});
  assert.equal(unknown.window_seconds,null);assert.equal(unknown.run_date,null);assert.equal(unknown.benchmark_version,null);
  assert.equal(unknown.score.value,null);assert.equal(unknown.state,'unknown');
});

test('raw questions, answers, traces, notes, paths and unrelated fields cannot cross the projection',()=>{
  const marker='PRIVATE_FIXTURE_CONTENT';
  const input={...report(),questions:marker,answers:marker,raw_trace:marker,notes:marker,
    experiment:{parameters:marker},configuration_disclosure:marker,endpoint:marker,api_key:marker,
    curve:[{question:marker}],hardware:{label:'Example hardware',source:'owner supplied',path:marker},
    repair:{private_source_path:marker},caveats:[{label:'Adjusted clock',attempts:2,message:marker,trace:marker}],
    execution:{question_timeout_s:900,private_path:marker}};
  const summary=hourglassReportSummary(input);assert.ok(!JSON.stringify(summary).includes(marker));
  assert.equal(summary.repaired,true);assert.deepEqual(summary.caveats,[{label:'Adjusted clock',attempts:2}]);
  assert.equal(summary.execution.question_timeout_s,900);
});

test('unrelated JSON is rejected and malformed optional metadata stays unknown',()=>{
  for(const input of [null,[],{}, {...report(),format:'raw-evaluation'}, {...report(),model:null}])assert.throws(()=>hourglassReportSummary(input),/aggregate report/);
  const summary=hourglassReportSummary({...report(),active_seconds:-1,window_seconds:'3600',run_date:'yesterday',bank_fingerprint:'wrong',execution:[]});
  assert.equal(summary.active_seconds,null);assert.equal(summary.window_seconds,null);assert.equal(summary.run_date,null);
  assert.equal(summary.bank_fingerprint,null);assert.equal(summary.execution.repeat,null);
});
