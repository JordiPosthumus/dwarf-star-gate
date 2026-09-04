// Bounded comparator for genuinely new/unaffined work. It may break only a real
// deterministic load tie, and only when every tied worker has fresh forecasts
// from deployed validated models. Established session homes never enter here.
const finite=n=>Number.isFinite(n)&&n>=0;
const workerId=value=>typeof value==='string'&&/^[\w-]{1,64}$/.test(value)?value:null;

function forecastCost(node,forecasts,now,maxAgeMs) {
  let seconds=0,evidence=[];
  if(node.active){
    const f=forecasts(node.active.id)?.remaining,age=finite(f?.at)?now-f.at:null;
    if(!f||f.experimental||!finite(f.seconds)||!finite(age)||age>maxAgeMs||f.seconds<=age/1000)return {status:'missing_active_remaining',seconds:null};
    seconds+=f.seconds-age/1000;evidence.push('active_remaining');
  }
  for(const job of node.queue??[]){
    if(job.cancelled)continue;
    const f=forecasts(job.id)?.admission;
    if(!f||f.experimental||!finite(f.seconds))return {status:'missing_queued_service',seconds:null};
    seconds+=f.seconds;evidence.push('queued_service');
  }
  return {status:'supported',seconds,evidence};
}

export function compareFallbackTieBreak(nodes,selected,forecasts,{now=Date.now(),maxAgeMs=60000}={}) {
  const candidates=(nodes??[]).filter(node=>workerId(node?.id));
  const load=node=>Number(!!node.active)+(node.queue??[]).filter(job=>!job.cancelled).length;
  const selectedId=workerId(selected?.id),minimum=candidates.length?Math.min(...candidates.map(load)):null;
  const tied=minimum===null?[]:candidates.filter(node=>load(node)===minimum);
  const base={schema:1,mode:'active_with_abstention',policy:'validated_remaining_tiebreak',selected:selectedId,minimum_load:minimum,candidates:[],alternative:null};
  if(tied.length<2)return {...base,verdict:'not_tied'};
  if(minimum===0)return {...base,verdict:'free_tie',candidates:tied.map(node=>({node:node.id,load:0,status:'immediately_free',predicted_wait_seconds:0}))};
  const costs=tied.map(node=>{try{return {node,load:minimum,...forecastCost(node,forecasts,now,maxAgeMs)};}catch{return {node,load:minimum,status:'forecast_unavailable',seconds:null};}});
  const visible=costs.map(cost=>({node:cost.node.id,load:cost.load,status:cost.status,predicted_wait_seconds:cost.seconds,evidence:cost.evidence??[]}));
  if(costs.some(cost=>cost.status!=='supported'))return {...base,verdict:'insufficient_evidence',candidates:visible};
  costs.sort((a,b)=>a.seconds-b.seconds||a.node.id.localeCompare(b.node.id));
  const alternative=costs[0].node.id;
  return {...base,verdict:alternative===selectedId?'would_keep':'would_change',alternative,candidates:visible};
}

export function selectFallbackTieBreak(nodes,selected,result) {
  if(result?.mode!=='active_with_abstention'||result.verdict!=='would_change')return selected;
  const alternative=(nodes??[]).find(node=>node.id===result.alternative);
  const eligible=node=>node&&node.healthy&&!node.drained&&!node.quarantine&&!node.recovering&&!node.removed;
  if(!eligible(selected)||!eligible(alternative))return selected;
  const load=node=>Number(!!node.active)+(node.queue??[]).filter(job=>!job.cancelled).length;
  return load(alternative)===load(selected)?alternative:selected;
}
