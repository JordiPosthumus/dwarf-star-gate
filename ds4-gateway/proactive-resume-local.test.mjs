import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {proactiveResumeLocalOptions} from './proactive-resume-local.mjs';

const turn=()=>new Promise(resolve=>setImmediate(resolve));
function deferred(){let resolve;const promise=new Promise(r=>{resolve=r;});return {resolve,promise};}
async function rig(t,{nextState,barrier}={}){
  const root=await mkdtemp(join(tmpdir(),'dsg-local-options-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const endpoint={url:'http://127.0.0.1:19999/v1',model:'fixture'};
  const commands=new Map(),statuses=[];let reads=0,fetches=0,scopeId;
  const initial={genie:{enabled:true,closed:false,config:endpoint},snapshot:{gateway_at:Date.now(),gateway:{genie_admission_version:1,model:endpoint.model,workers:[{is_healthy:true,load:0,queued:0}]}}};
  const session={sessionId:'fixture-session',model:{baseUrl:endpoint.url},messages:[{role:'user',content:'Finish this fixture task'},{role:'assistant',content:'Shall I continue?'}],subscribe:()=>()=>{},prepareContinuationEnrollment:({enrollment})=>{
    scopeId=enrollment.scopeId;return {cancel:()=>{},activate:()=>({inspect:()=>({ticket:{id:'ticket',scopeId}}),revoke:()=>{}})};
  }};
  const options=proactiveResumeLocalOptions({gatewayBaseUrl:endpoint.url,receiptRoot:join(root,'receipts'),enrollmentMs:60000,attemptBudget:1,
    ReceiptStore:{create:async()=>({close:async()=>{}}),open:async()=>{throw new Error('Unexpected reopen');}},
    getReviewState:async()=>{if(++reads>1){if(barrier)await barrier.promise;return nextState?.(initial)??initial;}return initial;},
    fetchImpl:async()=>{fetches++;throw new Error('No model request expected');}
  });
  options.extensionFactories[0]({registerCommand:(name,command)=>commands.set(name,command.handler),on:()=>{}});
  options.onRuntimeCreated({session});
  const ui={select:async()=>'Enable for this task',setStatus:(_key,text)=>statuses.push(text),notify:()=>{}};
  const run=name=>commands.get(name)('',{hasUI:true,ui});t.after(()=>run('proactive-resume-off'));
  return {run,statuses,stats:()=>({reads,fetches})};
}

test('provider refresh cannot send task text to a newly configured undisclosed model',async t=>{
  const r=await rig(t,{nextState:state=>({...state,genie:{...state.genie,config:{...state.genie.config,model:'changed'}}})});
  await r.run('proactive-resume');await turn();
  assert.equal(r.stats().reads,2);assert.equal(r.stats().fetches,0);
  assert.match(r.statuses.at(-1),/review unavailable/);
});
test('fresh pool occupancy prevents a review even when capacity was free at enrollment',async t=>{
  const r=await rig(t,{nextState:state=>({...state,snapshot:{...state.snapshot,gateway:{...state.snapshot.gateway,workers:[{is_healthy:true,load:1,queued:0}]}}})});
  await r.run('proactive-resume');await turn();assert.equal(r.stats().fetches,0);assert.equal(r.stats().reads,2);
});
test('opt-out during metadata refresh prevents a late snapshot from starting inference',async t=>{
  const barrier=deferred(),r=await rig(t,{barrier});await r.run('proactive-resume');await turn();
  assert.equal(r.stats().reads,2);await r.run('proactive-resume-off');barrier.resolve();await turn();
  assert.equal(r.stats().fetches,0);assert.equal(r.statuses.at(-1),'Proactive Resume: off');
});

test('a still-undispatched review uses newly freed capacity without retrying inference',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});let checks=0;
  const r=await rig(t,{nextState:state=>++checks===1?{...state,snapshot:{...state.snapshot,gateway:{...state.snapshot.gateway,workers:[{is_healthy:true,load:1,queued:0}]}}}:state});
  await r.run('proactive-resume');await turn();assert.equal(r.stats().fetches,0);
  t.mock.timers.tick(999);await turn();assert.equal(r.stats().fetches,0);
  t.mock.timers.tick(1);await turn();assert.equal(r.stats().fetches,1);assert.equal(r.stats().reads,3);
  t.mock.timers.tick(60000);await turn();assert.equal(r.stats().fetches,1);
});

test('capacity waiting shares the sixty-second ceiling and never queues a model request',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const r=await rig(t,{nextState:state=>({...state,snapshot:{...state.snapshot,gateway:{...state.snapshot.gateway,workers:[{is_healthy:true,load:1,queued:0}]}}})});
  await r.run('proactive-resume');await turn();t.mock.timers.tick(60000);await turn();
  assert.equal(r.stats().fetches,0);assert.match(r.statuses.at(-1),/review unavailable/);
});
