import {createHash} from 'node:crypto';
import {machinesFor} from './fleet-machines.mjs';
import {glmRecoveryProofValid} from './recovery-verify.mjs';
import {requestCapacity} from './worker-activity.mjs';

const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
export const pairRequest=op=>({action:op.service_action,action_id:op.id,epoch:op.pair_epoch,machine:op.machine,profile:op.profile,
  canary:op.canary,fault_after:op.canary||op.service_action==='start'?0:Math.max(0,Date.parse(op.quarantine?.at)-120000)});

export const pairBinding=(recovery,c)=>hash([c,machinesFor(c.id,recovery.fleetConfig)]);
export const pairQualificationEnabled=(recovery,id)=>recovery.state.automatic&&recovery.isPairQualificationEnabled()&&
  recovery.fleetConfig.pair_recovery_setup?.workers?.[id]?.qualify_restart===true;
export const pairQualificationEvidence=(recovery,n,s)=>hash([n.id,'pair-restart-qualification',pairBinding(recovery,recovery.config(n.id)),s.pair_epoch,n.contextLength,requestCapacity(n)]);
export function pairCertified(recovery,n,c){
  return recovery.state.operations.some(op=>op.worker_id===n.id&&op.canary===true&&
    ((op.actor==='operator'&&op.was_paused===true&&op.state==='verified_paused')||
     (op.actor==='genie'&&op.pair_qualification===true&&op.was_paused===false&&op.state==='recovered'))&&
    op.service_action==='restart'&&op.service_action_issued===true&&op.pair_dispatched===true&&
    op.pair_transaction_completed===true&&op.pair_reserved===false&&!op.operator_override&&op.pair_enrollment===pairBinding(recovery,c)&&
    op.context_length===n.contextLength&&op.pair_concurrency===requestCapacity(n)&&digest(op.pair_final_epoch)&&op.pair_final_epoch!==op.pair_epoch&&
    op.new_instance===op.pair_final_epoch.slice(0,32)&&glmRecoveryProofValid(op.proof,n.contextLength));
}

export function pairPeers(recovery,id){
  const own=new Set(machinesFor(id,recovery.fleetConfig));
  if(own.size!==2)throw Error('pair_physical_mapping_unverified');
  return recovery.nodes.filter(n=>machinesFor(n.id,recovery.fleetConfig).some(machine=>own.has(machine)));
}

export function reservePair(recovery,op,reserved){
  for(const node of pairPeers(recovery,op.worker_id)){
    if(reserved){
      if(node.recovering&&node.recoveryOperationId&&node.recoveryOperationId!==op.id)throw Error('shared_machine_recovery_in_progress');
      node.recoveryOperationId=op.id;node.recovering=true;node.healthy=false;
    }else if(node.recoveryOperationId===op.id){delete node.recoveryOperationId;node.recovering=false;}
  }
}

export function pairPermit(recovery,input){
  const op=recovery.state.operations.find(o=>o.id===input?.action_id),n=recovery.node(op?.worker_id),c=recovery.config(op?.worker_id);
  const denied=reason=>({allowed:false,reason});
  if(!op||!n||c?.adapter!=='docker-pair'||!op.pair_reserved||!op.service_action_issued||op.pair_enrollment!==pairBinding(recovery,c))return denied('pair_operation_not_owned');
  if(op.pair_qualification&&!pairQualificationEnabled(recovery,n.id))return denied('pair_qualification_policy_disabled');
  if(!op.canary&&!pairCertified(recovery,n,c))return denied('pair_restart_canary_required');
  if(!['queued','starting','restarting','reconciling','waiting_for_ownership'].includes(op.state))return denied('pair_operation_not_owned');
  const request=pairRequest(op);
  if(!input||Object.keys(input).sort().join(',')!==Object.keys(request).sort().join(',')||Object.keys(request).some(k=>input[k]!==request[k]))return denied('pair_request_changed');
  if(!recovery.binding(n,c)||n.contextLength!==op.context_length||requestCapacity(n)!==op.pair_concurrency)return denied('pair_binding_changed');
  if(recovery.closed||recovery.stopping()||n.removed||!n.recovering)return denied('controller_stopping');
  if(op.operator_override||(n.drained&&!op.was_paused)||(op.actor!=='operator'&&!recovery.state.automatic))return denied('pair_operator_decision_changed');
  const ownership=recovery.ownershipReason(n,{operationId:op.id});if(ownership)return denied(ownership);
  const peers=pairPeers(recovery,n.id);
  if(!recovery.nodes.some(other=>!peers.includes(other)&&other.healthy&&!other.drained&&!other.quarantine&&!other.recovering&&!other.removed))return denied('pair_other_llm_required');
  return {allowed:true,action_id:op.id,epoch:op.pair_epoch,profile:op.profile};
}

// Invoking the helper again observes/resumes the same durable native journal.
// It cannot replay an uncertain Docker command, including after controller exit.
export async function executePair(recovery,initial){
  let op={...initial};const n=recovery.node(op.worker_id),c=recovery.config(op.worker_id);
  const update=fields=>{recovery.update(op,fields);op={...recovery.current(op)};};
  try{
    if(!n||c?.adapter!=='docker-pair'||!digest(op.pair_epoch)||op.pair_enrollment!==pairBinding(recovery,c)||!recovery.binding(n,c)||
      op.binding!==hash([n.url,n.ssh,n.ssh_fallbacks??[],n.remote_port??8000])||n.contextLength!==op.context_length||requestCapacity(n)!==op.pair_concurrency)throw Error('pair_binding_changed');
    reservePair(recovery,op,true);
    if(!op.service_action_issued)update({service_action_issued:true,...(op.service_action==='restart'?{restart_issued:true}:{})});
    const permit=pairPermit(recovery,pairRequest(op));
    if(!permit.allowed){update({state:'waiting_for_ownership',error:permit.reason});return;}
    const before=await recovery.inspect(n.id);
    if(!before){
      const error=recovery.observations.get(n.id)?.error??'adapter_check_failed';
      update({state:error==='pair_identity_or_journal_unverified'?'reconciliation_needed':'reconciling',error});return;
    }
    if(before.machine!==c.machine||before.profile!==c.profile||!digest(before.pair_epoch))throw Error('pair_binding_changed');
    // A healthy exact replacement produced before any native dispatch needs
    // verification only. Never restart it to manufacture our own receipt.
    const replacement=!op.pair_dispatched&&recovery.valid(before,c)&&!before.fault&&before.pair_epoch!==op.pair_epoch;
    let finalEpoch=replacement?before.pair_epoch:null;
    if(!replacement){
      const currentPermit=pairPermit(recovery,pairRequest(op));
      if(!currentPermit.allowed){update({state:'waiting_for_ownership',error:currentPermit.reason});return;}
      update({state:op.service_action==='start'?'starting':'restarting',pair_dispatched:true,error:null});
      const receipt=await recovery.call(c,pairRequest(op));
      if(receipt.action_id!==op.id)throw Error('pair_runner_receipt_unverified');
      if(receipt.state!=='completed'){
        if(!['running','pending','uncertain','waiting_for_ownership'].includes(receipt.state))throw Error('pair_runner_receipt_unverified');
        update({state:receipt.state==='waiting_for_ownership'?'waiting_for_ownership':'reconciling',error:receipt.reason??null});return;
      }
      if(!digest(receipt.final_epoch)||receipt.final_epoch===op.pair_epoch)throw Error('pair_runner_receipt_unverified');
      finalEpoch=receipt.final_epoch;
    }
    const after=await recovery.inspect(n.id);
    if(!recovery.valid(after,c)||after.pair_epoch!==finalEpoch||after.fault){update({state:'reconciling',error:'pair_readiness_pending'});return;}
    if(after.context_length!==op.context_length||after.concurrency!==op.pair_concurrency)throw Error('pair_capacity_changed');
    const check=pairPermit(recovery,pairRequest(op));if(!check.allowed){update({state:'waiting_for_ownership',error:check.reason});return;}
    update({state:'verifying',new_instance:after.instance,error:null});
    const proof=await recovery.verify(n.url,recovery.model,op.context_length,{signal:recovery.abort.signal,kind:'glm53_vllm',endpoint:n});
    if(!glmRecoveryProofValid(proof,op.context_length))throw Error('pair_generation_or_cache_unverified');
    const final=await recovery.inspect(n.id);
    if(!recovery.valid(final,c)||final.pair_epoch!==finalEpoch||final.fault||final.context_length!==op.context_length||final.concurrency!==op.pair_concurrency)throw Error('pair_identity_changed_during_verification');
    op={...recovery.current(op)};
    if(op.pair_qualification&&!pairQualificationEnabled(recovery,n.id)){update({state:'waiting_for_ownership',proof,error:'pair_qualification_policy_disabled'});return;}
    const reason=recovery.ownershipReason(n,{phase:'readmit',operationId:op.id});
    const held=op.operator_override||op.was_paused||n.drained||n.removed||recovery.node(n.id)!==n||recovery.stopping()||reason;
    // A late temporary hold retains the proof and reservation. The same action
    // will recheck identities and serving before any later readmission.
    if(reason){update({state:'waiting_for_ownership',proof,readmission_blocked_reason:reason});return;}
    const done={...op,state:held?'verified_paused':'recovered',proof,pair_reserved:false,pair_final_epoch:finalEpoch,
      pair_transaction_completed:!replacement,error:null,updated_at:recovery.now()};
    const next={...recovery.state,operations:recovery.state.operations.map(o=>o.id===op.id?done:o)};
    if(held)recovery.commit(next);else recovery.reinstate(n,op.quarantine,next);
    reservePair(recovery,op,false);
    recovery.log('worker_recovery_action',{id:op.id,worker_id:n.id,state:done.state,proof});
  }catch(error){
    const reason=/^[a-z_]+$/.test(error.message)?error.message:'pair_recovery_unverified';
    const transient=recovery.closed||reason==='controller_stopping'||reason.startsWith('adapter_')||reason==='pair_ownership_unavailable';
    try{update({state:transient?'reconciling':'reconciliation_needed',error:reason});}catch{recovery.closed=true;}
  }
}
