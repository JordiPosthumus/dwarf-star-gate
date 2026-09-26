import test from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createRecoveryTools,recoveryEvidence} from './genie-recovery.mjs';import {hermesProvider} from './genie-hermes.mjs';import {GenieChat} from './genie-chat.mjs';
const exact={worker_id:'worker-a',evidence_id:'a'.repeat(64),action_id:'11111111-1111-4111-8111-111111111111'};
const state=()=>({version:1,recovery:{configured:true,automatic:true,workers:[{worker_id:'worker-a',eligible:true,evidence_id:exact.evidence_id}],operations:[]}});
test('local oMLX qualification rejects extra authority and respects each capability without retrying uncertain calls',async()=>{
 let calls=0,enabled=true,testing=false,inspection=true,changes=true;
 const q=createRecoveryTools({read:async()=>state(),isEnabled:()=>enabled,isTesting:()=>testing,isInspectionEnabled:()=>inspection,isChangesEnabled:()=>changes,
  qualifyOmlx:async input=>{calls++;assert.deepEqual(input,exact);return {id:input.action_id,worker_id:input.worker_id,actor:'genie',omlx_qualification:true,state:'queued'};}});
 for(const key of ['gateway_socket','launcher','canary'])await assert.rejects(q.tool({action:'qualify-omlx',...exact,[key]:'untrusted'}),/Specify/);
 enabled=false;await assert.rejects(q.tool({action:'qualify-omlx',...exact}),/suspended/);enabled=true;
 testing=true;await assert.rejects(q.tool({action:'qualify-omlx',...exact}),/suspended/);testing=false;
 inspection=false;await assert.rejects(q.tool({action:'qualify-omlx',...exact}),/suspended/);inspection=true;
 changes=false;await assert.rejects(q.tool({action:'qualify-omlx',...exact}),/suspended/);changes=true;
 assert.equal(calls,0);assert.equal((await q.tool({action:'qualify-omlx',...exact})).omlx_qualification,true);
 const uncertain=createRecoveryTools({read:async()=>state(),isChangesEnabled:()=>true,qualifyOmlx:async()=>{calls++;return {id:exact.action_id};}});
 await assert.rejects(uncertain.tool({action:'qualify-omlx',...exact}),/uncertain/);await uncertain.tool({action:'status'});assert.equal(calls,2);
});
test('pair qualification tool is separate, policy gated and never retries an uncertain acknowledgement',async()=>{
 let count=0,enabled=true;const q=createRecoveryTools({read:async()=>state(),isChangesEnabled:()=>enabled,qualify:async input=>{count++;assert.deepEqual(input,exact);return {id:input.action_id,worker_id:input.worker_id,actor:'genie',pair_qualification:true,state:'queued'};}});
 assert.equal((await q.tool({action:'qualify-pair',...exact})).pair_qualification,true);
 await assert.rejects(q.tool({action:'qualify-pair',...exact,canary:true}),/Specify/);
 enabled=false;await assert.rejects(q.tool({action:'qualify-pair',...exact}),/suspended/);assert.equal(count,1);
 const lost=createRecoveryTools({read:async()=>state(),isChangesEnabled:()=>true,qualify:async()=>{count++;throw Error('lost acknowledgement');}});
 await assert.rejects(lost.tool({action:'qualify-pair',...exact}),/lost/);await lost.tool({action:'status'});assert.equal(count,2);
});
test('recovery tools preserve policy, exact core inputs, read-only status when off and issued operations',async t=>{
 let enabled=true,testing=false,requests=0;const status=state(),q=createRecoveryTools({read:async()=>status,recover:async e=>{requests++;assert.deepEqual(e,exact);const receipt={id:e.action_id,worker_id:e.worker_id,actor:'genie',state:'queued'};status.recovery.operations.push(receipt);return receipt;},isEnabled:()=>enabled,isTesting:()=>testing});
 const server=http.createServer((req,res)=>{if(!q.handle(req,res))res.end();});await new Promise(r=>server.listen(0,'127.0.0.1',r));q.bind(server.address().port);t.after(()=>{server.closeAllConnections();server.close();});
 const call=(body,token=q.toolConfig.token)=>fetch(q.toolConfig.url,{method:'POST',headers:{'content-type':'application/json','x-sg-recovery-tool':token},body:JSON.stringify(body)});
 assert.equal((await call({action:'status'},'wrong')).status,403);enabled=false;
 assert.equal((await call({action:'recover',...exact})).status,409);assert.equal((await call({action:'status'})).status,200);assert.equal(requests,0);enabled=true;
 assert.equal((await call({action:'recover',...exact,canary:true})).status,409);testing=true;assert.equal((await call({action:'recover',...exact})).status,409);testing=false;
 const accepted=await(await call({action:'recover',...exact})).json();assert.equal(accepted.receipt.state,'queued');assert.equal(requests,1);
 enabled=false;status.recovery.operations[0].state='recovered';assert.equal((await(await call({action:'status'})).json()).operations[0].state,'recovered');assert.equal(requests,1);
});
test('lost recovery acknowledgement is observed without replay; core eligibility errors survive',async()=>{
 let requests=0;const q=createRecoveryTools({read:async()=>state(),recover:async()=>{requests++;throw new Error('connection lost');}});
 await assert.rejects(q.tool({action:'recover',...exact}),/connection lost/);assert.equal(requests,1);await q.tool({action:'status'});assert.equal(requests,1);
 const refusal=createRecoveryTools({read:async()=>state(),recover:async()=>{throw new Error('worker_has_active_requests');}});
 await assert.rejects(refusal.tool({action:'recover',...exact}),/worker_has_active_requests/);
});
test('installed Hermes requests recovery once, records its handle and observes the same receipt',{skip:!process.env.DSG_TEST_HERMES_SOURCE,timeout:120000},async t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'sg-recovery-chat-'));let requests=0,calls=0;const status=state();
 const q=createRecoveryTools({read:async()=>status,recover:async e=>{requests++;assert.equal(e.worker_id,exact.worker_id);assert.equal(e.evidence_id,exact.evidence_id);const receipt={id:e.action_id,worker_id:e.worker_id,actor:'genie',state:'queued'};status.recovery.operations.push(receipt);return receipt;}});
 const server=http.createServer((req,res)=>{if(q.handle(req,res))return;if(req.method==='GET'){res.end(JSON.stringify({data:[{id:'fixture'}]}));return;}let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{const body=JSON.parse(raw);if(req.url!=='/v1/chat/completions'){res.end(JSON.stringify({}));return;}calls++;
  if(calls===3)assert.match(JSON.stringify(body.messages),new RegExp(status.recovery.operations[0].id));
  const name=calls===2?'recover_server':'recovery_status',args=calls===2?{worker_id:exact.worker_id,evidence_id:exact.evidence_id}:{};
  const message=calls<=3?{role:'assistant',content:null,tool_calls:[{id:'recovery-'+calls,type:'function',function:{name:'tool_call',arguments:JSON.stringify({name,arguments:args})}}]}:{role:'assistant',content:'Recovery was accepted and is queued. It is not complete yet.'};
  const delta={...message,...(message.tool_calls?{tool_calls:message.tool_calls.map((v,index)=>({...v,index}))}:{})};res.setHeader('content-type','text/event-stream');res.end('data: '+JSON.stringify({id:'recovery-fixture',model:'fixture',choices:[{index:0,delta,finish_reason:null}]})+'\n\ndata: '+JSON.stringify({id:'recovery-fixture',model:'fixture',choices:[{index:0,delta:{},finish_reason:calls<=3?'tool_calls':'stop'}]})+'\n\ndata: [DONE]\n\n');});});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));q.bind(server.address().port);
 const provider=hermesProvider({python:process.env.DSG_TEST_HERMES_PYTHON,source:process.env.DSG_TEST_HERMES_SOURCE,url:`http://127.0.0.1:${server.address().port}/v1`,model:'fixture',recovery:q.toolConfig},{directory});
 t.after(()=>{provider.close();server.closeAllConnections();server.close();fs.rmSync(directory,{recursive:true,force:true});});
 const chat=new GenieChat({directory:path.join(directory,'chats'),provider,getSnapshot:()=>({gateway:state()})}),c=chat.create();chat.submit(c.id,'Recover worker-a if eligible.','recovery-test');await chat.idle();const answer=chat.get(c.id).messages[1];assert.equal(answer.state,'complete',JSON.stringify(answer));assert.equal(requests,1);assert.equal(calls,4);assert.equal(provider.info.can_act,true);
 const completed=answer.recovery.events.filter(e=>e.state==='complete');assert.equal(completed.length,3);assert.equal(completed[1].action_id,status.recovery.operations[0].id);assert.equal(chat.capabilityActivity().recovery.state,'complete');
 const reread=new GenieChat({directory:path.join(directory,'chats'),provider});assert.deepEqual(reread.get(c.id).messages[1].recovery,answer.recovery);
});
test('installed Hermes enrolls an opted-in pair once and persists its native enrollment tool handle',{skip:!process.env.DSG_TEST_HERMES_SOURCE,timeout:120000},async t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'sg-recovery-chat-'));let requests=0,calls=0;const status=state();
 const q=createRecoveryTools({read:async()=>status,isChangesEnabled:()=>true,enroll:async e=>{requests++;assert.equal(e.worker_id,exact.worker_id);assert.equal(e.capture_id,exact.action_id);const receipt={id:e.action_id,action_id:e.action_id,capture_id:e.capture_id,worker_id:e.worker_id,state:'queued'};status.recovery.operations.push(receipt);status.recovery.pair_enrollment={operations:[receipt]};return receipt;},recover:()=>assert.fail('Recovery requested during enrollment')});
 const server=http.createServer((req,res)=>{if(q.handle(req,res))return;if(req.method==='GET'){res.end(JSON.stringify({data:[{id:'fixture'}]}));return;}let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{const body=JSON.parse(raw);if(req.url!=='/v1/chat/completions'){res.end(JSON.stringify({}));return;}calls++;
  if(calls===3)assert.match(JSON.stringify(body.messages),new RegExp(status.recovery.operations[0].id));
  const name=calls===2?'enroll_pair_recovery':'recovery_status',args=calls===2?{worker_id:exact.worker_id,capture_id:exact.action_id}:{};
  const message=calls<=3?{role:'assistant',content:null,tool_calls:[{id:'recovery-'+calls,type:'function',function:{name:'tool_call',arguments:JSON.stringify({name,arguments:args})}}]}:{role:'assistant',content:'Pair enrollment was accepted and queued; restart qualification remains required.'};
  const delta={...message,...(message.tool_calls?{tool_calls:message.tool_calls.map((v,index)=>({...v,index}))}:{})};res.setHeader('content-type','text/event-stream');res.end('data: '+JSON.stringify({id:'recovery-fixture',model:'fixture',choices:[{index:0,delta,finish_reason:null}]})+'\n\ndata: '+JSON.stringify({id:'recovery-fixture',model:'fixture',choices:[{index:0,delta:{},finish_reason:calls<=3?'tool_calls':'stop'}]})+'\n\ndata: [DONE]\n\n');});});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));q.bind(server.address().port);
 const provider=hermesProvider({python:process.env.DSG_TEST_HERMES_PYTHON,source:process.env.DSG_TEST_HERMES_SOURCE,url:`http://127.0.0.1:${server.address().port}/v1`,model:'fixture',recovery:q.toolConfig},{directory});
 t.after(()=>{provider.close();server.closeAllConnections();server.close();fs.rmSync(directory,{recursive:true,force:true});});
 const chat=new GenieChat({directory:path.join(directory,'chats'),provider,getSnapshot:()=>({gateway:state()})}),c=chat.create();chat.submit(c.id,'Enroll worker-a from its existing prepared native capture if explicitly opted in.','recovery-test');await chat.idle();const answer=chat.get(c.id).messages[1];assert.equal(answer.state,'complete',JSON.stringify(answer));assert.equal(requests,1);assert.equal(calls,4);assert.equal(provider.info.can_act,true);
 const completed=answer.recovery.events.filter(e=>e.state==='complete');assert.equal(completed.length,3);assert.equal(completed[1].action_id,status.recovery.operations[0].id);assert.equal(chat.capabilityActivity().recovery.state,'complete');
 const reread=new GenieChat({directory:path.join(directory,'chats'),provider});assert.deepEqual(reread.get(c.id).messages[1].recovery,answer.recovery);
});

test('installed Hermes enrolls an opted-in local oMLX installation once and persists its native enrollment tool handle',{skip:!process.env.DSG_TEST_HERMES_SOURCE,timeout:120000},async t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'sg-recovery-chat-'));let requests=0,calls=0;const status=state();
 const q=createRecoveryTools({read:async()=>status,isChangesEnabled:()=>true,enrollOmlx:async e=>{requests++;assert.equal(e.worker_id,exact.worker_id);const receipt={id:e.action_id,action_id:e.action_id,worker_id:e.worker_id,state:'queued'};status.recovery.operations.push(receipt);status.recovery.omlx_enrollment={operations:[receipt]};return receipt;},recover:()=>assert.fail('Recovery requested during enrollment')});
 const server=http.createServer((req,res)=>{if(q.handle(req,res))return;if(req.method==='GET'){res.end(JSON.stringify({data:[{id:'fixture'}]}));return;}let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{const body=JSON.parse(raw);if(req.url!=='/v1/chat/completions'){res.end(JSON.stringify({}));return;}calls++;
  if(calls===3)assert.match(JSON.stringify(body.messages),new RegExp(status.recovery.operations[0].id));
  const name=calls===2?'enroll_omlx_recovery':'recovery_status',args=calls===2?{worker_id:exact.worker_id}:{};
  const message=calls<=3?{role:'assistant',content:null,tool_calls:[{id:'recovery-'+calls,type:'function',function:{name:'tool_call',arguments:JSON.stringify({name,arguments:args})}}]}:{role:'assistant',content:'Local oMLX enrollment was accepted and queued; restart qualification remains required.'};
  const delta={...message,...(message.tool_calls?{tool_calls:message.tool_calls.map((v,index)=>({...v,index}))}:{})};res.setHeader('content-type','text/event-stream');res.end('data: '+JSON.stringify({id:'recovery-fixture',model:'fixture',choices:[{index:0,delta,finish_reason:null}]})+'\n\ndata: '+JSON.stringify({id:'recovery-fixture',model:'fixture',choices:[{index:0,delta:{},finish_reason:calls<=3?'tool_calls':'stop'}]})+'\n\ndata: [DONE]\n\n');});});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));q.bind(server.address().port);
 const provider=hermesProvider({python:process.env.DSG_TEST_HERMES_PYTHON,source:process.env.DSG_TEST_HERMES_SOURCE,url:`http://127.0.0.1:${server.address().port}/v1`,model:'fixture',recovery:q.toolConfig},{directory});
 t.after(()=>{provider.close();server.closeAllConnections();server.close();fs.rmSync(directory,{recursive:true,force:true});});
 const chat=new GenieChat({directory:path.join(directory,'chats'),provider,getSnapshot:()=>({gateway:state()})}),c=chat.create();chat.submit(c.id,'Enroll worker-a using its configured existing launcher if explicitly opted in.','recovery-test');await chat.idle();const answer=chat.get(c.id).messages[1];assert.equal(answer.state,'complete',JSON.stringify(answer));assert.equal(requests,1);assert.equal(calls,4);assert.equal(provider.info.can_act,true);
 const completed=answer.recovery.events.filter(e=>e.state==='complete');assert.equal(completed.length,3);assert.equal(completed[1].action_id,status.recovery.operations[0].id);assert.equal(chat.capabilityActivity().recovery.state,'complete');
 const reread=new GenieChat({directory:path.join(directory,'chats'),provider});assert.deepEqual(reread.get(c.id).messages[1].recovery,answer.recovery);
});

test('installed Hermes qualifies an opted-in pair once and persists its native qualification tool handle',{skip:!process.env.DSG_TEST_HERMES_SOURCE,timeout:120000},async t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'sg-recovery-chat-'));let requests=0,calls=0;const status=state();
 const q=createRecoveryTools({read:async()=>status,isChangesEnabled:()=>true,qualify:async e=>{requests++;assert.equal(e.worker_id,exact.worker_id);assert.equal(e.evidence_id,exact.evidence_id);const receipt={id:e.action_id,action_id:e.action_id,worker_id:e.worker_id,actor:'genie',pair_qualification:true,state:'queued'};status.recovery.operations.push(receipt);return receipt;},recover:()=>assert.fail('Recovery requested during enrollment')});
 const server=http.createServer((req,res)=>{if(q.handle(req,res))return;if(req.method==='GET'){res.end(JSON.stringify({data:[{id:'fixture'}]}));return;}let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{const body=JSON.parse(raw);if(req.url!=='/v1/chat/completions'){res.end(JSON.stringify({}));return;}calls++;
  if(calls===3)assert.match(JSON.stringify(body.messages),new RegExp(status.recovery.operations[0].id));
  const name=calls===2?'qualify_pair_recovery':'recovery_status',args=calls===2?{worker_id:exact.worker_id,evidence_id:exact.evidence_id}:{};
  const message=calls<=3?{role:'assistant',content:null,tool_calls:[{id:'recovery-'+calls,type:'function',function:{name:'tool_call',arguments:JSON.stringify({name,arguments:args})}}]}:{role:'assistant',content:'Pair qualification was accepted; native restart proof remains pending.'};
  const delta={...message,...(message.tool_calls?{tool_calls:message.tool_calls.map((v,index)=>({...v,index}))}:{})};res.setHeader('content-type','text/event-stream');res.end('data: '+JSON.stringify({id:'recovery-fixture',model:'fixture',choices:[{index:0,delta,finish_reason:null}]})+'\n\ndata: '+JSON.stringify({id:'recovery-fixture',model:'fixture',choices:[{index:0,delta:{},finish_reason:calls<=3?'tool_calls':'stop'}]})+'\n\ndata: [DONE]\n\n');});});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));q.bind(server.address().port);
 const provider=hermesProvider({python:process.env.DSG_TEST_HERMES_PYTHON,source:process.env.DSG_TEST_HERMES_SOURCE,url:`http://127.0.0.1:${server.address().port}/v1`,model:'fixture',recovery:q.toolConfig},{directory});
 t.after(()=>{provider.close();server.closeAllConnections();server.close();fs.rmSync(directory,{recursive:true,force:true});});
 const chat=new GenieChat({directory:path.join(directory,'chats'),provider,getSnapshot:()=>({gateway:state()})}),c=chat.create();chat.submit(c.id,'Qualify worker-a using its current evidence if explicitly opted in.','recovery-test');await chat.idle();const answer=chat.get(c.id).messages[1];assert.equal(answer.state,'complete',JSON.stringify(answer));assert.equal(requests,1);assert.equal(calls,4);assert.equal(provider.info.can_act,true);
 const completed=answer.recovery.events.filter(e=>e.state==='complete');assert.equal(completed.length,3);assert.equal(completed[1].action_id,status.recovery.operations[0].id);assert.equal(chat.capabilityActivity().recovery.state,'complete');
 const reread=new GenieChat({directory:path.join(directory,'chats'),provider});assert.deepEqual(reread.get(c.id).messages[1].recovery,answer.recovery);
});

test('installed Hermes qualifies an opted-in local oMLX worker once and persists its native qualification tool handle',{skip:!process.env.DSG_TEST_HERMES_SOURCE,timeout:120000},async t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'sg-recovery-chat-'));let requests=0,calls=0;const status=state();
 const q=createRecoveryTools({read:async()=>status,isChangesEnabled:()=>true,qualifyOmlx:async e=>{requests++;assert.equal(e.worker_id,exact.worker_id);assert.equal(e.evidence_id,exact.evidence_id);const receipt={id:e.action_id,action_id:e.action_id,worker_id:e.worker_id,actor:'genie',omlx_qualification:true,state:'queued'};status.recovery.operations.push(receipt);return receipt;},recover:()=>assert.fail('Recovery requested during enrollment')});
 const server=http.createServer((req,res)=>{if(q.handle(req,res))return;if(req.method==='GET'){res.end(JSON.stringify({data:[{id:'fixture'}]}));return;}let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{const body=JSON.parse(raw);if(req.url!=='/v1/chat/completions'){res.end(JSON.stringify({}));return;}calls++;
  if(calls===3)assert.match(JSON.stringify(body.messages),new RegExp(status.recovery.operations[0].id));
  const name=calls===2?'qualify_omlx_recovery':'recovery_status',args=calls===2?{worker_id:exact.worker_id,evidence_id:exact.evidence_id}:{};
  const message=calls<=3?{role:'assistant',content:null,tool_calls:[{id:'recovery-'+calls,type:'function',function:{name:'tool_call',arguments:JSON.stringify({name,arguments:args})}}]}:{role:'assistant',content:'Local oMLX qualification was accepted; native restart proof remains pending.'};
  const delta={...message,...(message.tool_calls?{tool_calls:message.tool_calls.map((v,index)=>({...v,index}))}:{})};res.setHeader('content-type','text/event-stream');res.end('data: '+JSON.stringify({id:'recovery-fixture',model:'fixture',choices:[{index:0,delta,finish_reason:null}]})+'\n\ndata: '+JSON.stringify({id:'recovery-fixture',model:'fixture',choices:[{index:0,delta:{},finish_reason:calls<=3?'tool_calls':'stop'}]})+'\n\ndata: [DONE]\n\n');});});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));q.bind(server.address().port);
 const provider=hermesProvider({python:process.env.DSG_TEST_HERMES_PYTHON,source:process.env.DSG_TEST_HERMES_SOURCE,url:`http://127.0.0.1:${server.address().port}/v1`,model:'fixture',recovery:q.toolConfig},{directory});
 t.after(()=>{provider.close();server.closeAllConnections();server.close();fs.rmSync(directory,{recursive:true,force:true});});
 const chat=new GenieChat({directory:path.join(directory,'chats'),provider,getSnapshot:()=>({gateway:state()})}),c=chat.create();chat.submit(c.id,'Qualify worker-a using its current evidence if explicitly opted in.','recovery-test');await chat.idle();const answer=chat.get(c.id).messages[1];assert.equal(answer.state,'complete',JSON.stringify(answer));assert.equal(requests,1);assert.equal(calls,4);assert.equal(provider.info.can_act,true);
 const completed=answer.recovery.events.filter(e=>e.state==='complete');assert.equal(completed.length,3);assert.equal(completed[1].action_id,status.recovery.operations[0].id);assert.equal(chat.capabilityActivity().recovery.state,'complete');
 const reread=new GenieChat({directory:path.join(directory,'chats'),provider});assert.deepEqual(reread.get(c.id).messages[1].recovery,answer.recovery);
});

test('registered legacy adapter with mismatched binding is explicitly unconnected',()=>{const s=state();s.recovery.workers[0].enrollment={binding:'mismatch'};const result=recoveryEvidence(s);assert.deepEqual(result.matched_bindings,[]);assert.equal(result.unmatched_bindings[0].worker_id,'worker-a');assert.equal(result.configured,true);});
