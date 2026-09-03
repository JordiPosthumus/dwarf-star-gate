import {randomUUID} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import {CALL_ID_HEADER,DISPATCH_HEADER,validCallId} from './continuity.mjs';

// Opt-in transport, not a proxy/global fetch patch. A fresh Request/stream body
// cannot be replayed safely here; only caller-owned immutable JSON text is retried.
export function createContinuityFetch({baseUrl,fetchImpl=fetch,onWait=()=>{},wait=(ms,signal)=>sleep(ms,undefined,{signal})}){
  const base=new URL(baseUrl);
  if(!['http:','https:'].includes(base.protocol)||base.username||base.password||base.search||base.hash||!['/v1','/v1/'].includes(base.pathname))throw new Error('Specify the exact DSG /v1 URL');
  const routes=new Set(['/v1/chat/completions','/v1/completions','/v1/messages','/v1/responses']);
  const notify=info=>{try{onWait(info);}catch{}};
  return async function continuityFetch(input,init={}){
    const url=new URL(input instanceof Request?input.url:input);
    if(input instanceof Request||url.origin!==base.origin||!routes.has(url.pathname)||url.search||url.hash||init.method?.toUpperCase()!=='POST'||typeof init.body!=='string')return fetchImpl(input,init);
    const headers=new Headers(init.headers),callId=validCallId(headers.get(CALL_ID_HEADER))??randomUUID();
    headers.set(CALL_ID_HEADER,callId);
    let attempts=0;
    try{
      while(true){
        init.signal?.throwIfAborted();
        // Connection failures remain ambiguous: no catch-and-replay here.
        const response=await fetchImpl(input,{...init,headers});
        if(![429,503,504].includes(response.status)||response.headers.get(DISPATCH_HEADER)!=='not_dispatched')return response;
        // Consume only a bounded cloned error envelope; original response stays
        // available if this is not our exact positive retry certificate.
        const clone=response.clone(),reader=clone.body?.getReader();let body='',bytes=0;
        try{
          if(!reader)return response;
          const decoder=new TextDecoder();
          while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>8192)return response;body+=decoder.decode(part.value,{stream:true});}
          body+=decoder.decode();
          const error=JSON.parse(body).error,c=error?.continuity;
          if(error?.type!=='gateway_error'||c?.schema!==1||c.dispatch_state!=='not_dispatched'||c.retry_class!=='wait_then_retry'||c.call_id!==callId||!validCallId(c.request_id)||c.request_id!==response.headers.get('x-request-id')||!['draining','home_unavailable','no_healthy_workers','queue_full','queue_timeout'].includes(error.code))return response;
          ++attempts;notify({state:'waiting',attempts,call_id:callId,request_id:c.request_id,reason:c.reason,worker:c.node??null});
        }catch{return response;}finally{void reader?.cancel().catch(()=>{});reader?.releaseLock();}
        void response.body?.cancel().catch(()=>{});
        await wait(Math.min(30000,5000*Math.min(attempts,6)),init.signal);
      }
    }finally{if(attempts)notify({state:'finished_waiting',attempts,call_id:callId});}
  };
}

// The Pi adapter changes the transport for one explicitly named provider only.
// All model capabilities, provider auth, context, reasoning and output options
// are supplied unchanged to Pi's own OpenAI serializer/stream consumer.
export function registerPiContinuity(pi,{provider,baseUrl,streamSimple}){
  if(typeof provider!=='string'||!provider.trim()||typeof streamSimple!=='function')throw new Error('Explicit DSG provider and compatible Pi stream adapter required');
  let ui=null;
  const status=info=>ui?.setStatus('dsg-continuity',info.state==='waiting'?`DSG waiting: ${info.reason} · attempt ${info.attempts} · Esc to cancel`:undefined);
  pi.on('session_start',(_event,ctx)=>{ui=ctx.ui;});
  pi.on('session_shutdown',()=>{ui=null;});
  // Do not provide a models list: Pi must preserve models.json capabilities.
  pi.registerProvider(provider,{api:'openai-completions',streamSimple:(model,context,options={})=>{
    if(model.api!=='openai-completions'||new URL(model.baseUrl).href.replace(/\/$/,'')!==new URL(baseUrl).href.replace(/\/$/,''))throw new Error('DSG continuity provider API/URL mismatch; no request sent');
    return streamSimple(model,context,{...options,fetch:createContinuityFetch({baseUrl,fetchImpl:options.fetch??fetch,onWait:status})});
  }});
}
