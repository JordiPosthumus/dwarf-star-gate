import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {HourglassReports,hourglassForChat} from './hourglass-reports.mjs';
import {GenieChat} from './genie-chat.mjs';
import {loadConfig} from './config.mjs';
import http from 'node:http';
import {once} from 'node:events';
import {runDashboard} from './dashboard.mjs';

const report=()=>({format:'hourglass-public-report-v1',model:'example-model',score_version:'total-points-v1',hourglass_score:0,
  state:'final',is_current_run:false,benchmark_version:'4.0.0',scoring:'net-hour-v3',run_date:'2026-01-01T00:00:00Z',
  notes:'PRIVATE_NOTES',questions:'PRIVATE_QUESTIONS'});
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'sg-hourglass-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return {root,file:path.join(root,'report.json')};}

test('explicit references resolve beside the configuration and preserve unknown associations',t=>{
  const {root,file}=fixture(t),config=path.join(root,'config.json');fs.writeFileSync(file,JSON.stringify(report()));
  fs.writeFileSync(config,JSON.stringify({state_file:'runtime/state.json',hourglass_reports:[{file:'report.json'}]}));
  const c=loadConfig(config).config;assert.equal(c.hourglass_reports[0].file,file);
  const s=new HourglassReports(c.hourglass_reports).snapshot();assert.equal(s.reports[0].summary.score.value,0);
  assert.equal(s.reports[0].association.worker_id,null);assert.equal(s.reports[0].association.route,'unknown');
  assert.doesNotMatch(JSON.stringify(s),/PRIVATE_NOTES|PRIVATE_QUESTIONS|report\.json/);
  assert.equal(new HourglassReports().snapshot().configured,false);
});

test('edited or replaced reports invalidate the cached revision; broken files never reuse stale evidence',t=>{
  const {root,file}=fixture(t);fs.writeFileSync(file,JSON.stringify(report()));const reader=new HourglassReports([{file}]);
  const before=reader.snapshot().reports[0];assert.deepEqual(reader.snapshot().reports[0],before);
  const replacement=path.join(root,'replacement.json');fs.writeFileSync(replacement,JSON.stringify({...report(),hourglass_score:7}));fs.renameSync(replacement,file);
  const after=reader.snapshot().reports[0];assert.notEqual(before.report_revision,after.report_revision);assert.equal(after.summary.score.value,7);
  fs.writeFileSync(file,'broken');assert.equal(reader.snapshot().reports.length,0);assert.equal(reader.snapshot().unavailable.length,1);
  assert.equal(fs.readFileSync(file,'utf8'),'broken');
  fs.unlinkSync(file);assert.equal(reader.snapshot().reports.length,0);
});

test('symlinks, named pipes, oversized and unrelated files are rejected without writes or hangs',t=>{
  const {root,file}=fixture(t);fs.writeFileSync(file,JSON.stringify(report()));const link=path.join(root,'linked');fs.symlinkSync(file,link);
  const large=path.join(root,'large.json');fs.writeFileSync(large,' '.repeat(1048577));
  const pipe=path.join(root,'pipe');execFileSync('mkfifo',[pipe]);
  const module=new URL('./hourglass-reports.mjs',import.meta.url).href;
  const output=execFileSync(process.execPath,['--input-type=module','-e',`import {HourglassReports} from ${JSON.stringify(module)};console.log(JSON.stringify(new HourglassReports(${JSON.stringify([{file:link},{file:large},{file:pipe}])}).snapshot()));`],{timeout:3000});
  const result=JSON.parse(output);assert.equal(result.reports.length,0);assert.equal(result.unavailable.length,3);
  assert.ok(fs.lstatSync(pipe).isFIFO());assert.equal(fs.statSync(large).size,1048577);
});

test('chat reapplies the allowlist, stores exact evidence and retains it after a later report edit',async t=>{
  const {root,file}=fixture(t);fs.writeFileSync(file,JSON.stringify(report()));
  const reader=new HourglassReports([{file,worker_id:'example',route:'direct',contention:'owner-confirmed-idle',approved_configuration_revision:'a'.repeat(64)}]);
  const value=reader.snapshot(),revision=value.reports[0].report_revision;value.reports[0].summary.private_field='PRIVATE_ALTERNATE';
  value.reports[0].association.file='/private/PRIVATE_ALTERNATE';
  assert.doesNotMatch(JSON.stringify(hourglassForChat(value)),/PRIVATE_/);
  assert.doesNotMatch(JSON.stringify(reader.snapshot()),/PRIVATE_/,'consumers cannot contaminate cached summaries');
  const calls=[],directory=path.join(root,'chat'),provider={generate:async input=>{calls.push(input);return {text:'Recorded score is zero.'};}};
  let chat=new GenieChat({directory,provider,getSnapshot:()=>({hourglass_reports:reader.snapshot()})});const conversation=chat.create();
  chat.submit(conversation.id,'What was the recorded score?','hourglass-request');await chat.idle();
  assert.equal(calls[0].context.hourglass_reports.reports[0].summary.score.value,0);
  assert.equal(calls[0].context.hourglass_reports.reports[0].association.route,'direct');
  fs.writeFileSync(file,JSON.stringify({...report(),hourglass_score:99}));
  chat=new GenieChat({directory,provider});const saved=chat.get(conversation.id).messages.at(-1).context.hourglass_reports;
  assert.equal(saved.reports[0].summary.score.value,0);assert.equal(saved.reports[0].report_revision,revision);
  assert.match(saved.scope,/not inferred or verified/);
});

test('invalid reference configuration is explicit and cannot introduce arbitrary association fields',()=>{
  for(const entries of [null,{},Array(51).fill({file:'report.json'}),[{file:'report.json',command:'run'}],
    [{file:'report.json',worker_id:'../other'}],[{file:'report.json',approved_configuration_revision:'unverified'}],
    [{file:'report.json',route:'automatic'}],[{file:'report.json',contention:'verified'}]])assert.throws(()=>new HourglassReports(entries));
});

test('normal dashboard startup serves configured summaries and assets without exposing source files',async t=>{
  const {root,file}=fixture(t);fs.writeFileSync(file,JSON.stringify(report()));
  const core=http.createServer((_req,res)=>res.end(JSON.stringify({version:1,model:'example',context_length:262144,workers:[],total:0,healthy:0,active:0,queued:0})));
  core.listen(0,'127.0.0.1');await once(core,'listening');t.after(()=>{core.closeAllConnections();core.close();});
  const config=path.join(root,'config.json');fs.writeFileSync(config,JSON.stringify({port:core.address().port,api_key:'synthetic',nodes:[],state_file:path.join(root,'runtime/state.json'),hourglass_reports:[{file:'report.json'}]}));
  const app=await runDashboard(config,0);t.after(app.close);const origin=`http://127.0.0.1:${app.server.address().port}`;
  const value=await(await fetch(origin+'/api/status')).json();assert.equal(value.hourglass_reports.reports[0].summary.score.value,0);
  assert.doesNotMatch(JSON.stringify(value),/PRIVATE_NOTES|PRIVATE_QUESTIONS|report\.json/);
  const html=await(await fetch(origin)).text();assert.match(html,/id="hourglass-reports"/);
  assert.equal((await fetch(origin+'/report.json')).status,404);
});


test('chat retains owned measurement provenance without upgrading imported associations',async t=>{
  const {root}=fixture(t);
  const source='Reviewed gateway mapping and observed native target; full settings equivalence is not implied.';
  const summary=(await import('./hourglass-report.mjs')).hourglassReportSummary({...report(),timeouts:1,raw_correct:20,completed_questions:20,efficiency:{median_output_tokens:1391}});
  const supplied={configured:true,reports:[{report_revision:'b'.repeat(64),association:{worker_id:'example',route:'direct',contention:'owned-maintenance',approved_configuration_revision:'a'.repeat(64),source},summary}]};
  const calls=[],chat=new GenieChat({directory:path.join(root,'chat'),provider:{generate:async input=>{calls.push(input);return {text:'The recorded run used an owned window.'};}},getSnapshot:()=>({hourglass_reports:supplied})});
  const conversation=chat.create();chat.submit(conversation.id,'Was the recorded run kept off gateway traffic?','owned-window');await chat.idle();
  const evidence=calls[0].context.hourglass_reports;
  assert.equal(evidence.reports[0].association.contention,'owned-maintenance');assert.equal(evidence.reports[0].association.source,source);
  assert.equal(evidence.reports[0].summary.timeouts,1);assert.equal(evidence.reports[0].summary.raw_correct,20);assert.equal(evidence.reports[0].summary.efficiency.median_output_tokens,1391);
  assert.match(evidence.scope,/does not prove complete settings equivalence or exclude new direct traffic/);
  assert.deepEqual(chat.get(conversation.id).messages.at(-1).context.hourglass_reports,evidence);
  const unknown=structuredClone(supplied);unknown.reports[0].association.source='PRIVATE arbitrary claim';unknown.reports[0].association.contention='fully-isolated';
  const sanitized=hourglassForChat(unknown).reports[0].association;
  assert.equal(sanitized.contention,'unknown');assert.equal(sanitized.source,'operator-supplied association; not independently verified');
  assert.throws(()=>new HourglassReports([{file:path.join(root,'missing'),contention:'owned-maintenance'}]),'An imported report cannot opt into an owned workflow');
});
