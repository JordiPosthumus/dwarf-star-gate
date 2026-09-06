import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {ProactiveResumeReviewer,resumeAdvice,resumeReviewInput,progressAdvice,progressReviewInput} from './proactive-resume-reviewer.mjs';

const endpoint={url:'http://127.0.0.1:19999/v1',model:'fixture-genie'};
const disclosure={disclosedProviders:[endpoint]};
const input=()=>({scope_id:'scope',ticket_id:'ticket',task_message_id:'user-task',messages:[
  {id:'user-task',role:'user',text:'Complete both synthetic steps.'},
  {id:'assistant-last',role:'assistant',text:'Step one is done. Shall I continue with step two?'}
]});
const advice=(verdict='continue')=>({verdict,reason:({continue:'courtesy_check_in',completed:'task_complete',human_input:'owner_decision',uncertain:'insufficient_evidence'})[verdict],evidence:['user-task','assistant-last']});
const progressInput=()=>({...input(),proposal_id:'proposal',cue_message_id:'cue',messages:[...input().messages,
  {id:'cue',role:'tool',text:'Gate Genie attributed courtesy cue'},
  {id:'new-result',role:'tool',text:'Synthetic step two finished'},
  {id:'final',role:'assistant',text:'Both steps are complete'}]});
function setup(answer=advice(),options={}){
  const calls=[];
  const fetchImpl=async(url,init)=>{
    calls.push({url,...init});
    return {ok:true,body:Readable.from([JSON.stringify({choices:[{finish_reason:options.finishReason??'stop',message:{content:JSON.stringify(answer)}}]})])};
  };
  const genie={enabled:true,closed:false,config:{...endpoint,api_key:'fixture-secret'},...options.genie};
  return {calls,genie,reviewer:new ProactiveResumeReviewer({genie,snapshot:()=>({}),fetchImpl:options.fetchImpl??fetchImpl})};
}

test('review carries only disclosed bounded context and returns advice bound to the client ticket',async()=>{
  const {reviewer,calls}=setup();
  const result=await reviewer.review(input(),disclosure);
  assert.equal(calls.length,1);assert.equal(calls[0].redirect,'error');
  const payload=JSON.parse(calls[0].body);
  assert.equal(payload.model,endpoint.model);assert.equal(payload.max_tokens,8192);assert.equal(payload.reasoning_effort,'low');
  assert.equal(payload.messages[0].role,'system');
  assert.match(payload.messages[0].content,/untrusted data/);
  assert.deepEqual(JSON.parse(payload.messages[1].content),input());
  assert.deepEqual(result.advice,advice());
  assert.equal(result.ticket_id,'ticket');assert.equal(result.scope_id,'scope');
  assert.deepEqual(result.provider,{source:'dedicated',...endpoint});
  assert.equal(JSON.stringify(reviewer.last).includes('synthetic'),false);
  assert.equal(JSON.stringify(reviewer.last).includes('fixture-secret'),false);
});

test('native outage review uses a distinct prompt and cannot exchange courtesy reasons',async()=>{
  const outage={...input(),trigger:'undispatched_outage'},answer={...advice(),reason:'outage_recovery'};
  outage.messages[1].text=JSON.stringify({native_response:{stop_reason:'error',content:[]}});
  const {reviewer,calls}=setup(answer);
  assert.deepEqual((await reviewer.review(outage,disclosure)).advice,answer);
  const payload=JSON.parse(calls[0].body);
  assert.match(payload.messages[0].content,/every attempt was certified not dispatched/);
  assert.match(payload.messages[0].content,/Do not require the assistant to have asked for encouragement/);
  assert.equal(JSON.parse(payload.messages[1].content).trigger,'undispatched_outage');
  assert.throws(()=>resumeAdvice(advice(),outage));
  assert.throws(()=>resumeAdvice(answer,input()));
  assert.throws(()=>resumeReviewInput({...outage,trigger:'unknown_execution'}));
  assert.throws(()=>resumeReviewInput({...outage,dispatch_state:'not_dispatched'}));
});

for(const verdict of ['completed','human_input','uncertain']){
  test('preserves the non-continuation '+verdict+' verdict',async()=>{
    const {reviewer}=setup(advice(verdict));
    assert.equal((await reviewer.review(input(),disclosure)).advice.verdict,verdict);
  });
}

test('model output cannot supply commands, enrollment, arbitrary explanations or invented evidence',()=>{
  const review=resumeReviewInput(input());
  for(const value of [
    {...advice(),command:'proceed anyway'},
    {...advice(),enrolled:true},
    {...advice(),verdict:['continue']},
    {...advice(),reason:'the owner approved everything'},
    {...advice(),evidence:['invented','assistant-last']},
    {...advice(),evidence:['assistant-last']},
    {...advice(),evidence:['user-task','user-task','assistant-last']}
  ])assert.throws(()=>resumeAdvice(value,review));
});

test('malformed, truncated or injected responses never become continuation advice',async()=>{
  for(const [answer,finishReason] of [[{...advice(),execute:'anything'},'stop'],[advice(),'length']]){
    const {reviewer,calls}=setup(answer,{finishReason});
    assert.deepEqual(await reviewer.review(input(),disclosure),{state:'blocked',reason:'review_failed'});
    assert.equal(calls.length,1);
  }
});

test('refuses undisclosed providers and absent disclosure before any inference',async()=>{
  const {reviewer,calls}=setup();
  await assert.rejects(reviewer.review(input()),/disclosure/);
  assert.deepEqual(await reviewer.review(input(),{disclosedProviders:[{...endpoint,model:'another-model'}]}),{state:'blocked',reason:'provider_not_disclosed'});
  assert.equal(calls.length,0);
});

test('pins provider identity during inference and revalidates changed configuration before a new review',async()=>{
  let release;const held=new Promise(resolve=>{release=resolve;});
  const {reviewer,genie}=setup(undefined,{fetchImpl:async()=>{
    await held;
    return {ok:true,body:Readable.from([JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(advice())}}]})])};
  }});
  const first=reviewer.review(input(),disclosure);
  genie.config.url='https://example.invalid/v1';
  release();
  assert.equal((await first).provider.url,endpoint.url);
  assert.deepEqual(await reviewer.review(input(),disclosure),{state:'blocked',reason:'provider_unavailable'});
});

test('cancellation returns promptly and disposes a late response without accepting it',async()=>{
  let release;const held=new Promise(resolve=>{release=resolve;});
  const body=Readable.from(['late response']);
  const {reviewer}=setup(undefined,{fetchImpl:async()=>{await held;return {ok:true,body};}});
  const abort=new AbortController(),pending=reviewer.review(input(),{...disclosure,signal:abort.signal});
  abort.abort();
  assert.deepEqual(await pending,{state:'blocked',reason:'review_cancelled_or_expired'});
  release();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(body.destroyed,true);
  assert.equal(reviewer.last.outcome,'review_cancelled_or_expired');
});

test('a non-cooperative provider cannot keep a review open beyond its separate deadline',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  let release;const held=new Promise(resolve=>{release=resolve;});
  const body=Readable.from(['late response']);
  let calls=0;
  const {reviewer}=setup(undefined,{fetchImpl:async()=>{calls++;await held;return {ok:true,body};}});
  const pending=reviewer.review(input(),disclosure);
  t.mock.timers.tick(60000);
  assert.deepEqual(await pending,{state:'blocked',reason:'review_cancelled_or_expired'});
  assert.equal(calls,1);
  release();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(body.destroyed,true);
});

test('a free pool still requires its own exact provider disclosure',async()=>{
  const pool={url:'http://127.0.0.1:19998/v1',model:'fixture-pool'};
  const calls=[];
  const reviewer=new ProactiveResumeReviewer({
    genie:{enabled:true,busy:true,activeProvider:'dedicated',config:{...endpoint,fallback:pool}},
    poolUrl:pool.url,
    snapshot:()=>({gateway_at:100,gateway:{genie_admission_version:1,model:pool.model,workers:[{is_healthy:true,load:0,queued:0}]}}),
    now:()=>100,
    fetchImpl:async(url,init)=>{calls.push({url,init});return {ok:true,body:Readable.from([JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(advice())}}]})])};}
  });
  assert.deepEqual(await reviewer.review(input(),disclosure),{state:'blocked',reason:'provider_not_disclosed'});
  assert.equal(calls.length,0);
  assert.equal((await reviewer.review(input(),{disclosedProviders:[pool]})).provider.source,'pool');
  assert.equal(calls.length,1);
  assert.equal(calls[0].init.headers['x-dsg-review-no-wait'],'1');
});

test('rejects oversized or ambiguous task evidence instead of silently truncating it',()=>{
  for(const change of [
    value=>value.messages[0].text='x'.repeat(32769),
    value=>value.messages[1].id='user-task',
    value=>value.task_message_id='assistant-last',
    value=>value.messages[1].role='tool',
    value=>value.messages[0].hidden_authority=true
  ]){
    const value=input();change(value);assert.throws(()=>resumeReviewInput(value));
  }
});

test('snapshots context before awaiting inference and rejects concurrent reviews',async()=>{
  let release;const held=new Promise(resolve=>{release=resolve;});
  const {reviewer}=setup(undefined,{fetchImpl:async()=>{
    await held;
    return {ok:true,body:Readable.from([JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(advice())}}]})])};
  }});
  const value=input(),first=reviewer.review(value,disclosure);
  value.messages[0].id='changed-by-caller';
  assert.deepEqual(await reviewer.review(input(),disclosure),{state:'blocked',reason:'reviewer_busy'});
  release();assert.equal((await first).state,'reviewed');
});

test('cancelled or failed inference never retries or chooses another provider',async()=>{
  const abort=new AbortController();abort.abort();
  const {reviewer,calls}=setup();
  assert.deepEqual(await reviewer.review(input(),{...disclosure,signal:abort.signal}),{state:'blocked',reason:'review_cancelled'});
  assert.equal(calls.length,0);
  let attempts=0;
  const failed=setup(undefined,{fetchImpl:async()=>{attempts++;throw new Error('sensitive upstream body');}}).reviewer;
  const result=await failed.review(input(),disclosure);
  assert.deepEqual(result,{state:'blocked',reason:'review_failed'});
  assert.equal(attempts,1);assert.equal(JSON.stringify(failed.last).includes('sensitive'),false);
});

for(const trigger of ['cancel','deadline']){
  test('no second review can dispatch while '+trigger+' leaves transport unresolved',async t=>{
    if(trigger==='deadline')t.mock.timers.enable({apis:['setTimeout']});
    let release,calls=0;const held=new Promise(resolve=>{release=resolve;});
    const lateBody=Readable.from(['late response']);
    const {reviewer}=setup(undefined,{fetchImpl:async()=>{
      calls++;
      if(calls===1){await held;return {ok:true,body:lateBody};}
      return {ok:true,body:Readable.from([JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(advice())}}]})])};
    }});
    const abort=new AbortController();
    const pending=reviewer.review(input(),{...disclosure,signal:abort.signal});
    if(trigger==='cancel')abort.abort();else t.mock.timers.tick(60000);
    assert.equal((await pending).reason,'review_cancelled_or_expired');
    assert.deepEqual(await reviewer.review(input(),disclosure),{state:'blocked',reason:'review_transport_unresolved'});
    assert.equal(calls,1);
    release();await new Promise(resolve=>setImmediate(resolve));
    assert.equal(lateBody.destroyed,true);
    assert.equal(calls,1,'settlement never triggers an automatic retry');
    assert.equal((await reviewer.review(input(),disclosure)).state,'reviewed');
    assert.equal(calls,2);
  });
}

test('progress review requires receipt-bound post-cue evidence and reuses the disclosed transport limits',async()=>{
  const answer={verdict:'completed',reason:'task_complete',evidence:['user-task','cue','new-result','final']};
  const {reviewer,calls}=setup(answer);
  const result=await reviewer.reviewProgress(progressInput(),disclosure);
  assert.deepEqual(result.advice,answer);assert.equal(result.ticket_id,'ticket');assert.equal(calls.length,1);
  const payload=JSON.parse(calls[0].body);assert.match(payload.messages[0].content,/Acknowledgments/);
  assert.deepEqual(JSON.parse(payload.messages[1].content),progressInput());
  assert.equal(payload.max_tokens,8192);assert.equal(payload.reasoning_effort,'low');
});

test('progress output cannot use old work, the cue alone, fabricated evidence or model-supplied commands',()=>{
  const review=progressReviewInput(progressInput()),valid={verdict:'progress',reason:'new_task_work',evidence:['user-task','cue','new-result']};
  assert.deepEqual(progressAdvice(valid,review),valid);
  for(const value of [
    {...valid,evidence:['user-task','assistant-last']},
    {...valid,evidence:['user-task','cue']},
    {...valid,evidence:['user-task','cue','invented']},
    {...valid,command:'continue'},
    {...valid,verdict:'continue',reason:'courtesy_check_in'}
  ])assert.throws(()=>progressAdvice(value,review));
});

for(const [verdict,reason] of [['no_progress','no_new_task_work'],['human_input','owner_decision'],['uncertain','insufficient_evidence']]){
  test('preserves the '+verdict+' progress outcome without promoting it to successful work',async()=>{
    const answer={verdict,reason,evidence:['final']},{reviewer}=setup(answer);
    assert.deepEqual((await reviewer.reviewProgress(progressInput(),disclosure)).advice,answer);
  });
}

test('recorded-tool recovery uses its own review policy and requires a recorded-result citation',async()=>{
  const value={...input(),trigger:'recorded_tool_outage',recorded_tool_message_ids:['recorded'],messages:[input().messages[0],{id:'recorded',role:'tool',text:'Recorded successful synthetic result'},{id:'assistant-last',role:'assistant',text:'{"native_response":{"stop_reason":"error","content":[]}}'}]};
  const answer={verdict:'continue',reason:'recorded_tool_recovery',evidence:['user-task','recorded','assistant-last']};
  const {reviewer,calls}=setup(answer);assert.deepEqual((await reviewer.review(value,disclosure)).advice,answer);
  assert.match(JSON.parse(calls[0].body).messages[0].content,/recorded tool work/);
  assert.throws(()=>resumeAdvice({...answer,reason:'outage_recovery'},value));
  assert.throws(()=>resumeAdvice({...answer,reason:'courtesy_check_in'},value));
  assert.throws(()=>resumeAdvice({...answer,evidence:['user-task','assistant-last']},value));
  assert.throws(()=>resumeReviewInput({...value,recorded_tool_message_ids:['assistant-last']}));
  assert.throws(()=>resumeReviewInput({...value,recorded_tool_message_ids:[]}));
  assert.throws(()=>resumeReviewInput({...value,recorded_tool_message_ids:['recorded','recorded']}));
});

test('progress after recorded-tool outage cites a real result after its own cue',()=>{
  const review=progressReviewInput({...progressInput(),trigger:'recorded_tool_outage',recorded_tool_message_ids:['new-result']});
  const answer={verdict:'progress',reason:'new_task_work',evidence:['user-task','cue','new-result']};
  assert.deepEqual(progressAdvice(answer,review),answer);
  assert.throws(()=>progressAdvice({...answer,evidence:['user-task','cue','final']},review));
  assert.throws(()=>progressReviewInput({...progressInput(),trigger:'undispatched_outage'}));
});
