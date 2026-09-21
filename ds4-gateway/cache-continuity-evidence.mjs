// Dashboard-only bounded projection. It shares the analytics reader's I/O and
// never reads prompts, vectors, cache files or inference endpoints.
import {auditCacheContinuity} from './cache-continuity-audit.mjs';
const kinds=new Set(['decision','finish','queue_relocation']);
const fields=['schema','kind','run_id','event_id','request_id','time','node','session','affinity','outcome','finish_reason','route'];
const RECENT_USAGE_MS=30*60*1000;
const integer=value=>Number.isSafeInteger(value)&&value>=0?value:null;
const at=value=>{const parsed=Date.parse(value);return Number.isFinite(parsed)?parsed:null;};

// Prompt-token-weighted cached share per worker from retained completed finishes.
// Independent of the consecutive-pair audit: sums never certify a cache verdict,
// they only count returned token accounting. Cold first turns count as misses.
function usageSummary(events,now) {
  const workers=Object.create(null);
  const bucket=node=>{
    const key=typeof node==='string'&&/^[\w-]{1,64}$/.test(node)?node:'unknown';
    return workers[key]??={requests:0,prompt_tokens:0,cached_tokens:0,recent_requests:0,recent_prompt_tokens:0,recent_cached_tokens:0};
  };
  for(const row of events){
    if(row.kind!=='finish'||row.outcome!=='complete')continue;
    const prompt=integer(row.usage?.prompt_tokens),cached=integer(row.usage?.cached_tokens);
    if(prompt===null||cached===null||cached>prompt)continue;
    const worker=bucket(row.node),time=at(row.time);
    worker.requests++;worker.prompt_tokens+=prompt;worker.cached_tokens+=cached;
    if(time!==null&&now-time>=0&&now-time<=RECENT_USAGE_MS){worker.recent_requests++;worker.recent_prompt_tokens+=prompt;worker.recent_cached_tokens+=cached;}
  }
  const share=w=>w.prompt_tokens>0?Math.round(1000*w.cached_tokens/w.prompt_tokens)/1000:null;
  const recentShare=w=>w.recent_prompt_tokens>0?Math.round(1000*w.recent_cached_tokens/w.recent_prompt_tokens)/1000:null;
  for(const worker of Object.values(workers)){worker.cached_fraction=share(worker);worker.recent_cached_fraction=recentShare(worker);}
  return {schema:1,recent_window_ms:RECENT_USAGE_MS,workers};
}

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
    // Usage sums stay available even when the pair audit is blocked: a gap
    // invalidates consecutive-pair reasoning, not simple token accounting.
    const usage=this.blocked?{schema:1,recent_window_ms:RECENT_USAGE_MS,workers:{},status:this.blocked}:usageSummary(this.events,now);
    const base={schema:1,status:!enabled?'disabled':status,checked_at:this.evaluatedAt,interval_ms:this.intervalMs,events:this.events.length,event_limit:this.maxEvents,projected_bytes:this.bytes,byte_limit:this.maxBytes,partial_history:partialHistory,workers:{},usage};
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
