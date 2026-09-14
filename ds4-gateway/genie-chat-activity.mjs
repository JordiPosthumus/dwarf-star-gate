// Read-only projection of existing operational receipts. Never notebook prose,
// inference content, recovery commands, current action offers or new authority.
const worker=value=>typeof value==='string'&&/^[a-zA-Z0-9][\w-]{0,63}$/.test(value)?value:null;
const id=value=>typeof value==='string'&&/^[a-f0-9-]{36}$/.test(value)?value:null;
const time=value=>Number.isSafeInteger(value)&&value>=0?value:null;
const choice=(value,allowed)=>allowed.includes(value)?value:null;
const providers=['dedicated','pool','pool_assigned','pool_fallback'];
const recoveryStates=['queued','reconciling','starting','restarting','verifying','recovered','verified_paused','failed','reconciliation_needed'];
export function activityForChat(snapshot={}){
  const genie=snapshot.genie;
  if(!genie)return {available:false,reviews:[],actions:[],scope:'Operational history was not supplied; do not infer that no actions occurred.'};
  const reviews=(genie.reports??[]).filter(r=>id(r.id)&&time(r.time)!==null).slice(0,12).map(r=>({
    id:r.id,completed_at:r.time,evidence_at:time(r.evidence_at),provider:choice(r.served_by,providers),worker:worker(r.served_on),
    valid_assessment:r.ticker_error===null&&Array.isArray(r.ticker)&&r.ticker.length>0,retention:'dashboard_session',
  }));
  const actions=[];
  for(const r of genie.provider_actions??[])if(id(r.id)&&time(r.time)!==null&&['pool_fallback','pool_assigned'].includes(r.served_by))actions.push({
    kind:'review_placement',id:r.id,at:r.time,worker:worker(r.served_on),placement:r.served_by,state:'review_completed',
  });
  for(const op of snapshot.gateway?.recovery?.operations??[])if(id(op.id)&&worker(op.worker_id)&&time(op.updated_at)!==null&&choice(op.actor,['genie','operator','detector'])&&choice(op.state,recoveryStates))actions.push({
    kind:'recovery',id:op.id,at:op.updated_at,worker:op.worker_id,actor:op.actor,state:op.state,
    service_action:choice(op.service_action,['start','restart','bootstrap']),service_action_issued:typeof op.service_action_issued==='boolean'?op.service_action_issued:null,
    // Proof bytes and commands remain in the existing local recovery view.
    verification_recorded:Boolean(op.proof),
  });
  for(const move of snapshot.genie_handovers?.rows??[])if(worker(move.source)&&worker(move.destination)&&time(move.at)!==null&&choice(move.actor,['genie','operator','scheduler'])&&choice(move.service_state,['pending','complete','excluded']))actions.push({
    kind:'queue_move',at:move.at,source:move.source,destination:move.destination,actor:move.actor,state:move.service_state,
    waiting_before_move_ms:time(move.waiting_before_move_ms),
  });
  actions.sort((a,b)=>b.at-a.at);const latest=actions.slice(0,30);
  return {available:true,observed_at:time(snapshot.time),review_running:genie.busy===true,review_kind:choice(genie.review_kind,['scheduled','manual','action']),
    reviews,actions:latest,truncated:actions.length>latest.length,
    storage:{pool_receipts_available:genie.provider_action_storage?.available===true&&genie.provider_assignment_storage?.available===true,
      notebook_enabled:genie.memory?.enabled===true,notebook_included:false},
    scope:'Bounded historical receipts, not complete history or current health proof. Review metadata excludes assessment prose and private notebook content. Attribute actions to their recorded actor. A completed review or queue move is not a server upgrade; pending, failed or verified_paused recovery is not returned-to-service. Queue-move completion records the destination request outcome, not measured time saved. A historical recovered receipt does not prove present health. No commands or action authority are supplied.',
  };
}
