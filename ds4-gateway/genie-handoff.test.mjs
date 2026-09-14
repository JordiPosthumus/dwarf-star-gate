import test from 'node:test';
import assert from 'node:assert/strict';
import {genieHandoff} from './ui/genie-handoff.js';
const conversation='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',reply='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
test('handoff retains diagnostic references without copying private chat, draft, config or error bodies',()=>{
  const output=genieHandoff({connected:true,observedAt:1000,now:2000,
    status:{available:true,model:'example-model',csrf_token:'PRIVATE_TOKEN',url:'PRIVATE_ENDPOINT',memory:'PRIVATE_NOTE'},
    session:{id:conversation,title:'PRIVATE_TITLE',messages:[{role:'user',text:'PRIVATE_QUESTION'},{id:reply,role:'assistant',state:'failed',text:'PRIVATE_ANSWER',error:'PRIVATE_ERROR',context:{secret:'PRIVATE_CONTEXT'},finished_at:1500}]},draft:'PRIVATE_DRAFT'});
  assert.match(output,new RegExp(conversation));assert.match(output,new RegExp(reply));assert.match(output,/Last assistant state: failed/);assert.match(output,/example-model/);assert.match(output,/1970-01-01T00:00:01.000Z/);
  assert.doesNotMatch(output,/PRIVATE_/);assert.match(output,/nothing has been sent/);
});
test('disconnection and unacknowledged submission remain uncertain, never instructions to replay or restart',()=>{
  const output=genieHandoff({status:{available:true},session:{id:conversation,messages:[{role:'assistant',id:reply,state:'working',waiting_for_review:'action'}]},connected:false,pendingRequest:true,observedAt:1000,now:2000});
  assert.match(output,/cached observations may be stale/);assert.match(output,/no confirmed acknowledgement/);assert.match(output,/Waiting for fleet review: action/);assert.match(output,/does not prove the model stopped/);assert.match(output,/Do not replay an ambiguous request/);
  const unknown=genieHandoff({status:{model:'PRIVATE\nINJECTION'},session:{id:'PRIVATE_ID',messages:[{role:'assistant',state:'PRIVATE_STATE',finished_at:Infinity}]},now:NaN});
  assert.doesNotMatch(unknown,/PRIVATE/);assert.match(unknown,/Last assistant state: unknown/);assert.match(unknown,/Handoff captured: unknown/);
});
