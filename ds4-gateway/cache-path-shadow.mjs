// Four-path cache acquisition comparison. Pure shadow evidence: no routing,
// cache reads, transfer, replay or model calls.
import {cacheCompatibility} from './cache-inventory.mjs';

const PATHS=['wait_hot','local_restore','remote_acquisition','cold_prefill'];
const WORKER=/^[a-zA-Z0-9][\w-]{0,63}$/;
const COMPONENT_STATUS=new Set(['measured','validated_forecast','unvalidated_estimate']);
const AVAILABILITY=new Set(['observed','absent','unknown']);
const MAX_MS=30*24*3600000;
const PATH_FIELDS={
  wait_hot:new Set(['availability','worker','wait','suffix_prefill','generation']),
  local_restore:new Set(['availability','compatibility','worker','wait','restore','suffix_prefill','generation']),
  remote_acquisition:new Set(['availability','compatibility','protocol','worker','source_worker','wait','transfer','import_restore','suffix_prefill','generation','parallel_staging_verified']),
  cold_prefill:new Set(['availability','worker','wait','prefill','generation'])
};

function component(value,name){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['ms','status'].includes(key))||!Number.isFinite(value.ms)||value.ms<0||value.ms>MAX_MS||!COMPONENT_STATUS.has(value.status))return {error:`${name}_unavailable`};
  return {name,ms:value.ms,status:value.status};
}
function worker(value){return typeof value==='string'&&WORKER.test(value)?value:null;}
function unknown(id,reasons,details={}){return {id,status:'unknown',estimated_ms:null,reasons:[...new Set(reasons)],components:[],...details};}
function excluded(id,reason,details={}){return {id,status:'excluded',estimated_ms:null,reasons:[reason],components:[],...details};}
function ready(id,components,formula,details={}){
  const validation=components.every(item=>item.status!=='unvalidated_estimate')?'bounded_components':'unvalidated_components';
  return {id,status:'estimated',estimated_ms:formula(components),validation,reasons:[],components:components.map(({name,ms,status})=>({name,ms,status})),...details};
}
function gate(input,id,{compatibility=false,protocol=false}={}){
  if(!input||typeof input!=='object'||Array.isArray(input))return unknown(id,[`${id}_evidence_unavailable`]);
  const availability=AVAILABILITY.has(input.availability)?input.availability:'unknown',target=worker(input.worker);
  if(availability==='absent')return excluded(id,`${id}_unavailable`,{worker:target});
  if(availability!=='observed')return unknown(id,[`${id}_availability_unverified`],{worker:target});
  if(!target)return unknown(id,[`${id}_worker_unverified`]);
  if(compatibility){
    if(input.compatibility==='incompatible')return excluded(id,`${id}_incompatible`,{worker:target});
    if(input.compatibility!=='compatible')return unknown(id,[`${id}_compatibility_unverified`],{worker:target});
  }
  if(protocol){
    const source=worker(input.source_worker);
    if(input.protocol==='unavailable')return excluded(id,'remote_protocol_unavailable',{worker:target,source_worker:source});
    if(input.protocol!=='validated')return unknown(id,['remote_protocol_unverified'],{worker:target,source_worker:source});
    if(!source)return unknown(id,['remote_source_worker_unverified'],{worker:target});
  }
  return null;
}

export function compareCachePaths(raw={}){
  if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).some(key=>!PATHS.includes(key)))throw new Error('Cache path evidence must contain only the four named paths');
  for(const id of PATHS){
    const value=raw[id];
    if(value!==undefined&&value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).some(key=>!PATH_FIELDS[id].has(key)))throw new Error(`${id} contains unsupported evidence fields`);
  }
  const paths={};let blocked;

  blocked=gate(raw.wait_hot,'wait_hot');
  if(blocked)paths.wait_hot=blocked;else{
    const values=[component(raw.wait_hot.wait,'wait'),component(raw.wait_hot.suffix_prefill,'suffix_prefill'),component(raw.wait_hot.generation,'generation')],errors=values.filter(item=>item.error).map(item=>item.error);
    paths.wait_hot=errors.length?unknown('wait_hot',errors,{worker:worker(raw.wait_hot.worker)}):ready('wait_hot',values,rows=>rows.reduce((sum,item)=>sum+item.ms,0),{worker:worker(raw.wait_hot.worker),critical_path:'wait + suffix prefill + generation'});
  }

  blocked=gate(raw.local_restore,'local_restore',{compatibility:true});
  if(blocked)paths.local_restore=blocked;else{
    const values=[component(raw.local_restore.wait,'wait'),component(raw.local_restore.restore,'restore'),component(raw.local_restore.suffix_prefill,'suffix_prefill'),component(raw.local_restore.generation,'generation')],errors=values.filter(item=>item.error).map(item=>item.error);
    paths.local_restore=errors.length?unknown('local_restore',errors,{worker:worker(raw.local_restore.worker)}):ready('local_restore',values,rows=>rows.reduce((sum,item)=>sum+item.ms,0),{worker:worker(raw.local_restore.worker),critical_path:'wait + restore + suffix prefill + generation'});
  }

  blocked=gate(raw.remote_acquisition,'remote_acquisition',{compatibility:true,protocol:true});
  if(blocked)paths.remote_acquisition=blocked;else{
    const values=[component(raw.remote_acquisition.wait,'wait'),component(raw.remote_acquisition.transfer,'transfer'),component(raw.remote_acquisition.import_restore,'import_restore'),component(raw.remote_acquisition.suffix_prefill,'suffix_prefill'),component(raw.remote_acquisition.generation,'generation')],errors=values.filter(item=>item.error).map(item=>item.error),parallel=raw.remote_acquisition.parallel_staging_verified===true;
    if(raw.remote_acquisition.parallel_staging_verified!==true&&raw.remote_acquisition.parallel_staging_verified!==false)errors.push('remote_staging_overlap_unverified');
    const details={worker:worker(raw.remote_acquisition.worker),source_worker:worker(raw.remote_acquisition.source_worker),parallel_staging_verified:parallel};
    paths.remote_acquisition=errors.length?unknown('remote_acquisition',errors,details):ready('remote_acquisition',values,rows=>{
      const byName=Object.fromEntries(rows.map(item=>[item.name,item.ms]));return (parallel?Math.max(byName.wait,byName.transfer):byName.wait+byName.transfer)+byName.import_restore+byName.suffix_prefill+byName.generation;
    },{...details,critical_path:parallel?'max(wait, transfer) + import + suffix prefill + generation':'wait + transfer + import + suffix prefill + generation'});
  }

  blocked=gate(raw.cold_prefill,'cold_prefill');
  if(blocked)paths.cold_prefill=blocked;else{
    const values=[component(raw.cold_prefill.wait,'wait'),component(raw.cold_prefill.prefill,'prefill'),component(raw.cold_prefill.generation,'generation')],errors=values.filter(item=>item.error).map(item=>item.error);
    paths.cold_prefill=errors.length?unknown('cold_prefill',errors,{worker:worker(raw.cold_prefill.worker)}):ready('cold_prefill',values,rows=>rows.reduce((sum,item)=>sum+item.ms,0),{worker:worker(raw.cold_prefill.worker),critical_path:'wait + cold prefill + generation'});
  }

  const ranked=Object.values(paths).filter(path=>path.status==='estimated').sort((a,b)=>a.estimated_ms-b.estimated_ms||PATHS.indexOf(a.id)-PATHS.indexOf(b.id)).map(path=>({id:path.id,estimated_ms:path.estimated_ms,validation:path.validation}));
  const complete=!Object.values(paths).some(path=>path.status==='unknown');
  return {schema:1,mode:'shadow_only',authority:'none',validation:'unvalidated_composition',complete,paths,ranked,best_known:ranked[0]?.id??null,would_prefer:complete?ranked[0]?.id??null:null,
    note:'A shadow comparison is not permission to route, move, copy, load or delete a cache. Unknown paths block a winner.'};
}

export function snapshotPresence(inventory,snapshot_ref,target_profile,{now=Date.now(),max_age_ms=120000,reject_different_quant=false}={}){
  if(typeof snapshot_ref!=='string'||!/^[\da-f]{64}$/.test(snapshot_ref)||!Number.isFinite(now)||!Number.isSafeInteger(max_age_ms)||max_age_ms<1000||max_age_ms>3600000)return {status:'unknown',reason:'invalid_inventory_query'};
  if(inventory?.schema!==1||inventory?.source!=='stock_ds4_kvstore_headers'||inventory?.privacy!=='installation_keyed_hmac'||inventory?.status!=='ready'||!Array.isArray(inventory.entries)||!Number.isFinite(inventory.observed_at)||inventory.observed_at>now||now-inventory.observed_at>max_age_ms)return {status:'unknown',reason:'inventory_unavailable_or_stale'};
  const matches=inventory.entries.filter(candidate=>candidate?.snapshot_ref===snapshot_ref);
  if(matches.length>1)return {status:'unknown',reason:'ambiguous_snapshot_reference'};
  const entry=matches[0];
  if(!entry){
    if(inventory.capped)return {status:'unknown',reason:'inventory_capped'};
    if(inventory.capped!==false)return {status:'unknown',reason:'inventory_completeness_unverified'};
    if(!Number.isSafeInteger(inventory.rejected)||inventory.rejected!==0)return {status:'unknown',reason:'inventory_incomplete'};
    return {status:'absent',reason:'complete_scan_no_match',observed_at:inventory.observed_at};
  }
  const compatibility=cacheCompatibility(entry,target_profile,{reject_different_quant});
  if(compatibility.status==='incompatible')return {status:'incompatible',reason:compatibility.reasons[0],observed_at:inventory.observed_at};
  if(compatibility.status!=='compatible')return {status:'unknown',reason:compatibility.reasons[0],observed_at:inventory.observed_at};
  return {status:'observed',reason:'fresh_header_match',observed_at:inventory.observed_at,tokens:entry.tokens,file_bytes:entry.file_bytes,compatibility:'compatible'};
}
