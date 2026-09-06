import test from 'node:test';
import assert from 'node:assert/strict';
import {piResumeReviewInput,ProactiveResumePi} from './proactive-resume-pi.mjs';

const ticket={scopeId:'scope',id:'ticket'};
const user={role:'user',content:'Complete the synthetic task.'};
const assistant={role:'assistant',content:[{type:'text',text:'Shall I keep going?'}]};

test('native context conversion preserves task text and typed tool evidence',()=>{
  const input=piResumeReviewInput([user,
    {role:'assistant',content:[{type:'thinking',thinking:'Private reasoning excluded from review consent'},{type:'toolCall',name:'step',arguments:{phase:1}}]},
    {role:'toolResult',toolName:'step',isError:false,content:[{type:'text',text:'Step one finished'}]},assistant
  ],0,ticket);
  assert.equal(input.task_message_id,'m0');
  assert.deepEqual(input.messages.map(m=>m.role),['user','assistant','tool','assistant']);
  assert.deepEqual(JSON.parse(input.messages[1].text),{tool:'step',arguments:{phase:1}});
  assert.deepEqual(JSON.parse(input.messages[2].text),{tool:'step',result:'Step one finished',isError:false});
  assert.equal(JSON.stringify(input).includes('Private reasoning'),false);
});
test('custom context remains attributed data and never becomes a user task',()=>{
  const input=piResumeReviewInput([user,{role:'custom',customType:'other-extension',content:'Context only'},assistant],0,ticket);
  assert.equal(input.messages[1].role,'tool');
  assert.deepEqual(JSON.parse(input.messages[1].text),{customType:'other-extension',content:'Context only'});
  assert.throws(()=>piResumeReviewInput([user,{role:'custom',customType:'other-extension',content:'Context only'},assistant],1,ticket));
});
test('unsupported or oversized native context is rejected without silently dropping evidence',()=>{
  for(const messages of [
    [{...user,content:[{type:'image',data:'synthetic'}]},assistant],
    [user,{role:'compactionSummary',content:'summary'},assistant],
    [{...user,content:'x'.repeat(32769)},assistant],
    [user,...Array.from({length:24},()=>assistant)]
  ])assert.throws(()=>piResumeReviewInput(messages,0,ticket));
});

test('empty native errors remain typed metadata in outage and later progress context',()=>{
  const failed={role:'assistant',stopReason:'error',content:[],errorMessage:'PRIVATE_TRANSPORT_DIAGNOSTIC'};
  const outage=piResumeReviewInput([user,failed],0,{...ticket,trigger:'undispatched_outage'});
  assert.equal(outage.trigger,'undispatched_outage');
  assert.deepEqual(JSON.parse(outage.messages[1].text),{native_response:{stop_reason:'error',content:[]}});
  const later=piResumeReviewInput([user,failed,assistant],0,ticket);
  assert.equal(later.trigger,undefined);assert.equal(JSON.stringify(later).includes('PRIVATE_'),false);
});

test('opting out stops restoration polling without any inference',async()=>{
  let checks=0,reviews=0;
  const session={sessionId:'session',messages:[user,{role:'assistant',stopReason:'error',content:[]}],subscribe:()=>()=>{}};
  const bridge=new ProactiveResumePi({session,taskMessage:user,scopeId:'scope',control:{inspect:()=>({ticket:{...ticket,trigger:'undispatched_outage'}}),revoke:()=>{}},reviewer:{review:async()=>{reviews++;throw new Error('No review expected');}},outageReady:async()=>{checks++;return false;},consent:{reviewText:true,reviewOutage:true,providers:[{url:'http://127.0.0.1:19999/v1',model:'fixture'}]}});
  try{
    assert.equal((await bridge.start()).reason,'gateway_not_restored');
    bridge.close();await new Promise(resolve=>setTimeout(resolve,1100));
    assert.equal(checks,1);assert.equal(reviews,0);
  }finally{bridge.close();}
});
