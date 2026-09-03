// Display-only accounting of saved terminal usage, not GPU throughput or XGB.
const HOUR=3600000,DAY=24*HOUR;
const validId=x=>typeof x==='string'&&/^[\w-]{1,64}$/.test(x);
const tokens=x=>Number.isSafeInteger(x)&&x>=0?x:null;
const safe=n=>n<=BigInt(Number.MAX_SAFE_INTEGER)?Number(n):null;
const sum=(rows,key)=>safe(rows.reduce((n,r)=>n+BigInt(r[key]??0),0n));
export class FleetThroughput {
  constructor({maxRecords=20000}={}){
    if(!Number.isInteger(maxRecords)||maxRecords<1||maxRecords>20000)throw new Error('Throughput record budget must be 1–20000');
    this.maxRecords=maxRecords;this.records=new Map();this.evicted=0;this.rejected=0;
  }
  accept(row){
    if(row?.kind!=='finish')return;
    const at=Date.parse(row.time);
    if(row.schema!==1||!validId(row.run_id)||!validId(row.request_id)||!validId(row.node)||!Number.isFinite(at)){this.rejected++;return;}
    const key=`${row.run_id}:${row.request_id}`,prompt=tokens(row.usage?.prompt_tokens),cached=tokens(row.usage?.cached_tokens);
    const r={at,node:row.node,complete:row.outcome==='complete',output:tokens(row.usage?.completion_tokens),
      prompt:prompt!==null&&cached!==null&&cached<=prompt?prompt:null,cached:prompt!==null&&cached!==null&&cached<=prompt?cached:null};
    const prior=this.records.get(key);
    if(prior){if(JSON.stringify(prior)!==JSON.stringify(r)&&!prior.invalid){prior.invalid=true;this.rejected++;}return;}
    this.records.set(key,r);
    if(this.records.size>this.maxRecords){this.records.delete(this.records.keys().next().value);this.evicted++;}
  }
  snapshot(now=Date.now()){
    // Older rows are irrelevant to this display, not deleted from source files.
    for(const [key,r] of this.records)if(r.at<=now-DAY)this.records.delete(key);
    const all=[...this.records.values()].filter(r=>!r.invalid&&r.at<=now).sort((a,b)=>a.at-b.at);
    const completed=all.filter(r=>r.complete),recent=completed.filter(r=>r.at>now-HOUR);
    const output=recent.filter(r=>r.output!==null),cache=recent.filter(r=>r.cached!==null),known=completed.filter(r=>r.output!==null);
    let running=0n,peak=0n,left=0,end=null;
    for(let right=0;right<known.length;right++){
      running+=BigInt(known[right].output);
      while(known[left].at<=known[right].at-HOUR)running-=BigInt(known[left++].output);
      if(running>peak){peak=running;end=known[right].at;}
    }
    const cached=cache.length?sum(cache,'cached'):recent.length?null:0,prompt=cache.length?sum(cache,'prompt'):recent.length?null:0;
    return {schema:1,source:'gateway_finish_usage',as_of:now,window_ms:HOUR,peak_history_ms:DAY,
      completed_1h:recent.length,output_known_1h:output.length,output_tokens_1h:output.length?sum(output,'output'):recent.length?null:0,
      peak_output_tokens_1h:known.length?safe(peak):completed.length?null:0,peak_hour_end_at:end,
      completed_24h:completed.length,output_known_24h:known.length,cached_tokens_1h:cached,cache_known_1h:cache.length,
      cache_reuse_pct_1h:prompt>0&&cached!==null?100*cached/prompt:null,
      excluded_terminal_1h:all.filter(r=>!r.complete&&r.at>now-HOUR).length,
      oldest_observed_at:all[0]?.at??null,evicted_records:this.evicted,rejected_records:this.rejected};
  }
}
