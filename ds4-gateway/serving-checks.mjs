// Explicit diagnostic inference only. This module never changes serving settings,
// clears caches, drains workers, or claims a configured limit was exercised.
import {randomUUID} from 'node:crypto';
import {endpointHeaders} from './endpoint.mjs';
import {mediaPair} from './media-pair.mjs';
import {verifyRecovery} from './recovery-verify.mjs';

export async function runServingCheck({worker,check,config,registry,readDoor,fetchImpl=fetch,now=Date.now,onSample=()=>{}}){
  if(!['gateway','cache','tools','glm-cache'].includes(check))throw Error('Unknown serving check');
  const model=worker.served_model;
  if(!worker.url||!model)throw Error('Current worker endpoint and served model are required');
  if(check==='glm-cache'){
    const pair=mediaPair(config,worker);
    if(!pair||pair.model!==model||!Number.isSafeInteger(worker.context_length)||worker.context_length<=0)throw Error('GLM recovery-cache verification requires the exact configured pair, served model and current context.');
    const proof=await verifyRecovery(worker.url,model,worker.context_length,{kind:'glm53_vllm',endpoint:worker,fetchImpl,onSample});
    return {state:'passed',check,worker:worker.id,samples:proof.samples,proof,scope:proof.scope+' No recovery enrollment, container transition, cache reset or routing change was performed.'};
  }
  const nonce=randomUUID(),samples=[];
  const base=worker.url.replace(/\/+$/,'').replace(/\/v1$/,'');
  const nativeHeaders=endpointHeaders(worker);
  const request=async(label,messages,{gateway=false,...extra}={})=>{
    const start=now();
    const headers=gateway?{authorization:`Bearer ${config.api_key}`,'x-dsg-model':model,'x-session-affinity':`genie-check-${nonce}`,'x-dsg-priority':'idle-only'}:nativeHeaders;
    const response=await fetchImpl(`${gateway?`http://127.0.0.1:${config.port}`:base}/v1/chat/completions`,{
      method:'POST',headers:{...headers,'content-type':'application/json','x-dsg-observer':'serving-check'},redirect:'error',
      body:JSON.stringify({model:gateway?'PoolModel':model,messages,max_tokens:4096,stream:false,...extra}),signal:AbortSignal.timeout(600000)});
    if(!response.ok){await response.body?.cancel();throw Error(`${label}: generation HTTP ${response.status}`);}
    const result=await response.json(),choice=result.choices?.[0];
    const usage=result.usage??{},cached=usage.prompt_tokens_details?.cached_tokens;
    const sample={label,elapsed_ms:now()-start,worker:response.headers.get('x-ds4-node'),model:result.model??null,
      finish_reason:choice?.finish_reason??null,prompt_tokens:usage.prompt_tokens??null,completion_tokens:usage.completion_tokens??null,
      cached_tokens:Number.isSafeInteger(cached)?cached:null,
      // Requests in this module contain synthetic data only. Preserve the
      // returned answer so a content failure is diagnosable, not guessed at.
      answer:typeof choice?.message?.content==='string'?choice.message.content.slice(0,2000):null};
    samples.push(sample);onSample(sample);
    if(!choice?.message)throw Error(`${label}: no assistant message`);
    return {message:choice.message,sample};
  };
  const requireAnswer=(value,marker)=>{if(value.sample.finish_reason!=='stop'||!(value.message.content??'').includes(marker))throw Error(`${value.sample.label}: expected synthetic answer was not returned completely`);};
  if(check==='gateway'){
    const route=registry.model_routes?.[model];
    if(!Array.isArray(route)||route.length!==1||route[0]!==worker.id)throw Error('An existing exclusive model route is required to prove this exact worker through the Door');
    if(worker.drained||!worker.is_healthy)throw Error('Worker must already be healthy and admitted for its Door check');
    if(!readDoor)throw Error('Door observation is unavailable');
    const before=await readDoor();
    if(before.holding!==false||before.core_ready!==true)throw Error('Door is holding or not ready; leave queued work untouched');
    const result=await request('door-canary',[{role:'user',content:`Verification ${nonce}. Reply with exactly CANARY_7319.`}],{gateway:true});
    requireAnswer(result,'CANARY_7319');
    if(result.sample.worker!==worker.id)throw Error('Door response did not identify the requested worker');
    const after=await readDoor();
    if(after.holding!==false||after.core_ready!==true)throw Error('Door readiness changed during verification');
    return {state:'passed',check,worker:worker.id,samples,door:{holding:after.holding,core_ready:after.core_ready,held:after.held},scope:'One real generation through the Door with the expected worker response header. No context/output boundary or cache claim.'};
  }
  if(check==='cache'){
    const histories=[];
    for(const key of ['A','B']){
      const messages=[{role:'user',content:`${nonce}-${key}\n`+Array.from({length:500},(_,i)=>`Record ${i}: this synthetic serving check preserves the existing cache configuration.`).join('\n')+`\nReply with exactly COLD_${key}_7319.`}];
      const result=await request(`cold-${key}`,messages);requireAnswer(result,`COLD_${key}_7319`);
      if(!(result.sample.prompt_tokens>=2000)||result.sample.cached_tokens!==0)throw Error(`cold-${key}: a fresh uncached prefix was not demonstrated`);
      histories.push({key,messages:[...messages,result.message],prompt:result.sample.prompt_tokens});
    }
    for(const {key,messages,prompt}of histories){
      const result=await request(`warm-${key}`,[...messages,{role:'user',content:`Now reply with exactly WARM_${key}_7319.`}]);requireAnswer(result,`WARM_${key}_7319`);
      if(!(result.sample.prompt_tokens>=prompt)||!(result.sample.cached_tokens>=2000))throw Error(`warm-${key}: substantial real prefix reuse was not demonstrated`);
    }
    return {state:'passed',check,worker:worker.id,samples,scope:'Two interleaved synthetic conversations, cold then warm, with native cached-token evidence. Shared serving conditions; latency is not an isolated benchmark. No cache reset, setting change or capacity-boundary test.'};
  }
  const tools=[{type:'function',function:{name:'report_value',description:'Report the supplied integer.',parameters:{type:'object',properties:{value:{type:'integer'}},required:['value'],additionalProperties:false}}}];
  const messages=[{role:'user',content:`Verification ${nonce}. Call report_value exactly once with value 7319.`}];
  const result=await request('tool-call',messages,{tools,tool_choice:'auto'}),calls=result.message.tool_calls??[];
  if(result.sample.finish_reason!=='tool_calls'||calls.length!==1||!calls[0].id||calls[0].function?.name!=='report_value'||JSON.stringify(JSON.parse(calls[0].function.arguments))!==JSON.stringify({value:7319}))throw Error('Native tool call did not preserve the requested function/argument boundary');
  const followup=await request('tool-followup',[...messages,result.message,{role:'tool',tool_call_id:calls[0].id,content:'{"value":7319}'},{role:'user',content:'Reply with the returned integer; make no further tool calls.'}],{tools,tool_choice:'auto'});
  requireAnswer(followup,'7319');
  return {state:'passed',check,worker:worker.id,samples,scope:'One native synthetic tool call and its real tool-result follow-up. No general quality, context-boundary or performance claim.'};
}
