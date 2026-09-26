import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {OmlxSetupWatch} from './omlx-setup-watch.mjs';
import {GenieChat} from './genie-chat.mjs';
import http from 'node:http';
import {createRecoveryTools} from './genie-recovery.mjs';
import {hermesProvider} from './genie-hermes.mjs';

function fixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'omlx-setup-watch-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const id=randomUUID(),worker_id='local',conversation={id:randomUUID(),messages:[{id:randomUUID(),role:'assistant',state:'complete',recovery:{events:[{tool:'enroll_omlx_recovery',action_id:id,state:'complete',request:{worker_id}}]}}]};
  const s={automatic:true,workers:[{worker_id,enrollment:{binding:'matched',permissions:{start_stopped_enrolled:false}},omlx_qualification:{eligible:false,reason:'omlx_other_llm_required',certified:false}}],operations:[],
    omlx_enrollment:{operations:[{action_id:id,worker_id,state:'enrolled'}],demand_start_offers:[{worker_id,eligible:false,reason:'wait_for_admitted_work'}]}};
  const config={omlx_recovery_setup:{workers:{local:{exclusive:true,start_on_demand:true,qualify_restart:true}}}};
  const calls=[];let busy=false,enabled=true;
  const chat={status:()=>({available:true,conversations:[{id:conversation.id,busy,queued:0,queue_paused:conversation.queue_paused}]}),get:()=>structuredClone(conversation),submit:(...args)=>{
    calls.push(args);if(!conversation.messages.some(m=>m.request_id===args[2]))conversation.messages.push({role:'user',request_id:args[2],text:args[1]}, {id:randomUUID(),role:'assistant',state:'complete',recovery:{events:[]}});
  }};
  const options={filename:path.join(dir,'watch.json'),config,chat,read:async()=>structuredClone(s),isEnabled:()=>enabled};
  return {s,dir,id,conversation,config,calls,chat,options,watch:()=>new OmlxSetupWatch(options),enabled:v=>enabled=v,busy:v=>busy=v,
    ready(){s.omlx_enrollment.demand_start_offers[0]={worker_id,eligible:true,reason:null};},
    upgraded(){const action_id=randomUUID();s.omlx_enrollment.operations.push({action_id,worker_id,state:'enrolled',demand_start:true});s.omlx_enrollment.demand_start_offers=[];
      s.workers[0].enrollment.permissions.start_stopped_enrolled=true;
      conversation.messages.push({id:randomUUID(),role:'assistant',state:'complete',recovery:{events:[{tool:'enroll_omlx_recovery',state:'complete',action_id,request:{worker_id}}]}});return action_id;},
    qualificationReady(){s.workers[0].omlx_qualification={eligible:true,evidence_id:'a'.repeat(64),reason:null,certified:false};}};
}

test('a later idle offer wakes the same original conversation and advances to qualification after another busy wait',async t=>{
  const f=fixture(t);await f.watch().tick();assert.equal(f.calls.length,0);assert.equal(f.watch().status().targets[0].phase,'waiting');
  f.ready();await f.watch().tick();assert.equal(f.calls.length,1);assert.equal(f.calls[0][0],f.conversation.id);assert.match(f.calls[0][1],/call enroll_omlx_recovery once/);
  f.upgraded();await f.watch().tick();assert.equal(f.calls.length,1);f.qualificationReady();await f.watch().tick();assert.equal(f.calls.length,2);assert.match(f.calls[1][1],/CURRENT evidence_id/);
  f.s.workers[0].omlx_qualification.certified=true;const last=f.watch();await last.tick();assert.equal(last.status().targets[0].phase,'qualified');assert.equal(f.calls.length,2);
});

test('a verified no-action busy reply waits for later eligibility; narrative alone never loops',async t=>{
  const f=fixture(t);f.upgraded();f.qualificationReady();await f.watch().tick();
  const reply=f.conversation.messages.at(-1);const busy=structuredClone(f.s);busy.workers[0].omlx_qualification={eligible:false,reason:'wait_for_admitted_work',certified:false};
  reply.recovery.events=[{tool:'recovery_status',state:'complete',result:busy}];f.s.workers[0].omlx_qualification=busy.workers[0].omlx_qualification;
  await f.watch().tick();assert.equal(f.calls.length,1);f.qualificationReady();await f.watch().tick();assert.equal(f.calls.length,2);assert.notEqual(f.calls[0][2],f.calls[1][2]);
  await f.watch().tick();assert.equal(f.calls.length,2);assert.equal(f.watch().status().targets[0].phase,'needs_attention');
});

test('uncertain native tool acknowledgement is never replaced even if an offer appears eligible',async t=>{
  const f=fixture(t);f.upgraded();f.qualificationReady();await f.watch().tick();
  f.conversation.messages.at(-1).recovery.events=[{tool:'qualify_omlx_recovery',state:'reading',action_id:randomUUID(),request:{worker_id:'local'}}];
  for(let i=0;i<3;i++)await f.watch().tick();assert.equal(f.calls.length,1);assert.equal(f.watch().status().targets[0].reason,'native_action_already_requested');
});

test('qualification requested outside this watcher also prevents a duplicate action',async t=>{
  const f=fixture(t);f.upgraded();f.qualificationReady();
  f.conversation.messages.at(-1).recovery.events.push({tool:'qualify_omlx_recovery',state:'failed',action_id:randomUUID(),request:{worker_id:'local'}});
  await f.watch().tick();assert.equal(f.calls.length,0);assert.equal(f.watch().status().targets[0].phase,'observing');
});

test('an authoritative completed restart on the old binding permits demand enrollment, but uncertain outcomes do not',async t=>{
  for(const state of ['recovered','queued','failed',null]){
    const f=fixture(t),action_id=randomUUID();f.ready();
    f.conversation.messages.push({role:'assistant',state:'complete',recovery:{events:[{tool:'qualify_omlx_recovery',state:'complete',action_id,request:{worker_id:'local'}}]}});
    if(state)f.s.operations.push({id:action_id,worker_id:'local',state});
    await f.watch().tick();assert.equal(f.calls.length,state==='recovered'?1:0);
  }
});

test('lost chat acknowledgement retries the exact request and text, never a new chat identity',async t=>{
  const f=fixture(t);f.ready();const submit=f.chat.submit;let once=true;
  f.chat.submit=(...args)=>{if(once){once=false;f.calls.push(args);throw Error('lost before response');}return submit(...args);};
  await f.watch().tick();await f.watch().tick();assert.equal(f.calls.length,2);assert.deepEqual(f.calls[0],f.calls[1]);
  await f.watch().tick();assert.equal(f.calls.length,2);
  const g=fixture(t);g.ready();const save=g.chat.submit;g.chat.submit=(...args)=>{save(...args);throw Error('response lost after acceptance');};
  await g.watch().tick();await g.watch().tick();assert.equal(g.calls.length,1,'saved reply is observed instead of resubmitted');
});

test('policy, queue pause, any later owner stop and active chats prevent automatic progression',async t=>{
  for(const change of [f=>f.enabled(false),f=>f.busy(true),f=>f.config.omlx_recovery_setup.workers.local.start_on_demand=false,
    f=>f.config.omlx_recovery_setup.workers.local.qualify_restart=false,f=>f.config.omlx_recovery_setup.workers.local.exclusive=false,
    f=>f.s.automatic=false,f=>f.conversation.queue_paused='owner',f=>f.conversation.messages.push({role:'assistant',state:'interrupted',stop_requested_at:1}),
    f=>f.s.workers[0].enrollment.binding='mismatch']){
    const f=fixture(t);f.ready();change(f);await f.watch().tick();assert.equal(f.calls.length,0);
  }
});

test('changes during status observation or after intent save cannot submit a stale continuation',async t=>{
  for(const late of ['stop','busy','policy','close']){
    const f=fixture(t);f.ready();let watcher;
    f.options.read=async()=>{if(late==='stop')f.conversation.messages[0].stop_requested_at=1;if(late==='busy')f.busy(true);if(late==='policy')f.enabled(false);if(late==='close')watcher.close();return f.s;};
    watcher=f.watch();await watcher.tick();assert.equal(f.calls.length,0);
  }
  const f=fixture(t);f.ready();const w=f.watch(),save=w.save.bind(w);w.save=()=>{save();f.conversation.queue_paused='owner';};await w.tick();assert.equal(f.calls.length,0);
});

test('failed durable write must succeed before any submission on subsequent ticks',async t=>{
  const f=fixture(t);f.ready();const w=f.watch(),save=w.save.bind(w);w.save=()=>{throw Error('disk full');};
  await w.tick();await w.tick();assert.equal(f.calls.length,0);w.save=save;await w.tick();assert.equal(f.calls.length,1);
});

test('missing, failed or working enrollment receipts never initiate another action',async t=>{
  for(const state of [null,'failed','queued','unavailable']){
    const f=fixture(t);f.ready();if(state)f.s.omlx_enrollment.operations[0].state=state;else f.s.omlx_enrollment.operations=[];
    await f.watch().tick();await f.watch().tick();assert.equal(f.calls.length,0);
  }
});

test('without a real enrollment request the watcher does not invent a task or target',async t=>{
  const f=fixture(t);f.ready();f.conversation.messages=[];await f.watch().tick();assert.equal(f.calls.length,0);
  f.conversation.messages=[{role:'assistant',recovery:{events:[{tool:'enroll_omlx_recovery',action_id:f.id,request:{worker_id:'other'}}]}}];await f.watch().tick();assert.equal(f.calls.length,0);
});

test('real persisted Genie chat continues both stages and deduplicates an accepted request across watcher reconstruction',async t=>{
  const f=fixture(t),events=[];let turns=0;
  const provider={info:{configured:true,can_act:true},generate:async({message,onRecovery})=>{
    turns++;const stage=message.includes('next observed stage is enroll_demand')?'enroll':'qualify';
    const action_id=randomUUID(),event={tool:stage==='enroll'?'enroll_omlx_recovery':'qualify_omlx_recovery',state:'complete',at:new Date().toISOString(),action_id,request:{worker_id:'local'}};
    if(stage==='enroll'){f.s.omlx_enrollment.operations.push({action_id,worker_id:'local',state:'enrolled',demand_start:true});f.s.omlx_enrollment.demand_start_offers=[];f.s.workers[0].enrollment.permissions.start_stopped_enrolled=true;}
    else {f.s.workers[0].omlx_qualification.certified=true;f.s.operations.push({id:action_id,worker_id:'local',state:'recovered',omlx_qualification:true});}
    onRecovery(event);onRecovery({tool:'recovery_status',state:'complete',at:new Date().toISOString(),result:structuredClone(f.s)});events.push(event);return 'Observed fixture receipt.';
  }};
  let chat=new GenieChat({directory:path.join(f.dir,'chats'),provider}),c=chat.create();
  // Seed only the prior enrollment receipt that establishes this conversation's scope.
  const saved=chat.sessions.get(c.id);saved.messages=structuredClone(f.conversation.messages).map(m=>({...m,text:'Prior fixture enrollment.'}));chat.save(saved);
  f.options.chat=chat;f.ready();const submit=chat.submit.bind(chat);let lost=true;
  chat.submit=(...args)=>{const result=submit(...args);if(lost){lost=false;throw Error('accepted response lost');}return result;};
  await f.watch().tick();await chat.idle();assert.equal(turns,1);assert.equal(events[0].tool,'enroll_omlx_recovery');
  chat=new GenieChat({directory:path.join(f.dir,'chats'),provider});f.options.chat=chat;
  await f.watch().tick();assert.equal(turns,1);f.qualificationReady();await f.watch().tick();await chat.idle();assert.equal(turns,2);
  const done=f.watch();await done.tick();assert.equal(done.status().targets[0].phase,'qualified');assert.equal(turns,2);assert.equal(events[1].tool,'qualify_omlx_recovery');
  assert.equal(chat.status().conversations.length,1);assert.equal(chat.get(c.id).messages.filter(m=>m.role==='user').length,2);await chat.close();
});

test('installed Hermes resumes eligible enrollment and qualification through saved watcher conversations',{skip:!process.env.DSG_TEST_HERMES_SOURCE,timeout:120000},async t=>{
  const f=fixture(t);let calls=0,enrollments=0,qualifications=0;
  const previousQualification=randomUUID();
  f.conversation.messages.push({id:randomUUID(),role:'assistant',state:'complete',recovery:{events:[{tool:'qualify_omlx_recovery',state:'complete',action_id:previousQualification,request:{worker_id:'local'}}]}});
  f.s.operations.push({id:previousQualification,worker_id:'local',actor:'genie',omlx_qualification:true,state:'recovered'});f.s.workers[0].omlx_qualification.certified=true;
  const q=createRecoveryTools({read:async()=>({version:1,recovery:structuredClone(f.s)}),isChangesEnabled:()=>true,
    enrollOmlx:async input=>{
      enrollments++;assert.equal(input.worker_id,'local');
      const receipt={id:input.action_id,action_id:input.action_id,worker_id:'local',state:'enrolled',demand_start:true};
      f.s.omlx_enrollment.operations.push(receipt);f.s.omlx_enrollment.demand_start_offers=[];f.s.workers[0].enrollment.permissions.start_stopped_enrolled=true;f.s.workers[0].omlx_qualification.certified=false;return receipt;
    },qualifyOmlx:async input=>{
      qualifications++;assert.equal(input.worker_id,'local');assert.equal(input.evidence_id,f.s.workers[0].omlx_qualification.evidence_id);
      const receipt={id:input.action_id,worker_id:'local',actor:'genie',omlx_qualification:true,state:'recovered'};
      f.s.operations.push(receipt);f.s.workers[0].omlx_qualification.certified=true;return receipt;
    },recover:()=>assert.fail('Setup continuation must not request generic recovery')});
  const server=http.createServer((req,res)=>{
    if(q.handle(req,res))return;
    if(req.method==='GET'){res.end(JSON.stringify({data:[{id:'fixture'}]}));return;}
    let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{
      const body=JSON.parse(raw);if(req.url!=='/v1/chat/completions'){res.end('{}');return;}
      calls++;const step=(calls-1)%4+1,enrolling=calls<=4;
      if(step===3)assert.match(JSON.stringify(body.messages),new RegExp(enrolling?f.s.omlx_enrollment.operations.at(-1).action_id:f.s.operations.at(-1).id));
      const name=step===2?(enrolling?'enroll_omlx_recovery':'qualify_omlx_recovery'):'recovery_status';
      const args=step===2?{worker_id:'local',...(enrolling?{}:{evidence_id:f.s.workers[0].omlx_qualification.evidence_id})}:{};
      const message=step<4?{role:'assistant',content:null,tool_calls:[{index:0,id:'setup-'+calls,type:'function',function:{name:'tool_call',arguments:JSON.stringify({name,arguments:args})}}]}:
        {role:'assistant',content:'Observed the fixture setup receipt.'};
      res.setHeader('content-type','text/event-stream');res.end('data: '+JSON.stringify({id:'setup-fixture',model:'fixture',choices:[{index:0,delta:message,finish_reason:null}]})+'\n\ndata: '+JSON.stringify({id:'setup-fixture',model:'fixture',choices:[{index:0,delta:{},finish_reason:step<4?'tool_calls':'stop'}]})+'\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));q.bind(server.address().port);
  const provider=hermesProvider({python:process.env.DSG_TEST_HERMES_PYTHON,source:process.env.DSG_TEST_HERMES_SOURCE,url:`http://127.0.0.1:${server.address().port}/v1`,model:'fixture',recovery:q.toolConfig},{directory:f.dir});
  t.after(()=>{provider.close();server.closeAllConnections();server.close();});
  let chat=new GenieChat({directory:path.join(f.dir,'chats'),provider}),c=chat.create();
  const saved=chat.sessions.get(c.id);saved.messages=structuredClone(f.conversation.messages).map(m=>({...m,text:'Prior fixture enrollment.'}));chat.save(saved);f.options.chat=chat;
  await f.watch().tick();assert.equal(calls,0);f.ready();await f.watch().tick();await chat.idle();
  assert.equal(chat.get(c.id).messages.at(-1).state,'complete');assert.equal(calls,4);assert.equal(enrollments,1);assert.equal(qualifications,0);
  const receipt=chat.get(c.id).messages.at(-1).recovery.events.find(e=>e.tool==='enroll_omlx_recovery'&&e.state==='complete');
  assert.equal(receipt.action_id,f.s.omlx_enrollment.operations.at(-1).action_id);
  chat=new GenieChat({directory:path.join(f.dir,'chats'),provider});f.options.chat=chat;
  assert.equal(chat.status().conversations.length,1);await f.watch().tick();assert.equal(calls,4,'a busy qualification does not wake Hermes');
  f.qualificationReady();await f.watch().tick();await chat.idle();
  assert.equal(chat.get(c.id).messages.at(-1).state,'complete');assert.equal(calls,8);assert.equal(enrollments,1);assert.equal(qualifications,1);
  const done=f.watch();await done.tick();assert.equal(done.status().targets[0].phase,'qualified');assert.equal(calls,8);
  const qualification=chat.get(c.id).messages.at(-1).recovery.events.find(e=>e.tool==='qualify_omlx_recovery'&&e.state==='complete');
  assert.equal(qualification.action_id,f.s.operations.at(-1).id);assert.notEqual(qualification.action_id,receipt.action_id);assert.notEqual(qualification.action_id,previousQualification);
  assert.equal(chat.get(c.id).messages.filter(m=>m.role==='user').length,2);
});
