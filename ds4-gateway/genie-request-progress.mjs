// Transient local UI evidence only: never saved as model context or action authority.
export function withGatewayProgress(conversation,snapshot){
  const valid=!!snapshot&&snapshot.genie_progress_version===1&&snapshot.jobs_truncated!==true&&Number.isFinite(snapshot.observed_at)&&Array.isArray(snapshot.jobs);
  return {...conversation,messages:conversation.messages.map(message=>{
    if(message.state!=='working'||!message.gateway_call_id)return message;
    const matches=valid?snapshot.jobs.filter(job=>job.traffic_class==='genie'&&job.call_id===message.gateway_call_id):[];
    let execution={state:valid?(matches.length?'ambiguous':'not_observed'):'unavailable',observed_at:valid?snapshot.observed_at:null};
    const job=matches.length===1?matches[0]:null;
    if(job&&['running','queued','blocked'].includes(job.state)&&typeof job.request_id==='string')execution={state:job.state,observed_at:snapshot.observed_at,
      request_id:job.request_id,machine:typeof job.machine==='string'&&/^[a-zA-Z0-9][\w-]{0,63}$/.test(job.machine)?job.machine:null};
    return {...message,gateway_execution:execution};
  })};
}
