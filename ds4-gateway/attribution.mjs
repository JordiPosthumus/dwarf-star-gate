// Conservative, read-only association between gateway lifecycle records and
// stock DS4 prompt-start telemetry. This never claims protocol-level identity:
// without a request ID echoed by DS4, even an exact usage match is corroborated
// shadow evidence rather than proof.
import { createHash } from 'node:crypto';
import { summarizeAttribution } from './attribution-summary.mjs';

const UUID=/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/;
const ID=/^[a-zA-Z0-9][\w-]{0,63}$/;
const EPOCH=/^[\da-f]{64}$/;
const SAMPLE=/^[\da-f]{64}$/;
const OUTCOMES=new Set(['complete','client_cancelled','upstream_error','upstream_stream_error','upstream_aborted','upstream_http_error','upstream_engine_error','incomplete_sse','sse_observation_limited','connection_closed','timeout','other']);
const WINDOW_MS=15*60000, MAX_OPEN_SPAN_MS=7*24*3600000, SKEW_MS=5000, MAX_DISPATCH_LEAD_MS=10*60000, MAX_RECORDS=512, MAX_OVERLAP_CANDIDATES=64;
const time=value=>typeof value==='number'?value:typeof value==='string'?Date.parse(value):NaN;
const tokens=value=>Number.isSafeInteger(value)&&value>=0?value:null;

function candidateWindows(start,requests){
  return requests.filter(request=>request.node===start.node&&request.dispatched_at<=start.time+SKEW_MS&&
    start.time-request.dispatched_at<=MAX_DISPATCH_LEAD_MS&&(request.finished_at===null||request.finished_at>=start.time-SKEW_MS));
}

function safeGateway(raw) {
  if(!raw||!['request_dispatched','request_finished'].includes(raw.event)||!UUID.test(raw.request_id??'')||!ID.test(raw.node??''))return null;
  const at=time(raw.time);if(!Number.isFinite(at)||at<=0)return null;
  const row={event:raw.event,time:at,node:raw.node,request_id:raw.request_id};
  if(raw.event==='request_finished'){
    row.outcome=OUTCOMES.has(raw.outcome)?raw.outcome:'other';
    if(raw.usage&&typeof raw.usage==='object')row.usage={prompt_tokens:tokens(raw.usage.prompt_tokens),cached_tokens:tokens(raw.usage.cached_tokens)};
  }
  return row;
}

function safeEngine(raw) {
  if(!raw||raw.kind!=='start'||!ID.test(raw.node??'')||!SAMPLE.test(raw.sample_id??''))return null;
  const at=time(raw.time),prompt=tokens(raw.prompt),cached=tokens(raw.cached),fresh=tokens(raw.new_tokens);
  if(!Number.isFinite(at)||at<=0||prompt===null||cached===null||fresh===null||cached+fresh!==prompt)return null;
  return {sample_id:raw.sample_id,time:at,node:raw.node,prompt,cached,new_tokens:fresh,
    backend_epoch:EPOCH.test(raw.backend_epoch??'')?raw.backend_epoch:null,
    backend_epoch_confidence:['strong','bounded'].includes(raw.backend_epoch_confidence)?raw.backend_epoch_confidence:'unavailable'};
}

function result(start,requests) {
  const base={schema:1,event:'engine_attribution',sample_id:start.sample_id,node:start.node,engine_started_at:start.time,
    backend_epoch:start.backend_epoch,backend_epoch_confidence:start.backend_epoch_confidence,request_id:null,
    status:'abstained',reason:null,confidence:'none',basis:'stock_ds4_timing_shadow',dispatch_delta_ms:null,
    prompt_tokens:start.prompt,cached_tokens:start.cached,new_tokens:start.new_tokens};
  if(!start.backend_epoch)return {...base,reason:'backend_epoch_unavailable'};
  const candidates=candidateWindows(start,requests),candidateIds=new Set(candidates.map(request=>request.request_id));
  // Once an engine start has overlapped multiple gateway windows, pruning or a
  // conflicting later lifecycle record must never manufacture a unique owner.
  // The private bounded candidate set is not persisted or exported.
  if(start.overlap_overflow||(start.overlap_candidates?.size>1&&[...start.overlap_candidates].some(id=>!candidateIds.has(id))))return {...base,reason:'overlapping_gateway_windows'};
  if(!candidates.length)return {...base,reason:'no_gateway_request_window'};
  if(candidates.length!==1){
    // Clock tolerance can make two sequential gateway windows appear to
    // overlap around a prompt boundary. Wait until every candidate has a
    // completed, directly reported usage tuple, then use that tuple only when
    // it identifies exactly one request. This remains a corroborated candidate,
    // not protocol proof: invisible direct clients are still possible.
    const resolved=candidates.every(request=>request.finished_at!==null&&request.usage?.prompt_tokens!==null&&request.usage?.prompt_tokens!==undefined&&
      request.usage?.cached_tokens!==null&&request.usage?.cached_tokens!==undefined);
    if(!resolved)return {...base,reason:'overlapping_gateway_windows'};
    const matching=candidates.filter(request=>request.usage.prompt_tokens===start.prompt&&request.usage.cached_tokens===start.cached);
    if(matching.length!==1)return {...base,reason:matching.length?'overlapping_usage_matches':'usage_conflict'};
    const request=matching[0];
    return {...base,request_id:request.request_id,status:'corroborated',reason:'usage_disambiguated_overlap',
      confidence:start.backend_epoch_confidence==='strong'?'high_candidate':'bounded_candidate',dispatch_delta_ms:Math.round(start.time-request.dispatched_at)};
  }
  const request=candidates[0];
  return {...base,request_id:request.request_id,status:'candidate',reason:request.finished_at===null?'request_open':'usage_unavailable',confidence:'heuristic',
    dispatch_delta_ms:Math.round(start.time-request.dispatched_at)};
}

export class EngineAttribution {
  constructor(persist=()=>{}){this.persist=persist;this.requests=new Map();this.starts=new Map();this.emitted=new Map();this.latest=0;}
  acceptGateway(raw) {
    const e=safeGateway(raw);if(!e)return null;
    this.latest=Math.max(this.latest,e.time);
    const request=this.requests.get(e.request_id)??{request_id:e.request_id,node:e.node,dispatched_at:null,finished_at:null,outcome:null,usage:null};
    // Conflicting lifecycle identities are retained as an ambiguity, never
    // rewritten into a clean interval.
    if(request.node!==e.node)request.conflict=true;
    if(e.event==='request_dispatched')request.dispatched_at??=e.time;
    else {request.finished_at=e.time;request.outcome=e.outcome;request.usage=e.usage??null;}
    this.requests.set(e.request_id,request);this.reconcile();return e;
  }
  acceptEngine(raw) {
    const e=safeEngine(raw);if(!e)return null;
    this.latest=Math.max(this.latest,e.time);this.starts.set(e.sample_id,e);this.reconcile();return e;
  }
  captureOverlaps() {
    const requests=[...this.requests.values()].filter(row=>Number.isFinite(row.dispatched_at)&&!row.conflict);
    for(const start of this.starts.values()){
      const candidates=candidateWindows(start,requests);if(candidates.length<2)continue;
      start.overlap_candidates??=new Set();
      for(const request of candidates){
        if(start.overlap_candidates.size>=MAX_OVERLAP_CANDIDATES&&!start.overlap_candidates.has(request.request_id)){start.overlap_overflow=true;break;}
        if(!start.overlap_candidates.has(request.request_id)){start.overlap_candidates.add(request.request_id);start.overlap_settled=false;}
      }
    }
  }
  reconcile() {
    // Capture ambiguity before age/cap pruning. Completed candidates needed to
    // resolve a long overlap are then retained, while any unavoidable eviction
    // keeps the row abstained instead of creating false uniqueness.
    this.captureOverlaps();this.prune();
    const requests=[...this.requests.values()].filter(r=>Number.isFinite(r.dispatched_at)&&!r.conflict);
    const rows=[...this.starts.values()].map(start=>result(start,requests));
    const byRequest=new Map();
    for(const row of rows)if(row.request_id){const list=byRequest.get(row.request_id)??[];list.push(row);byRequest.set(row.request_id,list);}
    for(const row of rows){
      if(row.request_id&&byRequest.get(row.request_id).length>1)Object.assign(row,{status:'abstained',reason:'multiple_engine_starts',confidence:'none'});
      else if(row.request_id&&row.status!=='corroborated'){
        const request=this.requests.get(row.request_id);
        if(request?.finished_at!==null){
          const prompt=request.usage?.prompt_tokens,cached=request.usage?.cached_tokens;
          if(prompt!==null&&prompt!==undefined&&cached!==null&&cached!==undefined){
            if(prompt===row.prompt_tokens&&cached===row.cached_tokens)Object.assign(row,{status:'corroborated',reason:'usage_match',confidence:row.backend_epoch_confidence==='strong'?'high_candidate':'bounded_candidate'});
            else Object.assign(row,{status:'abstained',reason:'usage_conflict',confidence:'none'});
          } else Object.assign(row,{reason:request?.outcome==='complete'?'completed_without_usage':'censored_or_failed'});
        }
      }
      const signature=createHash('sha256').update(JSON.stringify(row)).digest('hex');
      if(this.emitted.get(row.sample_id)!==signature){this.emitted.set(row.sample_id,signature);this.persist({...row,attribution_revision_id:signature,observed_at:Date.now()});}
    }
    // Once every remembered overlap candidate has a terminal event, the next
    // ordinary prune may release the private lifecycle rows. The remembered IDs
    // remain as a fail-closed guard if late/out-of-order evidence appears.
    for(const start of this.starts.values())if(start.overlap_candidates?.size>1&&!start.overlap_overflow){
      const candidates=new Map(candidateWindows(start,requests).map(request=>[request.request_id,request]));
      start.overlap_settled=[...start.overlap_candidates].every(id=>candidates.get(id)?.finished_at!==null);
    }
    this.rows=rows.sort((a,b)=>b.engine_started_at-a.engine_started_at).slice(0,64);
  }
  prune() {
    const floor=this.latest-WINDOW_MS;
    const protectedIds=new Set();
    for(const start of this.starts.values())if(!start.overlap_settled&&start.time>=this.latest-MAX_OPEN_SPAN_MS)for(const id of start.overlap_candidates??[])protectedIds.add(id);
    for(const [id,row] of this.requests)if(!protectedIds.has(id)&&(row.finished_at!==null?row.finished_at<floor:row.dispatched_at<this.latest-MAX_OPEN_SPAN_MS))this.requests.delete(id);
    const retained=[...this.requests.values()].filter(row=>Number.isFinite(row.dispatched_at));
    for(const [id,start] of this.starts)if(start.time<this.latest-MAX_OPEN_SPAN_MS||start.time<floor&&!candidateWindows(start,retained).length)this.starts.delete(id);
    for(const id of this.emitted.keys())if(!this.starts.has(id))this.emitted.delete(id);
    while(this.requests.size>MAX_RECORDS){const evict=[...this.requests.keys()].find(id=>!protectedIds.has(id))??this.requests.keys().next().value;this.requests.delete(evict);}
    while(this.starts.size>MAX_RECORDS)this.starts.delete(this.starts.keys().next().value);
  }
  snapshot() {
    const rows=this.rows??[],counts={corroborated:0,candidate:0,abstained:0};
    for(const row of rows)counts[row.status]++;
    return {schema:1,mode:'shadow',request_identity:'heuristic_not_protocol_proof',recent_history_ms:WINDOW_MS,max_open_span_ms:MAX_OPEN_SPAN_MS,clock_tolerance_ms:SKEW_MS,
      counts,quality:summarizeAttribution(rows),recent:rows.slice(0,16),note:'Corroborated means one bounded gateway window plus matching DS4 usage inside one observed process epoch. Ambiguity or conflict abstains; routing is unchanged.'};
  }
}
