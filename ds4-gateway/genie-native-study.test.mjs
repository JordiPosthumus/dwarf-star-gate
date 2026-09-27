import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {NativeDashboardChat} from './genie-native-dashboard.mjs';
import {nativeRequestId} from './genie-native-chat.mjs';
import {STUDY_INSTRUCTIONS} from './genie-study.mjs';

function fixture(t){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'native-study-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const f={time:100000,views:new Map(),receipts:new Map(),calls:[],fail:false,suspended:false,uncertain:false};
  const client={bindings:new Map(),binding:id=>client.bindings.get(id),discover:async()=>[],
    read:async id=>{if(f.fail)throw Error('Observation unavailable');return structuredClone(f.views.get(id));},
    create:async metadata=>{
      const saved=JSON.parse(fs.readFileSync(path.join(directory,'research-plan.json'),'utf8'));
      assert.equal(saved.last_run.conversation_id,metadata.id,'Schedule intent exists before native creation');
      client.bindings.set(metadata.id,{...metadata,session_key:metadata.id});
      const view={...metadata,created_at:f.time,updated_at:f.time,native_session_key:metadata.id,history_complete:true,messages:[],busy:false,queued:0};f.views.set(metadata.id,view);return structuredClone(view);
    },receipt:async(id,request)=>f.receipts.get(nativeRequestId(id,request))??{request_id:nativeRequestId(id,request),state:'unknown'},
    submit:async(id,message,request,{research,studyContext})=>{
      const saved=JSON.parse(fs.readFileSync(path.join(directory,'research-plan.json'),'utf8'));assert.equal(saved.last_run.request_id,request);
      const receipt={request_id:nativeRequestId(id,request),source_request_id:request,session_key:id,message,research,study_context:studyContext,state:'accepted_unverified'};
      f.calls.push(receipt);f.receipts.set(receipt.request_id,receipt);
      if(f.uncertain)throw Error('Lost acceptance');
      Object.assign(f.views.get(id),{messages:[{role:'user',request_id:request,text:message,state:'complete',at:f.time},
        {id:randomUUID(),role:'assistant',text:'Correction and full evidence. '.repeat(1000),state:'complete',at:f.time,context:studyContext,
          inspection:{events:[{operation:'inspect_server',state:'complete',worker_id:'fixture',at:new Date(f.time).toISOString(),result:{sources:{status:'read',files:[{path:'source.py',status:'read',sha256:'a'.repeat(64),window:{complete_file:false,offset:100}}]}}}]}}]});
      return receipt;
    }};
  f.facade=()=>new NativeDashboardChat({client,directory,now:()=>f.time,info:()=>({research_available:true}),isSuspended:()=>f.suspended});
  f.chat=f.facade();return f;
}

test('async study start retains intent first and carries full previous evidence after reconstruction',async t=>{
  const f=fixture(t),first=randomUUID();
  await f.chat.study.change({action:'study-start',expected_revision:0,request_id:first});
  assert.equal(f.calls[0].study_context.study_brief,STUDY_INSTRUCTIONS);assert.equal(f.calls[0].study_context.previous_study,null);
  const prior=f.chat.study.status();assert.equal(prior.last_run.state,'complete');
  f.views.get(prior.last_run.conversation_id).messages[1].inspection.events.push({operation:'read_server_configuration',state:'complete',worker_id:'fixture',at:new Date(f.time).toISOString(),result:{records:{approved:{revision:'approved-fixture'},observed:{revision:'observed-fixture'}}}});
  f.time+=86400000;f.chat=f.facade();
  await f.chat.study.change({action:'study-start',expected_revision:1,request_id:randomUUID()});
  const previous=f.calls[1].study_context.previous_study;
  assert.equal(previous.conversation_id,prior.last_run.conversation_id);
  assert.ok(previous.latest_completed_answer.text.length>10000);
  assert.equal(previous.evidence.workers[0].source_files[0].window.complete_file,false);
  assert.equal(previous.evidence.workers[0].source_files[0].window.offset,100);
  assert.deepEqual(previous.configuration_snapshot_revisions,[{worker_id:'fixture',approved:'approved-fixture',observed:'observed-fixture'}]);
});

test('lost native acceptance remains the same saved study and never dispatches again on restart or tick',async t=>{
  const f=fixture(t),id=randomUUID();f.uncertain=true;
  await assert.rejects(f.chat.study.change({action:'study-start',expected_revision:0,request_id:id}),/Lost acceptance/);
  f.chat=f.facade();await f.chat.refresh();assert.equal(f.chat.study.status().last_run.state,'unverified');
  await f.chat.study.change({action:'study-start',expected_revision:0,request_id:id});
  await assert.rejects(f.chat.study.change({action:'study-start',expected_revision:1,request_id:randomUUID()}),/running or unverified/);
  await f.chat.study.change({action:'study-schedule',expected_revision:1,interval_days:1,mode:'automatic'});
  f.time+=86400001;await f.chat.tick();assert.equal(f.calls.length,1);
});

test('automatic native studies wait for fresh idle state and concurrent ticks dispatch once',async t=>{
  const f=fixture(t);
  await f.chat.study.change({action:'study-schedule',expected_revision:0,interval_days:1,mode:'automatic'});f.time+=86400001;
  f.suspended=true;await f.chat.tick();assert.equal(f.calls.length,0);f.suspended=false;
  await Promise.all([f.chat.tick(),f.chat.tick()]);assert.equal(f.calls.length,1);assert.equal(f.chat.study.status().last_run.state,'complete');
  f.time+=86400001;f.views.values().next().value.native_hold={state:'held',hold_id:'fixture-hold',turn_id:'fixture-turn',queued:1};await f.chat.tick();assert.equal(f.calls.length,1);
  f.views.values().next().value.native_hold=null;f.fail=true;await f.chat.tick();assert.equal(f.calls.length,1);assert.equal(f.chat.study.status().available,false);
});

test('concurrent study starts respect schedule revision and cannot create two studies from one revision',async t=>{
  const f=fixture(t);
  const results=await Promise.allSettled([f.chat.study.change({action:'study-start',expected_revision:0,request_id:randomUUID()}),f.chat.study.change({action:'study-start',expected_revision:0,request_id:randomUUID()})]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(f.calls.length,1);
});
