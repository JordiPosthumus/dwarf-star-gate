// Causal, numerical hardware inputs. This contract does not infer idle state,
// wall power, or zero usage from a missing sensor. Collection is independent.
export const HARDWARE_FEATURES=['hardware_sample_age_s','hardware_memory_used_fraction','hardware_memory_available_gib','hardware_activity_pct','hardware_power_watts','hardware_clock_mhz','hardware_memory_scope','hardware_activity_scope','hardware_power_scope','hardware_clock_scope'];
export const HARDWARE_CATEGORICAL=['hardware_memory_scope','hardware_activity_scope','hardware_power_scope','hardware_clock_scope'];
const bounded=(x,min,max)=>typeof x==='number'&&Number.isFinite(x)&&x>=min&&x<=max;
export function hardwareFeatures(sample,at,node) {
  const f=Object.fromEntries(HARDWARE_FEATURES.map(k=>[k,null]));
  if(!sample||sample.node!==node||!bounded(at,1,Number.MAX_SAFE_INTEGER)||
    !bounded(sample.time,1,at)||!bounded(sample.observed_at,sample.time,at)||
    at-sample.time>60000)return f;
  f.hardware_sample_age_s=(at-sample.time)/1000;
  if(['host','host_unified'].includes(sample.memory_scope)&&bounded(sample.memory_total_bytes,1,2**60)&&bounded(sample.memory_used_bytes,0,sample.memory_total_bytes)){
    f.hardware_memory_used_fraction=sample.memory_used_bytes/sample.memory_total_bytes;
    f.hardware_memory_available_gib=(sample.memory_total_bytes-sample.memory_used_bytes)/2**30;
    f.hardware_memory_scope=sample.memory_scope;
  }
  for(const [field,feature,scope,allowed,max] of [
    ['accelerator_activity_pct','activity_pct','accelerator_scope',['gpu_kernel_time','accelerator'],100],
    ['power_watts','power_watts','power_scope',['gpu_only','compute_module','system'],5000],
    ['clock_mhz','clock_mhz','clock_scope',['sm','accelerator'],100000]
  ])if(allowed.includes(sample[scope])&&bounded(sample[field],0,max)){
    f['hardware_'+feature]=sample[field];
    f['hardware_'+(field==='accelerator_activity_pct'?'activity':field==='power_watts'?'power':'clock')+'_scope']=sample[scope];
  }
  return f;
}
