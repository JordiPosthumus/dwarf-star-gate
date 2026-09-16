import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
import http from 'node:http';
import {GenieChat} from './genie-chat.mjs';
import {hermesProvider} from './genie-hermes.mjs';
import {SparkSetupWatch} from './spark-setup-watch.mjs';
import {createSparkSetupTools} from './genie-spark-setup.mjs';
import {capabilityStatus} from './genie-capability-status.mjs';
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sg-setup-watch-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 let enabled=true,busy=false;const calls=[],target={ssh:'new-spark',directory:'/srv/setup'},snapshot={targets:[{target_id:'new-spark',state:'not_started'}]};
 const chat={status:()=>({available:true,conversations:[{busy}]}),create:()=>({id:'setup-chat'}),submit:(...args)=>{calls.push(args);}};
 const options={filename:path.join(dir,'requests.json'),targets:{'new-spark':target},chat,read:async()=>snapshot,isEnabled:()=>enabled};
 return {options,calls,snapshot,enabled:v=>enabled=v,busy:v=>busy=v,watch:()=>new SparkSetupWatch(options)};
}
test('one saved request wakes each stage across restart, without repeated starts or a user follow-up',async t=>{
 const f=fixture(t);let w=f.watch();await w.tick();assert.equal(f.calls.length,0);w.request('new-spark');
 f.busy(true);await w.tick();assert.equal(f.calls.length,0);f.busy(false);await w.tick();assert.match(f.calls[0][1],/prepare_spark/);
 f.snapshot.targets[0].state='running';w=f.watch();await w.tick();assert.equal(f.calls.length,1);
 f.snapshot.targets[0].state='prepared_stopped';f.enabled(false);await w.tick();assert.equal(f.calls.length,1);f.enabled(true);await w.tick();assert.match(f.calls[1][1],/qualify_spark_llm/);
 f.snapshot.targets[0].qualification={state:'running'};await w.tick();assert.equal(f.calls.length,2);
 f.snapshot.targets[0].qualification.state='qualified_serving';w=f.watch();await w.tick();assert.match(f.calls[2][1],/register_spark_llm/);
 f.snapshot.targets[0].registration={state:'registered_serving'};await w.tick();assert.equal(w.status('new-spark').state,'complete');await f.watch().tick();assert.equal(f.calls.length,3);
 assert.equal(new Set(f.calls.map(c=>c[2])).size,3);assert.ok(f.calls.every(c=>c[0]==='setup-chat'));
});
test('uncertain remote status waits; failure or changed enrollment becomes visible without replay',async t=>{
 const f=fixture(t);const w=f.watch();w.request('new-spark');f.snapshot.targets[0].state='unavailable';await w.tick();assert.equal(f.calls.length,0);assert.equal(w.status('new-spark').state,'observing');
 f.snapshot.targets[0].state='prepared_stopped';f.snapshot.targets[0].qualification={state:'needs_attention',error:'native tools failed'};await w.tick();assert.match(w.status('new-spark').error,/native tools failed/);await w.tick();assert.equal(f.calls.length,0);
 const g=fixture(t);g.watch().request('new-spark');g.options.targets['new-spark'].ssh='different-host';const changed=g.watch();await changed.tick();assert.match(changed.status('new-spark').error,/enrollment changed/);assert.equal(g.calls.length,0);
});
test('uncertain chat submission reuses request identity; no-action answer stops repeated waking',async t=>{
 const f=fixture(t);const submit=f.options.chat.submit;f.options.chat.submit=(...args)=>{submit(...args);if(f.calls.length===1)throw Error('lost acknowledgement');};
 let w=f.watch();w.request('new-spark');await w.tick();w=f.watch();await w.tick();assert.deepEqual(f.calls[0],f.calls[1]);
 await w.tick();assert.equal(f.calls.length,2);assert.equal(w.status('new-spark').state,'needs_attention');
 const cap=capabilityStatus({gateway:{genie_capabilities:{spark_setup:true}}},{management:true,chat:{capabilities_configured:{spark_setup:true}},sparkSetup:{targets:[{...f.snapshot.targets[0],continuation:w.status('new-spark')}]}}).capabilities.find(c=>c.key==='spark_setup');assert.equal(cap.status,'Needs attention');assert.match(cap.detail,/reply ended/);
});
test('explicit full setup persists intent; preparation alone never opts into continuation',async t=>{
 const f=fixture(t);const w=f.watch();let starts=0;
 const tools=createSparkSetupTools({ui_worker_management:true,spark_setup:{enabled:true,targets:f.options.targets}},{continuation:w,bundle:()=>({}),transport:async(_target,input)=>{if(input.action==='start')starts++;return {state:input.action==='start'?'accepted':'not_started'};}});
 await tools.tool({action:'start',target_id:'new-spark'});assert.equal(w.status('new-spark'),null);assert.equal(starts,1);
 assert.equal((await tools.tool({action:'setup',target_id:'new-spark'})).state,'requested');assert.equal(starts,1);await w.tick();assert.equal(f.calls.length,1);
 w.close();assert.equal((await tools.tool({action:'status'})).targets[0].continuation.state,'waiting_for_genie');
});

test('pinned Hermes receives setup request and all automatic stage wakeups',{skip:!process.env.DSG_TEST_HERMES_SOURCE,timeout:120000},async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sg-setup-hermes-watch-'));let watch,stage='not_started',qualification=null,registered=null,calls=0;
 const targets={'new-spark':{ssh:'new-spark',directory:'/srv/setup'}};
 const actions=[];
 const tools=createSparkSetupTools({ui_worker_management:true,spark_setup:{enabled:true,targets}},{continuation:{status:id=>watch?.status(id),request:id=>watch.request(id)},bundle:()=>({}),registration:{read:()=>registered,register:async()=>{actions.push('register');return registered={state:'registered_serving'};}},transport:async(_target,input)=>{
  if(input.action==='start'){actions.push('prepare');stage='running';}
  if(input.action==='qualify'){actions.push('qualify');qualification={state:'running'};}
  if(input.action==='verify_serving')return {state:'qualified_serving'};
  return {state:stage,qualification};
 }});
 const names=['setup_spark','prepare_spark','qualify_spark_llm','register_spark_llm'];
 const server=http.createServer((req,res)=>{
  if(tools.handle(req,res))return;
  if(req.method==='GET'){res.end(JSON.stringify({data:[{id:'fixture'}]}));return;}
  let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{
   if(req.url!=='/v1/chat/completions'){res.end('{}');return;}
   const turn=Math.floor(calls/4),step=calls++%4;const body=JSON.parse(raw);
   if(step===0&&turn>0)assert.match(JSON.stringify(body.messages),new RegExp(names[turn]));
   const name=step===1?names[turn]:'spark_setup_status';const args=step===1?{target_id:'new-spark'}:{};
   const delta=step<3?{role:'assistant',content:null,tool_calls:[{index:0,id:'step-'+calls,type:'function',function:{name:'tool_call',arguments:JSON.stringify({name,arguments:args})}}]}:{role:'assistant',content:'The returned setup stage is recorded; subsequent stages continue through the watcher.'};
   res.setHeader('content-type','text/event-stream');res.end('data: '+JSON.stringify({id:'fixture',model:'fixture',choices:[{index:0,delta,finish_reason:null}]})+'\n\ndata: '+JSON.stringify({id:'fixture',model:'fixture',choices:[{index:0,delta:{},finish_reason:step<3?'tool_calls':'stop'}]})+'\n\ndata: [DONE]\n\n');
  });
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));tools.bind(server.address().port);
 const provider=hermesProvider({python:process.env.DSG_TEST_HERMES_PYTHON,source:process.env.DSG_TEST_HERMES_SOURCE,url:`http://127.0.0.1:${server.address().port}/v1`,model:'fixture',spark_setup:tools.toolConfig},{directory:dir});
 const chat=new GenieChat({directory:path.join(dir,'chat'),provider,getSnapshot:()=>({gateway:{}})});
 t.after(()=>{watch?.close();chat.close();provider.close();server.closeAllConnections();server.close();fs.rmSync(dir,{recursive:true,force:true});});
 const options={filename:path.join(dir,'requests.json'),targets,chat,read:()=>tools.tool({action:'status'}),isEnabled:()=>true};watch=new SparkSetupWatch(options);
 const c=chat.create();chat.submit(c.id,'Set up new-spark and bring its LLM into service.','owner-setup');await chat.idle();assert.equal(watch.status('new-spark').state,'requested');assert.ok(chat.get(c.id).messages[1].spark_setup.events.some(e=>e.tool==='setup_spark'&&e.state==='complete'&&e.result.state==='requested'));
 await watch.tick();await chat.idle();assert.equal(stage,'running');
 stage='prepared_stopped';watch=new SparkSetupWatch(options);await watch.tick();await chat.idle();assert.equal(qualification.state,'running');
 qualification.state='qualified_serving';await watch.tick();await chat.idle();await watch.tick();assert.equal(watch.status('new-spark').state,'complete');
 assert.deepEqual(actions,['prepare','qualify','register']);assert.equal(calls,16);
 const messages=chat.get(watch.status('new-spark').conversation_id).messages.filter(m=>m.role==='assistant');assert.equal(messages.length,3);
 for(const m of messages){assert.equal(m.state,'complete');assert.equal(m.spark_setup.events.filter(e=>e.state==='complete').length,3);}
});

test('fresh setup qualifies stopped media before the LLM, and waits for native completion',async t=>{
 const f=fixture(t);const w=f.watch();w.request('new-spark');const target=f.snapshot.targets[0];target.media_qualification_required=true;target.state='prepared_stopped';
 await w.tick();assert.match(f.calls[0][1],/qualify_spark_media/);target.media_qualification={state:'running'};await w.tick();assert.equal(f.calls.length,1);
 target.media_qualification.state='qualified_stopped';await w.tick();assert.match(f.calls[1][1],/qualify_spark_llm/);
});
test('an already qualified LLM remains eligible for registration without restarting it for media',async t=>{
 const f=fixture(t),w=f.watch();w.request('new-spark');Object.assign(f.snapshot.targets[0],{state:'prepared_stopped',media_qualification_required:true,qualification:{state:'qualified_serving'}});await w.tick();assert.match(f.calls[0][1],/register_spark_llm/);
});
