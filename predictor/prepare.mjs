// Freeze a private evidence snapshot and replay the SAME feature builder used
// by the running gateway. Never copy this output into the published tree.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {featureContract,featureBuilderHash,CURRENT_FEATURE_SCHEMA} from '../ds4-gateway/prediction-feature-registry.mjs';
import {isMain} from '../ds4-gateway/config.mjs';
import {replayOccupancy} from './occupancy.mjs';
import {replayDeliveryOccupancy} from './occupancy-delivery.mjs';
const occupancySchemas=new Set(['dsg-occupancy-v1','dsg-occupancy-v2']);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export function occupancyFeatureHash(schema){
  if(!occupancySchemas.has(schema))throw new Error('Unsupported offline occupancy schema');
  return hash(Buffer.concat([Buffer.from(featureBuilderHash('dsg-latency-v4')),fs.readFileSync(new URL('./occupancy.mjs',import.meta.url)),
    ...(schema==='dsg-occupancy-v2'?[fs.readFileSync(new URL('./occupancy-delivery.mjs',import.meta.url))]:[])]));
}
function cohortTime(value,schema){
  if(value===null)return null;
  if(!occupancySchemas.has(schema))throw new Error('Cohort selection requires the explicit offline occupancy schema');
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value))throw new Error('Cohort start requires a UTC ISO timestamp');
  const at=Date.parse(value),canonical=value.includes('.')?value:value.replace('Z','.000Z');
  if(!Number.isSafeInteger(at)||at<0||new Date(at).toISOString()!==canonical||at>Date.now())throw new Error('Cohort start must be a valid past UTC timestamp');
  return at;
}
export function selectOccupancyCohort(dataset,since){
  const at=cohortTime(since,dataset.schema);if(at===null)return null;
  const first=new Map();
  for(const row of dataset.rows){
    if(!Number.isSafeInteger(row.decision_time)||row.decision_time<0)throw new Error('Invalid cohort admission time');
    const key=JSON.stringify([row.run_id,row.request_id]);first.set(key,Math.min(first.get(key)??Infinity,row.decision_time));
  }
  const selected=new Set([...first].filter(([,time])=>time>=at).map(([key])=>key));
  const before=dataset.rows.length;
  // Replay full history FIRST. Older completed calls remain causal priors;
  // later progress on an earlier-admitted request cannot enter this cohort.
  dataset.rows=dataset.rows.filter(row=>selected.has(JSON.stringify([row.run_id,row.request_id])));
  return {schema:1,kind:'admitted_since',since:new Date(at).toISOString(),
    source_points:before,selected_points:dataset.rows.length,excluded_points:before-dataset.rows.length,
    source_requests:first.size,selected_requests:selected.size,excluded_requests:first.size-selected.size,
    selector_sha256:hash(fs.readFileSync(new URL('./prepare.mjs',import.meta.url)))};
}
export function prepare(data,profiles,output,schema=CURRENT_FEATURE_SCHEMA,{cohortSince=null}={}) {
  cohortTime(cohortSince,schema);
  if(fs.existsSync(output))throw new Error('Candidate directory already exists');
  const files=fs.readdirSync(data).filter(f=>/^routing-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort(),events=[],blobs=[];let bytes=0;
  for(const name of files){const full=path.join(data,name);if(!fs.lstatSync(full).isFile())throw new Error('Evidence must be a regular file');const fd=fs.openSync(full,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const size=fs.fstatSync(fd).size;bytes+=size;if(bytes>128*1024**2)throw new Error('Training snapshot exceeds 128 MiB; no input silently discarded');const b=Buffer.alloc(size);let n=0;while(n<size){const r=fs.readSync(fd,b,n,size-n,n);if(!r)throw new Error('Evidence shrank during snapshot');n+=r;}blobs.push({name,bytes:b});const text=b.toString('utf8'),end=text.lastIndexOf('\n');for(const line of text.slice(0,end<0?0:end).split('\n').filter(Boolean))events.push(JSON.parse(line));}finally{fs.closeSync(fd);}}
  if(!files.length)throw new Error('No evidence files');
  if(!fs.lstatSync(profiles).isFile())throw new Error('Inventory must be a regular file');const inventoryBytes=fs.readFileSync(profiles),inventory=JSON.parse(inventoryBytes);
  if(inventory.schema!==1||!inventory.workers)throw new Error('Versioned worker inventory required');
  const occupancy=occupancySchemas.has(schema);
  const dataset=schema==='dsg-occupancy-v2'?replayDeliveryOccupancy(events,inventory):occupancy?replayOccupancy(events,inventory):featureContract(schema).replay(events,inventory);if(dataset.rows.length>100000)throw new Error('Prepared data exceeds bounded trainer row budget');
  const cohort=selectOccupancyCohort(dataset,cohortSince);
  fs.mkdirSync(path.join(output,'snapshots'),{recursive:true,mode:0o700});
  for(const b of blobs)fs.writeFileSync(path.join(output,'snapshots',b.name),b.bytes,{flag:'wx',mode:0o600});
  fs.writeFileSync(path.join(output,'snapshots','worker-inventory.json'),inventoryBytes,{flag:'wx',mode:0o600});
  dataset.snapshot={created_at:new Date().toISOString(),bytes,hashes:Object.fromEntries([...blobs.map(b=>[b.name,hash(b.bytes)]),['worker-inventory.json',hash(inventoryBytes)]]),feature_builder_sha256:occupancy?occupancyFeatureHash(schema):featureBuilderHash(schema)};
  if(cohort)dataset.snapshot.cohort=cohort;
  fs.writeFileSync(path.join(output,'prepared.json'),JSON.stringify(dataset)+'\n',{flag:'wx',mode:0o600});return {rows:dataset.rows.length,kinds:Object.fromEntries(['admission','updated','remaining'].map(k=>[k,dataset.rows.filter(r=>r.kind===k).length])),snapshot:dataset.snapshot};
}
export function prepareArgs(args){
  const allowed=new Set(['--data','--profiles','--output','--schema','--cohort-since']),values=new Map();
  for(let i=0;i<args.length;i+=2){
    const key=args[i],value=args[i+1];
    if(!allowed.has(key)||values.has(key)||!value||value.startsWith('--'))throw new Error('Unknown, duplicate or incomplete preparation option');
    values.set(key,value);
  }
  const get=key=>{if(!values.has(key))throw new Error('Use --data --profiles --output');return path.resolve(values.get(key));};
  return [get('--data'),get('--profiles'),get('--output'),values.get('--schema')??CURRENT_FEATURE_SCHEMA,{cohortSince:values.get('--cohort-since')??null}];
}
if(isMain(import.meta.url))try{console.log(JSON.stringify(prepare(...prepareArgs(process.argv.slice(2)))));}catch(e){console.error(e.message);process.exitCode=1;}
