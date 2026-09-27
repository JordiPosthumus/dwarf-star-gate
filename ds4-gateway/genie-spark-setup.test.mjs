import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createSparkSetupTools} from './genie-spark-setup.mjs';
import {hermesProvider} from './genie-hermes.mjs';
import {execFileSync} from 'node:child_process';
import {GenieChat} from './genie-chat.mjs';
import {capabilityStatus} from './genie-capability-status.mjs';
import {genieCapabilities,validateGenieCapabilities} from './genie-capabilities.mjs';
const config={ui_worker_management:true,spark_setup:{enabled:true,targets:{new_spark:{ssh:'new-spark',directory:'/opt/new-spark-setup'}}}};
test('setup obeys switch and testing state; repeated starts observe the existing work',async()=>{
  let enabled=false,testing=false,starts=0,state='not_started';
  const tools=createSparkSetupTools(config,{isEnabled:()=>enabled,isTesting:()=>testing,bundle:()=>({bundle:'fixture'}),transport:async(target,input)=>{
    assert.deepEqual(target,config.spark_setup.targets.new_spark);
    if(input.action==='start'){starts++;state='running';return {state:'accepted'};}
    return {state};
  }});
  await assert.rejects(tools.tool({action:'start',target_id:'new_spark'}),/switched off/);
  enabled=true;testing=true;await assert.rejects(tools.tool({action:'start',target_id:'new_spark'}),/testing mode/);
  testing=false;await assert.rejects(tools.tool({action:'start',target_id:'new_spark',command:'arbitrary'}),/enrolled/);
  await assert.rejects(tools.tool({action:'start',target_id:'unknown'}),/enrolled/);
  assert.equal((await tools.tool({action:'start',target_id:'new_spark'})).state,'accepted');
  assert.equal((await tools.tool({action:'start',target_id:'new_spark'})).state,'running');assert.equal(starts,1);
  enabled=false;assert.equal((await tools.tool({action:'status'})).targets[0].state,'running');
  assert.equal(genieCapabilities({},config,false).spark_setup,true);
  assert.equal(genieCapabilities({}, {},false).spark_setup,false);
  assert.deepEqual(validateGenieCapabilities({spark_setup:false}),{spark_setup:false});
});
test('uncertain SSH observations never trigger preparation and failures identify the target',async()=>{
  const tools=createSparkSetupTools(config,{bundle:()=>{throw Error('must not build');},transport:async()=>{throw Error('SSH is unavailable');}});
  const row=await tools.tool({action:'start',target_id:'new_spark'});
  assert.equal(row.state,'unavailable');
  const view=capabilityStatus({gateway:{genie_capabilities:{spark_setup:true}}},{management:true,chat:{capabilities_configured:{spark_setup:true}},sparkSetup:await tools.status()});
  const cap=view.capabilities.find(c=>c.key==='spark_setup');assert.equal(cap.status,'Needs attention');assert.match(cap.detail,/new_spark: unavailable.*SSH/);
});
test('pinned Hermes calls setup tools and retains their receipts',{skip:!process.env.DSG_TEST_HERMES_SOURCE,timeout:120000},async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'sg-setup-chat-'));let calls=0,starts=0,resumes=0,scans=0,enrollments=0,accessRequests=0,bootstraps=0,state='not_started';const failedAt='2026-09-18T10:00:00Z';
  const accessId='11111111-1111-4111-8111-111111111111';
  const tools=createSparkSetupTools(config,{access:{request:async input=>{assert.deepEqual(input,{scan_id:'00000000-0000-4000-8000-000000000000',endpoint_ids:['b'.repeat(64)]});accessRequests++;return {access_id:accessId,state:'credentials_required'};},begin:async input=>{assert.deepEqual(input,{access_id:accessId});bootstraps++;return {access_id:accessId,state:'running'};},status:()=>({access_id:accessId,state:'complete',endpoints:[{state:'key_ready'}]})},enrollment:{targets:config.spark_setup.targets,enrollDiscovered:async args=>{assert.equal(args.scan_id,'00000000-0000-4000-8000-000000000000');assert.equal(args.candidate_id,'a'.repeat(64));assert.equal(args.target_id,'candidate');enrollments++;return {target_id:'candidate',state:'enrolled',readiness:'prerequisites_observed'};}},discovery:{discover:async()=>{scans++;return {state:'running',scan_id:'fixture-discovery'};},status:()=>({state:'complete',scan_id:'fixture-discovery',coverage:'partial',candidates:[]})},bundle:()=>({bundle:'fixture'}),transport:async(_target,input)=>{if(input.action==='start'){starts++;state='running';}if(input.action==='resume'){assert.equal(input.expected_finished_at,failedAt);resumes++;state='running';}return {state,...(state==='needs_attention'?{finished_at:failedAt,exit_code:7}:{}),...(resumes?{resume_of:failedAt}:{}),progress:state==='running'?{engine:'qwen38-repaired',phase:'build_image'}:undefined};}});
  const server=http.createServer((req,res)=>{
    if(tools.handle(req,res))return;
    if(req.method==='GET'){res.end(JSON.stringify({data:[{id:'fixture'}]}));return;}
    let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{
      if(req.url!=='/v1/chat/completions'){res.end('{}');return;}calls++;
      const body=JSON.parse(raw);if(calls===4)assert.match(JSON.stringify(body.messages),/build_image/);
      const name=calls===14?'request_spark_access':calls===15?'bootstrap_spark_access':calls===16?'spark_access_status':calls===12?'enroll_discovered_spark':calls===9?'discover_sparks':calls===10?'spark_discovery_status':calls===6?'resume_spark_preparation':calls===2?'prepare_spark':'spark_setup_status',args=calls===14?{scan_id:'00000000-0000-4000-8000-000000000000',endpoint_ids:['b'.repeat(64)]}:calls===15||calls===16?{access_id:accessId}:calls===12?{scan_id:'00000000-0000-4000-8000-000000000000',candidate_id:'a'.repeat(64),target_id:'candidate'}:calls===6?{target_id:'new_spark',expected_finished_at:failedAt}:calls===2?{target_id:'new_spark'}:{};const toolTurn=calls<=3||calls>=5&&calls<=7||calls===9||calls===10||calls===12||calls>=14&&calls<=16;
      const message=toolTurn?{role:'assistant',content:null,tool_calls:[{id:'setup-'+calls,type:'function',function:{name:'tool_call',arguments:JSON.stringify({name,arguments:args})}}]}:{role:'assistant',content:'The new Spark is building its LLM image. It is not yet qualified or serving.'};
      const delta={...message,...(message.tool_calls?{tool_calls:message.tool_calls.map((v,index)=>({...v,index}))}:{})};
      res.setHeader('content-type','text/event-stream');res.end('data: '+JSON.stringify({id:'fixture',model:'fixture',choices:[{index:0,delta,finish_reason:null}]})+'\n\ndata: '+JSON.stringify({id:'fixture',model:'fixture',choices:[{index:0,delta:{},finish_reason:toolTurn?'tool_calls':'stop'}]})+'\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));tools.bind(server.address().port);
  const provider=hermesProvider({python:process.env.DSG_TEST_HERMES_PYTHON,source:process.env.DSG_TEST_HERMES_SOURCE,url:`http://127.0.0.1:${server.address().port}/v1`,model:'fixture',spark_setup:tools.toolConfig},{directory});
  t.after(()=>{provider.close();server.closeAllConnections();server.close();fs.rmSync(directory,{recursive:true,force:true});});
  const chat=new GenieChat({directory:path.join(directory,'chats'),provider,getSnapshot:()=>({gateway:{}})});
  const conversation=chat.create();chat.submit(conversation.id,'Prepare the enrolled new Spark.','setup-fixture-1');await chat.idle();
  const answer=chat.get(conversation.id).messages[1];assert.equal(answer.state,'complete',JSON.stringify(answer));assert.equal(starts,1);assert.equal(calls,4);
  assert.equal(answer.spark_setup.events.filter(e=>e.state==='complete').length,3);assert.equal(chat.capabilityActivity().spark_setup.state,'complete');
  const reread=new GenieChat({directory:path.join(directory,'chats'),provider});assert.deepEqual(reread.get(conversation.id).messages[1].spark_setup,answer.spark_setup);
  state='needs_attention';chat.submit(conversation.id,'Resume the same confirmed failed preparation after its download service recovered.','resume-fixture-1');await chat.idle();
  const resumed=chat.get(conversation.id).messages.at(-1);assert.equal(resumed.state,'complete',JSON.stringify(resumed));assert.equal(resumes,1);assert.equal(starts,1);assert.ok(resumed.spark_setup.events.some(e=>e.tool==='resume_spark_preparation'&&e.state==='complete'));
  chat.submit(conversation.id,'Find the newly connected Sparks.','discovery-fixture-1');await chat.idle();
  const discovered=chat.get(conversation.id).messages.at(-1);assert.equal(discovered.state,'complete',JSON.stringify(discovered));assert.equal(scans,1);assert.equal(starts,1);assert.equal(resumes,1);
  for(const tool of ['discover_sparks','spark_discovery_status'])assert.ok(discovered.spark_setup.events.some(e=>e.tool===tool&&e.state==='complete'&&e.result.scan_id==='fixture-discovery'));
  const saved=new GenieChat({directory:path.join(directory,'chats'),provider});assert.deepEqual(saved.get(conversation.id).messages.at(-1).spark_setup,discovered.spark_setup);
  chat.submit(conversation.id,'Enroll the saved verified candidate using its scan and candidate IDs.','enroll-discovered-fixture');await chat.idle();
  const enrolled=chat.get(conversation.id).messages.at(-1);assert.equal(enrolled.state,'complete',JSON.stringify(enrolled));assert.equal(enrollments,1);assert.equal(starts,1);assert.ok(enrolled.spark_setup.events.some(e=>e.tool==='enroll_discovered_spark'&&e.state==='complete'&&e.result.state==='enrolled'));
  const reloaded=new GenieChat({directory:path.join(directory,'chats'),provider});assert.deepEqual(reloaded.get(conversation.id).messages.at(-1).spark_setup,enrolled.spark_setup);
  chat.submit(conversation.id,'Exercise the saved initial-access workflow with fixture credentials kept outside chat.','initial-access-fixture');await chat.idle();
  const accessed=chat.get(conversation.id).messages.at(-1);assert.equal(accessed.state,'complete',JSON.stringify(accessed));assert.equal(accessRequests,1);assert.equal(bootstraps,1);
  for(const name of ['request_spark_access','bootstrap_spark_access','spark_access_status'])assert.ok(accessed.spark_setup.events.some(e=>e.tool===name&&e.state==='complete'&&e.result.access_id===accessId));
});

test('bundled setup includes build constraints and redistribution notices, excluding tests',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'sg-setup-bundle-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const archive=path.join(directory,'recipes.tar.gz');
  let names=[];
  const tools=createSparkSetupTools(config,{transport:async(_target,input)=>{
    if(input.action==='status')return {state:'not_started'};
    // BSD tar may close stdin after its end marker before Node writes trailing
    // archive padding, yielding an intermittent EPIPE. Inspect the same bytes
    // from a regular file so this test checks package contents, not pipe timing.
    fs.writeFileSync(archive,Buffer.from(input.bundle,'base64'));
    names=execFileSync('tar',['-tzf',archive],{encoding:'utf8'}).trim().split('\n');
    return {state:'accepted'};
  }});
  await tools.tool({action:'start',target_id:'new_spark'});
  for(const name of ['ds4-gateway/spark_recovery.py','ds4-gateway/recovery-docker.py','examples/spark-build/h3/constraints.txt','examples/spark-build/qwen38-repaired/NOTICE.md','examples/spark-build/qwen38-repaired/LICENSE-APACHE-2.0','examples/spark-build/ace-step/requirements.lock','examples/server-profiles/qwen38-nvfp4-vllm.json'])assert.ok(names.includes(name),name);
  assert.equal(names.some(name=>name.includes('/test_')||name.includes('__pycache__')||name.includes('/.')),false);
});

test('qualification starts only after preparation and records existing outcomes without replay',async()=>{
  let preparation='running',qualification=null,starts=0;
  const tools=createSparkSetupTools(config,{bundle:()=>({bundle:'fixture'}),transport:async(_target,input)=>{
    if(input.action==='qualify'){starts++;qualification={state:'running',progress:{phase:'qualifying_text'}};return qualification;}
    return {state:preparation,qualification};
  }});
  assert.equal((await tools.tool({action:'qualify',target_id:'new_spark'})).state,'running');assert.equal(starts,0);
  preparation='prepared_stopped';assert.equal((await tools.tool({action:'qualify',target_id:'new_spark'})).state,'running');assert.equal(starts,1);
  await tools.tool({action:'qualify',target_id:'new_spark'});assert.equal(starts,1);
  const cap=capabilityStatus({gateway:{genie_capabilities:{spark_setup:true}}},{management:true,chat:{capabilities_configured:{spark_setup:true}},sparkSetup:await tools.tool({action:'status'})}).capabilities.find(c=>c.key==='spark_setup');
  assert.equal(cap.status,'Working');assert.match(cap.detail,/qualifying_text/);
});

test('resume passes the exact failed receipt, preserves capability gates and resumes only preparation',async()=>{
 const at='2026-09-18T10:00:00Z',calls=[];let enabled=false,qualification=null,continued=0;
 const tools=createSparkSetupTools(config,{isEnabled:()=>enabled,mediaQualification:{read:()=>qualification},continuation:{resumePreparation:()=>continued++},transport:async(_t,input)=>{calls.push(input);return {state:'accepted',resume_of:at};}});
 const request={action:'resume',target_id:'new_spark',expected_finished_at:at};
 await assert.rejects(tools.tool(request),/switched off/);enabled=true;
 await tools.tool(request);assert.deepEqual(calls,[{action:'resume',expected_finished_at:at}]);assert.equal(continued,1);
 qualification={state:'qualified_stopped'};await assert.rejects(tools.tool(request),/already advanced/);assert.equal(calls.length,1);
});
