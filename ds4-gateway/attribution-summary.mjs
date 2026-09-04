// Privacy-bounded quality summary for shadow request-to-engine attribution.
// This describes evidence yield; it never upgrades a candidate into protocol proof.
const ID=/^[a-zA-Z0-9][\w-]{0,63}$/;
const SAMPLE=/^[\da-f]{64}$/;
const STATUSES=new Set(['candidate','corroborated','abstained']);
const REASONS=new Set([
  'backend_epoch_unavailable','no_gateway_request_window','overlapping_gateway_windows',
  'overlapping_usage_matches','usage_conflict','request_open','usage_unavailable',
  'multiple_engine_starts','usage_match','usage_disambiguated_overlap',
  'completed_without_usage','censored_or_failed'
]);
const CONFIDENCE=new Set(['none','heuristic','bounded_candidate','high_candidate']);

function safe(raw,index) {
  if(!raw||raw.event!=='engine_attribution'||!ID.test(raw.node??'')||!SAMPLE.test(raw.sample_id??'')||
    !STATUSES.has(raw.status)||!REASONS.has(raw.reason)||!CONFIDENCE.has(raw.confidence))return null;
  const observed=Number.isFinite(raw.observed_at)?raw.observed_at:index;
  return {node:raw.node,sample_id:raw.sample_id,status:raw.status,reason:raw.reason,confidence:raw.confidence,observed};
}

const blank=()=>({corroborated:0,candidate:0,abstained:0});
const percent=(part,total)=>total?Math.round(part/total*1000)/10:null;

export function summarizeAttribution(rows=[]) {
  const latest=new Map();let invalid_records=0;
  for(let i=0;i<rows.length;i++){
    const row=safe(rows[i],i);if(!row){invalid_records++;continue;}
    const key=`${row.node}:${row.sample_id}`,prior=latest.get(key);
    if(!prior||row.observed>=prior.observed)latest.set(key,row);
  }
  const counts=blank(),reason_counts={},workers=new Map();
  let high_confidence=0,bounded_confidence=0;
  for(const row of latest.values()){
    counts[row.status]++;
    const worker=workers.get(row.node)??blank();worker[row.status]++;workers.set(row.node,worker);
    if(row.status==='abstained')reason_counts[row.reason]=(reason_counts[row.reason]??0)+1;
    if(row.status==='corroborated'){
      if(row.confidence==='high_candidate')high_confidence++;
      if(row.confidence==='bounded_candidate')bounded_confidence++;
    }
  }
  const total=counts.corroborated+counts.candidate+counts.abstained;
  const resolved=counts.corroborated+counts.abstained;
  const by_worker=[...workers].sort(([a],[b])=>a.localeCompare(b)).map(([node,value])=>{
    const workerResolved=value.corroborated+value.abstained;
    return {node,...value,total:value.corroborated+value.candidate+value.abstained,resolved:workerResolved,
      corroboration_rate_pct:percent(value.corroborated,workerResolved)};
  });
  return {schema:1,total_starts:total,resolved_starts:resolved,pending_starts:counts.candidate,counts,
    corroboration_rate_pct:percent(counts.corroborated,resolved),high_confidence,bounded_confidence,
    reason_counts:Object.fromEntries(Object.entries(reason_counts).sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]))),
    by_worker,invalid_records,
    note:'Rate denominator is resolved engine starts only. Corroborated remains bounded shadow evidence, not protocol identity or a cache-hit verdict.'};
}
