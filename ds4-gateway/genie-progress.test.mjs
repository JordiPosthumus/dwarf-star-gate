import test from 'node:test';import assert from 'node:assert/strict';import {chatProgress} from './ui/genie-progress.js';
test('waiting and liveness are not invented from the clock',()=>{
 const m={state:'working',at:1000,text:''};const p=chatProgress(m,{now:62000});assert.match(p.label,/Waiting/);assert.match(p.detail,/No new activity for 1m 1s/);assert.match(p.activity,/may be queued or generating/);
 assert.match(chatProgress(m,{now:62000,connected:false}).label,/progress unknown/);assert.equal(chatProgress({...m,state:'complete'}),null);
});
test('real reasoning, tool progress, queue and quiet periods have distinct status',()=>{
 const m={state:'working',at:0,text:'',progress:{phase:'reasoning',step:2,reasoning_chars:1400,at:9000}};assert.match(chatProgress(m,{now:10000}).label,/Reasoning/);
 m.research={events:[{kind:'search',state:'complete',at:new Date(9500).toISOString(),query:'vLLM MTP',sources:[]}]};assert.match(chatProgress(m,{now:10000}).label,/Sources returned/);assert.match(chatProgress(m,{now:10000}).activity,/vLLM MTP/);
 m.progress={...m.progress,phase:'model_wait',step:3,at:11000};assert.match(chatProgress(m,{now:12000}).label,/Waiting/);
 assert.match(chatProgress({...m,state:'queued'},{now:12000}).detail,/not been sent/);assert.match(chatProgress({...m,state:'queued'},{suspended:true}).label,/testing/);
});

test('earlier answer text does not hide current reasoning or model wait',()=>{
 const m={state:'working',at:0,text:'An earlier partial answer',progress:{phase:'reasoning',step:4,reasoning_chars:400,at:9000}};
 assert.match(chatProgress(m,{now:10000}).label,/Reasoning/);
 m.progress.phase='model_wait';assert.match(chatProgress(m,{now:10000}).label,/Waiting/);
 m.progress.phase='answer';assert.match(chatProgress(m,{now:10000}).label,/Writing/);
});

test('gateway queue/running evidence is separate from model activity and becomes unknown when stale',()=>{
 const m={state:'working',at:0,text:'',progress:{phase:'model_wait',step:2,reasoning_chars:0,at:1000},gateway_execution:{state:'queued',observed_at:59000,machine:'example'}};
 const p=chatProgress(m,{now:60000});assert.equal(p.label,'Queued on example');assert.match(p.detail,/No new activity/);m.gateway_execution.state='running';assert.equal(chatProgress(m,{now:60000}).label,'Running on example');
 assert.match(chatProgress(m,{now:80000}).activity,/unavailable or stale/);assert.doesNotMatch(chatProgress(m,{now:80000}).label,/Running/);
 m.gateway_execution={state:'not_observed',observed_at:79000};assert.match(chatProgress(m,{now:80000}).activity,/between model calls/);assert.match(chatProgress(m,{now:80000,connected:false}).label,/progress unknown/);
});

test('a manually paused chat queue is shown as paused, not an advancing answer',()=>{assert.equal(chatProgress({state:'queued',at:0},{now:1000,paused:true}).label,'Saved · paused for your review');});

test('operation tools show their own activity without inventing execution',()=>{const m={state:'working',at:0,operations:{events:[{tool:'propose_server_change',state:'reading',at:new Date(1000).toISOString()}]}};assert.equal(chatProgress(m,{now:2000}).label,'Preparing a server-change proposal');m.operations.events[0].state='complete';const p=chatProgress(m,{now:2000});assert.equal(p.label,'Server-change status returned');assert.match(p.detail,/1 tool call/);});


import {pendingInputPresentation,nativeObservationChanged,renewNativeObservation} from './ui/genie-pending.js';
test('pending input labels preserve delivery uncertainty and stale queue evidence',()=>{
 const options={now:20000,observedAt:new Date(19000).toISOString()};
 assert.match(pendingInputPresentation({state:'accepted_unverified'},options).detail,/execution is not confirmed/);
 assert.equal(pendingInputPresentation({state:'held'},options).label,'Saved · paused');
 assert.match(pendingInputPresentation({state:'uncertain'},options).detail,/Do not resend/);
 assert.match(pendingInputPresentation({state:'queued'},{...options,now:40000}).label,/Last observed/);
 assert.match(pendingInputPresentation({state:'queued'},{...options,connected:false}).detail,/unavailable/);
});


test('idle pending changes refresh the view; unchanged native evidence renews only its observed time',()=>{
 const cached={native_observation_revision:'prior',observed_at:'old',pending_inputs:[{text:'retained'}]};
 const fresh={native_observation_revision:'prior',observation_available:true,observed_at:'new'};
 assert.equal(nativeObservationChanged(fresh,cached),false);
 assert.deepEqual(renewNativeObservation(fresh,cached),{...cached,observed_at:'new'});assert.equal(cached.observed_at,'old');
 assert.equal(nativeObservationChanged({...fresh,native_observation_revision:'changed'},cached),true);
 assert.equal(nativeObservationChanged({...fresh,observation_available:false},cached),true);
 assert.equal(renewNativeObservation({...fresh,observation_available:false},cached),cached);
 assert.equal(renewNativeObservation({},cached),cached,'Legacy rendering is unaffected');
});
