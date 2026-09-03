import { randomUUID } from 'node:crypto';

// Synthetic checks have independent small budgets; model-server settings and
// ordinary inference budgets are never rewritten. Test both resident sessions.
export async function verifyRecovery(url,model,context,{fetchImpl=fetch,signal}={}) {
  async function request(route,body) {
    const r=await fetchImpl(new URL(route,url),{redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(180000)]):AbortSignal.timeout(180000),
      ...(body?{method:'POST',headers:{'content-type':'application/json','x-dsg-observer':'recovery-check'},body:JSON.stringify(body)}:{})});
    let text='';for await(const chunk of r.body){text+=Buffer.from(chunk).toString();if(text.length>65536)throw new Error('verification_response_limit');}
    if(!r.ok)throw new Error('verification_http_failure');return JSON.parse(text);
  }
  const models=await request('/v1/models');
  if(models.data?.find(m=>m.id===model)?.context_length!==context)throw new Error('verification_context_changed');
  const nonce=randomUUID(),samples=[],conversations=[];
  async function call(messages,expected,label) {
    const start=performance.now(),r=await request('/v1/chat/completions',{model,stream:false,max_tokens:32,temperature:0,thinking:{type:'disabled'},reasoning_effort:'none',messages});
    const choice=r.choices?.[0],prompt=r.usage?.prompt_tokens,cached=r.usage?.prompt_tokens_details?.cached_tokens;
    if(choice?.finish_reason!=='stop' || choice.message?.content?.trim()!==expected || !Number.isSafeInteger(prompt) || !Number.isSafeInteger(cached) || cached<0 || cached>prompt)throw new Error('verification_generation_or_usage_failed');
    const sample={label,prompt_tokens:prompt,cached_tokens:cached,elapsed_ms:Math.round(performance.now()-start)};samples.push(sample);return sample;
  }
  for(const id of ['A','B']) {
    const messages=[{role:'user',content:`${nonce}-${id}. Isolated synthetic recovery verification.\n`+
      Array.from({length:180},(_,i)=>`Record ${i}: local inference cache verification keeps configuration unchanged.`).join('\n')+`\nReply with exactly CHECK_${id}_OK and nothing else.`}];
    const cold=await call(messages,`CHECK_${id}_OK`,`cold-${id}`);
    if(cold.prompt_tokens<2000 || cold.cached_tokens>64)throw new Error('verification_cold_start_not_proven');
    conversations.push({id,messages,cold});
  }
  for(const {id,messages,cold} of conversations) {
    const warm=await call([...messages,{role:'assistant',content:`CHECK_${id}_OK`},{role:'user',content:`Now reply exactly WARM_${id}_OK.`}],`WARM_${id}_OK`,`warm-${id}`);
    if(warm.cached_tokens<2000 || warm.cached_tokens<cold.prompt_tokens-64)throw new Error('verification_warm_cache_not_proven');
  }
  return {check:'two_conversations_cold_to_warm',context_length:context,samples,verified_at:new Date().toISOString()};
}
