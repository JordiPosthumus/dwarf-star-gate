// Dated tool receipts; completed tool calls do not prove a fleet outcome.
export function chatCapabilityActivity(sessions) {
    const latest={};
    for(const session of sessions)for(const message of session.messages)for(const key of ['research','inspection','queue','recovery','media','spark_setup'])for(const event of message[key]?.events??[]){
      if(!['complete','failed'].includes(event.state))continue;
      const at=Date.parse(event.finished_at??event.at);
      if(!Number.isFinite(at)||at<=(latest[key==='queue'?'rebalance':key]?.at??0))continue;
      latest[key==='queue'?'rebalance':key]={at,state:event.state,service:key==='research'?(event.kind==='search'?'Web search':'Page extraction'):key==='queue'?'Queue balancing':key==='spark_setup'?(event.request?.target_id??'Spark setup'):key==='media'?(event.request?.worker_id??'Media jobs'):key==='recovery'?(event.request?.worker_id??'Server recovery'):event.worker_id,error:event.state==='failed'?event.error:null};
    }
    return latest;
  }
