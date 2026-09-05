// Read-only evaluation of predictions already saved by the shadow collector.
// No model fitting, inference, request bodies, routing or persistence here.
import fs from 'node:fs';
import path from 'node:path';
import {FleetThroughput} from './throughput.mjs';
import {CacheContinuityEvidence} from './cache-continuity-evidence.mjs';

const validId = x => typeof x === 'string' && /^[\w-]{1,64}$/.test(x);
const number = x => Number.isFinite(x) && x >= 0 ? x : null;
const kinds = new Set(['decision','routing_shadow','dispatch','finish','queued_cancel','queue_timeout','unavailable_before_dispatch','model_prediction']);
const LINE_BYTES = 65536, READ_BYTES = 262144, TAIL_BYTES = 8 * 1024 * 1024;

export class PredictionEvidence {
  constructor({maxRequests=4096,maxEvents=16384,maxResults=500}={}) {
    Object.assign(this,{maxRequests,maxEvents,maxResults});
    this.requests=new Map();this.seen=new Set();this.sequence=0;
    this.rejected=0;this.evicted=0;this.lastEvent=null;this.rejectionReasons={};
  }
  reject(reason){this.rejected++;this.rejectionReasons[reason]=(this.rejectionReasons[reason]??0)+1;}
  accept(row) {
    // Other versioned collector streams are not missing analytics joins.
    if(row?.schema===1 && ['request_features','embedding','progress','rejection','waiting','queue_relocation'].includes(row.kind))return;
    if(row?.schema===1&&row.node===null&&['queued_cancel','queue_timeout'].includes(row.kind))return; // No worker admission/forecast existed.
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
      r={node:row.node,at:time,observer:row.traffic_class==='genie',invalid:false,prediction:null,models:new Map(),dispatch:null,finish:null,terminal:null};
      this.requests.set(key,r);
      if(this.requests.size>this.maxRequests){this.requests.delete(this.requests.keys().next().value);this.evicted++;}
      return;
    }
    if(!r || row.node!==r.node) {this.reject(!r?'missing_admission':'different_worker');return;}
    if(r.invalid)return;
    if(row.kind==='model_prediction'){
      const kind=row.model_kind,stage=row.prediction_stage;
      if(row.predictor_schema!==2||!/^[a-f0-9]{64}$/.test(row.model_id)||!['admission','updated','remaining'].includes(kind)||!['admission','upload','embedded','remaining'].includes(stage)||number(row.seconds)===null||r.terminal||time<r.at||!Number.isFinite(row.available_at)||row.available_at>time){this.rejected++;return;}
      if(!(kind==='admission'?stage==='admission':kind==='updated'?['upload','embedded'].includes(stage):stage==='remaining')){this.reject('stage_kind_mismatch');return;}
      if((kind==='admission'&&r.dispatch)||(kind!=='admission'&&!r.dispatch)||(kind==='remaining'&&number(row.elapsed_s)===null)){this.reject('forecast_lifecycle_mismatch');return;}
      if(kind==='remaining'&&row.elapsed_s<30)return;
      const key=row.model_id+':'+stage;
      // Freeze one forecast per model/stage/request; later updates cannot
      // replace an inaccurate earlier forecast in this chart.
      if(!r.models.has(key)){
        if(r.models.size>=16){this.reject('request_forecast_limit');return;}
        r.models.set(key,{id:row.model_id,kind,stage,at:time,seconds:row.seconds,baseline_seconds:number(row.baseline_seconds),elapsed_s:row.elapsed_s??0,experimental:row.experimental});
      }
      return;
    }
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
    const dispatched=valid.filter(r=>r.dispatch),rows=dispatched.sort((a,b)=>b.dispatch.sequence-a.dispatch.sequence).slice(0,this.maxResults).reverse();
    const series=new Map();for(const r of rows)for(const [key,p] of r.models){if(!series.has(key))series.set(key,{id:p.id,kind:p.kind,stage:p.stage,rows:[]});series.get(key).rows.push({node:r.node,at:p.at,experimental:p.experimental,predicted_service_ms:p.seconds*1000,reference_service_ms:p.baseline_seconds===null?null:p.baseline_seconds*1000,service_ms:r.finish?.eligible?Math.max(0,r.finish.service_ms-(p.kind==='remaining'?p.elapsed_s*1000:0)):null,service_state:!r.finish?'pending':r.finish.eligible?'complete':'excluded'});}
    for(const [key,s] of series){s.first_forecast_at=Math.min(...s.rows.map(r=>r.at));s.last_forecast_at=Math.max(...s.rows.map(r=>r.at));for(const r of rows){if(r.models.has(key)||r.at<s.first_forecast_at)continue;const eligible=!!r.finish?.eligible&&(s.kind!=='remaining'||r.finish.service_ms>=30000);s.rows.push({node:r.node,at:r.at,predicted_service_ms:null,service_ms:s.kind==='remaining'?null:r.finish?.service_ms??null,forecast_eligible:eligible,service_state:!r.finish?'pending':eligible?'complete':'excluded'});}}
    return {source:'historical_baseline',validation:'unvalidated',prediction_point:'admission',last_event_at:this.lastEvent,
      model_series:[...series.values()].sort((a,b)=>b.last_forecast_at-a.last_forecast_at||a.id.localeCompare(b.id)||a.stage.localeCompare(b.stage)).slice(0,32),
      series_window:{limit:32,in_view:Math.min(32,series.size),outside_view:Math.max(0,series.size-32),selection:'latest_saved_forecast'},
      window:{selection:'latest_dispatches',limit:this.maxResults,in_view:rows.length,outside_view:Math.max(0,dispatched.length-rows.length),first_dispatch_at:rows[0]?.dispatch.at??null,last_dispatch_at:rows.at(-1)?.dispatch.at??null,request_index_size:this.requests.size,request_index_evictions:this.evicted,invalid_requests:[...this.requests.values()].filter(r=>r.invalid).length,observer_requests:[...this.requests.values()].filter(r=>r.observer).length},
      rejection_reasons:{...this.rejectionReasons,other_invalid_events:this.rejected-Object.values(this.rejectionReasons).reduce((sum,n)=>sum+n,0)},
      window_limit:this.maxResults,rows:rows.map(r=>({node:r.node,at:r.dispatch.at,queue_ms:r.dispatch.queue_ms,
        predicted_queue_ms:r.prediction?.wait_ms??null,service_ms:r.finish?.service_ms??null,
        predicted_service_ms:r.prediction?.service_ms??null,service_state:!r.finish?'pending':r.finish.eligible?'complete':'excluded'})),
      not_dispatched:valid.filter(r=>r.terminal==='not_dispatched').length,
      pending:valid.filter(r=>!r.dispatch && !r.terminal).length,
      rejected_events:this.rejected,evicted_requests:this.evicted};
  }
}

// Applied handovers change the selected worker, so they must not be folded into
// the ordinary decision-node prediction join. This separate observer reports
// only the route that actually ran; it never invents the no-move outcome.
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
      note:'Observed destination outcomes only. The unobserved no-move outcome remains unknown; these rows do not train or validate the ordinary placement predictor.'};
  }
}

export class AnalyticsReader {
  constructor(directory,{enabled=false,readBytes=READ_BYTES,tailBytes=TAIL_BYTES}={}) {
    Object.assign(this,{directory,enabled,readBytes,tailBytes});this.cursors=new Map();this.evidence=new PredictionEvidence();this.handovers=new HandoverEvidence();this.throughput=new FleetThroughput();
    this.status='waiting';this.lastRead=null;this.partialHistory=false;this.malformed=0;this.rescans=0;this.scanReason='initial_read';this.skippedBytes=0;
    this.cacheContinuity=new CacheContinuityEvidence();
  }
  poll(now=Date.now()) {
    if(!this.enabled)return;
    try {
      if(!fs.lstatSync(this.directory).isDirectory())throw new Error('Not a directory');
      const files=fs.readdirSync(this.directory).filter(f=>/^routing-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort().slice(-2);
      if([...this.cursors.keys()].some(file=>!files.includes(file))) {
        this.cursors.clear();this.evidence=new PredictionEvidence();this.handovers=new HandoverEvidence();this.throughput=new FleetThroughput();this.cacheContinuity=new CacheContinuityEvidence();this.rescans++;this.scanReason='daily_window_changed';this.skippedBytes=0;this.partialHistory=false;this.status='rescanning';return;
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
            this.cursors.clear();this.evidence=new PredictionEvidence();this.handovers=new HandoverEvidence();this.throughput=new FleetThroughput();this.cacheContinuity=new CacheContinuityEvidence();this.rescans++;this.scanReason='file_replaced_or_rewritten';this.skippedBytes=0;this.partialHistory=false;this.status='rescanning';return;
          }
          if(!c) {
            const offset=Math.max(0,stat.size-this.tailBytes);this.partialHistory ||= offset>0;this.skippedBytes+=offset;
            // Each daily tail can omit a middle interval. Never compare across
            // that gap: retain only the contiguous suffix for cache continuity.
            // Forecast analytics keeps its separately documented window.
            if(offset>0)this.cacheContinuity=new CacheContinuityEvidence();
            c={identity,offset,fragment:Buffer.alloc(0),skipping:offset>0,anchor:Buffer.alloc(0)};this.cursors.set(file,c);
          }
          const length=Math.min(this.readBytes,Math.max(0,stat.size-c.offset)),chunk=Buffer.alloc(length);
          const read=length?fs.readSync(fd,chunk,0,length,c.offset):0;c.offset+=read;
          const buffer=Buffer.concat([c.fragment,chunk.subarray(0,read)]);
          let from=0,end;
          while((end=buffer.indexOf(10,from))>=0) {
            if(!c.skipping && end-from<=LINE_BYTES) {
              try {const row=JSON.parse(buffer.subarray(from,end).toString('utf8'));this.evidence.accept(row);this.handovers.accept(row);this.throughput.accept(row);this.cacheContinuity.accept(row);} catch {this.malformed++;this.cacheContinuity.invalidate();}
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
      ...this.evidence.snapshot()};
  }
  cacheSnapshot(now=Date.now()) {
    return this.cacheContinuity.snapshot(now,{enabled:this.enabled,status:this.status,partialHistory:this.partialHistory});
  }
}
