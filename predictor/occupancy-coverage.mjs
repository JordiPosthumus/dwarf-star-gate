// Read-only snapshot census. No new labels, fitting, live probes or authority.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {isMain} from '../ds4-gateway/config.mjs';
import {replayOccupancy} from './occupancy.mjs';
import {replayDeliveryOccupancy} from './occupancy-delivery.mjs';
import {occupancyFeatureHash,selectOccupancyCohort} from './prepare.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const key=e=>JSON.stringify([e.run_id,e.request_id]);
const identifier=x=>typeof x==='string'&&/^[\w-]{1,64}$/.test(x);
const terminalKinds=new Set(['finish','queued_cancel','queue_timeout','unavailable_before_dispatch']);
const lifecycleKinds=new Set(['decision','dispatch',...terminalKinds]);
const limits={bytes:128*1024**2,inventory:1024**2,events:200000,requests:20000};
function reject(code){const error=new Error(code);error.coverageCode=code;throw error;}
function time(value){
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value))reject('invalid_timestamp');
  const at=Date.parse(value),canonical=value.includes('.')?value:value.replace('Z','.000Z');
  if(!Number.isSafeInteger(at)||at<0||new Date(at).toISOString()!==canonical)reject('invalid_timestamp');
  return at;
}
function readBounded(file,max){
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try{
    const info=fs.fstatSync(fd);if(!info.isFile()||info.size>max)reject('input_byte_budget');
    const bytes=Buffer.alloc(info.size);let offset=0;
    while(offset<bytes.length){const n=fs.readSync(fd,bytes,offset,bytes.length-offset,offset);if(!n)reject('input_shrank');offset+=n;}
    return bytes;
  }finally{fs.closeSync(fd);}
}

export function summarizeCoverage(events,rows,{since=null,through}={}){
  if(events.length>limits.events)reject('event_budget');
  const end=time(through),cut=since===null?-Infinity:time(since);
  if(cut>end)reject('invalid_cohort_range');
  const jobs=new Map(),seen=new Map();
  for(const event of events){
    if(!lifecycleKinds.has(event?.kind))continue;
    if(event.schema!==1||!identifier(event.run_id)||!identifier(event.request_id)||!identifier(event.event_id))reject('invalid_lifecycle_identity');
    const at=time(event.time);if(at>end)reject('event_after_snapshot');
    const id=JSON.stringify([event.run_id,event.event_id]),canonical=JSON.stringify(event);
    if(seen.has(id)){if(seen.get(id)!==canonical)reject('conflicting_event_identity');continue;}seen.set(id,canonical);
    const idKey=key(event);let job=jobs.get(idKey);
    if(!job){if(jobs.size>=limits.requests)reject('request_budget');job={decision:[],dispatch:[],terminal:[]};jobs.set(idKey,job);}
    job[terminalKinds.has(event.kind)?'terminal':event.kind].push(event);
  }
  const labeled=new Set(rows.map(key)),dispositions={labeled_complete:0,complete_without_label:0,
    noncomplete_terminal:0,no_terminal_evidence:0,conflicting_lifecycle:0};
  const cohort={admitted:0,excluded_before_cutoff:0,excluded_genie:0,ambiguous_admission:0,orphan_lifecycles:0};
  const unlabelled={worker_changed:0,unsupported_finish_reason:0,other:0};
  const unfinished={dispatch_recorded:0,dispatch_not_observed:0,admission_age:{under_5m:0,'5m_to_1h':0,'1h_plus':0},max_admission_age_s:null};
  const noncomplete={client_cancelled:0,incomplete_sse:0,queued_cancel:0,queue_timeout:0,unavailable_before_dispatch:0,other:0};
  const accounted=new Set();
  for(const [id,job] of jobs){
    if(!job.decision.length){cohort.orphan_lifecycles++;continue;}
    // Conflicting admission records cannot establish cohort or traffic class.
    if(job.decision.length!==1){cohort.ambiguous_admission++;continue;}
    const d=job.decision[0],admitted=time(d.time);
    if(admitted<cut){cohort.excluded_before_cutoff++;continue;}
    if(d.traffic_class==='genie'){cohort.excluded_genie++;continue;}
    cohort.admitted++;
    const terminal=job.terminal[0],dispatch=job.dispatch[0];
    const conflict=job.dispatch.length>1||job.terminal.length>1||
      job.dispatch.some(e=>time(e.time)<admitted)||job.terminal.some(e=>time(e.time)<admitted)||
      dispatch&&terminal&&time(terminal.time)<time(dispatch.time);
    if(conflict){dispositions.conflicting_lifecycle++;continue;}
    if(labeled.has(id)){
      if(terminal?.kind!=='finish'||terminal.outcome!=='complete')reject('label_without_complete_terminal');
      dispositions.labeled_complete++;accounted.add(id);continue;
    }
    if(!terminal){
      dispositions.no_terminal_evidence++;unfinished[dispatch?'dispatch_recorded':'dispatch_not_observed']++;
      const age=(end-admitted)/1000;unfinished.admission_age[age<300?'under_5m':age<3600?'5m_to_1h':'1h_plus']++;
      unfinished.max_admission_age_s=Math.max(unfinished.max_admission_age_s??0,age);continue;
    }
    if(terminal.kind!=='finish'||terminal.outcome!=='complete'){
      dispositions.noncomplete_terminal++;
      const outcome=terminal.kind==='finish'?terminal.outcome:terminal.kind;
      noncomplete[Object.hasOwn(noncomplete,outcome)?outcome:'other']++;continue;
    }
    dispositions.complete_without_label++;
    unlabelled[terminal.node!==d.node||dispatch&&dispatch.node!==d.node?'worker_changed':
      !['stop','tool_calls','function_call','length'].includes(terminal.finish_reason)?'unsupported_finish_reason':'other']++;
  }
  if(accounted.size!==labeled.size)reject('labels_outside_unambiguous_cohort');
  if(Object.values(dispositions).reduce((a,b)=>a+b,0)!==cohort.admitted)reject('census_mismatch');
  return {cohort,dispositions,complete_without_label_reasons:unlabelled,noncomplete_terminal_reasons:noncomplete,
    no_terminal_evidence:unfinished,labeled_points:rows.length};
}

export function auditOccupancyCoverage(preparedPath){
  const bytes=readBounded(preparedPath,limits.bytes),prepared=JSON.parse(bytes),snapshot=prepared.snapshot;
  if(!['dsg-occupancy-v1','dsg-occupancy-v2'].includes(prepared.schema)||prepared.routing_enabled!==false||
    !Array.isArray(prepared.rows)||prepared.rows.length>100000)reject('unsupported_prepared_contract');
  if(snapshot?.feature_builder_sha256!==occupancyFeatureHash(prepared.schema))reject('feature_builder_changed');
  time(snapshot.created_at);
  const hashes=snapshot.hashes;
  if(!hashes||typeof hashes!=='object'||Array.isArray(hashes)||!Object.hasOwn(hashes,'worker-inventory.json'))reject('invalid_snapshot_manifest');
  const names=Object.keys(hashes).sort();
  if(names.length<2||names.length>4096||names.some(name=>name!=='worker-inventory.json'&&!/^routing-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))||
    Object.values(hashes).some(value=>typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value)))reject('invalid_snapshot_manifest');
  const root=path.join(path.dirname(path.resolve(preparedPath)),'snapshots'),events=[];
  let inventory,inventoryBytes=0,routingBytes=0,tails=0;
  for(const name of names){
    const raw=readBounded(path.join(root,name),name==='worker-inventory.json'?limits.inventory:limits.bytes-routingBytes);
    if(hash(raw)!==hashes[name])reject('snapshot_hash_mismatch');
    if(name==='worker-inventory.json'){inventory=JSON.parse(raw);inventoryBytes=raw.length;continue;}
    routingBytes+=raw.length;
    const text=raw.toString('utf8'),end=text.lastIndexOf('\n');if(end!==text.length-1)tails++;
    for(const line of text.slice(0,end<0?0:end).split('\n').filter(Boolean)){
      if(events.length>=limits.events)reject('event_budget');events.push(JSON.parse(line));
    }
  }
  if(routingBytes!==snapshot.bytes||inventory?.schema!==1||!inventory.workers)reject('snapshot_metadata_mismatch');
  // Reconstruct labels with the unchanged versioned builder, using full causal
  // history before cohort selection. The census does not invent eligibility.
  const replayed=prepared.schema==='dsg-occupancy-v2'?replayDeliveryOccupancy(events,inventory):replayOccupancy(events,inventory);
  const since=snapshot.cohort?.since??null;
  if(snapshot.cohort&&(snapshot.cohort.schema!==1||snapshot.cohort.kind!=='admitted_since'))reject('unsupported_cohort');
  selectOccupancyCohort(replayed,since);
  if(replayed.feature_schema!==prepared.feature_schema||!isDeepStrictEqual(replayed.rows,prepared.rows))reject('prepared_rows_changed');
  return {schema:1,mode:'offline_occupancy_coverage',authority:'none',routing_enabled:false,
    prepared_sha256:hash(bytes),feature_builder_sha256:snapshot.feature_builder_sha256,
    coverage_auditor_sha256:hash(fs.readFileSync(new URL(import.meta.url))),
    source:{evidence_through:new Date(time(snapshot.created_at)).toISOString(),cohort_since:since,
      files:names.length,routing_bytes:routingBytes,inventory_bytes:inventoryBytes,unterminated_tail_files:tails},
    ...summarizeCoverage(events,prepared.rows,{since,through:snapshot.created_at}),
    limitations:['Counts cover the captured files and complete lines, not all historical or currently live requests.',
      'No terminal evidence does not mean running, failed or safe to retry; client cancellation does not prove the engine stopped.',
      'Unfinished admission age includes queue time. It is not service age, remaining time or a stall diagnosis.',
      'Complete without a label is not a failed request. Changed-worker work cannot receive an original-worker label.',
      'Completed-only early scores may underrepresent long jobs. Repeated progress points are not independent requests.',
      'This report changes no labels, candidate, promotion gate, routing or retained evidence.']};
}
if(isMain(import.meta.url))try{
  const args=process.argv.slice(2);if(args.length!==2||args[0]!=='--prepared'||!args[1]||args[1].startsWith('--'))reject('use_prepared_file');
  console.log(JSON.stringify(auditOccupancyCoverage(args[1]),null,2));
}catch(error){console.error(`Coverage audit rejected: ${error.coverageCode??'io_or_parse_error'}`);process.exitCode=1;}
