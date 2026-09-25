import { randomUUID } from 'node:crypto';
import {endpointHeaders,endpointUrl} from './endpoint.mjs';

// Synthetic checks have independent small budgets; model-server settings and
// ordinary inference budgets are never rewritten. Test both resident sessions.
export async function verifyRecovery(url,model,context,{fetchImpl=fetch,signal,kind='ds4',endpoint,onSample=()=>{}}={}) {
  if(!['ds4','qwen_vllm','qwen_omlx','glm53_vllm'].includes(kind))throw new Error('verification_kind_unsupported');
  if(endpoint&&endpoint.url!==url)throw new Error('verification_endpoint_changed');
  const worker=endpoint??{url},servedModel=worker.model_aliases?.[model]??model;
  const qwen=['qwen_vllm','qwen_omlx'].includes(kind),glm=kind==='glm53_vllm',hybrid=qwen||glm;
  async function request(route,body) {
    const r=await fetchImpl(endpointUrl(worker,route),{redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(180000)]):AbortSignal.timeout(180000),
      headers:{...endpointHeaders(worker),...(body?{'content-type':'application/json','x-dsg-observer':'recovery-check'}:{})},
      ...(body?{method:'POST',body:JSON.stringify(body)}:{})});
    let text='';for await(const chunk of r.body){text+=Buffer.from(chunk).toString();if(text.length>65536)throw new Error('verification_response_limit');}
    if(!r.ok)throw new Error('verification_http_failure');return JSON.parse(text);
  }
  const models=await request('/v1/models');
  if(models.data?.find(m=>m.id===servedModel)?.[hybrid?'max_model_len':'context_length']!==context)throw new Error('verification_context_changed');
  const nonce=randomUUID(),samples=[],conversations=[];
  async function call(messages,expected,label) {
    // GLM keeps its enrolled template/thinking defaults. The synthetic response
    // budget never changes the production output setting or server capacity.
    const parameters=qwen?{max_tokens:context,temperature:1,top_p:.95,top_k:20,min_p:0,presence_penalty:0,repetition_penalty:1,chat_template_kwargs:{enable_thinking:true,preserve_thinking:true,reasoning_effort:'xhigh'}}:glm?{max_tokens:4096,temperature:0}:{max_tokens:32,temperature:0,thinking:{type:'disabled'},reasoning_effort:'none'};
    const start=performance.now(),r=await request('/v1/chat/completions',{model:servedModel,stream:false,...parameters,messages});
    const choice=r.choices?.[0],prompt=r.usage?.prompt_tokens,cached=r.usage?.prompt_tokens_details?.cached_tokens;
    const answer=choice?.message?.content;
    if(choice?.finish_reason!=='stop' || (hybrid?!answer?.includes(expected):answer?.trim()!==expected) || !Number.isSafeInteger(prompt) || !Number.isSafeInteger(cached) || cached<0 || cached>prompt)throw new Error('verification_generation_or_usage_failed');
    const sample={label,prompt_tokens:prompt,cached_tokens:cached,elapsed_ms:Math.round(performance.now()-start)};samples.push(sample);onSample(sample);return {sample,message:choice.message};
  }
  for(const id of ['A','B']) {
    const messages=[{role:'user',content:`${nonce}-${id}. Isolated synthetic recovery verification.\n`+
      Array.from({length:glm?1536:qwen?500:180},(_,i)=>`Record ${i}: local inference cache verification keeps configuration unchanged.`).join('\n')+`\nReply with exactly CHECK_${id}_OK and nothing else.`}];
    const {sample:cold,message}=await call(messages,`CHECK_${id}_OK`,`cold-${id}`);
    if(cold.prompt_tokens<(glm?16384:2000) || cold.cached_tokens>(hybrid?0:64))throw new Error('verification_cold_start_not_proven');
    conversations.push({id,messages,cold,message});
  }
  for(const {id,messages,cold,message} of conversations) {
    const {sample:warm}=await call([...messages,hybrid?message:{role:'assistant',content:`CHECK_${id}_OK`},{role:'user',content:`Now reply exactly WARM_${id}_OK.`}],`WARM_${id}_OK`,`warm-${id}`);
    if(warm.cached_tokens<(glm?4096:2000) || (hybrid?warm.prompt_tokens<cold.prompt_tokens:warm.cached_tokens<cold.prompt_tokens-64) || (glm&&warm.cached_tokens<cold.prompt_tokens-8192))throw new Error('verification_warm_cache_not_proven');
  }
  return {check:hybrid?kind+'_two_conversations_cold_to_warm':'two_conversations_cold_to_warm',context_length:context,samples,verified_at:new Date().toISOString(),
    ...(glm?{scope:'Native model context metadata and two interleaved cold-to-warm histories with at most 8192 uncached prefix tokens. This does not exercise maximum context, output or concurrent-request boundaries.'}:{})};
}

// GLM's cache check uses a longer prefix and an explicit bounded uncached tail.
// Keep its receipts distinct from Qwen hybrid-cache and DS4 near-full reuse.
export function glmRecoveryProofValid(proof,context){
  return proof?.check==='glm53_vllm_two_conversations_cold_to_warm'&&proof.context_length===context&&Number.isFinite(Date.parse(proof.verified_at))&&
    Array.isArray(proof.samples)&&proof.samples.length===4&&proof.samples.every((s,i)=>s?.label===['cold-A','cold-B','warm-A','warm-B'][i]&&
      Number.isSafeInteger(s.prompt_tokens)&&s.prompt_tokens>=16384&&Number.isSafeInteger(s.cached_tokens)&&s.cached_tokens>=0&&s.cached_tokens<=s.prompt_tokens&&
      Number.isFinite(s.elapsed_ms)&&s.elapsed_ms>=0&&(i<2?s.cached_tokens===0:s.cached_tokens>=4096&&s.cached_tokens>=proof.samples[i-2].prompt_tokens-8192&&s.prompt_tokens>=proof.samples[i-2].prompt_tokens));
}

// Qwen's hybrid attention/Mamba cache can reuse a substantial prefix without
// claiming DS4's near-complete prefix retention. Keep the evidence distinct.
export function qwenRecoveryProofValid(proof,context,kind='qwen_vllm'){
  return ['qwen_vllm','qwen_omlx'].includes(kind)&&proof?.check===kind+'_two_conversations_cold_to_warm'&&proof.context_length===context&&Number.isFinite(Date.parse(proof.verified_at))&&
    Array.isArray(proof.samples)&&proof.samples.length===4&&proof.samples.every((s,i)=>s?.label===['cold-A','cold-B','warm-A','warm-B'][i]&&
      Number.isSafeInteger(s.prompt_tokens)&&s.prompt_tokens>=2000&&Number.isSafeInteger(s.cached_tokens)&&s.cached_tokens>=0&&s.cached_tokens<=s.prompt_tokens&&
      Number.isFinite(s.elapsed_ms)&&s.elapsed_ms>=0&&(i<2?s.cached_tokens===0:s.cached_tokens>=2000&&s.prompt_tokens>=proof.samples[i-2].prompt_tokens));
}
