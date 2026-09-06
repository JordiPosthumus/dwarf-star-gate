// Separately opted-in content handoff. The metadata-only adapter stays separate.
// Genuine Pi user messages supply a bounded task excerpt; custom continuation
// messages, tool content, system prompts and model reasoning are excluded.
import {randomUUID} from 'node:crypto';
import {PRIORITY_INTENT_HEADER,PRIORITY_INTENT_ROUTE} from './priority-intent.mjs';
import {requestUserExcerpt} from './priority-request.mjs';

const bounded=(text,max)=>{
  let result='',bytes=0;
  for(const character of text){const size=Buffer.byteLength(character);if(bytes+size>max)break;result+=character;bytes+=size;}
  return result.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g,' ').trim();
};
export function createPiPriorityIntent({provider,baseUrl,fetchImpl=fetch}={}){
  const base=new URL(baseUrl),endpoint=new URL(PRIORITY_INTENT_ROUTE,base.origin);
  if(typeof provider!=='string'||!provider.trim()||!['http:','https:'].includes(base.protocol)||base.username||base.password||base.search||base.hash||!['/v1','/v1/'].includes(base.pathname))throw new Error('Invalid Pi priority scope');
  let manager=null,session=null,current=null,pending=null;
  const clear=()=>{pending?.abort();pending=null;current=null;};
  return {
    start(_event,ctx){clear();manager=null;session=null;try{const id=ctx?.sessionManager?.getSessionId();if(typeof id==='string'&&id&&Buffer.byteLength(id)<=256){manager=ctx.sessionManager;session=id;}}catch{}},
    stop(){clear();manager=null;session=null;},
    snapshot(model,options={}){
      if(!manager||model?.provider!==provider||options.sessionId!==session)return null;
      try{
        if(new URL(model.baseUrl).href.replace(/\/$/,'')!==base.href.replace(/\/$/,'')||manager.getSessionId()!==session)return null;
        const branch=manager.getBranch();if(!Array.isArray(branch)||branch.length>10000)return null;
        const user=branch.findLast(entry=>entry?.type==='message'&&entry.message?.role==='user');
        if(typeof user?.id!=='string'||!user.id||user.id.length>256)return null;
        if(current?.entry===user.id)return current;
        const excerpt=requestUserExcerpt({messages:branch.filter(entry=>entry?.type==='message'&&entry.message?.role==='user').map(entry=>entry.message)});
        if(!excerpt)return null;
        const name=manager.getSessionName?.();
        const title=typeof name==='string'&&name.trim()?bounded(name,256):null;
        clear();current={entry:user.id,id:randomUUID(),session,title,excerpt,sent:false};return current;
      }catch{return null;}
    },
    optOut(input,init={}){
      if(input instanceof Request)return init;
      let url;try{url=new URL(input);}catch{return init;}
      if(url.origin!==base.origin||url.pathname!=='/v1/chat/completions'||url.search||url.hash||init.method?.toUpperCase()!=='POST'||typeof init.body!=='string')return init;
      const headers=new Headers(init.headers);if(!headers.has('authorization'))return init;
      headers.set(PRIORITY_INTENT_HEADER,'off');return {...init,headers};
    },
    decorate(input,init={},intent){
      if(!intent||intent!==current||input instanceof Request)return init;
      let url;try{url=new URL(input);}catch{return init;}
      if(url.origin!==base.origin||url.pathname!=='/v1/chat/completions'||url.search||url.hash||init.method?.toUpperCase()!=='POST'||typeof init.body!=='string')return init;
      const headers=new Headers(init.headers),credential=headers.get('authorization');
      const affinity=headers.get('x-session-affinity')||headers.get('x-ds4-conversation-id')||headers.get('x-session-id')||headers.get('session_id');
      // An existing affinity is the authority. Never enable Pi cache affinity or
      // invent a conversation identity merely to attach optional advice.
      if(!credential||(affinity&&affinity!==intent.session)||headers.has(PRIORITY_INTENT_HEADER))return init;
      headers.set(PRIORITY_INTENT_HEADER,intent.id);
      if(!intent.sent){
        intent.sent=true;
        const controller=new AbortController();pending=controller;
        const body=JSON.stringify({schema:affinity&&intent.title?1:2,id:intent.id,...(affinity&&intent.title?{session:intent.session}:{}),client:'pi',title:intent.title,excerpt:intent.excerpt});
        intent.excerpt=null;
        // Start separately, without waiting before inference. No retry after a
        // rejected or ambiguous advisory submission; a new user turn may try.
        void Promise.resolve().then(()=>fetchImpl(endpoint,{method:'POST',redirect:'manual',headers:{authorization:credential,'content-type':'application/json'},body,signal:AbortSignal.any([controller.signal,AbortSignal.timeout(5000)])}))
          .then(response=>response.body?.cancel()).catch(()=>{}).finally(()=>{if(pending===controller)pending=null;});
      }
      return {...init,headers};
    }
  };
}
