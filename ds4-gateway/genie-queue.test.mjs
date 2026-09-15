import test from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createQueueTools} from './genie-queue.mjs';import {hermesProvider} from './genie-hermes.mjs';import {GenieChat} from './genie-chat.mjs';
const exact={request_id:'11111111-1111-4111-8111-111111111111',source:'worker-a',destination:'worker-b',evidence_id:'a'.repeat(64)};
const state=()=>({version:1,workers:[{id:'worker-a',load:1,queued:2},{id:'worker-b',load:0,queued:0}],continuity:{relocation:{genie_enabled:true,genie_offers:[exact],diagnostics:{},last:null}}});
test('chat queue tools enforce toggle, testing, exact inputs and authenticated endpoint',async t=>{
 let enabled=true,testing=false,moves=0;const q=createQueueTools({read:async()=>state(),move:async e=>{moves++;return {...e,state:'relocated',actor:'genie'};},isEnabled:()=>enabled,isTesting:()=>testing});
 const server=http.createServer((req,res)=>{if(!q.handle(req,res))res.end();});await new Promise(r=>server.listen(0,'127.0.0.1',r));q.bind(server.address().port);t.after(()=>{server.closeAllConnections();server.close();});
 const call=(body,token=q.toolConfig.token)=>fetch(q.toolConfig.url,{method:'POST',headers:{'content-type':'application/json','x-sg-queue-tool':token},body:JSON.stringify(body)});
 assert.equal((await call({action:'status'},'wrong')).status,403);assert.equal((await (await call({action:'status'})).json()).offers.length,1);
 enabled=false;assert.equal((await call({action:'move',...exact})).status,409);assert.equal(moves,0);enabled=true;
 assert.equal((await call({action:'move',...exact,cancel:true})).status,409);assert.equal((await (await call({action:'move',...exact})).json()).state,'relocated');assert.equal(moves,1);
 testing=true;assert.equal((await call({action:'status'})).status,409);assert.equal(moves,1);
});
test('lost queue move acknowledgement is never retried by the chat service',async()=>{
 let moves=0;const q=createQueueTools({read:async()=>state(),move:async()=>{moves++;throw new Error('connection lost');}});
 await assert.rejects(q.tool({action:'move',...exact}));assert.equal(moves,1);assert.equal((await q.tool({action:'status'})).offers.length,1);assert.equal(moves,1);
});
test('installed Hermes reads offers and returns an actual chat tool receipt',{skip:!process.env.DSG_TEST_HERMES_SOURCE,timeout:120000},async t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'sg-queue-chat-'));let moves=0,calls=0;
 const q=createQueueTools({read:async()=>state(),move:async e=>{assert.deepEqual(e,exact);moves++;return {...e,state:'relocated',actor:'genie',deadline_preserved:true};}});
 const server=http.createServer((req,res)=>{if(q.handle(req,res))return;if(req.method==='GET'){res.end(JSON.stringify({data:[{id:'fixture'}]}));return;}let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{const body=JSON.parse(raw);if(req.url!=='/v1/chat/completions'){res.end(JSON.stringify({}));return;}calls++;if(calls===3)assert.match(JSON.stringify(body.messages),/deadline_preserved/);
  const message=calls<=2?{role:'assistant',content:null,tool_calls:[{id:'queue-'+calls,type:'function',function:{name:'tool_call',arguments:JSON.stringify({name:calls===1?'queue_balance_status':'move_waiting_job',arguments:calls===1?{}:exact})}}]}:{role:'assistant',content:'The waiting job moved; its deadline was preserved.'};
  const delta={...message,...(message.tool_calls?{tool_calls:message.tool_calls.map((v,index)=>({...v,index}))}:{})};res.setHeader('content-type','text/event-stream');res.end('data: '+JSON.stringify({id:'queue-fixture',model:'fixture',choices:[{index:0,delta,finish_reason:null}]})+'\n\ndata: '+JSON.stringify({id:'queue-fixture',model:'fixture',choices:[{index:0,delta:{},finish_reason:calls<=2?'tool_calls':'stop'}]})+'\n\ndata: [DONE]\n\n');});});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));q.bind(server.address().port);
 const provider=hermesProvider({python:process.env.DSG_TEST_HERMES_PYTHON,source:process.env.DSG_TEST_HERMES_SOURCE,url:`http://127.0.0.1:${server.address().port}/v1`,model:'fixture',queue:q.toolConfig},{directory});
 t.after(()=>{provider.close();server.closeAllConnections();server.close();fs.rmSync(directory,{recursive:true,force:true});});
 const chat=new GenieChat({directory:path.join(directory,'chats'),provider,getSnapshot:()=>({gateway:state()})}),c=chat.create();chat.submit(c.id,'Rebalance the queue.','queue-test');await chat.idle();const answer=chat.get(c.id).messages[1];assert.equal(answer.state,'complete',JSON.stringify(answer));assert.equal(moves,1);assert.equal(calls,3);assert.equal(provider.info.can_act,true);assert.equal(answer.queue.events.filter(e=>e.state==='complete').length,2,JSON.stringify(answer.queue));assert.equal(chat.capabilityActivity().rebalance.state,'complete');
 const reread=new GenieChat({directory:path.join(directory,'chats'),provider});assert.deepEqual(reread.get(c.id).messages[1].queue,answer.queue);
});
