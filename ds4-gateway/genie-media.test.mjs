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
const id='11111111-1111-4111-8111-111111111111';
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
});
test('bounded media status keeps old queued jobs ahead of recent completed history',async()=>{
  const jobs=[{id:'old-waiting',state:'queued',priority:'normal'},...Array.from({length:60},(_,i)=>({id:String(i),state:'completed'})),{id:'urgent',state:'queued',priority:'high'}];
  const tools=createMediaTools({read:async()=>({jobs,workers:[]})});const result=await tools.tool({action:'status'});
  assert.equal(result.jobs.length,50);assert.equal(result.truncated,true);assert.deepEqual(result.jobs.slice(0,2).map(j=>j.id),['urgent','old-waiting']);
});
test('automatic queue wakeup uses pinned Hermes to start once and retain actual tool events',{skip:!process.env.DSG_TEST_HERMES_SOURCE,timeout:120000},async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'sg-media-chat-'));let starts=0,calls=0;
  const state={enabled:true,hosts:[{id:'one'}],fleet:[{id:'one',is_healthy:true,drained:false,load:0,queued:0},{id:'two',is_healthy:true,drained:false,load:0,queued:0}],workers:[{id:'one',kinds:['video'],busy:false}],jobs:[{id,kind:'video',state:'queued'}]};
  const resources=createMediaResources({genie_chat:{inspection:{workers:{one:{kind:'omlx-local'}}}}},{inspect:async()=>({system:'Darwin',architecture:'arm64',gpu_names:[]})});
  const tools=createMediaTools({resources,read:async()=>state,start:async input=>{assert.deepEqual(input,{job_id:id,worker_id:'one'});starts++;state.jobs[0].execution={worker_id:'one',phase:'waiting_idle',detail:'Admitted work finishing'};return state.jobs[0];}});
  const server=http.createServer((req,res)=>{
    if(tools.handle(req,res))return;
    if(req.method==='GET'){res.end(JSON.stringify({data:[{id:'fixture'}]}));return;}
    let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{
      const body=JSON.parse(raw);if(req.url!=='/v1/chat/completions'){res.end('{}');return;}calls++;
      if(calls===4)assert.match(JSON.stringify(body.messages),/waiting_idle/);
      if(calls===3)assert.match(JSON.stringify(body.messages),/recipe_platform_matches/);
      const name=calls===2?'inspect_media_host':calls===3?'start_media_job':'media_job_status',args=calls===2?{worker_id:'one'}:calls===3?{job_id:id,worker_id:'one'}:{};
      const message=calls<=4?{role:'assistant',content:null,tool_calls:[{id:'media-'+calls,type:'function',function:{name:'tool_call',arguments:JSON.stringify({name,arguments:args})}}]}:{role:'assistant',content:'Job accepted on one; admitted LLM work is finishing. Generation has not started.'};
      const delta={...message,...(message.tool_calls?{tool_calls:message.tool_calls.map((v,index)=>({...v,index}))}:{})};
      res.setHeader('content-type','text/event-stream');res.end('data: '+JSON.stringify({id:'fixture',model:'fixture',choices:[{index:0,delta,finish_reason:null}]})+'\n\ndata: '+JSON.stringify({id:'fixture',model:'fixture',choices:[{index:0,delta:{},finish_reason:calls<=4?'tool_calls':'stop'}]})+'\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));tools.bind(server.address().port);
  const provider=hermesProvider({python:process.env.DSG_TEST_HERMES_PYTHON,source:process.env.DSG_TEST_HERMES_SOURCE,url:`http://127.0.0.1:${server.address().port}/v1`,model:'fixture',media:tools.toolConfig},{directory});
  t.after(()=>{provider.close();server.closeAllConnections();server.close();fs.rmSync(directory,{recursive:true,force:true});});
  const chat=new GenieChat({directory:path.join(directory,'chats'),provider,getSnapshot:()=>({gateway:{}})});
  const watch=new MediaWatch({filename:path.join(directory,'watch.json'),chat,read:async()=>state,isEnabled:()=>true});
  await watch.tick();const conversation={id:watch.state.conversation_id};await chat.idle();await watch.tick();
  const answer=chat.get(conversation.id).messages[1];assert.equal(answer.state,'complete',JSON.stringify(answer));assert.equal(starts,1);assert.equal(calls,5);assert.equal(provider.info.can_act,true);
  assert.equal(answer.media.events.filter(e=>e.state==='complete').length,4);assert.equal(chat.capabilityActivity().media.state,'complete');
  const reread=new GenieChat({directory:path.join(directory,'chats'),provider});assert.deepEqual(reread.get(conversation.id).messages[1].media,answer.media);
});
