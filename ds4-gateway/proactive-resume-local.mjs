import {mkdir,lstat} from 'node:fs/promises';
import {isAbsolute,join} from 'node:path';
import {proactiveResumeMainOptions} from './proactive-resume-host.mjs';
import {ProactiveResumeReviewer} from './proactive-resume-reviewer.mjs';
import {priorityProvider} from './priority-classifier.mjs';

/** Local trusted-host assembly. Files and inference start only after task approval. */
export function proactiveResumeLocalOptions({gatewayBaseUrl,receiptRoot,ReceiptStore,getReviewState,enrollmentMs,attemptBudget,fetchImpl}={}){
  const gateway=new URL(gatewayBaseUrl);
  if(gateway.protocol!=='http:'||gateway.hostname!=='127.0.0.1'||gateway.username||gateway.password||gateway.search||gateway.hash||!['/v1','/v1/'].includes(gateway.pathname))throw new Error('Explicit local DSG gateway required');
  if(!isAbsolute(receiptRoot)||typeof ReceiptStore?.create!=='function'||typeof ReceiptStore?.open!=='function'||typeof getReviewState!=='function')throw new Error('Local receipt owner and review state required');
  if(!Number.isSafeInteger(enrollmentMs)||enrollmentMs<1||enrollmentMs>24*60*60*1000||!Number.isInteger(attemptBudget)||attemptBudget<1||attemptBudget>10)throw new Error('Explicit bounded enrollment limits required');
  return proactiveResumeMainOptions({getEnrollmentOptions:async session=>{
    if(session.model?.baseUrl!==gatewayBaseUrl)throw new Error('This session does not use the configured DSG gateway');
    const initial=await getReviewState({signal:AbortSignal.timeout(5000)});
    let genie={...initial.genie},snapshot=initial.snapshot;
    const providers=[genie.config,genie.config?.fallback].filter(Boolean).map(endpoint=>({url:endpoint.url,model:endpoint.model}));
    const unique=providers.filter((endpoint,index)=>providers.findIndex(other=>other.url===endpoint.url&&other.model===endpoint.model)===index);
    const reviewer=new ProactiveResumeReviewer({genie,snapshot:()=>snapshot,poolUrl:gatewayBaseUrl,...(fetchImpl?{fetchImpl}:{})});
    let preparing=false,statePending=false;
    return {gatewayBaseUrl,providers:unique,expiresAt:Date.now()+enrollmentMs,attemptBudget,
      createReceipts:async sessionId=>{
        if(!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId))throw new Error('Invalid native session identity');
        await mkdir(receiptRoot,{recursive:true,mode:0o700});
        const info=await lstat(receiptRoot);
        if(!info.isDirectory()||(info.mode&0o077)!==0)throw new Error('Receipt root must be a private regular directory');
        const directory=join(receiptRoot,sessionId);
        try{return await ReceiptStore.create(directory,sessionId);}
        catch(error){if(error?.code!=='EEXIST')throw error;return ReceiptStore.open(directory,sessionId);}
      },
      reviewer:Object.fromEntries(['review','reviewProgress'].map(method=>[method,async(input,options)=>{
        if(preparing||statePending)return {state:'blocked',reason:'reviewer_busy'};
        preparing=true;
        const deadline=new AbortController(),timer=setTimeout(()=>deadline.abort(),60000);timer.unref?.();
        const signal=AbortSignal.any([deadline.signal,...(options.signal?[options.signal]:[])]);
        try{
          while(true){
          signal.throwIfAborted();
          const stateSignal=AbortSignal.any([signal,AbortSignal.timeout(5000)]);
          let cancel;
          const cancelled=new Promise((_,reject)=>{cancel=()=>reject(new Error('Review state cancelled'));stateSignal.addEventListener('abort',cancel,{once:true});});
          statePending=true;
          const refresh=Promise.resolve().then(()=>getReviewState({signal:stateSignal})).finally(()=>{statePending=false;});
          let state;
          try{state=await Promise.race([refresh,cancelled]);}
          finally{stateSignal.removeEventListener('abort',cancel);}
          signal.throwIfAborted();
          genie={...state.genie};reviewer.genie=genie;snapshot=state.snapshot;
          const pool=genie.source==='pool'?genie.config?.fallback:genie.config?.url===gatewayBaseUrl?genie.config:genie.config?.fallback;
          const canWait=genie.enabled&&!genie.closed&&snapshot?.gateway?.genie_admission_version===1&&pool?.url===gatewayBaseUrl&&pool.model===snapshot.gateway.model&&unique.some(p=>p.url===pool.url&&p.model===pool.model);
          if(priorityProvider(genie,snapshot,Date.now(),gatewayBaseUrl)||!canWait)return await reviewer[method](input,{...options,signal});
          // No inference has been dispatched. Refresh free capacity within this
          // same advisory deadline; ordinary Pi input never waits for this loop.
          await new Promise((resolve,reject)=>{
            const cancel=()=>{clearTimeout(wait);reject(new Error('Review cancelled'));};
            const wait=setTimeout(()=>{signal.removeEventListener('abort',cancel);resolve();},1000);wait.unref?.();
            signal.addEventListener('abort',cancel,{once:true});
          });
          }
        }catch{return {state:'blocked',reason:signal.aborted?'review_cancelled_or_expired':'provider_unavailable'};}
        finally{clearTimeout(timer);preparing=false;}
      }]))
    };
  }});
}
