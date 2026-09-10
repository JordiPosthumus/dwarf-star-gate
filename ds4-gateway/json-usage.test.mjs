import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JsonUsageObserver} from './json-usage.mjs';
import {evidence} from './dataset.mjs';
test('JSON usage observes whole-response counts without exposing text or inventing TTFT',()=>{
  const observer=new JsonUsageObserver('/v1/chat/completions');
  const b=Buffer.from(JSON.stringify({choices:[{finish_reason:'tool_calls',message:{reasoning_content:'PRIVATE_THINK',content:'星',tool_calls:[{function:{arguments:'{}'}}]}}],usage:{prompt_tokens:100,completion_tokens:14,prompt_tokens_details:{cached_tokens:80}}}));
  for(let i=0;i<b.length;i+=3)observer.accept(b.subarray(i,i+3));
  const s=observer.finish();assert.equal(s.status,'observed');assert.equal(s.usage.cached_tokens,80);assert.equal(s.finish_reason,'tool_calls');assert.equal(s.generation.answer_characters,1);assert.equal(s.generation.first_semantic_ms,null);assert.equal(s.generation.tool_characters,2);assert.equal(s.generation.thinking_characters,13);
  assert.ok(!JSON.stringify(s).includes('PRIVATE_THINK'));assert.equal(observer.parts.length,0);assert.deepEqual(observer.finish(),s);
});
test('JSON observation bounds, bad numbers and unsupported formats remain explicit unknowns',()=>{
  const get=(route,body,options)=>{const o=new JsonUsageObserver(route,options);o.accept(Buffer.from(body));return o.finish();};
  assert.equal(get('/v1/chat/completions','x'.repeat(20),{maxBytes:10}).status,'json_capture_limit');
  assert.equal(get('/v1/chat/completions','{').status,'invalid_json');
  assert.equal(get('/v1/messages','{}').status,'unsupported_route');
  assert.equal(get('/v1/chat/completions','{"error":{"message":"private"}}').status,'not_reported');
  const partial=get('/v1/completions',JSON.stringify({choices:[{text:'ok',finish_reason:'stop'}],usage:{prompt_tokens:0,completion_tokens:'secret',prompt_tokens_details:{cached_tokens:-1}}}));
  assert.equal(partial.status,'partial');assert.equal(partial.usage.prompt_tokens,0);assert.equal(partial.usage.completion_tokens,null);assert.equal(partial.usage.cached_tokens,null);assert.equal(partial.generation.answer_characters,2);
  const multi=get('/v1/chat/completions',JSON.stringify({choices:[{finish_reason:'stop'},{finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:2}}));assert.equal(multi.finish_reason,null);assert.equal(multi.generation,null);
});
test('collector provenance is strictly allowlisted and does not save headers or response text',()=>{
  const e=evidence('finish',{request_id:'req',node:'worker',route:'/private-secret',response_format:'private',http_status:200,usage_observation:'private',request_stream:'private',requested_usage:true,raw_body:'private'});
  assert.equal(e.route,null);assert.equal(e.response_format,null);assert.equal(e.http_status,200);assert.equal(e.usage_observation,null);assert.equal(e.request_stream,null);assert.equal(e.requested_usage,true);assert.ok(!JSON.stringify(e).includes('private'));
});

import {UsageObserver} from './gateway.mjs';
import {GenerationEvidence} from './generation-evidence.mjs';
test('JSON and SSE output warnings recognize refusals, tools, alternate reasoning and unknown shapes',()=>{
  const cases=[
    [{refusal:'PRIVATE_REFUSAL'},false,15],
    [{content:[{type:'text',text:'PRIVATE_ANSWER'}]},false,14],
    [{tool_calls:[{function:{name:'clock',arguments:''}}]},false,0],
    [{function_call:{name:'clock',arguments:''}},false,0],
    [{content:[{type:'image_url',image_url:{url:'PRIVATE'}}]},false,0],
    [{reasoning_text:'PRIVATE_THOUGHT'},true,0],
    [{content:null},true,0],
  ];
  for(const [message,warns,answers] of cases)for(const format of ['json','sse']){
    let generation;
    if(format==='json'){
      const o=new JsonUsageObserver('/v1/chat/completions');o.accept(Buffer.from(JSON.stringify({choices:[{message,finish_reason:'stop'}]})));generation=o.finish().generation;
    }else{
      const o=new UsageObserver();
      o.accept(Buffer.from(`data: ${JSON.stringify({choices:[{index:0,delta:message,finish_reason:null}]})}\n\ndata: ${JSON.stringify({choices:[{index:0,delta:{},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`));
      o.finishState();generation={thinking_characters:o.thinkingCharacters,answer_characters:o.answerCharacters,tool_characters:o.toolCharacters,output_present:o.outputPresent,observation_complete:o.shapeComplete&&!o.limited&&!o.reasonEofAmbiguous&&o.singleChoiceFinish};
    }
    assert.equal(generation.answer_characters,answers);
    const row=evidence('finish',{run_id:'run',request_id:'req',node:'spark',outcome:'complete',route:'/v1/chat/completions',finish_reason:'stop',generation});
    const h=new GenerationEvidence(),now=Date.now();h.accept({...row,schema:1,run_id:'run',time:new Date(now).toISOString()});
    assert.equal(h.snapshot(now).rows.length,warns?1:0,`${format}: ${JSON.stringify(message)}`);
    assert.ok(!JSON.stringify(row).includes('PRIVATE'));
  }
});
test('old output counts without completeness evidence cannot establish an empty response',()=>{
 const h=new GenerationEvidence(),now=Date.now();h.accept({schema:1,kind:'finish',run_id:'run',request_id:'req',node:'spark',outcome:'complete',route:'/v1/chat/completions',finish_reason:'stop',time:new Date(now).toISOString(),generation:{thinking_characters:0,answer_characters:0,tool_characters:0}});assert.equal(h.snapshot(now).rows.length,0);
});
