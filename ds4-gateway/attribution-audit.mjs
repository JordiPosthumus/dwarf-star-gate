#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { summarizeAttribution } from './attribution-summary.mjs';
import { safeGatewayEvent } from './telemetry.mjs';
import { timeWindows } from './time-window-index.mjs';

const FILE=/^metrics-\d{4}-\d{2}-\d{2}\.jsonl$/;
const MAX_FILES=7,MAX_BYTES_PER_FILE=8*1024*1024,MAX_LINE_BYTES=64*1024,MAX_RECORDS=65536;
const MAX_RECONCILE_BYTES_PER_FILE=32*1024*1024,MAX_GATEWAY_BYTES=32*1024*1024,MAX_SOURCE_RECORDS=250000;
const ID=/^[a-zA-Z0-9][\w-]{0,63}$/,UUID=/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/;
const SAMPLE=/^[\da-f]{64}$/,EPOCH=/^[\da-f]{64}$/;
const STATUSES=new Set(['candidate','corroborated','abstained']);
const REASONS=new Set(['backend_epoch_unavailable','no_gateway_request_window','overlapping_gateway_windows','overlapping_usage_matches','usage_conflict','request_open','usage_unavailable','multiple_engine_starts','usage_match','usage_disambiguated_overlap','completed_without_usage','censored_or_failed']);
const CONFIDENCE=new Set(['none','heuristic','bounded_candidate','high_candidate']);
const SKEW_MS=5000,MAX_DISPATCH_LEAD_MS=10*60000;
function cohortFilter(sinceMs){
  if(sinceMs!==null&&(!Number.isSafeInteger(sinceMs)||sinceMs<0||sinceMs>8.64e15))throw new Error('sinceMs must be a nonnegative integer timestamp in the Date range');
  return row=>sinceMs===null||Number.isFinite(row.engine_started_at)&&row.engine_started_at>=sinceMs;
}

function boundedLines(file,maxBytes=MAX_BYTES_PER_FILE) {
  let fd;
  try{fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);}
  catch(error){if(['ELOOP','ENOENT','ENOTDIR'].includes(error.code))return {lines:[],skipped:'not_regular'};throw error;}
  try{
    const stat=fs.fstatSync(fd);if(!stat.isFile())return {lines:[],skipped:'not_regular'};
    const length=Math.min(stat.size,maxBytes),offset=stat.size-length,buffer=Buffer.alloc(length);
    if(length)fs.readSync(fd,buffer,0,length,offset);
    const text=buffer.toString('utf8'),lines=text.split('\n');if(offset>0)lines.shift();
    return {lines,partial:offset>0};
  }finally{fs.closeSync(fd);}
}

export function auditAttributionDirectory(directory,{maxFiles=MAX_FILES,maxBytesPerFile=MAX_BYTES_PER_FILE,sinceMs=null}={}) {
  const inCohort=cohortFilter(sinceMs);
  if(typeof directory!=='string'||!path.isAbsolute(directory))throw new Error('Attribution audit directory must be an absolute path');
  if(!Number.isSafeInteger(maxFiles)||maxFiles<1||maxFiles>MAX_FILES)throw new Error(`maxFiles must be an integer from 1 to ${MAX_FILES}`);
  if(!Number.isSafeInteger(maxBytesPerFile)||maxBytesPerFile<1024||maxBytesPerFile>MAX_BYTES_PER_FILE)throw new Error(`maxBytesPerFile must be an integer from 1024 to ${MAX_BYTES_PER_FILE}`);
  const root=fs.lstatSync(directory);if(!root.isDirectory()||root.isSymbolicLink())throw new Error('Attribution audit directory must be a real directory');
  const files=fs.readdirSync(directory).filter(name=>FILE.test(name)).sort().slice(-maxFiles);
  const rows=[];let malformed_lines=0,oversized_lines=0,partial_files=0,skipped_files=0,truncated_records=0;
  for(const name of files){
    const result=boundedLines(path.join(directory,name),maxBytesPerFile);
    if(result.skipped){skipped_files++;continue;}if(result.partial)partial_files++;
    for(const line of result.lines){
      if(!line.trim())continue;if(Buffer.byteLength(line)>MAX_LINE_BYTES){oversized_lines++;continue;}
      try{const row=JSON.parse(line);if(row?.event==='engine_attribution'){if(rows.length<MAX_RECORDS)rows.push(row);else truncated_records++;}}
      catch{malformed_lines++;}
    }
  }
  return {schema:1,mode:'read_only_shadow_audit',files_read:files.length-skipped_files,partial_files,skipped_files,
    malformed_lines,oversized_lines,truncated_records,...summarizeAttribution(rows.filter(inCohort)),cohort_since:sinceMs===null?null:new Date(sinceMs).toISOString(),
    privacy:'Counts, bounded reason codes and configured server IDs only. No prompts, responses, request IDs, sample IDs, paths or credentials are returned.'};
}

const integer=value=>Number.isSafeInteger(value)&&value>=0?value:null;
function safeAttribution(raw) {
  if(!raw||raw.event!=='engine_attribution'||!ID.test(raw.node??'')||!SAMPLE.test(raw.sample_id??'')||!STATUSES.has(raw.status)||!REASONS.has(raw.reason)||!CONFIDENCE.has(raw.confidence))return null;
  const engine_started_at=Number(raw.engine_started_at),prompt_tokens=integer(raw.prompt_tokens),cached_tokens=integer(raw.cached_tokens),new_tokens=integer(raw.new_tokens);
  if(!Number.isFinite(engine_started_at)||engine_started_at<=0||prompt_tokens===null||cached_tokens===null||new_tokens===null||cached_tokens+new_tokens!==prompt_tokens)return null;
  const observed_at=Number.isFinite(raw.observed_at)?raw.observed_at:engine_started_at;
  return {schema:1,event:'engine_attribution',sample_id:raw.sample_id,node:raw.node,engine_started_at,
    backend_epoch:EPOCH.test(raw.backend_epoch??'')?raw.backend_epoch:null,
    backend_epoch_confidence:['strong','bounded'].includes(raw.backend_epoch_confidence)?raw.backend_epoch_confidence:'unavailable',
    request_id:UUID.test(raw.request_id??'')?raw.request_id:null,status:raw.status,reason:raw.reason,confidence:raw.confidence,
    dispatch_delta_ms:Number.isFinite(raw.dispatch_delta_ms)?Math.round(raw.dispatch_delta_ms):null,
    prompt_tokens,cached_tokens,new_tokens,observed_at};
}
function safeCollisionStart(raw) {
  if(!raw||raw.kind!=='start'||!ID.test(raw.node??''))return null;
  const time=Number(raw.time),prompt=integer(raw.prompt),cached=integer(raw.cached),new_tokens=integer(raw.new_tokens);
  if(!Number.isFinite(time)||time<=0||prompt===null||cached===null||new_tokens===null||cached+new_tokens!==prompt)return null;
  return {kind:'start',sample_id:SAMPLE.test(raw.sample_id??'')?raw.sample_id:null,node:raw.node,time,prompt,cached,new_tokens,
    backend_epoch:EPOCH.test(raw.backend_epoch??'')?raw.backend_epoch:null,
    backend_epoch_confidence:['strong','bounded'].includes(raw.backend_epoch_confidence)?raw.backend_epoch_confidence:'unavailable'};
}
function safeStart(raw) {const row=safeCollisionStart(raw);return row?.sample_id?row:null;}
function safeLifecycle(raw) {
  const event=safeGatewayEvent(raw),at=Date.parse(event?.time??'');
  // safeGatewayEvent is a permissive telemetry sanitizer. A lifecycle join
  // additionally needs its identity AND clock; silently dropping a malformed
  // dispatch could erase a competing owner and manufacture a unique match.
  return event&&UUID.test(event.request_id??'')&&ID.test(event.node??'')&&Number.isFinite(at)&&at>0?event:null;
}
function latestRows(rows) {
  const latest=new Map(),conflicts=new Set(),claims=new Map();
  for(const raw of rows){
    const row=safeAttribution(raw);if(!row)continue;
    const key=`${row.node}:${row.sample_id}`,prior=latest.get(key);
    if(!prior||row.observed_at>prior.observed_at){latest.set(key,row);conflicts.delete(key);claims.set(key,new Set([row.request_id]));}
    else if(row.observed_at===prior.observed_at){
      if(JSON.stringify(row)!==JSON.stringify(prior))conflicts.add(key);
      claims.get(key).add(row.request_id);
      latest.set(key,row); // Preserve the recorded view, but never infer ownership from a tie.
    }
  }
  return {latest,conflicts,claims};
}

// Re-evaluate only historical clock-overlap abstentions after all candidate
// requests have exact prompt/cache usage. The original rows stay immutable.
// A request collision, incomplete source or missing coverage keeps abstention.
export function reconcileAttributionRows(attributionRows=[],engineRows=[],gatewayRows=[],{complete=false,metricCoverageStart=-Infinity,sinceMs=null}={}) {
  const inCohort=cohortFilter(sinceMs);
  const {latest,conflicts,claims}=latestRows(attributionRows),original=[...latest.values()];
  // Select only the report cohort. Older ownership and competing starts remain
  // in every reconciliation check; dropping them could manufacture certainty.
  const overlapCount=original.filter(row=>inCohort(row)&&row.reason==='overlapping_gateway_windows').length;
  const unchanged=(reason='source_incomplete')=>({summary:summarizeAttribution(original.filter(inCohort)),reconciled_overlaps:0,remaining_overlap_abstentions:overlapCount,reconciliation_block_reasons:overlapCount?{[reason]:overlapCount}:{}});
  const invalid=attributionRows.some(raw=>raw?.event==='engine_attribution'&&!safeAttribution(raw))||engineRows.some(raw=>raw?.kind==='start'&&!safeCollisionStart(raw))||gatewayRows.some(raw=>['request_dispatched','request_finished'].includes(raw?.event)&&!safeLifecycle(raw));
  if(!complete||invalid)return unchanged();
  const starts=new Map(),conflictingStarts=new Set();
  for(const raw of engineRows){
    const row=safeStart(raw);if(!row)continue;
    const key=`${row.node}:${row.sample_id}`,prior=starts.get(key);
    if(prior&&JSON.stringify(prior)!==JSON.stringify(row))conflictingStarts.add(key);
    starts.set(key,row);
  }
  const collisionStarts=engineRows.map(safeCollisionStart).filter(Boolean);
  const lifecycle=new Map();let coverageStart=Infinity;
  for(const raw of gatewayRows){
    const event=safeLifecycle(raw);if(!event)continue;
    const at=Date.parse(event.time);coverageStart=Math.min(coverageStart,at);
    const request=lifecycle.get(event.request_id)??{request_id:event.request_id,node:event.node,dispatched_at:null,finished_at:null,usage:null,conflict:false};
    if(request.node!==event.node)request.conflict=true;
    if(event.event==='request_dispatched'){if(request.dispatched_at!==null&&request.dispatched_at!==at)request.conflict=true;request.dispatched_at??=at;}
    else{const usage={prompt_tokens:integer(event.usage?.prompt_tokens),cached_tokens:integer(event.usage?.cached_tokens)};
      if(request.finished_at!==null&&(request.finished_at!==at||request.outcome!==event.outcome||JSON.stringify(request.usage)!==JSON.stringify(usage)))request.conflict=true;
      request.finished_at=at;request.outcome=event.outcome;request.usage=usage;}
    lifecycle.set(event.request_id,request);
  }
  // Dropping a contradictory lifecycle would remove a possible competing owner
  // and manufacture uniqueness. Keep the recorded view, not a revised match.
  if([...lifecycle.values()].some(request=>request.conflict||Number.isFinite(request.dispatched_at)&&Number.isFinite(request.finished_at)&&request.finished_at<request.dispatched_at))return unchanged('gateway_evidence_conflict');
  const requests=[...lifecycle.values()].filter(request=>Number.isFinite(request.dispatched_at));
  const requestWindows=timeWindows(requests,'dispatched_at'),startWindows=timeWindows(collisionStarts,'time');
  const proposals=new Map(),blocks={};
  let currentRow;
  const block=reason=>{if(inCohort(currentRow))blocks[reason]=(blocks[reason]??0)+1;};
  for(const row of original){
    currentRow=row;
    if(row.reason!=='overlapping_gateway_windows')continue;
    const startKey=`${row.node}:${row.sample_id}`,start=starts.get(startKey);
    if(conflicts.has(startKey)){block('attribution_evidence_conflict');continue;}
    if(!start){block('engine_start_unavailable');continue;}
    if(conflictingStarts.has(startKey)||start.time!==row.engine_started_at||!start.backend_epoch||!['strong','bounded'].includes(start.backend_epoch_confidence)||start.backend_epoch!==row.backend_epoch||
      start.backend_epoch_confidence!==row.backend_epoch_confidence||start.prompt!==row.prompt_tokens||start.cached!==row.cached_tokens||start.new_tokens!==row.new_tokens){block('engine_start_conflict');continue;}
    if(metricCoverageStart>start.time-MAX_DISPATCH_LEAD_MS){block('metric_coverage_incomplete');continue;}if(coverageStart>start.time-MAX_DISPATCH_LEAD_MS){block('gateway_coverage_incomplete');continue;}
    // The index only narrows the scan. Padded bounds retain the original exact
    // predicates below, including clock-tolerance edges and unfinished owners.
    const candidates=requestWindows(start.node,start.time-MAX_DISPATCH_LEAD_MS-SKEW_MS,start.time+2*SKEW_MS).filter(request=>request.node===start.node&&request.dispatched_at<=start.time+SKEW_MS&&start.time-request.dispatched_at<=MAX_DISPATCH_LEAD_MS&&(request.finished_at===null||request.finished_at>=start.time-SKEW_MS));
    if(candidates.length<2){block('candidate_window_changed');continue;}
    if(!candidates.every(request=>Number.isFinite(request.finished_at)&&request.usage?.prompt_tokens!==null&&request.usage?.cached_tokens!==null)){block('candidate_usage_incomplete');continue;}
    const matching=candidates.filter(request=>request.usage.prompt_tokens===start.prompt&&request.usage.cached_tokens===start.cached);
    if(matching.length!==1){block(matching.length?'duplicate_usage_match':'usage_conflict');continue;}
    proposals.set(`${row.node}:${row.sample_id}`,{request_id:matching[0].request_id,dispatch_delta_ms:Math.round(start.time-matching[0].dispatched_at)});
  }
  // Preserve the online invariant that one request cannot explain multiple
  // engine starts. Existing and newly proposed owners participate equally.
  const owners=new Map();
  const add=(requestId,sampleKey)=>{if(!UUID.test(requestId??''))return;const set=owners.get(requestId)??new Set();set.add(sampleKey);owners.set(requestId,set);};
  // Retain every possible latest owner, including conflicting revisions outside
  // the report cohort. Dropping a tied claim could manufacture request uniqueness.
  for(const [sampleKey,requestIds] of claims)for(const requestId of requestIds)add(requestId,sampleKey);
  for(const [sampleKey,proposal] of proposals)add(proposal.request_id,sampleKey);
  // Only ORIGINAL corroboration can establish an independent owner. Never use
  // a proposal from this pass: mutually ambiguous starts cannot prove each other.
  const independentlyOwned=(start,proposal,target)=>{
    const owner=latest.get(`${start.node}:${start.sample_id}`),request=lifecycle.get(owner?.request_id);
    return !!(start.sample_id&&!conflicts.has(`${start.node}:${start.sample_id}`)&&!conflictingStarts.has(`${start.node}:${start.sample_id}`)&&owner?.status==='corroborated'&&['high_candidate','bounded_candidate'].includes(owner.confidence)&&['usage_match','usage_disambiguated_overlap'].includes(owner.reason)&&
      owner.request_id!==proposal.request_id&&owners.get(owner.request_id)?.size===1&&request&&!request.conflict&&request.outcome==='complete'&&
      request.node===start.node&&Number.isFinite(request.dispatched_at)&&Number.isFinite(request.finished_at)&&request.finished_at>=request.dispatched_at&&
      start.time>=request.dispatched_at-SKEW_MS&&start.time<=request.finished_at+SKEW_MS&&start.time-request.dispatched_at<=MAX_DISPATCH_LEAD_MS&&
      start.backend_epoch&&start.backend_epoch===owner.backend_epoch&&start.backend_epoch===target.backend_epoch&&owner.engine_started_at===start.time&&
      owner.prompt_tokens===start.prompt&&owner.cached_tokens===start.cached&&request.usage?.prompt_tokens===start.prompt&&request.usage?.cached_tokens===start.cached&&
      (start.prompt!==target.prompt_tokens||start.cached!==target.cached_tokens));
  };
  let reconciled_overlaps=0;const competing_start_details={};
  const revised=original.map(row=>{
    currentRow=row;
    const key=`${row.node}:${row.sample_id}`,proposal=proposals.get(key);
    if(!proposal)return row;
    if(owners.get(proposal.request_id)?.size!==1){block('request_collision');return row;}
    const request=lifecycle.get(proposal.request_id);
    const competing=startWindows(request.node,request.dispatched_at-2*SKEW_MS,Math.min(request.dispatched_at+MAX_DISPATCH_LEAD_MS+SKEW_MS,request.finished_at===null?Infinity:request.finished_at+2*SKEW_MS)).filter(start=>!(start.sample_id===row.sample_id&&start.node===row.node)&&start.node===request.node&&request.dispatched_at<=start.time+SKEW_MS&&start.time-request.dispatched_at<=MAX_DISPATCH_LEAD_MS&&(request.finished_at===null||request.finished_at>=start.time-SKEW_MS));
    const unresolved=competing.filter(start=>!independentlyOwned(start,proposal,row));
    if(unresolved.length){
      if(inCohort(row)){
        const flags=new Set(competing.map(s=>s.sample_id?'identified_start':'anonymous_start'));
        for(const s of competing)flags.add(s.prompt===row.prompt_tokens&&s.cached===row.cached_tokens?'same_prompt_cache_usage':'different_prompt_cache_usage');
        for(const s of competing){const owner=latest.get(`${s.node}:${s.sample_id}`);flags.add(owner?.status==='corroborated'&&owner.request_id&&owner.request_id!==proposal.request_id?'corroborated_other_owner':'unresolved_competing_owner');}
        for(const flag of flags)competing_start_details[flag]=(competing_start_details[flag]??0)+1;
      }
      block('competing_engine_start');return row;
    }
    if(inCohort(row))reconciled_overlaps++;
    return {...row,request_id:proposal.request_id,status:'corroborated',reason:'usage_disambiguated_overlap',
      confidence:row.backend_epoch_confidence==='strong'?'high_candidate':'bounded_candidate',dispatch_delta_ms:proposal.dispatch_delta_ms};
  });
  return {summary:summarizeAttribution(revised.filter(inCohort)),reconciled_overlaps,competing_start_details,remaining_overlap_abstentions:revised.filter(row=>inCohort(row)&&row.reason==='overlapping_gateway_windows').length,reconciliation_block_reasons:Object.fromEntries(Object.entries(blocks).sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])))};
}

export function auditAttributionReconciliation(directory,gatewayLog,{maxFiles=MAX_FILES,maxBytesPerFile=MAX_RECONCILE_BYTES_PER_FILE,maxGatewayBytes=MAX_GATEWAY_BYTES,sinceMs=null}={}) {
  const inCohort=cohortFilter(sinceMs);
  if(typeof directory!=='string'||!path.isAbsolute(directory))throw new Error('Attribution audit directory must be an absolute path');
  if(typeof gatewayLog!=='string'||!path.isAbsolute(gatewayLog))throw new Error('Gateway log must be an absolute path');
  if(!Number.isSafeInteger(maxFiles)||maxFiles<1||maxFiles>MAX_FILES)throw new Error(`maxFiles must be an integer from 1 to ${MAX_FILES}`);
  if(!Number.isSafeInteger(maxBytesPerFile)||maxBytesPerFile<1024||maxBytesPerFile>MAX_RECONCILE_BYTES_PER_FILE)throw new Error('maxBytesPerFile is outside reconciliation bounds');
  if(!Number.isSafeInteger(maxGatewayBytes)||maxGatewayBytes<1024||maxGatewayBytes>MAX_GATEWAY_BYTES)throw new Error('maxGatewayBytes is outside reconciliation bounds');
  const root=fs.lstatSync(directory);if(!root.isDirectory()||root.isSymbolicLink())throw new Error('Attribution audit directory must be a real directory');
  const availableFiles=fs.readdirSync(directory).filter(name=>FILE.test(name)).sort(),files=availableFiles.slice(-maxFiles),metric_files_omitted=availableFiles.length-files.length;
  const attributionRows=[],engineRows=[];let malformed_lines=0,oversized_lines=0,invalid_metric_records=0,anonymous_metric_starts=0,partial_files=0,skipped_files=0,truncated_records=0;
  for(const name of files){
    const result=boundedLines(path.join(directory,name),maxBytesPerFile);if(result.skipped){skipped_files++;continue;}if(result.partial)partial_files++;
    for(const line of result.lines){
      if(!line.trim())continue;if(Buffer.byteLength(line)>MAX_LINE_BYTES){oversized_lines++;continue;}
      try{const row=JSON.parse(line);if(row?.event==='engine_attribution'||row?.kind==='start'){if(attributionRows.length+engineRows.length>=MAX_SOURCE_RECORDS){truncated_records++;continue;}if(row.event==='engine_attribution'){if(safeAttribution(row))attributionRows.push(row);else invalid_metric_records++;}else{if(safeCollisionStart(row)){engineRows.push(row);if(!safeStart(row))anonymous_metric_starts++;}else invalid_metric_records++;}}}
      catch{malformed_lines++;}
    }
  }
  const gateway=boundedLines(gatewayLog,maxGatewayBytes);if(gateway.skipped)throw new Error('Gateway log must be a regular file');
  const gatewayRows=[];let gateway_malformed_lines=0,gateway_oversized_lines=0,gateway_invalid_records=0,gateway_truncated_records=0;
  for(const line of gateway.lines){
    if(!line.trim())continue;if(Buffer.byteLength(line)>MAX_LINE_BYTES){gateway_oversized_lines++;continue;}
    try{const row=JSON.parse(line);if(['request_dispatched','request_finished'].includes(row?.event)){if(!safeLifecycle(row))gateway_invalid_records++;else if(gatewayRows.length>=MAX_SOURCE_RECORDS)gateway_truncated_records++;else gatewayRows.push(row);}}
    catch{gateway_malformed_lines++;}
  }
  const complete=partial_files===0&&skipped_files===0&&truncated_records===0&&malformed_lines===0&&oversized_lines===0&&invalid_metric_records===0&&!gateway.partial&&gateway_malformed_lines===0&&gateway_oversized_lines===0&&gateway_invalid_records===0&&gateway_truncated_records===0;
  // The supported source budget exceeds JavaScript's function-argument limit.
  // Reduce in constant auxiliary space rather than spreading timestamps.
  let metricCoverageStart=Infinity;
  for(const row of engineRows)metricCoverageStart=Math.min(metricCoverageStart,safeCollisionStart(row)?.time??Infinity);
  const recorded=summarizeAttribution(attributionRows.filter(inCohort)),later=reconcileAttributionRows(attributionRows,engineRows,gatewayRows,{complete,metricCoverageStart,sinceMs});
  return {schema:1,mode:'read_only_later_evidence_reconciliation',source_complete:complete,files_read:files.length-skipped_files,metric_files_omitted,partial_files,skipped_files,malformed_lines,oversized_lines,invalid_metric_records,anonymous_metric_starts,truncated_records,
    gateway_partial:gateway.partial,gateway_malformed_lines,gateway_oversized_lines,gateway_invalid_records,gateway_truncated_records,recorded,with_later_gateway_evidence:later.summary,
    cohort_since:sinceMs===null?null:new Date(sinceMs).toISOString(),reconciled_overlaps:later.reconciled_overlaps,remaining_overlap_abstentions:later.remaining_overlap_abstentions,reconciliation_block_reasons:later.reconciliation_block_reasons,competing_start_details:later.competing_start_details??{},
    privacy:'Counts, bounded reason codes and configured server IDs only. Original telemetry is not rewritten; no prompts, responses, request IDs, sample IDs, paths or credentials are returned.'};
}

function args(argv) {
  let directory=path.resolve('runtime/dashboard'),maxFiles=3,gatewayLog=null,sinceMs=null;
  for(let i=0;i<argv.length;i++){
    if(argv[i]==='--directory'&&argv[i+1])directory=path.resolve(argv[++i]);
    else if(argv[i]==='--files'&&argv[i+1])maxFiles=Number(argv[++i]);
    else if(argv[i]==='--gateway-log'&&argv[i+1])gatewayLog=path.resolve(argv[++i]);
    else if(argv[i]==='--since'&&argv[i+1]){const value=argv[++i];if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)||!Number.isFinite(Date.parse(value)))throw new Error('--since requires a UTC ISO timestamp');sinceMs=Date.parse(value);}
    else if(argv[i]==='--help')return {help:true};
    else throw new Error(`Unknown or incomplete argument: ${argv[i]}`);
  }
  if(!Number.isInteger(maxFiles)||maxFiles<1||maxFiles>MAX_FILES)throw new Error(`--files must be an integer from 1 to ${MAX_FILES}`);
  return {directory,maxFiles,gatewayLog,sinceMs};
}

if(import.meta.url===pathToFileURL(process.argv[1]??'').href){
  try{
    const input=args(process.argv.slice(2));
    if(input.help){console.log('Usage: node ds4-gateway/attribution-audit.mjs [--directory PATH] [--files 1..7] [--gateway-log PATH] [--since UTC_ISO_TIMESTAMP]');process.exit(0);}
    const options={maxFiles:input.maxFiles,sinceMs:input.sinceMs};
    const report=input.gatewayLog?auditAttributionReconciliation(input.directory,input.gatewayLog,options):auditAttributionDirectory(input.directory,options);
    console.log(JSON.stringify(report,null,2));
  }catch(error){console.error(`DSG attribution audit: ${error.message}`);process.exit(1);}
}
