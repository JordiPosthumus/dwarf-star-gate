// Opt-in metadata only. Read entry types/IDs and terminal metadata, never message
// content, compaction summaries, token usage or prompt/embedding hashes. The
// session-file API is checked only for absence; no session files are opened.
import {CLIENT_METADATA_HEADER,clientMetadata} from './client-metadata.mjs';

const MAX_ENTRIES=10000;
const efforts=new Set(['none','minimal','low','medium','high','xhigh']);
const routes=new Set(['/v1/chat/completions','/v1/completions','/v1/messages','/v1/responses']);
const entryList=rows=>Array.isArray(rows)&&rows.length<=MAX_ENTRIES&&rows.every(row=>row&&typeof row==='object'&&typeof row.id==='string'&&row.id.length>0&&row.id.length<=256&&typeof row.type==='string')&&new Set(rows.map(row=>row.id)).size===rows.length;

export function createPiClientMetadata({provider,baseUrl}){
  const base=new URL(baseUrl);
  if(typeof provider!=='string'||!provider.trim()||!['http:','https:'].includes(base.protocol)||base.username||base.password||base.search||base.hash||!['/v1','/v1/'].includes(base.pathname))throw new Error('Invalid Pi metadata scope');
  let manager=null,sessionId=null,knownIndex=false,lastInput=null,index=-1;
  const invalidate=()=>{knownIndex=false;};
  return {
    start(event,ctx){
      manager=null;sessionId=null;knownIndex=false;lastInput=null;index=-1;
      try{
        const candidate=ctx?.sessionManager,id=candidate?.getSessionId(),header=candidate?.getHeader(),entries=candidate?.getEntries();
        if(typeof id!=='string'||!id||header?.id!==id||header?.type!=='session')return;
        manager=candidate;sessionId=id;
        // Never reconstruct an absolute call counter from persisted assistant
        // messages: failed attempts, retries and forked history are ambiguous.
        const fresh=event?.reason==='new'||event?.reason==='startup'&&candidate.getSessionFile()==null;
        knownIndex=fresh&&!header.parentSession&&entryList(entries)&&entries.every(row=>['model_change','thinking_level_change'].includes(row.type));
      }catch{/* Advisory evidence must not prevent inference. */}
    },
    stop(){manager=null;sessionId=null;invalidate();},
    invalidate,
    snapshot(model,options={}){
      if(!manager||model?.provider!==provider||options.sessionId!==sessionId)return null;
      try{
        if(manager.getSessionId()!==sessionId)return null;
        const values={schema:1};
        if(efforts.has(options.reasoning))values.reasoning_effort=options.reasoning;
        const header=manager.getHeader(),entries=manager.getEntries(),branch=manager.getBranch();
        const valid=header?.id===sessionId&&header?.type==='session'&&!header.parentSession&&entryList(entries)&&entryList(branch);
        const ids=valid?new Set(entries.map(row=>row.id)):null;
        if(!valid||branch.some(row=>!ids.has(row.id)))invalidate();
        else {
          values.compaction_count=entries.filter(row=>row.type==='compaction').length;
          if(branch.some(row=>row.type==='message'&&row.message?.role==='assistant'&&row.message.provider!==provider))invalidate();
          // Pi retains failed attempts in session history while retrying the
          // same input. Ignore only those attempt records and compaction records;
          // a new user/tool/successful-assistant input gives the next call index.
          const input=branch.findLast(row=>row.type==='custom_message'||row.type==='branch_summary'||row.type==='message'&&!(row.message?.role==='assistant'&&['error','aborted'].includes(row.message.stopReason)));
          const key=input?.id??'empty-session-input';
          if(knownIndex&&key!==lastInput){lastInput=key;index++;if(index>1000000)invalidate();}
          if(knownIndex)values.turn_index=index;
        }
        // getContextUsage and previous usage are not current full-input token
        // estimates. Leave prompt_tokens_estimate absent instead of guessing.
        if(Object.keys(values).length===1)return null;
        const text=JSON.stringify(values);
        return clientMetadata(text).status==='ready'?text:null;
      }catch{invalidate();return null;}
    },
    decorate(input,init={},metadata){
      if(!metadata||input instanceof Request)return init;
      let url;try{url=new URL(input);}catch{return init;}
      if(url.origin!==base.origin||!routes.has(url.pathname)||url.search||url.hash||init.method?.toUpperCase()!=='POST'||typeof init.body!=='string')return init;
      const headers=new Headers(init.headers);
      // Explicit caller hints win, even if invalid: do not silently replace them.
      if(headers.has(CLIENT_METADATA_HEADER))return init;
      headers.set(CLIENT_METADATA_HEADER,metadata);return {...init,headers};
    }
  };
}
