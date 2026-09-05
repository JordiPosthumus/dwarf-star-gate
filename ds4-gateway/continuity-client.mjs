import {randomUUID} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import {CALL_ID_HEADER,DISPATCH_HEADER,validCallId} from './continuity.mjs';
import {CLIENT_WATCH_HEADER,CLIENT_WATCH_ROUTE,createClientWatchId} from './client-watch.mjs';
import {createPiClientMetadata} from './pi-client-metadata.mjs';
import {registerPiVisualContinuity} from './pi-visual-continuity.mjs';

const watchStates=new Set(['local_tool','waiting_for_model','idle','done','needs_attention']);
export function createClientWatchReporter({baseUrl,fetchImpl=fetch,intervalMs=15_000,schedule=setInterval,unschedule=clearInterval}={}){
  const base=new URL(baseUrl),endpoint=new URL(CLIENT_WATCH_ROUTE,base.origin),routes=new Set(['/v1/chat/completions','/v1/completions','/v1/messages','/v1/responses']);
  if(!['http:','https:'].includes(base.protocol)||base.username||base.password||base.search||base.hash||!['/v1','/v1/'].includes(base.pathname)||!Number.isSafeInteger(intervalMs)||intervalMs<1000||intervalMs>300_000)throw new Error('Invalid Agent Watch endpoint or interval');
  let id=createClientWatchId(),state='idle',processAlive=true,sequence=0,authorization=null,timer=null,closed=false,pending=null;
  const cancelPending=()=>{pending?.abort();pending=null;};
  const transmit=async()=>{
    if(!authorization||pending)return false;
    const controller=new AbortController();pending=controller;
    const body=JSON.stringify({schema:1,watch_id:id,client:'pi',state,sequence:sequence++,process_alive:processAlive});
    try{
      // Disposable telemetry must never accumulate behind a held Continuity Door.
      // This deadline belongs only to heartbeats, never inference or Genie calls.
      const response=await fetchImpl(endpoint,{method:'POST',redirect:'manual',headers:{authorization,'content-type':'application/json'},body,signal:AbortSignal.any([controller.signal,AbortSignal.timeout(15_000)])});
      // Unsuccessful/redirected heartbeats are disposable too: do not leave an
      // unread response holding transport resources until garbage collection.
      await response.body?.cancel();
      if(!response.ok)throw new Error(`Agent Watch heartbeat rejected (${response.status})`);
      return true;
    }finally{if(pending===controller)pending=null;}
  };
  const safely=()=>{void transmit().catch(()=>{});};
  return {
    get id(){return id;},get state(){return state;},
    start(){
      if(timer)unschedule(timer);cancelPending();closed=false;id=createClientWatchId();state='idle';processAlive=true;sequence=0;authorization=null;
      timer=schedule(safely,intervalMs);timer?.unref?.();return id;
    },
    update(next,{alive=true}={}){if(closed||!watchStates.has(next)||typeof alive!=='boolean')return false;state=next;processAlive=alive;safely();return true;},
    decorate(input,init={}){
      let url;try{url=new URL(input instanceof Request?input.url:input);}catch{return init;}
      if(closed||input instanceof Request||url.origin!==base.origin||!routes.has(url.pathname)||url.search||url.hash||init.method?.toUpperCase()!=='POST'||typeof init.body!=='string')return init;
      const headers=new Headers(init.headers),credential=headers.get('authorization');
      if(credential){authorization=credential;headers.set(CLIENT_WATCH_HEADER,id);safely();return {...init,headers};}
      return init;
    },
    async stop(){
      if(closed)return false;if(timer){unschedule(timer);timer=null;}state='done';processAlive=false;closed=true;
      cancelPending();
      const completion=transmit();authorization=null;
      try{return await completion;}catch{return false;}
    }
  };
}

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
    // Caller-owned URL/RequestInit objects can change while a certified wait is
    // pending. Pin the destination and immutable text/options once, otherwise a
    // retry could send changed content or credentials to a different origin.
    // Fetch follows redirects before returning a response: 307/308 can replay
    // this POST without any dispatch certificate, including to another origin.
    // Surface redirects unchanged; preserve explicit error/manual modes and
    // native validation of invalid values. Never extend this to other providers.
    const redirect=init.redirect===undefined||init.redirect==='follow'?'manual':init.redirect;
    const requestUrl=url.href,requestInit={...init,headers,redirect};
    let attempts=0;
    try{
      while(true){
        requestInit.signal?.throwIfAborted();
        // Connection failures remain ambiguous: no catch-and-replay here.
        const response=await fetchImpl(requestUrl,{...requestInit,headers:new Headers(headers)});
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
        await wait(Math.min(30000,5000*Math.min(attempts,6)),requestInit.signal);
      }
    }finally{if(attempts)notify({state:'finished_waiting',attempts,call_id:callId});}
  };
}

// The Pi adapter changes the transport for one explicitly named provider only.
// All model capabilities, provider auth, context, reasoning and output options
// are supplied unchanged to Pi's own OpenAI serializer/stream consumer.
export function registerPiContinuity(pi,{provider,baseUrl,streamSimple,agentWatch=false,watchFetchImpl=fetch,watchIntervalMs=15_000,clientMetadata=false,visualContinuity=false}){
  if(typeof provider!=='string'||!provider.trim()||typeof streamSimple!=='function')throw new Error('Explicit DSG provider and compatible Pi stream adapter required');
  if(typeof agentWatch!=='boolean')throw new Error('agentWatch must be boolean');
  if(typeof clientMetadata!=='boolean')throw new Error('clientMetadata must be boolean');
  if(typeof visualContinuity!=='boolean')throw new Error('visualContinuity must be boolean');
  const visual=visualContinuity?registerPiVisualContinuity(pi,{provider,baseUrl}):null;
  const metadata=clientMetadata?createPiClientMetadata({provider,baseUrl}):null;
  let ui=null,watchAttempted=false,terminalFailed=false;const watch=agentWatch?createClientWatchReporter({baseUrl,fetchImpl:watchFetchImpl,intervalMs:watchIntervalMs}):null;
  const status=info=>ui?.setStatus('dsg-continuity',info.state==='waiting'?`DSG waiting: ${info.reason} · attempt ${info.attempts} · Esc to cancel`:undefined);
  pi.on('session_start',(event,ctx)=>{ui=ctx.ui;watchAttempted=false;terminalFailed=false;watch?.start();metadata?.start(event,ctx);});
  pi.on('session_shutdown',()=>{ui=null;void watch?.stop();metadata?.stop();});
  if(metadata){pi.on('session_tree',()=>{metadata.invalidate();});pi.on('model_select',()=>{metadata.invalidate();});}
  if(watch){
    pi.on('agent_start',()=>{watchAttempted=false;terminalFailed=false;watch.update('waiting_for_model');});
    // Pi treats a non-undefined before_provider_request result as the entire
    // replacement JSON payload. Advisory hooks must never return update's bool.
    pi.on('before_provider_request',()=>{watch.update('waiting_for_model');});
    pi.on('tool_execution_start',()=>{watch.update('local_tool');});
    pi.on('tool_execution_end',()=>{watch.update('waiting_for_model');});
    // Read only terminal metadata, never content/error strings. Pi can retry or
    // compact after message_end/agent_end: only agent_settled certifies that no
    // automatic continuation remains. This is client evidence, not replay proof.
    pi.on('message_end',event=>{
      const message=event?.message;
      if(message?.role==='assistant')terminalFailed=watchAttempted&&message.provider===provider&&message.api==='openai-completions'&&message.stopReason==='error';
    });
    pi.on('agent_settled',()=>{watch.update(terminalFailed?'needs_attention':'idle');});
  }
  // Do not provide a models list: Pi must preserve models.json capabilities.
  pi.registerProvider(provider,{api:'openai-completions',streamSimple:(model,context,options={})=>{
    if(model.api!=='openai-completions'||new URL(model.baseUrl).href.replace(/\/$/,'')!==new URL(baseUrl).href.replace(/\/$/,''))throw new Error('DSG continuity provider API/URL mismatch; no request sent');
    if(watch)watchAttempted=true;
    const continuity=createContinuityFetch({baseUrl,fetchImpl:options.fetch??fetch,onWait:status});
    const hints=metadata?.snapshot(model,options);
    return streamSimple(model,visual?visual.prepare(model,context):context,{...options,fetch:watch||metadata?(input,init={})=>{
      const decorated=metadata?metadata.decorate(input,init,hints):init;
      return continuity(input,watch?watch.decorate(input,decorated):decorated);
    }:continuity});
  }});
  return {agentWatch:watch,visualContinuity:visual};
}
