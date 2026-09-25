import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createMediaResources} from './media-resources.mjs';
import {MediaWatch} from './media-watch.mjs';
import {createMediaTools} from './genie-media.mjs';
import {hermesProvider} from './genie-hermes.mjs';
import {GenieChat} from './genie-chat.mjs';
import {capabilityStatus} from './genie-capability-status.mjs';
const id='11111111-1111-4111-8111-111111111111', secondId='22222222-2222-4222-8222-222222222222';
test('media tool preserves exact selection, observed progress and testing policy',async()=>{
  let testing=false,starts=0;
  const q=createMediaTools({read:async()=>({enabled:false,jobs:[{id,state:'running',execution:{phase:'generating'}}],workers:[]}),start:async input=>{starts++;assert.deepEqual(input,{job_id:id,worker_id:'one'});return {id,execution:{phase:'starting'}};},isTesting:()=>testing});
  assert.equal((await q.tool({action:'status'})).jobs[0].execution.phase,'generating');
  await assert.rejects(q.tool({action:'start',job_id:id,worker_id:'one',command:['override']}));
  testing=true;await assert.rejects(q.tool({action:'start',job_id:id,worker_id:'one'}),/testing/);assert.equal(starts,0);
  testing=false;assert.equal((await q.tool({action:'start',job_id:id,worker_id:'one'})).id,id);assert.equal(starts,1);
});
test('media capability reports the failed service and ongoing return',()=>{
  const base={gateway:{genie_capabilities:{media:true}}},options={management:true,chat:{capabilities_configured:{media:true}},media:{workers:[{id:'one'}],jobs:[{execution:{worker_id:'one',phase:'needs_attention',detail:'LLM cache check failed'}}]}};
  let row=capabilityStatus(base,options).capabilities.find(c=>c.key==='media');assert.equal(row.status,'Needs attention');assert.match(row.detail,/one: LLM cache check failed/);
  options.media.jobs[0].execution={worker_id:'one',phase:'restoring_llm',detail:'Original LLM loading'};
  row=capabilityStatus(base,options).capabilities.find(c=>c.key==='media');assert.equal(row.status,'Working');
  options.media.setup={connected:true,operations:[{worker_id:'two',phase:'qualified_returned',enrollment_error:'New engine binding changed'}]};
  row=capabilityStatus(base,options).capabilities.find(c=>c.key==='media');assert.equal(row.status,'Needs attention');assert.match(row.detail,/two setup: New engine binding changed/);
});
test('media setup tool accepts only worker and engine, preserving the testing pause',async()=>{
 let calls=0,testing=true;const tools=createMediaTools({isTesting:()=>testing,setup:async input=>{calls++;assert.deepEqual(input,{worker_id:'one',engine:'ace-step'});return {phase:'starting'};}});
 await assert.rejects(tools.tool({action:'setup',worker_id:'one',engine:'ace-step'}),/testing/);testing=false;
 await assert.rejects(tools.tool({action:'setup',worker_id:'one',engine:'ace-step',command:'override'}));
 assert.equal((await tools.tool({action:'setup',worker_id:'one',engine:'ace-step'})).phase,'starting');assert.equal(calls,1);
});
test('bounded media status keeps old queued jobs ahead of recent completed history',async()=>{
  const jobs=[{id:'old-waiting',state:'queued',priority:'normal'},...Array.from({length:60},(_,i)=>({id:String(i),state:'completed'})),{id:'urgent',state:'queued',priority:'high'}];
  const tools=createMediaTools({read:async()=>({jobs,workers:[]})});const result=await tools.tool({action:'status'});
  assert.equal(result.jobs.length,50);assert.equal(result.truncated,true);assert.deepEqual(result.jobs.slice(0,2).map(j=>j.id),['urgent','old-waiting']);
});
test('automatic queue wakeup uses pinned Hermes to start once and retain actual tool events',{skip:!process.env.DSG_TEST_HERMES_SOURCE,timeout:120000},async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'sg-media-chat-'));let starts=0,calls=0,setups=0,inputChecks=0;
  const state={enabled:true,batch_jobs_supported:true,hosts:[{id:'one',engines:[{kind:'video',ready:true}]}],fleet:[{id:'one',is_healthy:true,drained:false,load:0,queued:0},{id:'two',is_healthy:true,drained:false,load:0,queued:0}],workers:[{id:'one',kinds:['video'],busy:false}],jobs:[{id,kind:'video',state:'queued'},{id:secondId,kind:'video',state:'queued'}]};
  const resources=createMediaResources({genie_chat:{inspection:{workers:{one:{kind:'omlx-local'}}}}},{inspect:async()=>({system:'Darwin',architecture:'arm64',gpu_names:[]})});
  const tools=createMediaTools({inspectInputs:async input=>{assert.deepEqual(input,{job_id:id,worker_id:'one'});inputChecks++;return {files:[{state:'present'}]};},setup:async input=>{assert.deepEqual(input,{worker_id:'one',engine:'ace-step'});setups++;state.setup={operations:[{worker_id:'one',engine:'ace-step',phase:'waiting_idle'}]};return state.setup.operations[0];},resources,read:async()=>state,start:async input=>{assert.deepEqual(input,{job_id:id,worker_id:'one',following_job_ids:[secondId]});starts++;for(const job of state.jobs)job.execution={worker_id:'one',phase:'waiting_idle',detail:'Admitted work finishing'};return state.jobs[0];}});
  const server=http.createServer((req,res)=>{
    if(tools.handle(req,res))return;
    if(req.method==='GET'){res.end(JSON.stringify({data:[{id:'fixture'}]}));return;}
    let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{
      const body=JSON.parse(raw);if(req.url!=='/v1/chat/completions'){res.end('{}');return;}calls++;
      if(calls===5)assert.match(JSON.stringify(body.messages),/waiting_idle/);
      if(calls===3)assert.match(JSON.stringify(body.messages),/recipe_platform_matches/);
      const name=calls===2?'inspect_media_host':calls===3?'inspect_media_inputs':calls===4?'start_media_job':calls===6?'setup_media_host':'media_job_status',args=calls===2?{worker_id:'one'}:calls===3?{job_id:id,worker_id:'one'}:calls===4?{job_id:id,worker_id:'one',following_job_ids:[secondId]}:calls===6?{worker_id:'one',engine:'ace-step'}:{};
      const message=calls<=7?{role:'assistant',content:null,tool_calls:[{id:'media-'+calls,type:'function',function:{name:'tool_call',arguments:JSON.stringify({name,arguments:args})}}]}:{role:'assistant',content:'Job accepted on one; admitted LLM work is finishing. Generation has not started.'};
      const delta={...message,...(message.tool_calls?{tool_calls:message.tool_calls.map((v,index)=>({...v,index}))}:{})};
      res.setHeader('content-type','text/event-stream');res.end('data: '+JSON.stringify({id:'fixture',model:'fixture',choices:[{index:0,delta,finish_reason:null}]})+'\n\ndata: '+JSON.stringify({id:'fixture',model:'fixture',choices:[{index:0,delta:{},finish_reason:calls<=7?'tool_calls':'stop'}]})+'\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));tools.bind(server.address().port);
  const provider=hermesProvider({python:process.env.DSG_TEST_HERMES_PYTHON,source:process.env.DSG_TEST_HERMES_SOURCE,url:`http://127.0.0.1:${server.address().port}/v1`,model:'fixture',media:tools.toolConfig},{directory});
  t.after(()=>{provider.close();server.closeAllConnections();server.close();fs.rmSync(directory,{recursive:true,force:true});});
  const chat=new GenieChat({directory:path.join(directory,'chats'),provider,getSnapshot:()=>({gateway:{}})});
  const watch=new MediaWatch({filename:path.join(directory,'watch.json'),chat,read:async()=>state,isEnabled:()=>true});
  await watch.tick();const conversation={id:watch.state.conversation_id};await chat.idle();await watch.tick();
  const answer=chat.get(conversation.id).messages[1];assert.equal(answer.state,'complete',JSON.stringify(answer));assert.equal(starts,1);assert.equal(calls,8);assert.equal(inputChecks,1);assert.equal(setups,1);assert.equal(provider.info.can_act,true);
  assert.equal(answer.media.events.filter(e=>e.state==='complete').length,7);assert.ok(answer.media.events.some(e=>e.tool==='inspect_media_inputs'&&e.state==='complete'));assert.ok(answer.media.events.some(e=>e.tool==='start_media_job'&&e.state==='complete'));assert.equal(chat.capabilityActivity().media.state,'complete');
  const reread=new GenieChat({directory:path.join(directory,'chats'),provider});assert.deepEqual(reread.get(conversation.id).messages[1].media,answer.media);
});

test('compact overview keeps fleet and active return facts; full records remain available by ID',async()=>{
 const long='native diagnostic '.repeat(1000),old={id,state:'completed',result:{prompt:long},detail:long,outputs:{state:'ready',files:[{id:'file',filename:'full-name.mp4'}]}};
 const jobs=[old,...Array.from({length:60},(_,i)=>({id:'history-'+i,state:'completed'})),{id:secondId,state:'completed',priority:'high',execution:{worker_id:'one',phase:'restoring_llm',detail:long}}];
 const state={jobs,workers:[{id:'one',kinds:['video'],busy:true}],fleet:[{id:'two',is_healthy:true,drained:false,load:1,queued:0}]};
 const before=JSON.stringify(state),tools=createMediaTools({read:async()=>state});
 const overview=await tools.tool({action:'overview'}),full=await tools.tool({action:'status'}),detail=await tools.tool({action:'job',job_id:id});
 assert.deepEqual(overview.fleet,state.fleet);assert.equal(overview.jobs[0].id,secondId);assert.equal(overview.jobs[0].execution.phase,'restoring_llm');assert.equal(overview.jobs[0].details_shortened,true);
 assert.match(overview.scope,/job_id/);assert.equal(overview.truncated,true);assert.equal(overview.jobs.length,50);assert.equal(overview.jobs[0].result,undefined);
 assert.equal(full.jobs[0].execution.detail,long,'existing dashboard status is unchanged');assert.deepEqual(detail.job,old,'even records older than the overview remain available');assert.equal(JSON.stringify(state),before);
 await assert.rejects(tools.tool({action:'job',job_id:'missing'}),/Unknown/);await assert.rejects(tools.tool({action:'job',job_id:id,command:'change'}));
});

test('pinned Hermes reads the complete compact overview and asks for full job details',{skip:!process.env.DSG_TEST_HERMES_SOURCE,timeout:120000},async t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'sg-media-overview-'));let calls=0;const seen=[];
 const state={enabled:true,fleet:[{id:'fleet-visible-at-the-front',is_healthy:true,drained:false,load:0}],workers:[{id:'one',kinds:['video'],busy:false}],jobs:[{id,state:'queued',kind:'video',result:{detail:'FULL_JOB_DETAIL_MARKER',graph:'x'.repeat(7000)}},...Array.from({length:25},(_,i)=>({id:'done-'+i,state:'completed',kind:'video',result:{graph:'x'.repeat(7000)}}))]};
 const tools=createMediaTools({read:async()=>state,start:()=>{throw Error('Read-only test');}});
 const server=http.createServer((req,res)=>{
  if(tools.handle(req,res))return;
  if(req.method==='GET'){res.end(JSON.stringify({data:[{id:'fixture'}]}));return;}
  let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{
   if(req.url!=='/v1/chat/completions'){res.end('{}');return;}calls++;const body=JSON.parse(raw);seen.push(body);
   const message=calls<=2?{role:'assistant',content:null,tool_calls:[{id:'overview-'+calls,type:'function',function:{name:'tool_call',arguments:JSON.stringify({name:'media_job_status',arguments:calls===1?{}:{job_id:id}})}}]}:{role:'assistant',content:'Fleet and full job details read.'};
   const delta={...message,...(message.tool_calls?{tool_calls:message.tool_calls.map((v,index)=>({...v,index}))}:{})};res.setHeader('content-type','text/event-stream');res.end('data: '+JSON.stringify({id:'fixture',model:'fixture',choices:[{index:0,delta,finish_reason:null}]})+'\n\ndata: '+JSON.stringify({id:'fixture',model:'fixture',choices:[{index:0,delta:{},finish_reason:calls<=2?'tool_calls':'stop'}]})+'\n\ndata: [DONE]\n\n');
  });
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));tools.bind(server.address().port);
 const provider=hermesProvider({python:process.env.DSG_TEST_HERMES_PYTHON,source:process.env.DSG_TEST_HERMES_SOURCE,url:`http://127.0.0.1:${server.address().port}/v1`,model:'fixture',media:tools.toolConfig},{directory});
 t.after(()=>{provider.close();server.closeAllConnections();server.close();fs.rmSync(directory,{recursive:true,force:true});});
 const chat=new GenieChat({directory:path.join(directory,'chats'),provider,getSnapshot:()=>({gateway:{}})}),conversation=chat.create();chat.submit(conversation.id,'Read the overview, then full details for the queued job. Do not act.','overview-test');await chat.idle();
 const answer=chat.get(conversation.id).messages[1];assert.equal(answer.state,'complete',JSON.stringify(answer));assert.equal(calls,3);
 const first=JSON.stringify(seen[1].messages);assert.match(first,/fleet-visible-at-the-front/);assert.doesNotMatch(first,/FULL_JOB_DETAIL_MARKER|<persisted-output>/);
 const second=JSON.stringify(seen[2].messages);assert.match(second,/FULL_JOB_DETAIL_MARKER/);assert.doesNotMatch(second,/<persisted-output>/);
 const events=answer.media.events.filter(e=>e.state==='complete');assert.equal(events.length,2);assert.equal(events[1].request.job_id,id);assert.deepEqual(events[1].result.job,state.jobs[0]);
});

 test('setup retry forwards only the observed timestamp and physical selection',async()=>{
  const input={worker_id:'pair',member:1,engine:'ace-step',expected_failed_at:'2026-01-01T01:02:03.000Z'};
  const tools=createMediaTools({setup:async observed=>{assert.deepEqual(observed,input);return {phase:'starting'};}});
  assert.equal((await tools.tool({action:'setup',...input})).phase,'starting');
  await assert.rejects(tools.tool({action:'setup',...input,force:true}));
 });
