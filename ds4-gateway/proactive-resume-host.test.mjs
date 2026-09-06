import test from 'node:test';
import assert from 'node:assert/strict';
import {registerProactiveResumeHost} from './proactive-resume-host.mjs';

const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
const turn=()=>new Promise(resolve=>setImmediate(resolve));
function rig({optionsWait,reviewWait}={}){
  const commands=new Map(),events=new Map(),statuses=[],notices=[];
  let selection='Enable for this task',closed=0,revoked=0,prepared=0,reviewed=0,reviewSignal,scopeId;
  const ui={select:async()=>selection,setStatus:(_key,value)=>statuses.push(value),notify:text=>notices.push(text)};
  const session={sessionId:'fixture-session',model:{baseUrl:'http://127.0.0.1:30000/v1'},messages:[{role:'user',content:'Finish the synthetic task'},{role:'assistant',content:'Shall I continue?'}],subscribe:()=>()=>{},prepareContinuationEnrollment:({enrollment})=>{
    prepared++;scopeId=enrollment.scopeId;return {cancel:()=>{},activate:()=>({revoke:()=>{revoked++;},inspect:()=>reviewWait?{ticket:{id:'fixture-ticket',scopeId}}:{blockedReason:'native_busy'}})};
  }};
  const host=registerProactiveResumeHost({registerCommand:(name,command)=>commands.set(name,command.handler),on:(name,handler)=>events.set(name,handler)},{getSession:()=>session,getEnrollmentOptions:async()=>{
    if(optionsWait)await optionsWait.promise;
    return {gatewayBaseUrl:session.model.baseUrl,providers:[{url:session.model.baseUrl,model:'fixture'}],expiresAt:Date.now()+60000,attemptBudget:1,createReceipts:async()=>({close:async()=>{closed++;}}),reviewer:{review:async(_input,{signal})=>{reviewed++;reviewSignal=signal;await reviewWait.promise;return {state:'unavailable'};}}};
  }});
  return {host,statuses,notices,events,run:name=>commands.get(name)('',{hasUI:true,ui}),decline:()=>{selection='Keep disabled';},stats:()=>({closed,revoked,prepared,reviewed,reviewSignal})};
}

test('off cancels pending options and prevents later enrollment',async()=>{
  const optionsWait=deferred(),r=rig({optionsWait});
  const pending=r.run('proactive-resume');
  await r.run('proactive-resume-off');optionsWait.resolve();await pending;await turn();
  assert.equal(r.stats().prepared,0);assert.equal(r.statuses.at(-1),'Proactive Resume: off');
});

test('declining creates no active capability; immediate off prevents scheduled review',async()=>{
  const declined=rig();declined.decline();await declined.run('proactive-resume');await turn();
  assert.equal(declined.stats().reviewed,0);assert.equal(declined.stats().closed,0);
  const r=rig();await r.run('proactive-resume');
  assert.match(r.statuses.at(-1),/on/);await r.run('proactive-resume-off');await turn();
  assert.equal(r.stats().reviewed,0);assert.equal(r.stats().revoked,1);assert.equal(r.stats().closed,1);
  assert.equal(r.statuses.at(-1),'Proactive Resume: off');
});

test('session exit aborts an in-flight review and late completion cannot restore enabled status',async()=>{
  const reviewWait=deferred(),r=rig({reviewWait});await r.run('proactive-resume');await turn();
  assert.equal(r.stats().reviewed,1);await r.events.get('session_before_switch')();
  assert.equal(r.stats().reviewSignal.aborted,true);assert.equal(r.stats().closed,1);
  reviewWait.resolve();await turn();assert.equal(r.statuses.at(-1),'Proactive Resume: off');
});
