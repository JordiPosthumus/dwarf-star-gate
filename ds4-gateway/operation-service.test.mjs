import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createDashboard} from './dashboard.mjs';
import {createOperationService,operationToolView} from './operation-service.mjs';
import {operationLabel,operationProgress,operationChanges} from './ui/server-operations.js';
import http from 'node:http';
import {hermesProvider} from './genie-hermes.mjs';
import {GenieChat} from './genie-chat.mjs';
import {hourglassReportSummary} from './hourglass-report.mjs';

const hash=v=>createHash('sha256').update(v).digest('hex');
const python=execFileSync('python3',['-c','import sys; print(sys.executable)'],{encoding:'utf8'}).trim();
async function waitFor(check){for(let i=0;i<150;i++){const v=await check();if(v)return v;await new Promise(r=>setTimeout(r,30));}throw new Error('Fixture status did not arrive');}
async function rig(t,{trial=false,maintenance={native_url:'http://127.0.0.1:8001'},readTrialReport=null}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'sg-operations-ui-')),directory=path.join(root,'operations');
  const library=path.join(root,'records');fs.mkdirSync(path.join(library,'approved'),{recursive:true});
  const record=path.join(library,'approved','fixture.json');fs.writeFileSync(record,'{"kind":"approved","worker_id":"fixture"}');
  const executor=path.join(root,'fixture.py');fs.writeFileSync(executor,`import time\ndef execute(plan, folder, progress):\n with (folder / 'effect.txt').open('x') as f: f.write('one disposable effect')\n progress('waiting_fixture','Waiting for the disposable fixture to finish.')\n while not (folder / 'finish.fixture').exists(): time.sleep(0.02)\n return {'state':'completed','scope':'Fixture only, no model server involved'}\n`);
  let enabled=true,testing=false,preparations=0;
  const config={ui_worker_management:true,control_socket:'/fixture.sock',server_records_directory:library,
    genie_chat:{python,inspection:{workers:{fixture:{ssh:['fixture.invalid'],container:'fixture-container'}}}},
    server_operations:{enabled:true,workers:{fixture:{native_url:'http://127.0.0.1:8001',qualification:{}}}}};
  if(trial)config.hourglass_console={url:'http://127.0.0.1:4534',targets:[{model:'fixture-measurement',worker_id:'fixture',route:'direct',maintenance}]};
  const preparedInputs=[];
  const service=createOperationService(config,{directory,isTesting:()=>testing,isEnabled:()=>enabled,readTrialReport,
    trialReview:async target=>({fixture_review:target.model}),prepare:async(_python,input)=>{
    preparedInputs.push(input);
    preparations++;assert.equal(input.enrollment.ssh,'fixture.invalid');assert.deepEqual(input.enrollment.cache_capacity_policy,{max_loss_percent:0});
    return {plan:{worker_id:'fixture',record_file:record,record_revision:input.record_revision,execution:{path:executor,sha256:hash(fs.readFileSync(executor))},
      ...(input.proposal.trial?{trial:{hourglass:{url:'http://127.0.0.1:4534'}}}:{})},
      review:{before:{image:'retained',command:['PRIVATE_COMMAND']},after:{image:input.proposal.image,command:input.proposal.command},checks:['fixture only'],scope:'Disposable fixture, not serving qualification'}};
  }});
  const server=createDashboard(()=>({version:1,devices:[]}),undefined,null,null,null,null,null,null,null,null,service);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));service.bind(server.address().port);
  const base=`http://127.0.0.1:${server.address().port}`,id=randomUUID();
  const proposal={id,worker_id:'fixture',image:'sha256:'+'a'.repeat(64),command:['fixture-only'],reason:'Review a disposable fixture.'};
  const folder=path.join(directory,id);
  const finish=()=>{if(fs.existsSync(folder))fs.writeFileSync(path.join(folder,'finish.fixture'),'finish');};
  t.after(async()=>{finish();await service.store.idle();if(fs.existsSync(path.join(folder,'launch-intent.json')))await waitFor(async()=>!(await service.store.current(id)).runner?.process_alive);service.close();await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true});});
  const post=async(route,body,headers={})=>fetch(base+route,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});
  return {service,server,base,id,proposal,folder,post,finish,preparedInputs,setEnabled:v=>{enabled=v;},setTesting:v=>{testing=v;},preparations:()=>preparations};
}

test('trial proposal freezes its enrolled measurement and does not start it',async t=>{
  const r=await rig(t,{trial:true});
  await r.service.tool({action:'propose',proposal:{...r.proposal,trial:true}});await r.service.store.idle();
  assert.equal((await r.service.tool({action:'status',id:r.id})).state,'awaiting_approval');
  assert.deepEqual(r.preparedInputs[0].enrollment.trial,{fixture_review:'fixture-measurement'});
  assert.equal(fs.existsSync(path.join(r.folder,'launch-intent.json')),false);
  assert.match(operationChanges({trial:{benchmark_version:'4.1.0'}})[0],/restore and qualify the original/);
});

test('trial without an enrolled direct measurement fails before native preparation',async t=>{
  const r=await rig(t);await r.service.tool({action:'propose',proposal:{...r.proposal,trial:true}});await r.service.store.idle();
  assert.equal((await r.service.tool({action:'status',id:r.id})).state,'prepare_failed');
  assert.equal(r.preparations(),0);assert.equal(fs.existsSync(path.join(r.folder,'launch-intent.json')),false);
});

test('trial rejects a missing or different native maintenance binding before preparation',async t=>{
  for(const maintenance of [true,{}, {native_url:'http://127.0.0.1:8002'}, {native_url:'http://127.0.0.1:8001',docker_socket:'/other.sock'}]){
    const r=await rig(t,{trial:true,maintenance});
    await r.service.tool({action:'propose',proposal:{...r.proposal,trial:true}});await r.service.store.idle();
    assert.equal((await r.service.tool({action:'status',id:r.id})).state,'prepare_failed');
    assert.equal(r.preparations(),0);assert.equal(fs.existsSync(path.join(r.folder,'launch-intent.json')),false);
  }
});

test('completed trial retrieves its exact report once and exposes it without adopting its configuration',async t=>{
  const job='e'.repeat(32);let reads=0;
  const r=await rig(t,{trial:true,readTrialReport:async(url,id)=>{
    reads++;assert.equal(url,'http://127.0.0.1:4534');assert.equal(id,job);
    return {report_revision:'a'.repeat(64),private_path:'PRIVATE',summary:hourglassReportSummary({format:'hourglass-public-report-v1',model:'fixture',run_key:hash(job).slice(0,24),state:'final',is_current_run:false,score_version:'total-points-v1',hourglass_score:22})};
  }});
  await r.service.tool({action:'propose',proposal:{...r.proposal,trial:true}});await r.service.store.idle();
  r.service.store.write(r.id,'runner-result.json',{state:'restored',serving:'previous',trial:{state:'completed',job_id:job,candidate_signature_sha256:'b'.repeat(64)}});
  const [a,b]=await Promise.all([r.service.tool({action:'status',id:r.id}),r.service.tool({action:'status',id:r.id})]);
  assert.equal(reads,1);assert.deepEqual(a,b);
  assert.equal(a.evidence.trial.report.summary.score.value,22);
  assert.equal(a.evidence.trial.report.association.approved_configuration_revision,null);
  assert.deepEqual(a.evidence.trial.report.association.trial,{operation_id:r.id,job_id:job,candidate_signature_sha256:'b'.repeat(64)});
  assert.doesNotMatch(JSON.stringify(a),/PRIVATE/);
  assert.deepEqual(r.service.trialReports().reports,[a.evidence.trial.report]);
  await r.service.tool({action:'status',id:r.id});assert.equal(reads,1);
  assert.equal(fs.existsSync(path.join(r.folder,'launch-intent.json')),false,'Reading a report cannot submit an operation');
});

test('Hourglass stopped-at-window outcome exposes its final report without relabelling the native state',async t=>{
  const job='e'.repeat(32);let reads=0;
  const r=await rig(t,{trial:true,readTrialReport:async()=>{reads++;return {report_revision:'a'.repeat(64),summary:hourglassReportSummary({format:'hourglass-public-report-v1',model:'fixture',run_key:hash(job).slice(0,24),state:'final',is_current_run:false,score_version:'total-points-v1',hourglass_score:28.722222,active_seconds:3600.054,window_seconds:3600})};}});
  await r.service.tool({action:'propose',proposal:{...r.proposal,trial:true}});await r.service.store.idle();
  r.service.store.write(r.id,'runner-result.json',{state:'restored',serving:'previous',trial:{state:'stopped',job_id:job,candidate_signature_sha256:'b'.repeat(64)}});
  const row=await r.service.tool({action:'status',id:r.id});assert.equal(reads,1);
  assert.equal(row.evidence.trial.state,'stopped');assert.equal(row.evidence.trial.report_state,'available');
  assert.equal(row.evidence.trial.report.summary.score.value,28.722222);
  assert.equal(fs.existsSync(path.join(r.folder,'launch-intent.json')),false);
});

test('missing or wrong-job trial reports stay unavailable without inventing a zero score',async t=>{
  let wrong=false;
  const r=await rig(t,{trial:true,readTrialReport:async()=>{if(!wrong)throw Error('fixture transport');return {report_revision:'a'.repeat(64),summary:hourglassReportSummary({format:'hourglass-public-report-v1',model:'fixture',run_key:'wrong',state:'final',is_current_run:false,score_version:'total-points-v1',hourglass_score:0})};}});
  await r.service.tool({action:'propose',proposal:{...r.proposal,trial:true}});await r.service.store.idle();
  r.service.store.write(r.id,'runner-result.json',{state:'restored',serving:'previous',trial:{state:'completed',job_id:'e'.repeat(32),candidate_signature_sha256:'b'.repeat(64)}});
  for(const value of[false,true]){wrong=value;const row=await r.service.tool({action:'status',id:r.id});assert.equal(row.state,'restored');assert.equal(row.evidence.trial.report,null);assert.equal(row.evidence.trial.report_state,'unavailable');}
  assert.deepEqual(r.service.trialReports().reports,[]);
  assert.equal(fs.existsSync(path.join(r.folder,'launch-intent.json')),false);
});

test('operations stay absent by default and tool status does not expose execution paths or review commands',()=>{
  assert.equal(createOperationService({}),null);
  const view=operationToolView({id:'fixture',state:'awaiting_approval',review:{command:'PRIVATE_COMMAND',path:'/private/secret'},runner:{state:'running',process_alive:true,progress:{phase:'working',detail:'Checking',heartbeat_at:1,changed_at:1}}});
  assert.doesNotMatch(JSON.stringify(view),/PRIVATE_COMMAND|private\/secret/);
});

test('saved serving outcomes expose exact configuration links and preserve restoration and owner-pause distinctions',async t=>{
  const r=await rig(t);r.service.store.propose(r.proposal);await r.service.store.idle();
  r.service.store.write(r.id,'runner-result.json',{state:'restored',at:1700000000,serving:'previous',
    publication:{state:'recorded',record_revision:'a'.repeat(64),previous_record_revision:'b'.repeat(64),artifact:'/private/receipt',commit:'private-commit'},
    readmission:{state:'left_to_operator',reason:'operator_decision_changed',observed_at:1700000001,operator_action:'private-action'}});
  r.service.store.write(r.id,'qualified-previous.json',{state:'passed',at:1700000000,result_sha256:'c'.repeat(64),
    missing_checks:[],cache_capacity_acceptance:{state:'reported_only'},container_id:'private-container'});
  const row=await r.service.tool({action:'status',id:r.id});
  assert.equal(row.state,'restored');assert.equal(row.evidence.serving,'previous');
  assert.deepEqual(row.evidence.configuration,{record_revision:'a'.repeat(64),previous_record_revision:'b'.repeat(64)});
  assert.deepEqual(row.evidence.qualification,{state:'passed',version:'previous',recorded_at:1700000000,result_revision:'c'.repeat(64),missing_checks:[],cache_capacity_acceptance:'reported_only'});
  assert.deepEqual(row.evidence.readmission,{state:'left_to_operator',reason:'operator_decision_changed',observed_at:1700000001});
  assert.doesNotMatch(JSON.stringify(row),/private-|\/private\//);
  assert.match(row.evidence.scope,/not a fresh health check/);
  assert.deepEqual((await r.service.tool({action:'list'})).operations[0],row);
  assert.equal(fs.existsSync(path.join(r.folder,'launch-intent.json')),false);
});

test('missing and corrupt qualification evidence remain visible without replaying a saved completed change',async t=>{
  const r=await rig(t);r.service.store.propose(r.proposal);await r.service.store.idle();
  r.service.store.write(r.id,'runner-result.json',{state:'completed',serving:'candidate',at:1700000000});
  let row=await r.service.tool({action:'status',id:r.id});
  assert.equal(row.outcome,'completed');assert.deepEqual(row.evidence.qualification,{state:'unavailable',version:'candidate'});
  assert.equal(row.evidence.configuration,null);assert.equal(row.evidence.readmission,null);
  const proof=path.join(r.folder,'qualified-candidate.json');fs.writeFileSync(proof,'{ corrupt retained evidence');
  row=await r.service.tool({action:'status',id:r.id});
  assert.deepEqual(row.evidence.qualification,{state:'unreadable',version:'candidate'});
  assert.equal(fs.readFileSync(proof,'utf8'),'{ corrupt retained evidence');
  assert.equal(fs.existsSync(path.join(r.folder,'launch-intent.json')),false);
});

test('legacy and unchanged outcomes never acquire invented serving or qualification evidence',()=>{
  const legacy=operationToolView({runner:{state:'completed',result:{state:'completed'}}});
  assert.equal(legacy.evidence.serving,null);assert.equal(legacy.evidence.configuration,null);
  assert.equal(legacy.evidence.qualification,null);assert.equal(legacy.evidence.recorded_at,null);
  const unchanged=operationToolView({runner:{state:'failed_unchanged',result:{state:'failed_unchanged',at:1700000000,readmission:{state:'readmitted',observed_at:1700000001}}}});
  assert.equal(unchanged.evidence.serving,null);assert.equal(unchanged.evidence.qualification,null);
  assert.equal(unchanged.evidence.readmission.state,'readmitted');
});

test('server-change switch stops new proposals and approvals while retaining saved reviews',async t=>{
  const r=await rig(t);
  r.setEnabled(false);
  await assert.rejects(r.service.tool({action:'propose',proposal:r.proposal}),/switched off/);
  assert.equal(r.preparations(),0);
  r.setEnabled(true);await r.service.tool({action:'propose',proposal:r.proposal});await r.service.store.idle();
  const row=(await r.service.status()).operations[0];
  r.setEnabled(false);
  await assert.rejects(r.service.change({action:'approve',id:r.id,plan_revision:row.plan_revision}),/switched off/);
  assert.equal((await r.service.tool({action:'status',id:r.id})).state,'awaiting_approval');
  assert.equal(fs.existsSync(path.join(r.folder,'launch-intent.json')),false);
});

test('proposal token cannot approve; exact owner approval starts one independent operation with visible progress',async t=>{
  const r=await rig(t),headers={'x-sg-operation-tool':r.service.toolConfig.token};
  const origin={conversation_id:randomUUID(),reply_id:randomUUID()};
  let response=await r.post('/api/genie/operation-tools',{action:'propose',proposal:r.proposal,origin},headers);
  assert.equal(response.status,200);await r.service.store.idle();
  assert.equal(r.service.store.read(r.id,'proposal.json').conversation_id,origin.conversation_id);
  assert.equal(fs.existsSync(path.join(r.folder,'runner-started.json')),false);
  const snapshot=await (await fetch(r.base+'/api/genie/operations')).json(),row=snapshot.operations[0];
  assert.equal(row.state,'awaiting_approval');assert.doesNotMatch(JSON.stringify(snapshot),new RegExp(r.service.toolConfig.token));
  const approval={action:'approve',id:r.id,plan_revision:row.plan_revision};
  assert.equal((await r.post('/api/genie/operation-tools',approval,headers)).status,409);
  assert.equal((await r.post('/api/genie/operations',approval,headers)).status,403);
  assert.equal((await r.post('/api/genie/operations',approval,{'x-dsg-csrf':snapshot.csrf_token,origin:'http://evil.invalid'})).status,403);
  assert.equal((await r.post('/api/genie/operations',{...approval,plan_revision:'0'.repeat(64)},{'x-dsg-csrf':snapshot.csrf_token,origin:r.base})).status,409);
  response=await r.post('/api/genie/operations',approval,{'x-dsg-csrf':snapshot.csrf_token,origin:r.base});assert.equal(response.status,200);
  await r.service.store.idle();
  const running=await waitFor(async()=>{const v=await r.service.store.current(r.id);return v.runner?.progress?.phase==='waiting_fixture'?v:null;});
  assert.equal(running.runner.process_alive,true);assert.equal(fs.readFileSync(path.join(r.folder,'effect.txt'),'utf8'),'one disposable effect');
  r.service.close();r.finish();await waitFor(async()=>(await r.service.store.current(r.id)).runner?.state==='completed');
  assert.equal(r.preparations(),1);
});

test('testing mode preserves the saved proposal without starting it',async t=>{
  const r=await rig(t);r.service.store.propose(r.proposal);await r.service.store.idle();r.setTesting(true);
  await assert.rejects(r.service.change({action:'approve',id:r.id,plan_revision:r.service.store.status(r.id).plan_revision}),/paused/);
  assert.equal(fs.existsSync(path.join(r.folder,'approved.json')),false);
  await r.service.change({action:'decline',id:r.id,plan_revision:r.service.store.status(r.id).plan_revision});assert.equal(r.service.store.status(r.id).state,'declined');
});

test('rejected inputs and missing proposals have definite feedback; uncertain writes remain uncertain',async t=>{
  const r=await rig(t);
  const rejected=await r.service.tool({action:'propose',proposal:{...r.proposal,reason:'x'.repeat(2001)}});
  assert.equal(rejected.state,'rejected');assert.match(rejected.error,/1–2000/);
  assert.equal(r.preparations(),0);assert.equal(fs.existsSync(r.folder),false);
  assert.equal((await r.service.tool({action:'status',id:r.id})).state,'not_found');
  // An unexpected filesystem/transport failure is not proof of rejection.
  const original=r.service.store.propose;r.service.store.propose=()=>{throw new Error('Uncertain write');};
  await assert.rejects(r.service.tool({action:'propose',proposal:r.proposal}),/Uncertain write/);
  r.service.store.propose=original;
});

test('progress distinguishes heartbeat from completion and never renders a missing time as NaN',()=>{
  const row={state:'submitted',runner:{state:'running',process_alive:true,progress:{phase:'waiting',detail:'Waiting for model',heartbeat_at:100}}};
  assert.equal(operationLabel(row),'Working');assert.match(operationProgress(row,140000),/40s ago/);
  assert.match(operationProgress(row,140000),/does not prove model progress/);
  delete row.runner.progress.heartbeat_at;assert.doesNotMatch(operationProgress(row),/NaN/);
  assert.match(operationProgress(row),/time unavailable/);
});

test('installed Hermes really proposes and checks status without receiving approval authority',{
  skip:!process.env.DSG_TEST_HERMES_SOURCE||!process.env.DSG_TEST_HERMES_PYTHON,timeout:120000
},async t=>{
  const r=await rig(t),requests=[];let turn=0;
  const upstream=http.createServer((req,res)=>{
    if(req.method==='GET'){res.end(JSON.stringify({data:[{id:'example-model',context_length:131072}]}));return;}
    let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{
      const input=JSON.parse(raw);if(!Array.isArray(input.messages)){res.writeHead(404);res.end(JSON.stringify({error:'No additional metadata endpoint in this fixture'}));return;}requests.push(input);turn++;
      const message=turn<=2?{role:'assistant',content:null,tool_calls:[{id:'operation-'+turn,type:'function',function:{name:'tool_call',arguments:JSON.stringify({
        name:turn===1?'propose_server_change':'server_change_status',arguments:turn===1?r.proposal:{id:r.id}})}}]}:{role:'assistant',content:'The fixture proposal is ready for your review. Nothing has been approved or changed.'};
      const finish=turn<=2?'tool_calls':'stop';
      if(input.stream){res.setHeader('content-type','text/event-stream');const delta={...message,...(message.tool_calls?{tool_calls:message.tool_calls.map((c,index)=>({index,...c}))}:{})};res.end('data: '+JSON.stringify({choices:[{index:0,delta,finish_reason:null}]})+'\n\ndata: '+JSON.stringify({choices:[{index:0,delta:{},finish_reason:finish}]})+'\n\ndata: [DONE]\n\n');}
      else{res.setHeader('content-type','application/json');res.end(JSON.stringify({id:'fixture-response',choices:[{index:0,message,finish_reason:finish}],usage:{prompt_tokens:100,completion_tokens:30,total_tokens:130}}));}
    });
  });
  await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'sg-native-operation-chat-'));
  const provider=hermesProvider({python:process.env.DSG_TEST_HERMES_PYTHON,source:process.env.DSG_TEST_HERMES_SOURCE,url:`http://127.0.0.1:${upstream.address().port}/v1`,model:'example-model',operations:r.service.toolConfig},{directory});
  const chat=new GenieChat({directory,provider,getSnapshot:()=>({time:Date.now(),gateway:{workers:[{id:'fixture'}]}})});
  t.after(async()=>{chat.close();upstream.closeAllConnections();await new Promise(resolve=>upstream.close(resolve));fs.rmSync(directory,{recursive:true,force:true});});
  const conversation=chat.create();chat.submit(conversation.id,'Prepare the synthetic fixture proposal and check its status. Do not approve anything.','native-operation-fixture');await chat.idle();await r.service.store.idle();
  const answer=chat.get(conversation.id).messages.at(-1);
  assert.equal(answer.state,'complete',answer.error);assert.equal(r.service.store.list().length,1,JSON.stringify({events:answer.operations,tools:requests.flatMap(p=>(p.messages??[]).filter(m=>m.role==='tool')),request_keys:requests.map(p=>Object.keys(p))}));assert.equal(r.service.store.status(r.id).state,'awaiting_approval');
  assert.equal(r.service.store.read(r.id,'approved.json'),null);assert.equal(r.service.store.read(r.id,'proposal.json').reply_id,answer.id);
  assert.deepEqual(answer.operations.events.filter(e=>e.state==='complete').map(e=>e.tool),['propose_server_change','server_change_status']);
  assert.doesNotMatch(JSON.stringify(requests),new RegExp(r.service.toolConfig.token));
  assert.equal(fs.existsSync(path.join(r.folder,'runner-started.json')),false);
});

// A review must surface capacity and reasoning changes before approval.
test('review identifies reductions, cache cost and unknown defaults without inventing equivalence',()=>{
  const changes=operationChanges({settings:{current:{context_length:262144,server_concurrency:2,prefix_caching:true},proposed:{context_length:131072,server_concurrency:1,prefix_caching:false},current_thinking:{enable_thinking:true}},before:{image:'old'},after:{image:'new'}});
  assert.equal(changes.filter(v=>v.includes('reduces this serving capacity')).length,2);
  assert.ok(changes.some(v=>v.includes('repeated context may take more work')));
  assert.ok(changes.some(v=>v.includes('Thinking defaults:')&&v.includes('unknown')));
  assert.ok(changes.some(v=>v.includes('Serving image changes')));
  assert.deepEqual(operationChanges({settings:{current:{context_length:262144},proposed:{context_length:262144}},before:{image:'same',command:['same']},after:{image:'same',command:['same']}}),[]);
});

test('review displays the exact cache allowance and leaves older reviews unchanged',()=>{
  assert.ok(operationChanges({cache_capacity_policy:{max_loss_percent:0}}).some(v=>v.includes('no reduction allowed')));
  assert.ok(operationChanges({cache_capacity_policy:{max_loss_percent:4}}).some(v=>v.includes('permits up to 4% fewer cached tokens')));
  assert.deepEqual(operationChanges({}),[]);
});
