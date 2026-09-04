import {randomUUID} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import {CALL_ID_HEADER,DISPATCH_HEADER,validCallId} from './continuity.mjs';
import {CLIENT_WATCH_HEADER,CLIENT_WATCH_ROUTE,createClientWatchId} from './client-watch.mjs';

const watchStates=new Set(['local_tool','waiting_for_model','idle','done']);
export function createClientWatchReporter({baseUrl,fetchImpl=fetch,intervalMs=15_000,schedule=setInterval,unschedule=clearInterval}={}){
  const base=new URL(baseUrl),endpoint=new URL(CLIENT_WATCH_ROUTE,base.origin),routes=new Set(['/v1/chat/completions','/v1/completions','/v1/messages','/v1/responses']);
  if(!['http:','https:'].includes(base.protocol)||base.username||base.password||base.search||base.hash||!['/v1','/v1/'].includes(base.pathname)||!Number.isSafeInteger(intervalMs)||intervalMs<1000||intervalMs>300_000)throw new Error('Invalid Agent Watch endpoint or interval');
  let id=createClientWatchId(),state='idle',processAlive=true,sequence=0,authorization=null,timer=null,closed=false;
  const transmit=async()=>{
    if(!authorization)return false;
    const body=JSON.stringify({schema:1,watch_id:id,client:'pi',state,sequence:sequence++,process_alive:processAlive});
    const response=await fetchImpl(endpoint,{method:'POST',headers:{authorization,'content-type':'application/json'},body});
    if(!response.ok)throw new Error(`Agent Watch heartbeat rejected (${response.status})`);
    await response.arrayBuffer();return true;
  };
  const safely=()=>{void transmit().catch(()=>{});};
  return {
    get id(){return id;},get state(){return state;},
    start(){
      if(timer)unschedule(timer);closed=false;id=createClientWatchId();state='idle';processAlive=true;sequence=0;authorization=null;
      timer=schedule(safely,intervalMs);timer?.unref?.();return id;
    },
    update(next,{alive=true}={}){if(closed||!watchStates.has(next)||typeof alive!=='boolean')return false;state=next;processAlive=alive;safely();return true;},
    decorate(input,init={}){
      let url;try{url=new URL(input instanceof Request?input.url:input);}catch{return init;}
      if(input instanceof Request||url.origin!==base.origin||!routes.has(url.pathname)||url.search||url.hash||init.method?.toUpperCase()!=='POST'||typeof init.body!=='string')return init;
      const headers=new Headers(init.headers),credential=headers.get('authorization');
      if(credential){authorization=credential;headers.set(CLIENT_WATCH_HEADER,id);safely();return {...init,headers};}
      return init;
    },
    async stop(){
      if(closed)return false;if(timer){unschedule(timer);timer=null;}state='done';processAlive=false;closed=true;
      const credential=authorization,payload=JSON.stringify({schema:1,watch_id:id,client:'pi',state,sequence:sequence++,process_alive:false});authorization=null;
      if(!credential)return false;
      try{const response=await fetchImpl(endpoint,{method:'POST',headers:{authorization:credential,'content-type':'application/json'},body:payload});if(!response.ok)return false;await response.arrayBuffer();return true;}catch{return false;}
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
export function registerPiContinuity(pi,{provider,baseUrl,streamSimple,agentWatch=false,watchFetchImpl=fetch,watchIntervalMs=15_000}){
  if(typeof provider!=='string'||!provider.trim()||typeof streamSimple!=='function')throw new Error('Explicit DSG provider and compatible Pi stream adapter required');
  if(typeof agentWatch!=='boolean')throw new Error('agentWatch must be boolean');
  let ui=null;const watch=agentWatch?createClientWatchReporter({baseUrl,fetchImpl:watchFetchImpl,intervalMs:watchIntervalMs}):null;
  const status=info=>ui?.setStatus('dsg-continuity',info.state==='waiting'?`DSG waiting: ${info.reason} · attempt ${info.attempts} · Esc to cancel`:undefined);
  pi.on('session_start',(_event,ctx)=>{ui=ctx.ui;watch?.start();});
  pi.on('session_shutdown',()=>{ui=null;void watch?.stop();});
  if(watch){
    pi.on('agent_start',()=>watch.update('waiting_for_model'));
    pi.on('before_provider_request',()=>watch.update('waiting_for_model'));
    pi.on('tool_execution_start',()=>watch.update('local_tool'));
    pi.on('tool_execution_end',()=>watch.update('waiting_for_model'));
    pi.on('agent_settled',()=>watch.update('idle'));
  }
  // Do not provide a models list: Pi must preserve models.json capabilities.
  pi.registerProvider(provider,{api:'openai-completions',streamSimple:(model,context,options={})=>{
    if(model.api!=='openai-completions'||new URL(model.baseUrl).href.replace(/\/$/,'')!==new URL(baseUrl).href.replace(/\/$/,''))throw new Error('DSG continuity provider API/URL mismatch; no request sent');
    const continuity=createContinuityFetch({baseUrl,fetchImpl:options.fetch??fetch,onWait:status});
    return streamSimple(model,context,{...options,fetch:watch?(input,init={})=>continuity(input,watch.decorate(input,init)):continuity});
  }});
  return {agentWatch:watch};
}
