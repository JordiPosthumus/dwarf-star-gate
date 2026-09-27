import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {saveFollowupJournal,followupStatus,followupReady,followupConversation,createChatTick} from './genie-followup.mjs';
import {NativeDashboardChat} from './genie-native-dashboard.mjs';
import {SparkDiscoveryWatch} from './spark-discovery-watch.mjs';
import {MediaWatch} from './media-watch.mjs';
import {chatCapabilityActivity} from './genie-capability-activity.mjs';

const idle=()=>({mode:'native',available:true,native_observation_available:true,conversations:[{id:'conversation',observation_available:true,busy:false,queued:0,pending_input_count:0,queue_paused:null}]});
const temporary=t=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'native-followup-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;};

test('failed journal replacement preserves the previous private operation record',t=>{
  const dir=temporary(t),file=path.join(dir,'watch.json'),old={request_id:'retained-request',state:'pending'};
  saveFollowupJournal(file,old);assert.equal(fs.statSync(file).mode&0o777,0o600);
  const invalid={};invalid.circular=invalid;
  assert.throws(()=>saveFollowupJournal(file,invalid));assert.deepEqual(JSON.parse(fs.readFileSync(file)),old);
  assert.deepEqual(fs.readdirSync(dir),['watch.json']);
});

test('follow-ups require a fresh native observation including unresolved-input evidence',async()=>{
  const summary=idle();let refreshed=0;
  const chat={refresh:async()=>{refreshed++;},status:()=>summary};
  assert.equal(followupReady(await followupStatus(chat)),true);assert.equal(refreshed,1);
  for(const change of [{busy:true},{busy:null},{queued:null},{queued:1},{pending_input_count:1},{pending_input_count:null},{queue_paused:'hold'},{observation_available:false}]){
    assert.equal(followupReady({...summary,conversations:[{...summary.conversations[0],...change}]}),false);
  }
  assert.equal(followupReady({...summary,native_observation_available:false}),false);
  await assert.rejects(followupStatus({...chat,refresh:async()=>{throw Error('unavailable');}}),/unavailable/);
  assert.equal(followupReady({available:true,conversations:[]}),true,'Existing legacy state remains supported');
});

test('a lost native creation reply survives watcher reconstruction with exactly one saved conversation ID',async t=>{
  const dir=temporary(t),file=path.join(dir,'watch.json'),calls=[],created=new Set();let fail=true,record={};
  const save=()=>fs.writeFileSync(file,JSON.stringify(record),{mode:0o600});
  const chat={status:idle,create:async intent=>{
    assert.deepEqual(JSON.parse(fs.readFileSync(file)).conversation_intent,intent,'Intent is durable before native creation');
    calls.push(structuredClone(intent));created.add(intent.id);if(fail)throw Error('lost acknowledgment');return {id:intent.id};
  }};
  await assert.rejects(followupConversation(chat,record,save,'Automatic media dispatch'),/lost acknowledgment/);
  record=JSON.parse(fs.readFileSync(file));fail=false;
  const id=await followupConversation(chat,record,save,'Automatic media dispatch');
  assert.equal(created.size,1);assert.deepEqual(calls[0],calls[1]);assert.equal(record.conversation_id,id);assert.equal(record.conversation_intent,undefined);
  await followupConversation(chat,record,save,'Automatic media dispatch');assert.equal(calls.length,2);
});

test('native creation does not proceed after a failed journal write or mismatched saved metadata',async()=>{
  let created=0;const chat={status:idle,create:async()=>{created++;}};
  await assert.rejects(followupConversation(chat,{},()=>{throw Error('disk full');},'Original'),/disk full/);
  await assert.rejects(followupConversation(chat,{conversation_intent:{id:'not-an-id',title:'Other',purpose:null}},()=>{},'Original'),/reconciliation/);
  assert.equal(created,0);
});

test('discovery watcher refreshes actual native facade without a dashboard poll and honors a new hold during its read',async t=>{
  const directory=temporary(t),scan='11111111-1111-4111-8111-111111111111';let reads=0,submitted=0,holdDuringRead=true;
  const view={id:'conversation',title:'Native',history_complete:true,busy:false,queued:0,pending_inputs:[],native_hold:null,native_session_key:'key',native_session_id:'session',
    messages:[{id:'assistant',role:'assistant',state:'complete',text:'Discovery is running.',spark_setup:{events:[{tool:'discover_sparks',state:'complete',result:{scan_id:scan,state:'running'}}]}}],updated_at:1};
  const client={bindings:new Map([['conversation',{}]]),discover:async()=>{},read:async()=>{reads++;return {...structuredClone(view),observed_at:new Date().toISOString()};}};
  const chat=new NativeDashboardChat({client});chat.submit=async()=>{submitted++;};
  const options={filename:path.join(directory,'watch.json'),chat,isEnabled:()=>true,read:async()=>{
    if(holdDuringRead)view.native_hold={hold_id:'held',turn_id:'stopped',state:'held',queued:0};return {scan_id:scan,state:'complete'};
  }};
  assert.equal(chat.status().available,false);await new SparkDiscoveryWatch(options).tick();
  assert.ok(reads>=2);assert.equal(submitted,0);assert.equal(chat.status().conversations[0].queue_paused!==null,true);
  holdDuringRead=false;view.native_hold=null;await new SparkDiscoveryWatch(options).tick();assert.equal(submitted,1);
  await new SparkDiscoveryWatch(options).tick();assert.equal(submitted,1);
});

test('media watcher rechecks native pending input after reading capacity',async t=>{
  const directory=temporary(t),summary=idle();let sent=0,created=0,refreshes=0;
  const chat={status:()=>summary,refresh:async()=>refreshes++,create:async()=>{created++;},submit:async()=>sent++};
  const watch=new MediaWatch({filename:path.join(directory,'watch.json'),chat,isEnabled:()=>true,read:async()=>{
    summary.conversations[0].pending_input_count=1;
    return {enabled:true,jobs:[{id:'job',state:'queued',kind:'video'}],workers:[],fleet:[]};
  }});
  await watch.tick();assert.equal(created,0);assert.equal(sent,0);assert.equal(refreshes,2);
});

test('chat scheduling awaits studies, serializes watchers, and stops new work after close',async()=>{
  const order=[];let release;
  const runner=createChatTick({chat:{tick:async()=>{order.push('study');await new Promise(r=>release=r);}},watchers:[{tick:async()=>order.push('first')},{tick:async()=>order.push('second')}]});
  const a=runner.tick(),b=runner.tick();assert.deepEqual(order,['study']);release();await Promise.all([a,b]);assert.deepEqual(order,['study','first','second']);
  const c=runner.tick();runner.close();release();await c;assert.deepEqual(order,['study','first','second','study']);await runner.tick();assert.equal(order.length,4);
});

test('native capability activity retains dated tool failures and does not count active calls as success',()=>{
  const sessions=[{messages:[{inspection:{events:[{state:'complete',finished_at:'2026-09-27T00:00:00Z',worker_id:'fixture'},
    {state:'failed',finished_at:'2026-09-27T00:01:00Z',worker_id:'fixture',error:'unavailable'},
    {state:'reading',at:'2026-09-27T00:02:00Z',worker_id:'fixture'}]}}]}];
  const expected=chatCapabilityActivity(sessions);assert.equal(expected.inspection.state,'failed');
  const native=new NativeDashboardChat({client:{bindings:new Map()}});native.sessions.set('fixture',sessions[0]);
  assert.deepEqual(native.capabilityActivity(),expected);assert.equal(expected.inspection.at,Date.parse('2026-09-27T00:01:00Z'));
});
