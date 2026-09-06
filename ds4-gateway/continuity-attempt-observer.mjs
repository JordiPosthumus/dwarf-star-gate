import {CALL_ID_HEADER,DISPATCH_HEADER,validCallId} from './continuity.mjs';
import {certifiedNotDispatched} from './continuity-certificate.mjs';
import {randomUUID} from 'node:crypto';

/** Explicit enrollment adapter: add only a missing DSG correlation header.
 * The passive observer below remains unchanged; retries stay owned by the SDK.
 */
export function createCorrelatedContinuityAttemptObserver(options){
  const observer=createContinuityAttemptObserver(options),base=new URL(options.baseUrl);
  let closed=false;
  return Object.freeze({...observer,close(){closed=true;observer.close();},fetch:(input,init={})=>{
    if(closed)return observer.fetch(input,init);
    let decorated=init;
    try{
      const url=new URL(input instanceof Request?input.url:input);
      if(!(input instanceof Request)&&url.origin===base.origin&&url.pathname==='/v1/chat/completions'&&!url.search&&!url.hash&&init.method?.toUpperCase()==='POST'&&typeof init.body==='string'){
        const headers=new Headers(init.headers);
        if(!headers.has(CALL_ID_HEADER)){headers.set(CALL_ID_HEADER,randomUUID());decorated={...init,headers};}
      }
    }catch{}
    return observer.fetch(input,decorated);
  }});
}

/** One observer per provider invocation. It observes, never retries or grants a native cue. */
export function createContinuityAttemptObserver({baseUrl,fetchImpl=fetch,maxAttempts=256,inspectionMs=5000}={}){
  const base=new URL(baseUrl),routes=new Set(['/v1/chat/completions','/v1/completions','/v1/messages','/v1/responses']);
  if(!['http:','https:'].includes(base.protocol)||base.username||base.password||base.search||base.hash||!['/v1','/v1/'].includes(base.pathname))throw new Error('Exact DSG /v1 endpoint required');
  if(!Number.isSafeInteger(maxAttempts)||maxAttempts<1||maxAttempts>256||!Number.isSafeInteger(inspectionMs)||inspectionMs<1||inspectionMs>5000)throw new Error('Invalid observation bounds');
  const rows=[],inspections=new Set();let overflow=false,sealed=false,invalidated=false,pending=0;
  const inspect=async(response,callId,row)=>{
    let reader,timer,cancel;const controller=new AbortController();inspections.add(controller);
    try{
      reader=response.clone().body?.getReader();if(!reader)return;
      const cancelled=new Promise((_,reject)=>{cancel=()=>reject(new Error('Inspection cancelled'));controller.signal.addEventListener('abort',cancel,{once:true});});
      timer=setTimeout(()=>controller.abort(),inspectionMs);timer.unref?.();
      const read=async()=>{let bytes=0,text='';const decoder=new TextDecoder();while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>8192)return null;text+=decoder.decode(part.value,{stream:true});}text+=decoder.decode();return certifiedNotDispatched(response,JSON.parse(text).error,callId);};
      const receipt=await Promise.race([read(),cancelled]);
      if(receipt&&!invalidated){row.state='certified_not_dispatched';row.receipt=receipt;}
    }catch{}finally{
      clearTimeout(timer);controller.signal.removeEventListener('abort',cancel);inspections.delete(controller);
      // Cancel only our cloned branch. Do not await cancellation of a tee while
      // the SDK still owns the original response body.
      void reader?.cancel().catch(()=>{});try{reader?.releaseLock();}catch{}
      if(row.state==='pending')row.state='unknown';pending--;
    }
  };
  const observed=async(input,init={})=>{
    let row;
    if(sealed||invalidated)invalidated=true;
    else if(rows.length>=maxAttempts)overflow=true;
    else{row={state:'pending'};rows.push(row);pending++;}
    // Capture identity before yielding to fetch; caller-owned options may mutate.
    let url,callId;
    try{url=new URL(input instanceof Request?input.url:input);callId=validCallId(new Headers(init.headers).get(CALL_ID_HEADER));}catch{}
    const scoped=!(input instanceof Request)&&url?.origin===base.origin&&routes.has(url.pathname)&&!url.search&&!url.hash&&init.method?.toUpperCase()==='POST'&&typeof init.body==='string';
    let response;
    try{response=await fetchImpl(input,init);}catch(error){if(row){row.state='unknown';pending--;}throw error;}
    if(!row)return response;
    if(invalidated||!scoped||!callId||response.redirected===true||(response.url&&response.url!==url?.href)||![429,503,504].includes(response.status)||response.headers.get(DISPATCH_HEADER)!=='not_dispatched'){
      row.state='unknown';pending--;return response;
    }
    // Inspection runs beside consumption of the response, never before delivery
    // to the SDK. An unfinished inspection cannot certify an outcome.
    void inspect(response,callId,row);
    return response;
  };
  return Object.freeze({
    fetch:observed,
    seal(){sealed=true;},
    close(){invalidated=true;sealed=true;for(const controller of inspections)controller.abort();},
    snapshot(){
      const unknown=rows.filter(row=>row.state==='unknown').length,certified=rows.filter(row=>row.state==='certified_not_dispatched').length;
      return {state:invalidated||overflow||unknown?'unknown':pending?'pending':!rows.length?'unused':sealed&&certified===rows.length?'certified_not_dispatched':'unsealed',
        attempts:rows.length,pending,certified,unknown,overflow,sealed,receipts:rows.flatMap(row=>row.receipt?[{...row.receipt}]:[])};
    }
  });
}
