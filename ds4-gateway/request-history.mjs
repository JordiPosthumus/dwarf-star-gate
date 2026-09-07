// Read-only operational request history: cache continuity, handovers and throughput.
import fs from 'node:fs';
import path from 'node:path';
import {FleetThroughput} from './throughput.mjs';
import {CacheContinuityEvidence} from './cache-continuity-evidence.mjs';
const validId=x=>typeof x==='string'&&/^[\w-]{1,64}$/.test(x);
const number=x=>Number.isFinite(x)&&x>=0?x:null;
const LINE_BYTES=65536,READ_BYTES=262144,TAIL_BYTES=8*1024*1024;

// Join applied handovers to the destination that actually ran. The observer
// never invents what would have happened without the move.
export class HandoverEvidence {
  constructor({maxRecords=512,maxEvents=4096,maxResults=100}={}) {
    Object.assign(this,{maxRecords,maxEvents,maxResults});this.records=new Map();this.seen=new Set();this.rejected=0;this.evicted=0;
  }
  accept(row) {
    if(row?.schema!==1||!['queue_relocation','dispatch','finish'].includes(row.kind))return;
    if(!validId(row.run_id)||!validId(row.request_id)||!validId(row.event_id)){this.rejected++;return;}
    const eventKey=`${row.run_id}:${row.event_id}`;if(this.seen.has(eventKey))return;
    this.seen.add(eventKey);if(this.seen.size>this.maxEvents)this.seen.delete(this.seen.keys().next().value);
    const time=Date.parse(row.time),key=`${row.run_id}:${row.request_id}`;if(!Number.isFinite(time)){this.rejected++;return;}
    if(row.kind==='queue_relocation') {
      if(this.records.has(key)||row.relocation_schema!==1||!validId(row.source)||!validId(row.destination)||row.source===row.destination||row.node!==row.destination||
        !['operator','scheduler','genie'].includes(row.actor)||row.dispatch_state!=='not_dispatched'||row.body_replayed!==false||row.deadline_preserved!==true||row.cache_locality!=='unknown'||number(row.waiting_ms)===null){this.rejected++;return;}
      this.records.set(key,{source:row.source,destination:row.destination,actor:row.actor,at:time,waiting_ms:row.waiting_ms,dispatch:null,finish:null});
      if(this.records.size>this.maxRecords){this.records.delete(this.records.keys().next().value);this.evicted++;}return;
    }
    const r=this.records.get(key);if(!r)return;
    if(row.node!==r.destination){this.records.delete(key);this.rejected++;return;}
    if(row.kind==='dispatch') {
      // Gateway queue_ms is wall-clock integer milliseconds while relocation
      // waiting_ms is monotonic and fractional. Permit only their tiny rounding
      // skew; a materially earlier dispatch still invalidates the join.
      if(r.dispatch||r.finish||time<r.at||number(row.queue_ms)===null||row.queue_ms+10<r.waiting_ms){this.records.delete(key);this.rejected++;return;}
      r.dispatch={at:time,total_queue_ms:row.queue_ms,post_move_wait_ms:Math.max(0,row.queue_ms-r.waiting_ms)};return;
    }
    if(!r.dispatch||r.finish||time<r.dispatch.at){this.records.delete(key);this.rejected++;return;}
    const eligible=row.outcome==='complete'&&['stop','tool_calls','function_call'].includes(row.finish_reason)&&number(row.service_ms)>0;
    const prompt=number(row.usage?.prompt_tokens),cached=number(row.usage?.cached_tokens);
    r.finish={eligible,service_ms:eligible?row.service_ms:null,outcome:typeof row.outcome==='string'?row.outcome:'unknown',
      cached_fraction:eligible&&prompt!==null&&prompt>0&&cached!==null&&cached<=prompt?cached/prompt:null};
  }
  snapshot() {
    const records=[...this.records.values()].sort((a,b)=>a.at-b.at),completed=records.filter(r=>r.finish?.eligible),excluded=records.filter(r=>r.finish&&!r.finish.eligible);
    return {source:'observed_applied_relocations',counterfactual:'unknown',total:records.length,dispatched:records.filter(r=>r.dispatch).length,completed:completed.length,excluded:excluded.length,pending:records.filter(r=>!r.finish).length,
      rows:records.slice(-this.maxResults).map(r=>({source:r.source,destination:r.destination,actor:r.actor,at:r.at,waiting_before_move_ms:r.waiting_ms,
        post_move_wait_ms:r.dispatch?.post_move_wait_ms??null,service_ms:r.finish?.service_ms??null,service_state:!r.finish?'pending':r.finish.eligible?'complete':'excluded',cached_fraction:r.finish?.cached_fraction??null})),
      rejected_events:this.rejected,evicted_records:this.evicted,
      note:'Observed destination outcomes only. The unobserved no-move outcome remains unknown; these rows do not establish time saved.'};
  }
}

export class RequestHistoryReader {
  constructor(directory,{enabled=false,readBytes=READ_BYTES,tailBytes=TAIL_BYTES}={}) {
    Object.assign(this,{directory,enabled,readBytes,tailBytes});this.cursors=new Map();this.handovers=new HandoverEvidence();this.throughput=new FleetThroughput();
    this.status='waiting';this.lastRead=null;this.partialHistory=false;this.malformed=0;this.rescans=0;this.scanReason='initial_read';this.skippedBytes=0;
    this.cacheContinuity=new CacheContinuityEvidence();
  }
  poll(now=Date.now()) {
    if(!this.enabled)return;
    try {
      if(!fs.lstatSync(this.directory).isDirectory())throw new Error('Not a directory');
      const files=fs.readdirSync(this.directory).filter(f=>/^routing-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort().slice(-2);
      if([...this.cursors.keys()].some(file=>!files.includes(file))) {
        this.cursors.clear();this.handovers=new HandoverEvidence();this.throughput=new FleetThroughput();this.cacheContinuity=new CacheContinuityEvidence();this.rescans++;this.scanReason='daily_window_changed';this.skippedBytes=0;this.partialHistory=false;this.status='rescanning';return;
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
            this.cursors.clear();this.handovers=new HandoverEvidence();this.throughput=new FleetThroughput();this.cacheContinuity=new CacheContinuityEvidence();this.rescans++;this.scanReason='file_replaced_or_rewritten';this.skippedBytes=0;this.partialHistory=false;this.status='rescanning';return;
          }
          if(!c) {
            const offset=Math.max(0,stat.size-this.tailBytes);this.partialHistory ||= offset>0;this.skippedBytes+=offset;
            // Each daily tail can omit a middle interval. Never compare across
            // that gap: retain only the contiguous suffix for cache continuity.
            if(offset>0)this.cacheContinuity=new CacheContinuityEvidence();
            c={identity,offset,fragment:Buffer.alloc(0),skipping:offset>0,anchor:Buffer.alloc(0)};this.cursors.set(file,c);
          }
          const length=Math.min(this.readBytes,Math.max(0,stat.size-c.offset)),chunk=Buffer.alloc(length);
          const read=length?fs.readSync(fd,chunk,0,length,c.offset):0;c.offset+=read;
          const buffer=Buffer.concat([c.fragment,chunk.subarray(0,read)]);
          let from=0,end;
          while((end=buffer.indexOf(10,from))>=0) {
            if(!c.skipping && end-from<=LINE_BYTES) {
              try {const row=JSON.parse(buffer.subarray(from,end).toString('utf8'));this.handovers.accept(row);this.throughput.accept(row);this.cacheContinuity.accept(row);} catch {this.malformed++;this.cacheContinuity.invalidate();}
            } else if(!c.skipping){this.malformed++;this.cacheContinuity.invalidate();}
            c.skipping=false;from=end+1;
          }
          c.fragment=Buffer.from(buffer.subarray(from));
          if(c.fragment.length>LINE_BYTES || c.skipping){if(!c.skipping){this.malformed++;this.cacheContinuity.invalidate();}c.fragment=Buffer.alloc(0);c.skipping=true;}
          if(c.fragment.length&&file!==files.at(-1))this.cacheContinuity.invalidate();
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
    } catch(error) {this.status=error.code==='ENOENT'&&this.lastRead===null&&!this.cursors.size?'waiting':'unavailable';}
  }
  snapshot(now=Date.now()) {
    return {enabled:this.enabled,status:this.enabled?this.status:'disabled',last_read_at:this.lastRead,
      partial_history:this.partialHistory,malformed_lines:this.malformed,rescans:this.rescans,
      reader_window:{file_limit:2,files_indexed:this.cursors.size,tail_bytes_per_file:this.tailBytes,skipped_bytes:this.skippedBytes,last_rebuild_reason:this.scanReason,raw_records_modified:false},
      throughput:this.throughput.snapshot(now),
      handovers:this.handovers.snapshot(),
      requests_observed:this.cacheContinuity.requests?.size??null};
  }
  cacheSnapshot(now=Date.now()) {
    return this.cacheContinuity.snapshot(now,{enabled:this.enabled,status:this.status,partialHistory:this.partialHistory});
  }
}
