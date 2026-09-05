// Offline experiment only. Never emits a prepared dataset or changes collection.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {isMain} from '../ds4-gateway/config.mjs';
import {featureContract,featureBuilderHash,CURRENT_FEATURE_SCHEMA} from '../ds4-gateway/prediction-feature-registry.mjs';
import {replayOccupancy} from './occupancy.mjs';
import {replayDeliveryOccupancy} from './occupancy-delivery.mjs';
import {occupancyFeatureHash} from './prepare.mjs';
import {TRAINING_INPUT_LIMIT,trainingInputAudit} from './training-input.mjs';

const common=['schema','event_id','run_id','request_id','kind','node','time'];
const byKind=new Map([
  ['decision',['session','traffic_class','candidates','candidates_truncated','affinity','client_metadata','admission_wait_ms']],
  ['request_features',['status','available_at','latest_characters','recent_characters','visible_messages_considered','requested_thinking',
    'request_bytes','message_count','user_messages','assistant_messages','system_messages','tool_messages','hardware',
    'text_characters','image_parts','tool_definitions','max_output_tokens','temperature','top_p','request_stream','request_route']],
  ['embedding',['status','available_at','dimensions','vectors','hardware']],
  ['progress',['hardware','active_elapsed_ms','phase','semantic_characters','semantic_age_ms','thinking_characters','answer_characters','tool_characters']],
  ['finish',['outcome','finish_reason','service_ms','usage','generation','requested_thinking']]
]);
const knownKinds=new Set(['decision','dispatch','request_features','embedding','progress','finish',
  'queued_cancel','queue_timeout','unavailable_before_dispatch','queue_relocation','model_prediction',
  'routing_shadow','routing_tiebreak_shadow','rejection','waiting']);
const hash=x=>createHash('sha256').update(x).digest('hex');
function reject(code){throw Object.assign(new Error(code),{projectionCode:code});}
function contract(schema){
  if(schema==='dsg-occupancy-v1')return {replay:replayOccupancy,hash:occupancyFeatureHash(schema)};
  if(schema==='dsg-occupancy-v2')return {replay:replayDeliveryOccupancy,hash:occupancyFeatureHash(schema)};
  if(!['dsg-latency-v2','dsg-latency-v3','dsg-latency-v4'].includes(schema))reject('unsupported_schema');
  return {replay:featureContract(schema).replay,hash:featureBuilderHash(schema)};
}
export function projectReplayEvent(event){
  if(!event||typeof event!=='object'||Array.isArray(event))reject('invalid_event_object');
  const projected=Object.fromEntries([...common,...(byKind.get(event.kind)??[])].filter(key=>Object.hasOwn(event,key)).map(key=>[key,event[key]]));
  // Preserve the original replay's JSON-string duplicate/conflict distinction,
  // even if the only differing field is otherwise unused by feature builders.
  // This hash is NOT anonymization, an upstream identity, or a substitute for raw evidence.
  projected.dsg_projection_source_sha256=hash(JSON.stringify(event));
  return projected;
}
export function auditReplayProjection(events,inventory,{schema=CURRENT_FEATURE_SCHEMA}={}){
  const c=contract(schema);
  if(!Array.isArray(events)||events.length>200000)reject('event_budget');
  const projected=[],kinds={},sourceHash=createHash('sha256');let rawBytes=0,projectedBytes=0;
  for(const event of events){
    const original=JSON.stringify(event)+'\n',p=projectReplayEvent(event),packed=JSON.stringify(p)+'\n';
    const before=Buffer.byteLength(original),after=Buffer.byteLength(packed);
    rawBytes+=before;projectedBytes+=after;if(rawBytes>TRAINING_INPUT_LIMIT)reject('canonical_byte_budget');
    sourceHash.update(original);projected.push(p);
    const kind=knownKinds.has(event.kind)?event.kind:'other';
    const count=kinds[kind]??={events:0,canonical_bytes:0,projected_bytes:0};
    count.events++;count.canonical_bytes+=before;count.projected_bytes+=after;
  }
  const original=c.replay(events,inventory),candidate=c.replay(projected,inventory);
  if(original.rows.length>100000||candidate.rows.length>100000)reject('row_budget');
  const {rows:a,...metaA}=original,{rows:b,...metaB}=candidate;
  let changedRows=0;for(let i=0;i<Math.max(a.length,b.length);i++)if(!isDeepStrictEqual(a[i],b[i]))changedRows++;
  return {schema:1,experiment:'forecast_replay_projection',authority:'none',production_enabled:false,
    feature_schema:schema,feature_builder_sha256:c.hash,projector_sha256:hash(fs.readFileSync(new URL(import.meta.url))),
    source_canonical_sha256:sourceHash.digest('hex'),inventory_canonical_sha256:hash(JSON.stringify(inventory)),
    events:events.length,canonical_bytes:rawBytes,projected_bytes:projectedBytes,
    saved_bytes:rawBytes-projectedBytes,saved_fraction:rawBytes?(rawBytes-projectedBytes)/rawBytes:null,
    parity:isDeepStrictEqual(original,candidate),metadata_equal:isDeepStrictEqual(metaA,metaB),
    original_rows:a.length,projected_rows:b.length,changed_rows:changedRows,kinds,
    limitations:['Exact comparison covers only this input and these builder versions.',
      'Unused fields remain necessary for other audits; raw source must be retained.',
      'Projected events and prepared datasets are not written or accepted by this command.',
      'This does not change snapshot budgets, history windows, training or routing.']};
}
function readBounded(file,max){
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
  try{
    const stat=fs.fstatSync(fd);if(!stat.isFile()||!Number.isSafeInteger(stat.size)||stat.size<0||stat.size>max)reject('input_byte_budget');
    const b=Buffer.alloc(stat.size);let offset=0;
    while(offset<b.length){const n=fs.readSync(fd,b,offset,b.length-offset,offset);if(!n)reject('input_shrank');offset+=n;}
    return b;
  }finally{fs.closeSync(fd);}
}
export function loadProjectionFiles(data,profiles){
  const audit=trainingInputAudit(data);if(audit.state!=='within_budget')reject('input_'+audit.state);
  const inventoryRaw=readBounded(profiles,1024**2),inventory=JSON.parse(inventoryRaw);
  if(inventory?.schema!==1||!inventory.workers||typeof inventory.workers!=='object'||Array.isArray(inventory.workers))reject('invalid_inventory');
  const events=[],hashes={};let bytes=0,tails=0;
  for(const {name} of audit.files){
    const raw=readBounded(path.join(data,name),TRAINING_INPUT_LIMIT-bytes);bytes+=raw.length;hashes[name]=hash(raw);
    const text=raw.toString('utf8'),end=text.lastIndexOf('\n');if(end!==text.length-1)tails++;
    for(const line of text.slice(0,end<0?0:end).split('\n').filter(Boolean)){
      if(events.length>=200000)reject('event_budget');events.push(JSON.parse(line));
    }
  }
  return {events,inventory,source:{bytes,files:audit.file_count,incomplete_tails:tails,hashes,inventory_sha256:hash(inventoryRaw)}};
}
export function auditProjectionFiles(data,profiles,options={}){
  contract(options.schema??CURRENT_FEATURE_SCHEMA);
  const {events,inventory,source}=loadProjectionFiles(data,profiles);
  return {...auditReplayProjection(events,inventory,options),source};
}
export function projectionArgs(args){
  const values=new Map();
  for(let i=0;i<args.length;i+=2){const k=args[i],v=args[i+1];
    if(!['--data','--profiles','--schema'].includes(k)||values.has(k)||!v||v.startsWith('--'))reject('invalid_arguments');values.set(k,v);}
  if(!values.has('--data')||!values.has('--profiles'))reject('invalid_arguments');
  return [path.resolve(values.get('--data')),path.resolve(values.get('--profiles')),{schema:values.get('--schema')??CURRENT_FEATURE_SCHEMA}];
}
if(isMain(import.meta.url))try{
  const result=auditProjectionFiles(...projectionArgs(process.argv.slice(2)));console.log(JSON.stringify(result));if(!result.parity)process.exitCode=1;
}catch(e){console.error('Projection audit failed: '+(e.projectionCode??'invalid_input_or_replay'));process.exitCode=1;}
