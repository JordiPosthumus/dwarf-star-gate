// Explicit opt-in challenger contract. Existing V2/V3 artifacts stay unchanged.
import * as v3 from './prediction-features-v3.mjs';
import {hardwareFeatures,HARDWARE_FEATURES,HARDWARE_CATEGORICAL} from './prediction-hardware.mjs';
export const FEATURE_SCHEMA='dsg-latency-v4';
export const GROUPS={...v3.GROUPS,hardware:HARDWARE_FEATURES};
export const FEATURE_NAMES=[...v3.FEATURE_NAMES,...HARDWARE_FEATURES];
export const CATEGORICAL=[...v3.CATEGORICAL,...HARDWARE_CATEGORICAL];
export class PredictionHistory extends v3.PredictionHistory {
  snapshot(job,stage,at,progress=null,candidate=null){
    const point=super.snapshot(job,stage,at,progress,candidate);
    const c=candidate??job.decision.candidates?.find(w=>w.node===point.node);
    // Never backfill an earlier stage with a later measurement. A missing
    // progress snapshot is unknown, rather than recycling admission telemetry.
    const sample=stage==='admission'?c?.hardware:progress?.hardware;
    Object.assign(point.features,hardwareFeatures(sample,at,point.node));
    return point;
  }
}
export function replay(events,inventory){
  const history=new PredictionHistory(inventory),rows=[],seen=new Map();let invalid=0;
  for(const row of [...events].sort((a,b)=>Date.parse(a.time)-Date.parse(b.time))){
    if(!row?.event_id||!row.run_id||!row.request_id||row.schema!==1){invalid++;continue;}
    const key=row.run_id+':'+row.event_id,canonical=JSON.stringify(row);
    if(seen.has(key)){if(seen.get(key)!==canonical)throw new Error('Conflicting evidence ID');continue;}seen.set(key,canonical);
    rows.push(...history.observe(row).rows);
  }
  return {schema:FEATURE_SCHEMA,feature_names:FEATURE_NAMES,categorical:CATEGORICAL,groups:GROUPS,rows,invalid};
}
