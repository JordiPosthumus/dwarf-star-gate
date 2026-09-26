import {machinesFor} from './fleet-machines.mjs';

const released=new Set(['returned','failed_returned','failed_unchanged','enrolled','qualified_returned','candidate_prepared','promoted']);
const physical=(worker,config)=>{
  if(typeof worker!=='string'||!worker)throw Error('Media physical ownership is unverified');
  const ids=machinesFor(worker,config);
  if(!Array.isArray(ids)||!ids.length||ids.some(id=>typeof id!=='string'||!id.trim())||new Set(ids).size!==ids.length)throw Error('Media physical ownership is unverified');
  return ids;
};
export function mediaSparkLimit(config){
  const value=config.media_jobs?.max_borrowed_sparks;
  if(value===undefined)return null;
  if(!Number.isSafeInteger(value)||value<0)throw Error('media_jobs.max_borrowed_sparks must be a non-negative whole physical-Spark count');
  return value;
}
export function mediaBudget(config,jobs=[],setups=[]){
  const limit=mediaSparkLimit(config),occupied=new Set(),owners=[];
  for(const row of [...jobs.map(j=>j.execution).filter(Boolean),...setups]){
    if(released.has(row.phase))continue;
    const current=physical(row.worker_id,config),saved=row.physical_machines??current;
    if(!Array.isArray(saved)||!saved.length||saved.some(id=>typeof id!=='string'||!id.trim()))throw Error('Media saved physical ownership is unverified');
    // A changed mapping must not erase an earlier reservation. The union is
    // conservative until the original operation has a verified return receipt.
    for(const id of [...saved,...current])occupied.add(id);
    owners.push({worker_id:row.worker_id,machines:[...new Set([...saved,...current])]});
  }
  const snapshot={max_borrowed_sparks:limit,borrowed_sparks:occupied.size,
    remaining_sparks:limit===null?null:Math.max(0,limit-occupied.size),over_budget:limit!==null&&occupied.size>limit};
  const admission=worker=>{
    const machines=physical(worker,config);
    if(machines.some(id=>occupied.has(id)))return {allowed:false,reason:'Media already owns an overlapping physical machine',sparks_required:machines.length,machines};
    return {allowed:limit===null||occupied.size+machines.length<=limit,
      reason:limit!==null&&occupied.size+machines.length>limit?'Media physical-Spark budget is currently exhausted':null,
      sparks_required:machines.length,machines};
  };
  return {snapshot,admission,owners};
}
