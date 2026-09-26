import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {MediaImprovementWatch} from './media-improvement-watch.mjs';
import {GenieChat} from './genie-chat.mjs';
import {createMediaTools} from './genie-media.mjs';
import {hermesProvider} from './genie-hermes.mjs';

const stageTool={prepare:'prepare_media_improvement',qualify:'qualify_media_improvement',promote:'promote_media_improvement'};
function fixture(t){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'sg-improvement-watch-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const config={media_jobs:{improvements:{enabled:true},standard:{enabled:true,targets:[{worker_id:'pair',engine:'ace-step',member:0}]}}};
 const id=randomUUID(),key=JSON.stringify(['pair',0]),offer={key,worker_id:'pair',member:0,stage:'prepare',eligible:true,evidence_id:'a'.repeat(64)};
 const state={enabled:true,jobs:[],workers:[],improvements:{enabled:true,offers:[offer],operations:[]}},conversations=[],calls=[];let enabled=true,busy=false;
 const chat={status:()=>({available:true,conversations:conversations.map(c=>({id:c.id,busy,queued:0}))}),get:id=>{const c=conversations.find(c=>c.id===id);if(!c)throw Error('missing chat');return structuredClone(c);},create:()=>{const c={id:randomUUID(),messages:[]};conversations.push(c);return structuredClone(c);},submit:(id,text,request_id)=>{
  calls.push({id,text,request_id});const c=conversations.find(c=>c.id===id);if(!c.messages.some(m=>m.request_id===request_id))c.messages.push({role:'user',request_id,text},{id:randomUUID(),role:'assistant',state:'complete',media:{events:[]}});
 }};
 const options={filename:path.join(directory,'watch.json'),config,chat,read:async()=>structuredClone(state),isEnabled:()=>enabled};
 return {directory,config,id,key,offer,state,conversations,calls,chat,options,watch:()=>new MediaImprovementWatch(options),enabled:v=>enabled=v,busy:v=>busy=v,
  advance(stage){Object.assign(offer,{operation_id:id,stage,phase:stage==='qualify'?'candidate_prepared':stage==='promote'?'qualified_returned':'promoted',eligible:!!stage,evidence_id:'a'.repeat(64)});state.improvements.operations=[{operation_id:id,worker_id:'pair',member:0,phase:offer.phase}];},
  reply(){return conversations[0].messages.at(-1);},
 };
}
test('configured standard progresses prepare, qualify and promote in one durable conversation',async t=>{
 const f=fixture(t);await f.watch().tick();assert.equal(f.calls.length,1);
 assert.match(f.calls[0].text,/call prepare_media_improvement once/);
 f.advance('qualify');await f.watch().tick();f.advance('promote');await f.watch().tick();f.advance(null);const done=f.watch();await done.tick();
 assert.equal(f.calls.length,3);assert.equal(new Set(f.calls.map(c=>c.id)).size,1);assert.equal(new Set(f.calls.map(c=>c.request_id)).size,3);
 assert.match(f.calls[1].text,/call qualify_media_improvement once/);assert.match(f.calls[2].text,/call promote_media_improvement once/);
 assert.equal(done.status().targets[0].phase,'promoted');assert.equal(f.conversations.length,1);
});
test('native completion receipts can be finalized under their original operation without another native launch',async t=>{
 const f=fixture(t);f.advance('qualify');f.offer.stage='finish_preparation';f.offer.phase='candidate_preparing';await f.watch().tick();
 assert.match(f.calls[0].text,/observes and verifies the same saved completion/);assert.match(f.calls[0].text,/call prepare_media_improvement once/);
 f.offer.stage='finish_qualification';f.offer.phase='candidate_qualifying';await f.watch().tick();assert.equal(f.calls.length,2);assert.match(f.calls[1].text,/call qualify_media_improvement once/);
 assert.ok(f.calls.every(c=>c.text.includes(f.id)));
});
test('lost chat acknowledgement retains the exact submit identity across watcher restart',async t=>{
 for(const accepted of [false,true]){
  const f=fixture(t),submit=f.chat.submit;let once=true;
  f.chat.submit=(...args)=>{if(once){once=false;if(accepted)submit(...args);else f.calls.push({id:args[0],text:args[1],request_id:args[2]});throw Error('lost reply');}return submit(...args);};
  await f.watch().tick();await f.watch().tick();assert.equal(f.calls.length,accepted?1:2);
  if(!accepted)assert.deepEqual(f.calls[0],f.calls[1]);
  await f.watch().tick();assert.equal(f.calls.length,accepted?1:2);
 }
});
test('a verified no-action refusal waits for eligibility; narrative alone needs attention',async t=>{
 const f=fixture(t);await f.watch().tick();const proof=structuredClone(f.state);proof.improvements.offers[0].eligible=false;proof.improvements.offers[0].reason='capacity_busy';
 f.reply().media.events=[{tool:'media_job_status',state:'complete',result:proof}];f.offer.eligible=false;await f.watch().tick();assert.equal(f.calls.length,1);
 f.offer.eligible=true;await f.watch().tick();assert.equal(f.calls.length,2);assert.notEqual(f.calls[0].request_id,f.calls[1].request_id);
 await f.watch().tick();assert.equal(f.calls.length,2);assert.equal(f.watch().status().targets[0].phase,'needs_attention');
});
test('uncertain or external tool attempts cannot acquire a replacement operation',async t=>{
 const f=fixture(t);await f.watch().tick();f.reply().media.events=[{tool:'prepare_media_improvement',state:'reading',request:{worker_id:'pair',member:0}}];
 await f.watch().tick();await f.watch().tick();assert.equal(f.calls.length,1);assert.equal(f.watch().status().targets[0].reason,'stage_action_already_requested');
 const g=fixture(t),c=g.chat.create();g.conversations[0].messages.push({role:'assistant',media:{events:[{tool:'prepare_media_improvement',state:'failed',request:{worker_id:'pair',member:0}}]}});
 await g.watch().tick();assert.equal(g.calls.length,0);assert.equal(g.watch().status().targets[0].conversation_id,c.id);assert.equal(g.watch().status().targets[0].phase,'needs_attention');
});
test('an existing requested improvement continues in its actual Genie conversation',async t=>{
 const f=fixture(t),c=f.chat.create();f.conversations[0].messages.push({role:'assistant',state:'complete',media:{events:[{tool:'prepare_media_improvement',state:'complete',request:{worker_id:'pair',member:0},result:{operation_id:f.id,member:0,phase:'candidate_preparing'}}]}});
 f.advance('qualify');await f.watch().tick();assert.equal(f.calls[0].id,c.id);assert.equal(f.conversations.length,1);
});
test('owner stop, paused chat, testing/capability changes and configuration withdrawal prevent progression',async t=>{
 for(const change of [f=>f.enabled(false),f=>f.busy(true),f=>f.config.media_jobs.improvements.enabled=false,f=>f.config.media_jobs.standard.enabled=false,f=>f.config.media_jobs.standard.targets=[],f=>f.state.improvements.enabled=false,f=>f.state.enabled=false,
  f=>f.conversations[0].queue_paused=true,f=>f.conversations[0].messages.push({role:'assistant',stop_requested_at:1})]){
  const f=fixture(t);await f.watch().tick();f.advance('qualify');change(f);await f.watch().tick();assert.equal(f.calls.length,1);
 }
});
test('late status or durable-intent permission changes cannot submit a stale prompt',async t=>{
 for(const late of ['disabled','closed','busy']){
  const f=fixture(t);let watch;f.options.read=async()=>{if(late==='disabled')f.enabled(false);if(late==='closed')watch.close();if(late==='busy')f.busy(true);return f.state;};watch=f.watch();await watch.tick();assert.equal(f.calls.length,0);
 }
 const f=fixture(t),watch=f.watch(),save=watch.save.bind(watch);watch.save=()=>{save();f.enabled(false);};await watch.tick();assert.equal(f.calls.length,0);
});
test('failed persistence must succeed before submission, and missing chats do not create replacements',async t=>{
 const f=fixture(t),watch=f.watch(),save=watch.save.bind(watch);watch.save=()=>{throw Error('disk full');};await watch.tick();await watch.tick();assert.equal(f.calls.length,0);
 watch.save=save;await watch.tick();assert.equal(f.calls.length,1);f.conversations.length=0;f.advance('qualify');await f.watch().tick();assert.equal(f.calls.length,1);assert.equal(f.conversations.length,0);
});
test('pending native operations and reconciliation cannot be mistaken for readiness',async t=>{
 for(const phase of ['candidate_preparing','candidate_qualifying','candidate_promoting','requires_reconciliation']){
  const f=fixture(t);Object.assign(f.offer,{operation_id:f.id,stage:null,eligible:false,phase,reason:'observe_existing_operation'});
  await f.watch().tick();await f.watch().tick();assert.equal(f.calls.length,0);
 }
});
test('real persisted Genie chats retain the three stage receipts across reconstruction',async t=>{
 const f=fixture(t);let turns=0;
 const provider={info:{configured:true,can_act:true},generate:async({onMedia})=>{
  const stage=['prepare','qualify','promote'][turns++],request=stage==='prepare'?{worker_id:'pair',member:0}:{operation_id:f.id};
  f.advance(stage==='prepare'?'qualify':stage==='qualify'?'promote':null);
  onMedia({tool:stageTool[stage],state:'complete',at:new Date().toISOString(),request,result:{operation_id:f.id,member:0,phase:f.offer.phase}});
  onMedia({tool:'media_job_status',state:'complete',at:new Date().toISOString(),request:{},result:structuredClone(f.state)});return 'Observed native fixture receipt.';
 }};
 let chat=new GenieChat({directory:path.join(f.directory,'chats'),provider});f.options.chat=chat;
 for(let i=0;i<3;i++){await f.watch().tick();await chat.idle();chat=new GenieChat({directory:path.join(f.directory,'chats'),provider});f.options.chat=chat;}
 const done=f.watch();await done.tick();assert.equal(turns,3);assert.equal(done.status().targets[0].phase,'promoted');assert.equal(chat.status().conversations.length,1);
 const messages=chat.get(chat.status().conversations[0].id).messages;assert.equal(messages.filter(m=>m.role==='user').length,3);assert.equal(messages.flatMap(m=>m.media?.events??[]).filter(e=>mutating(e.tool)).length,3);await chat.close();
});
const mutating=tool=>Object.values(stageTool).includes(tool);

test('installed Hermes invokes each registered stage tool once through watcher wakeups',{skip:!process.env.DSG_TEST_HERMES_SOURCE,timeout:120000},async t=>{
 const f=fixture(t);let calls=0,actions=[];
 const action=stage=>async input=>{actions.push(stage);assert.deepEqual(input,stage==='prepare'?{worker_id:'pair',member:0}:{operation_id:f.id});f.advance(stage==='prepare'?'qualify':stage==='qualify'?'promote':null);return {operation_id:f.id,member:0,phase:f.offer.phase};};
 const tools=createMediaTools({read:async()=>structuredClone(f.state),improve:action('prepare'),qualify:action('qualify'),promote:action('promote')});
 const server=http.createServer((req,res)=>{
  if(tools.handle(req,res))return;
  if(req.method==='GET'){res.end(JSON.stringify({data:[{id:'fixture'}]}));return;}
  let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{
   JSON.parse(raw);const turn=Math.floor(calls/4),step=calls++%4,stage=['prepare','qualify','promote'][turn];
   const name=step===1?stageTool[stage]:'media_job_status',args=step===1?(stage==='prepare'?{worker_id:'pair',member:0}:{operation_id:f.id}):{};
   const message=step<3?{role:'assistant',content:null,tool_calls:[{index:0,id:'improvement-'+calls,type:'function',function:{name:'tool_call',arguments:JSON.stringify({name,arguments:args})}}]}:{role:'assistant',content:'Observed saved fixture operation.'};
   res.setHeader('content-type','text/event-stream');res.end('data: '+JSON.stringify({id:'fixture',model:'fixture',choices:[{index:0,delta:message,finish_reason:null}]})+'\n\ndata: '+JSON.stringify({id:'fixture',model:'fixture',choices:[{index:0,delta:{},finish_reason:step<3?'tool_calls':'stop'}]})+'\n\ndata: [DONE]\n\n');
  });
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));tools.bind(server.address().port);
 const provider=hermesProvider({python:process.env.DSG_TEST_HERMES_PYTHON,source:process.env.DSG_TEST_HERMES_SOURCE,url:`http://127.0.0.1:${server.address().port}/v1`,model:'fixture',media:tools.toolConfig},{directory:f.directory});
 const chat=new GenieChat({directory:path.join(f.directory,'chats'),provider,getSnapshot:()=>({gateway:{}})});f.options.chat=chat;
 t.after(async()=>{await chat.close();provider.close();server.closeAllConnections();server.close();});
 for(let i=0;i<3;i++){await f.watch().tick();await chat.idle();}
 const done=f.watch();await done.tick();assert.deepEqual(actions,['prepare','qualify','promote']);assert.equal(calls,12);assert.equal(done.status().targets[0].phase,'promoted');
 const conversations=chat.status().conversations;assert.equal(conversations.length,1);const messages=chat.get(conversations[0].id).messages;
 assert.equal(messages.filter(m=>m.role==='user').length,3);assert.equal(messages.flatMap(m=>m.media?.events??[]).filter(e=>e.state==='complete'&&mutating(e.tool)).length,3);
});
