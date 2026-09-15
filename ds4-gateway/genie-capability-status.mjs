export function capabilityStatus(snapshot,{genie={},chat={},operations={},hourglass={},activity={},management=false}={}){
  const g=snapshot.gateway??{},switches=g.genie_capabilities??{},configured=chat.capabilities_configured??{};
  const current=operations.operations?.[0];
  const recovery=g.recovery??{},unbound=(recovery.workers??[]).filter(w=>w.enrollment?.binding!=='matched');
  const bound=(recovery.workers??[]).filter(w=>w.enrollment?.binding==='matched');
  const rows=[
    ['fleet_reviews','Routine fleet reviews',genie.configured,genie.error?'Failed':genie.busy?'Working':genie.enabled?'Ready':'Genie reviewer is off',genie.error??'Periodic checks of fleet health. Queue balancing has its own switch.'],
    ['rebalance','Queue balancing',management,genie.enabled===false&&!configured.rebalance?'Genie reviewer is off':'Ready','Genie may move waiting jobs to an eligible idle server, from chat or fleet reviews. Running jobs finish.'],
    ['recovery','Server recovery',recovery.configured,unbound.length?(bound.length?'Partly connected':'Not connected'):'Monitoring',unbound.length?`${bound.length?`Connected: ${bound.map(w=>w.worker_id).join(', ')}. `:''}Recovery service needs connecting: ${unbound.map(w=>w.worker_id).join(', ')}.`:'Uses the existing recovery runner and service permissions.'],
    ['research','Public web research',configured.research,'Ready','Genie can search public sources while answering.'],
    ['inspection','Server inspection',configured.inspection,'Ready','Genie can read configuration records and inspect connected servers.'],
    ['server_changes','Server changes',operations.configured,current?.error?'Failed':current?.state==='awaiting_approval'?'Waiting for approval':'Ready',current?.error??'Genie prepares changes; each exact change still needs your approval.'],
    ['hourglass','Hourglass measurements',hourglass.configured,hourglass.error?'Failed':'Ready',hourglass.error??'Prepare measurements and observe results. Starting a run needs your approval.'],
  ];
  return {capabilities:rows.map(([key,label,available,status,detail])=>({key,label,available:Boolean(management&&g.genie_capabilities),connected:Boolean(available&&(key!=='recovery'||bound.length>0)),enabled:key==='recovery'?recovery.automatic===true:switches[key]!==false,status:switches[key]===false||key==='recovery'&&!recovery.automatic?(!available?'Off · not connected':'Off'):!available?'Not connected':activity[key]?.state==='failed'?'Last attempt failed':status,detail:activity[key]?.state==='failed'?`${activity[key].service}: ${activity[key].error??'Request failed'}`:detail})),
    services:(g.workers??[]).map(w=>{const r=recovery.workers?.find(r=>r.worker_id===w.id);return {id:w.id,status:w.drained?'Paused':w.is_healthy?'Serving':'Unavailable',detail:w.quarantine?.reason?.replaceAll('_',' ')??(!w.is_healthy?(r?.reason??'Health check failed').replaceAll('_',' '):'')};})};
}
