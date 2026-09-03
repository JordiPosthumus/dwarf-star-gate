// Read-only evaluation of predictions already saved by the shadow collector.
// No model fitting, inference, request bodies, routing or persistence here.
import fs from 'node:fs';
import path from 'node:path';

const validId = x => typeof x === 'string' && /^[\w-]{1,64}$/.test(x);
const number = x => Number.isFinite(x) && x >= 0 ? x : null;
const kinds = new Set(['decision','routing_shadow','dispatch','finish','queued_cancel','queue_timeout','unavailable_before_dispatch']);
const LINE_BYTES = 65536, READ_BYTES = 262144, TAIL_BYTES = 8 * 1024 * 1024;

export class PredictionEvidence {
  constructor({maxRequests=4096,maxEvents=16384,maxResults=500}={}) {
    Object.assign(this,{maxRequests,maxEvents,maxResults});
    this.requests=new Map();this.seen=new Set();this.sequence=0;
    this.rejected=0;this.evicted=0;this.lastEvent=null;
  }
  accept(row) {
    if(row?.schema!==1 || !kinds.has(row.kind) || !validId(row.run_id) || !validId(row.request_id) || !validId(row.event_id)) {this.rejected++;return;}
    const eventKey=`${row.run_id}:${row.event_id}`;
    if(this.seen.has(eventKey))return;
    this.seen.add(eventKey);if(this.seen.size>this.maxEvents)this.seen.delete(this.seen.keys().next().value);
    const time=Date.parse(row.time);
    if(!Number.isFinite(time)) {this.rejected++;return;}
    this.lastEvent=Math.max(this.lastEvent??0,time);
    const key=`${row.run_id}:${row.request_id}`;
    let r=this.requests.get(key);
    if(row.kind==='decision') {
      if(r){r.invalid=true;this.rejected++;return;}
      if(!validId(row.node)){this.rejected++;return;}
      r={node:row.node,at:time,observer:row.traffic_class==='genie',invalid:false,prediction:null,dispatch:null,finish:null,terminal:null};
      this.requests.set(key,r);
      if(this.requests.size>this.maxRequests){this.requests.delete(this.requests.keys().next().value);this.evicted++;}
      return;
    }
    if(!r || row.node!==r.node) {this.rejected++;return;}
    if(r.invalid)return;
    if(row.kind==='routing_shadow') {
      // Freeze the admission forecast. Re-evaluations when a worker becomes
      // free are NOT independent predictions or replacements for a poor one.
      if(row.reason!=='admission')return;
      if(r.dispatch || r.terminal || r.prediction || row.shadow_schema!==1 || row.source!==r.node ||
        row.confidence!=='unvalidated' || row.basis!=='prior_session_prompt_bucket_mixed_cache' || time<r.at) {this.rejected++;return;}
      const home=Array.isArray(row.candidates)?row.candidates.filter(c=>c.node===r.node):[];
      const c=home.length===1 && home[0].eligible===true?home[0]:null;
      const wait=number(c?.wait_ms),elapsed=number(row.waiting_ms);
      r.prediction={at:time,wait_ms:wait!==null && elapsed!==null?number(wait+elapsed):null,service_ms:number(c?.service_ms)};
      return;
    }
    if(row.kind==='dispatch') {
      if(r.dispatch || r.terminal || time<r.at || number(row.queue_ms)===null || (r.prediction && time<r.prediction.at)) {r.invalid=true;this.rejected++;return;}
      r.dispatch={at:time,sequence:++this.sequence,queue_ms:row.queue_ms};return;
    }
    if(row.kind==='finish') {
      if(!r.dispatch || r.finish || r.terminal || time<r.dispatch.at){r.invalid=true;this.rejected++;return;}
      const eligible=row.outcome==='complete' && ['stop','tool_calls','function_call'].includes(row.finish_reason) && number(row.service_ms)>0;
      r.finish={eligible,service_ms:eligible?row.service_ms:null};r.terminal='finished';return;
    }
    if(r.dispatch || r.terminal){r.invalid=true;this.rejected++;return;}
    r.terminal='not_dispatched';
  }
  snapshot() {
    const valid=[...this.requests.values()].filter(r=>!r.invalid && !r.observer);
    const rows=valid.filter(r=>r.dispatch).sort((a,b)=>b.dispatch.sequence-a.dispatch.sequence).slice(0,this.maxResults).reverse();
    return {source:'historical_baseline',validation:'unvalidated',prediction_point:'admission',last_event_at:this.lastEvent,
      window_limit:this.maxResults,rows:rows.map(r=>({node:r.node,at:r.dispatch.at,queue_ms:r.dispatch.queue_ms,
        predicted_queue_ms:r.prediction?.wait_ms??null,service_ms:r.finish?.service_ms??null,
        predicted_service_ms:r.prediction?.service_ms??null,service_state:!r.finish?'pending':r.finish.eligible?'complete':'excluded'})),
      not_dispatched:valid.filter(r=>r.terminal==='not_dispatched').length,
      pending:valid.filter(r=>!r.dispatch && !r.terminal).length,
      rejected_events:this.rejected,evicted_requests:this.evicted};
  }
}

export class AnalyticsReader {
  constructor(directory,{enabled=false,readBytes=READ_BYTES,tailBytes=TAIL_BYTES}={}) {
    Object.assign(this,{directory,enabled,readBytes,tailBytes});this.cursors=new Map();this.evidence=new PredictionEvidence();
    this.status='waiting';this.lastRead=null;this.partialHistory=false;this.malformed=0;this.rescans=0;
  }
  poll(now=Date.now()) {
    if(!this.enabled)return;
    try {
      if(!fs.lstatSync(this.directory).isDirectory())throw new Error('Not a directory');
      const files=fs.readdirSync(this.directory).filter(f=>/^routing-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort().slice(-2);
      if([...this.cursors.keys()].some(file=>!files.includes(file))) {
        this.cursors.clear();this.evidence=new PredictionEvidence();this.rescans++;this.status='rescanning';return;
      }
      let backlog=false;
      for(const file of files) {
        const full=path.join(this.directory,file);
        if(!fs.lstatSync(full).isFile())throw new Error('Not regular');
        const fd=fs.openSync(full,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
        try {
          const stat=fs.fstatSync(fd);if(!stat.isFile())throw new Error('Not regular');
          const identity=`${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
          let c=this.cursors.get(file);
          const anchor=c?Buffer.alloc(c.anchor.length):Buffer.alloc(0);
          const changed=c && (c.identity!==identity || stat.size<c.offset || (anchor.length &&
            (fs.readSync(fd,anchor,0,anchor.length,c.offset-anchor.length)!==anchor.length || !anchor.equals(c.anchor))));
          if(changed) {
            // Rebuild a bounded window after replacement/truncation; do not mix
            // old labels with a new file that happens to reuse request IDs.
            this.cursors.clear();this.evidence=new PredictionEvidence();this.rescans++;this.status='rescanning';return;
          }
          if(!c) {
            const offset=Math.max(0,stat.size-this.tailBytes);this.partialHistory ||= offset>0;
            c={identity,offset,fragment:Buffer.alloc(0),skipping:offset>0,anchor:Buffer.alloc(0)};this.cursors.set(file,c);
          }
          const length=Math.min(this.readBytes,Math.max(0,stat.size-c.offset)),chunk=Buffer.alloc(length);
          const read=length?fs.readSync(fd,chunk,0,length,c.offset):0;c.offset+=read;
          const buffer=Buffer.concat([c.fragment,chunk.subarray(0,read)]);
          let from=0,end;
          while((end=buffer.indexOf(10,from))>=0) {
            if(!c.skipping && end-from<=LINE_BYTES) {
              try {this.evidence.accept(JSON.parse(buffer.subarray(from,end).toString('utf8')));} catch {this.malformed++;}
            } else if(!c.skipping)this.malformed++;
            c.skipping=false;from=end+1;
          }
          c.fragment=Buffer.from(buffer.subarray(from));
          if(c.fragment.length>LINE_BYTES || c.skipping){if(!c.skipping)this.malformed++;c.fragment=Buffer.alloc(0);c.skipping=true;}
          c.anchor=Buffer.alloc(Math.min(64,c.offset));
          if(c.anchor.length)fs.readSync(fd,c.anchor,0,c.anchor.length,c.offset-c.anchor.length);
          backlog ||= c.offset<stat.size;
          // Preserve append ordering across midnight: finish the older daily
          // file before looking at a newer one during initial backfill.
          if(backlog)break;
        } finally {fs.closeSync(fd);}
      }
      for(const file of this.cursors.keys())if(!files.includes(file))this.cursors.delete(file);
      this.status=!files.length?'waiting':backlog?'catching_up':'ready';this.lastRead=now;
    } catch {this.status='unavailable';}
  }
  snapshot() {
    return {enabled:this.enabled,status:this.enabled?this.status:'disabled',last_read_at:this.lastRead,
      partial_history:this.partialHistory,malformed_lines:this.malformed,rescans:this.rescans,
      ...this.evidence.snapshot()};
  }
}
