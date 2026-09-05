// Dashboard-only bounded projection. It shares the analytics reader's I/O and
// never reads prompts, vectors, cache files or inference endpoints.
import {auditCacheContinuity} from './cache-continuity-audit.mjs';
const kinds=new Set(['decision','finish','queue_relocation']);
const fields=['schema','kind','run_id','event_id','request_id','time','node','session','affinity','outcome','finish_reason','route'];

export class CacheContinuityEvidence {
  constructor({maxEvents=16384,maxBytes=8*1024*1024,intervalMs=15000}={}) {
    if(!Number.isSafeInteger(maxEvents)||maxEvents<1||maxEvents>200000||!Number.isSafeInteger(maxBytes)||maxBytes<1024||maxBytes>16*1024*1024||!Number.isSafeInteger(intervalMs)||intervalMs<15000)throw new Error('Invalid cache dashboard budget');
    this.maxEvents=maxEvents;this.maxBytes=maxBytes;this.bytes=0;this.intervalMs=intervalMs;this.events=[];this.dirty=true;
    this.blocked=null;this.evaluatedAt=null;this.result=null;
  }
  accept(raw) {
    if(!kinds.has(raw?.kind)||this.blocked)return;
    if(this.events.length>=this.maxEvents){this.blocked='event_limit';this.result=null;return;}
    if(raw.candidates?.length>128){this.blocked='invalid_evidence';this.result=null;return;}
    const row=Object.fromEntries(fields.filter(k=>Object.hasOwn(raw,k)).map(k=>[k,raw[k]]));
    if(raw.kind==='decision'){
      row.client_metadata=Object.fromEntries(['schema','status','turn_index','compaction_count'].map(k=>[k,raw.client_metadata?.[k]]));
      if(Array.isArray(raw.candidates))row.candidates=raw.candidates.map(c=>({node:c?.node,profile:c?.profile,observation_epoch:c?.observation_epoch}));
    }
    if(raw.kind==='finish')row.usage={prompt_tokens:raw.usage?.prompt_tokens,cached_tokens:raw.usage?.cached_tokens};
    // A fixed scalar projection cannot retain caller-owned nested payloads.
    if(Object.values(row).some(v=>v!==null&&typeof v==='object'&&!['client_metadata','candidates','usage'].some(k=>row[k]===v))){this.blocked='invalid_evidence';this.result=null;return;}
    const nested=[row.client_metadata,row.usage,...(row.candidates??[])].filter(Boolean);
    if(nested.some(o=>Object.values(o).some(v=>v!==null&&typeof v==='object'))){this.blocked='invalid_evidence';this.result=null;return;}
    const bytes=Buffer.byteLength(JSON.stringify(row));
    if(this.bytes+bytes>this.maxBytes){this.blocked='event_limit';this.result=null;return;}
    this.bytes+=bytes;
    this.events.push(row);this.dirty=true;
  }
  invalidate(){this.blocked='source_gap';this.result=null;}
  snapshot(now,{enabled=true,status='ready',partialHistory=false}={}) {
    const base={schema:1,status:!enabled?'disabled':status,checked_at:this.evaluatedAt,interval_ms:this.intervalMs,events:this.events.length,event_limit:this.maxEvents,projected_bytes:this.bytes,byte_limit:this.maxBytes,partial_history:partialHistory,workers:{}};
    if(!enabled||status!=='ready')return base;
    if(this.blocked)return {...base,status:this.blocked};
    if(this.dirty&&(this.evaluatedAt===null||now-this.evaluatedAt>=this.intervalMs)){
      try{this.result=auditCacheContinuity(this.events);}
      catch{this.blocked='invalid_evidence';this.result=null;return {...base,status:this.blocked};}
      this.evaluatedAt=now;this.dirty=false;
    }
    return {...base,status:'ready',checked_at:this.evaluatedAt,refresh_pending:this.dirty,workers:this.result?.workers??{}};
  }
}
