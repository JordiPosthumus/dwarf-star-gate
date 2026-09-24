import test from 'node:test';import assert from 'node:assert/strict';
import {runServingCheck} from './serving-checks.mjs';
const worker={id:'fixture-worker',url:'http://127.0.0.1:1234/v1',served_model:'fixture-model',is_healthy:true,drained:false};
function fixture({wrongNode=false,warmHit=true,toolError=false}={}){
 const requests=[];
 const fetchImpl=async(url,options)=>{
  const body=JSON.parse(options.body);requests.push({url,options,body});
  const last=body.messages.at(-1).content;
  let content=last.match(/(?:CANARY|COLD_[AB]|WARM_[AB])_7319/)?.[0]??'7319',finish='stop',message={role:'assistant',content};
  if(last.includes('Call report_value')){finish='tool_calls';message={role:'assistant',content:null,tool_calls:[{id:'fixture-call',type:'function',function:{name:'report_value',arguments:JSON.stringify({value:toolError?2:7319})}}]};}
  const warm=last.includes('WARM_');
  return Response.json({model:'fixture-model',choices:[{message,finish_reason:finish}],usage:{prompt_tokens:warm?8100:8000,completion_tokens:12,prompt_tokens_details:{cached_tokens:warm&&warmHit?7000:0}}},{headers:{'x-ds4-node':wrongNode?'wrong-worker':worker.id}});
 };
 const args={worker,config:{port:30000,api_key:'synthetic-key'},registry:{model_routes:{'fixture-model':[worker.id]}},readDoor:async()=>({holding:false,core_ready:true,held:0}),fetchImpl};
 return {requests,args};
}
test('Door proof requires real generation, exact route and worker header',async()=>{
 const f=fixture();const result=await runServingCheck({...f.args,check:'gateway'});assert.equal(result.state,'passed');assert.equal(f.requests.length,1);assert.equal(f.requests[0].options.method,'POST');assert.equal(f.requests[0].options.headers['x-dsg-model'],'fixture-model');assert.equal(f.requests[0].body.model,'PoolModel');
 await assert.rejects(runServingCheck({...fixture({wrongNode:true}).args,check:'gateway'}),/requested worker/);
 await assert.rejects(runServingCheck({...f.args,check:'gateway',worker:{...worker,drained:true}}),/already be healthy and admitted/);
 await assert.rejects(runServingCheck({...f.args,check:'gateway',registry:{model_routes:{'fixture-model':[worker.id,'other']}}}),/exclusive model route/);
 assert.equal(f.requests.length,1,'failed preflight never generates');
});
test('cache proof uses real cold/warm usage with interleaved histories and never resets cache',async()=>{
 const f=fixture(),r=await runServingCheck({...f.args,check:'cache'});assert.equal(r.state,'passed');assert.deepEqual(r.samples.map(s=>s.label),['cold-A','cold-B','warm-A','warm-B']);assert.deepEqual(r.samples.map(s=>s.cached_tokens),[0,0,7000,7000]);
 assert.equal(f.requests[2].body.messages[0].content,f.requests[0].body.messages[0].content);assert.equal(f.requests[3].body.messages[0].content,f.requests[1].body.messages[0].content);assert.equal(f.requests[2].body.messages[1].content,'COLD_A_7319');
 assert.ok(f.requests.every(r=>r.url.endsWith('/v1/chat/completions')));assert.ok(f.requests.every(r=>r.body.max_tokens===4096));
 await assert.rejects(runServingCheck({...fixture({warmHit:false}).args,check:'cache'}),/substantial real prefix reuse/);
});
test('tool proof checks the actual arguments and sends the actual tool call into follow-up',async()=>{
 const f=fixture(),r=await runServingCheck({...f.args,check:'tools'});assert.equal(r.state,'passed');assert.equal(f.requests[1].body.messages[2].tool_call_id,'fixture-call');
 await assert.rejects(runServingCheck({...fixture({toolError:true}).args,check:'tools'}),/function\/argument boundary/);
});
