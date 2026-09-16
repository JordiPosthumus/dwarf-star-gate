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
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'sg-setup-chat-'));let calls=0,starts=0,state='not_started';
  const tools=createSparkSetupTools(config,{bundle:()=>({bundle:'fixture'}),transport:async(_target,input)=>{if(input.action==='start'){starts++;state='running';}return {state,progress:state==='running'?{engine:'qwen38-repaired',phase:'build_image'}:undefined};}});
  const server=http.createServer((req,res)=>{
    if(tools.handle(req,res))return;
    if(req.method==='GET'){res.end(JSON.stringify({data:[{id:'fixture'}]}));return;}
    let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{
      if(req.url!=='/v1/chat/completions'){res.end('{}');return;}calls++;
      const body=JSON.parse(raw);if(calls===4)assert.match(JSON.stringify(body.messages),/build_image/);
      const name=calls===2?'prepare_spark':'spark_setup_status',args=calls===2?{target_id:'new_spark'}:{};
      const message=calls<=3?{role:'assistant',content:null,tool_calls:[{id:'setup-'+calls,type:'function',function:{name:'tool_call',arguments:JSON.stringify({name,arguments:args})}}]}:{role:'assistant',content:'The new Spark is building its LLM image. It is not yet qualified or serving.'};
      const delta={...message,...(message.tool_calls?{tool_calls:message.tool_calls.map((v,index)=>({...v,index}))}:{})};
      res.setHeader('content-type','text/event-stream');res.end('data: '+JSON.stringify({id:'fixture',model:'fixture',choices:[{index:0,delta,finish_reason:null}]})+'\n\ndata: '+JSON.stringify({id:'fixture',model:'fixture',choices:[{index:0,delta:{},finish_reason:calls<=3?'tool_calls':'stop'}]})+'\n\ndata: [DONE]\n\n');
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
});

test('bundled setup includes build constraints and redistribution notices, excluding tests',async()=>{
  let names=[];
  const tools=createSparkSetupTools(config,{transport:async(_target,input)=>{
    if(input.action==='status')return {state:'not_started'};
    names=execFileSync('tar',['-tzf','-'],{input:Buffer.from(input.bundle,'base64'),encoding:'utf8'}).trim().split('\n');
    return {state:'accepted'};
  }});
  await tools.tool({action:'start',target_id:'new_spark'});
  for(const name of ['examples/spark-build/h3/constraints.txt','examples/spark-build/qwen38-repaired/NOTICE.md','examples/spark-build/qwen38-repaired/LICENSE-APACHE-2.0','examples/spark-build/ace-step/requirements.lock','examples/server-profiles/qwen38-nvfp4-vllm.json'])assert.ok(names.includes(name),name);
  assert.equal(names.some(name=>name.includes('/test_')||name.includes('__pycache__')||name.includes('/.')),false);
});
