// Separate offline target contract; never relabel normal-completion histories.
import {PredictionHistory,FEATURE_NAMES,CATEGORICAL,GROUPS} from '../ds4-gateway/prediction-features-v4.mjs';
import {profileFor} from '../ds4-gateway/prediction-features.mjs';
export function replayOccupancy(events,inventory) {
  const history=new PredictionHistory(inventory),rows=[],seen=new Map();let invalid=0;
  const finishes=new Map();
  for(const event of events)if(event?.kind==='finish'){
    const key=event.run_id+':'+event.request_id,variants=finishes.get(key)??new Set();
    variants.add(JSON.stringify(event));finishes.set(key,variants);
  }
  for(const event of [...events].sort((a,b)=>Date.parse(a.time)-Date.parse(b.time))) {
    if(!event?.event_id||!event.run_id||!event.request_id||event.schema!==1){invalid++;continue;}
    const identity=event.run_id+':'+event.event_id,canonical=JSON.stringify(event);
    if(seen.has(identity)){if(seen.get(identity)!==canonical)throw new Error('Conflicting evidence ID');continue;}
    seen.set(identity,canonical);
    if(finishes.get(event.run_id+':'+event.request_id)?.size>1)continue;
    const job=history.getJob(event),at=Date.parse(event.time);
    // Complete terminal responses measure observed service occupancy. A cancelled
    // connection does not prove backend work stopped, so it is not an exact label.
    if(event.kind==='finish'&&job&&!job.invalid&&job.decision.traffic_class!=='genie'&&job.dispatch&&
      event.node===job.decision.node&&Number.isFinite(at)&&at>=Date.parse(job.dispatch.time)&&
      Date.parse(job.dispatch.time)>=Date.parse(job.decision.time)&&event.outcome==='complete'&&
      ['stop','tool_calls','function_call','length'].includes(event.finish_reason)&&
      typeof event.service_ms==='number'&&Number.isFinite(event.service_ms)&&event.service_ms>0&&
      profileFor(inventory,job.decision.candidates?.find(c=>c.node===event.node))) {
      for(const point of job.points)if(point.at<=at){
        const elapsed=point.kind==='remaining'?point.features.elapsed_s:0;
        if(typeof elapsed!=='number'||!Number.isFinite(elapsed)||elapsed<0||elapsed>event.service_ms/1000)continue;
        rows.push({...point,request_id:event.request_id,run_id:event.run_id,group:job.decision.session??'unknown-session',
          decision_time:Date.parse(job.decision.time),finish_time:at,target_s:event.service_ms/1000-elapsed,
          terminal_class:event.finish_reason==='length'?'output_limited':'normal',target_contract:'observed_terminal_occupancy'});
      }
    }
    // In particular, a length finish does NOT enter natural-completion priors.
    history.observe(event);
  }
  return {schema:'dsg-occupancy-v1',feature_schema:'dsg-latency-v4',feature_names:FEATURE_NAMES,categorical:CATEGORICAL,
    groups:GROUPS,rows,invalid,routing_enabled:false,
    limitations:['Offline observed terminal occupancy, not time to an uncapped natural answer.',
      'Cancelled, incomplete and ambiguous endings are not exact occupancy labels.',
      'Normal-completion history priors remain unchanged; output-limit terminal class is a label, never an input feature.']};
}
