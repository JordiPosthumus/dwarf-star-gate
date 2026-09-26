// Exact local qualification uses the enrolled launcher and a durable native
// transaction. It grants no stopped-start or guessed fatal-fault authority.
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {machinesFor} from './fleet-machines.mjs';
import {requestCapacity,activeCount} from './worker-activity.mjs';
import {glmRecoveryProofValid} from './recovery-verify.mjs';

const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const instance=value=>typeof value==='string'&&/^[a-f0-9]{32}$/.test(value);
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const terminal=new Set(['recovered','verified_paused','failed','reconciliation_needed']);
export const omlxBinding=(r,c)=>hash([c,machinesFor(c.id,r.fleetConfig),r.fleetConfig.control_socket]);
export const omlxRequest=op=>({action:'transaction',action_id:op.id,instance:op.instance,machine:op.machine,profile:op.profile,canary:true});
export const omlxQualificationEnabled=(r,id)=>r.state.automatic&&r.isOmlxQualificationEnabled()&&
  r.fleetConfig.omlx_recovery_setup?.workers?.[id]?.exclusive===true&&r.fleetConfig.omlx_recovery_setup.workers[id].qualify_restart===true;
export const omlxQualificationEvidence=(r,n,s)=>hash([n.id,'omlx-restart-qualification',omlxBinding(r,r.config(n.id)),s.instance,n.contextLength,requestCapacity(n)]);
export function omlxOperationValid(op){
  return uuid(op.id)&&op.omlx_qualification===true&&op.actor==='genie'&&op.canary===true&&op.was_paused===false&&
    op.service_action==='restart'&&typeof op.omlx_reserved==='boolean'&&digest(op.evidence_id)&&digest(op.omlx_enrollment)&&
    digest(op.machine)&&digest(op.profile)&&instance(op.instance)&&Number.isSafeInteger(op.context_length)&&op.context_length>0&&
    Number.isSafeInteger(op.omlx_concurrency)&&op.omlx_concurrency>0;
}
export function omlxPeers(r,id){
  const physical=machinesFor(id,r.fleetConfig);
  if(physical.length!==1)throw Error('omlx_physical_mapping_unverified');
  return r.nodes.filter(n=>machinesFor(n.id,r.fleetConfig).includes(physical[0]));
}
export function reserveOmlx(r,op,reserved){
  for(const n of omlxPeers(r,op.worker_id)){
    if(reserved){
      if(n.recovering&&n.recoveryOperationId!==op.id)throw Error('shared_machine_recovery_in_progress');
      n.recoveryOperationId=op.id;n.recovering=true;n.healthy=false;
    }else if(n.recoveryOperationId===op.id){delete n.recoveryOperationId;n.recovering=false;}
  }
}
export function omlxCertified(r,n,c){
  return r.state.operations.some(op=>omlxOperationValid(op)&&op.worker_id===n.id&&op.state==='recovered'&&
    !op.operator_override&&op.omlx_reserved===false&&op.omlx_dispatched===true&&op.omlx_transaction_completed===true&&
    op.service_action_issued===true&&op.machine===c.machine&&op.profile===c.profile&&op.omlx_enrollment===omlxBinding(r,c)&&op.context_length===n.contextLength&&
    op.omlx_concurrency===requestCapacity(n)&&instance(op.new_instance)&&op.new_instance!==op.instance&&
    glmRecoveryProofValid(op.proof,n.contextLength,'glm53_omlx'));
}
function anotherLlm(r,n){
  const peers=omlxPeers(r,n.id);
  return r.nodes.some(other=>!peers.includes(other)&&other.healthy&&!other.drained&&!other.quarantine&&!other.recovering&&!other.removed);
}
export function omlxQualificationReason(r,n,s){
  const c=r.config(n?.id);
  if(!n||c?.adapter!=='omlx'||c.transport!=='local'||c.verification!=='glm53_omlx'||!r.binding(n,c))return 'omlx_qualification_binding_unverified';
  if(!omlxQualificationEnabled(r,n.id))return 'omlx_qualification_policy_disabled';
  if(r.closed||r.stopping())return 'gateway_stopping';
  if(omlxCertified(r,n,c))return 'omlx_already_restart_qualified';
  if(n.drained)return 'operator_paused';
  if(n.removed||n.recovering||!n.healthy||n.quarantine||!r.valid(s,c)||s.fault)return 'omlx_qualification_requires_healthy_worker';
  if(!Number.isSafeInteger(n.contextLength)||n.contextLength<=0)return 'context_unverified';
  if(typeof r.fleetConfig.control_socket!=='string'||!path.isAbsolute(r.fleetConfig.control_socket))return 'omlx_private_socket_required';
  if(r.task||r.state.operations.some(op=>!terminal.has(op.state)||op.omlx_reserved||op.pair_reserved))return 'fleet_recovery_in_progress';
  const ownership=r.ownershipReason(n);if(ownership)return ownership;
  try{if(!anotherLlm(r,n))return 'omlx_other_llm_required';}catch{return 'omlx_physical_mapping_unverified';}
  return null;
}
export function requestOmlxQualification(r,input){
  if(!input||Object.keys(input).sort().join(',')!=='action_id,evidence_id,worker_id'||!uuid(input.action_id)||!digest(input.evidence_id)||typeof input.worker_id!=='string')throw Error('omlx_qualification_request_invalid');
  const prior=r.state.operations.find(op=>op.id===input.action_id);
  if(prior){
    if(prior.worker_id!==input.worker_id||prior.evidence_id!==input.evidence_id||!prior.omlx_qualification)throw Error('omlx_qualification_action_conflict');
    return prior;
  }
  const n=r.node(input.worker_id),observed=r.observations.get(input.worker_id),s=observed?.value;
  if(!observed||observed.error||observed.at>r.now()||r.now()-observed.at>90000)throw Error('service_inspection_pending');
  const reason=omlxQualificationReason(r,n,s);if(reason)throw Error(reason);
  if(input.evidence_id!==omlxQualificationEvidence(r,n,s))throw Error('omlx_qualification_evidence_changed');
  if(r.state.operations.length>=10000)throw Error('recovery_journal_full');
  // The same synchronous turn checks the entire physical group before saving
  // intent and reserving it. Later waiting jobs are held behind this operation.
  const c=r.config(n.id),op={id:input.action_id,worker_id:n.id,actor:'genie',evidence_id:input.evidence_id,
    service_action:'restart',state:'queued',created_at:r.now(),updated_at:r.now(),instance:s.instance,machine:s.machine,profile:s.profile,
    context_length:n.contextLength,canary:true,was_paused:false,quarantine:null,operator_override:false,
    binding:hash([n.url,n.ssh,n.ssh_fallbacks??[],n.remote_port??8000]),
    omlx_qualification:true,omlx_reserved:true,omlx_enrollment:omlxBinding(r,c),omlx_concurrency:requestCapacity(n)};
  if(!r.store.filename)throw Error('omlx_metadata_backup_unavailable');
  op.qualification_backup=r.store.filename+'.omlx-qualification-'+r.now()+'-'+randomUUID()+'.bak';
  fs.copyFileSync(r.store.filename,op.qualification_backup,fs.constants.COPYFILE_EXCL);fs.chmodSync(op.qualification_backup,0o600);
  r.commit({...r.state,operations:[...r.state.operations,op]});reserveOmlx(r,op,true);
  r.task=r.execute(op,false).finally(()=>{r.task=null;});return op;
}
export function omlxPermit(r,input,{readmit=false,allowPaused=false}={}){
  const op=r.state.operations.find(o=>o.id===input?.action_id),n=r.node(op?.worker_id),c=r.config(op?.worker_id);
  const denied=reason=>({allowed:false,reason});
  if(!op||!omlxOperationValid(op)||!n||c?.adapter!=='omlx'||c.verification!=='glm53_omlx'||!op.omlx_reserved||
     !op.service_action_issued||op.omlx_enrollment!==omlxBinding(r,c))return denied('omlx_operation_not_owned');
  if(!omlxQualificationEnabled(r,n.id))return denied('omlx_qualification_policy_disabled');
  if(!['queued','starting','restarting','reconciling','waiting_for_ownership',...(readmit?['verifying']:[])].includes(op.state))return denied('omlx_operation_not_owned');
  const request=omlxRequest(op);
  if(!input||Object.keys(input).sort().join(',')!==Object.keys(request).sort().join(',')||Object.keys(request).some(k=>input[k]!==request[k]))return denied('omlx_request_changed');
  if(!r.binding(n,c)||n.contextLength!==op.context_length||requestCapacity(n)!==op.omlx_concurrency)return denied('omlx_binding_changed');
  if(r.closed||r.stopping()||n.removed)return denied('controller_stopping');
  if((op.operator_override||n.drained)&&!allowPaused)return denied('omlx_operator_decision_changed');
  const peers=omlxPeers(r,n.id);
  if(peers.some(p=>!p.recovering||p.recoveryOperationId!==op.id))return denied('omlx_reservation_changed');
  const ownership=r.ownershipReason(n,{operationId:op.id,allowReservedQueue:true,phase:readmit?'readmit':'action'});
  if(ownership)return denied(ownership);
  if(!readmit&&!anotherLlm(r,n))return denied('omlx_other_llm_required');
  return {allowed:true,action_id:op.id,instance:op.instance,profile:op.profile};
}
// Reinstate may admit requests that queued after the operation reserved an idle
// physical machine. An arbitrary nonempty queue still forbids readmission.
export function omlxReadmissionOwnsQueue(r,n,next){
  const op=next.operations.find(o=>o.id===n.recoveryOperationId),previous=r.state.operations.find(o=>o.id===op?.id);
  return !!previous&&omlxOperationValid(previous)&&previous.omlx_reserved&&previous.worker_id===n.id&&previous.state==='verifying'&&
    n.recovering&&op?.state==='recovered'&&op.omlx_reserved===false&&op.omlx_enrollment===previous.omlx_enrollment&&
    !activeCount(n)&&omlxPermit(r,omlxRequest(previous),{readmit:true}).allowed;
}
export async function executeOmlx(r,initial){
  let op={...initial};const n=r.node(op.worker_id),c=r.config(op.worker_id);
  const update=fields=>{r.update(op,fields);op={...r.current(op)};};
  try{
    if(!omlxOperationValid(op)||!n||c?.adapter!=='omlx'||op.omlx_enrollment!==omlxBinding(r,c))throw Error('omlx_binding_changed');
    reserveOmlx(r,op,true);
    if(!op.service_action_issued)update({service_action_issued:true,restart_issued:true});
    // Verification can be interrupted too. No native permit is available until
    // this controller has resumed observation of the same saved operation.
    if(op.state==='verifying')update({state:'reconciling'});
    const permit=omlxPermit(r,omlxRequest(op));
    if(!permit.allowed){update({state:'waiting_for_ownership',error:permit.reason});return;}
    const before=await r.inspect(n.id);
    if(!before){update({state:'reconciling',error:r.observations.get(n.id)?.error??'adapter_check_failed'});return;}
    if(before.machine!==op.machine||before.profile!==op.profile)throw Error('omlx_binding_changed');
    if(!op.omlx_dispatched&&(!r.valid(before,c)||before.instance!==op.instance||before.fault))throw Error('omlx_original_instance_changed');
    const fresh=omlxPermit(r,omlxRequest(op));if(!fresh.allowed){update({state:'waiting_for_ownership',error:fresh.reason});return;}
    update({state:op.omlx_dispatched?'reconciling':'restarting',omlx_dispatched:true,error:null});
    const receipt=await r.call(c,{...omlxRequest(op),gateway_socket:r.fleetConfig.control_socket});
    if(receipt.action_id!==op.id)throw Error('omlx_runner_receipt_unverified');
    if(receipt.state!=='completed'){
      if(!['running','pending','waiting_for_ownership','uncertain'].includes(receipt.state))throw Error('omlx_runner_receipt_unverified');
      update({state:receipt.state==='uncertain'?'reconciliation_needed':receipt.state==='waiting_for_ownership'?'waiting_for_ownership':'reconciling',error:receipt.reason??null});return;
    }
    if(!instance(receipt.new_instance)||receipt.new_instance===op.instance)throw Error('omlx_runner_receipt_unverified');
    const after=await r.inspect(n.id);
    if(!r.valid(after,c)||after.instance!==receipt.new_instance||after.fault){update({state:'reconciling',error:'omlx_readiness_pending'});return;}
    const check=omlxPermit(r,omlxRequest(op));if(!check.allowed){update({state:'waiting_for_ownership',error:check.reason});return;}
    update({state:'verifying',new_instance:after.instance});
    const proof=await r.verify(n.url,r.model,op.context_length,{signal:r.abort.signal,kind:'glm53_omlx',endpoint:n});
    if(!glmRecoveryProofValid(proof,op.context_length,'glm53_omlx'))throw Error('omlx_generation_or_cache_unverified');
    const final=await r.inspect(n.id);
    if(!r.valid(final,c)||final.instance!==after.instance||final.fault)throw Error('omlx_identity_changed_during_verification');
    op={...r.current(op)};
    const allowed=omlxPermit(r,omlxRequest(op),{readmit:true,allowPaused:true});
    if(!allowed.allowed){update({state:'waiting_for_ownership',proof,error:allowed.reason});return;}
    const held=op.operator_override||n.drained;
    const done={...op,state:held?'verified_paused':'recovered',omlx_reserved:false,omlx_transaction_completed:true,proof,error:null,updated_at:r.now()};
    const next={...r.state,operations:r.state.operations.map(o=>o.id===op.id?done:o)};
    if(held)r.commit(next);else r.reinstate(n,op.quarantine,next);
    reserveOmlx(r,op,false);
    r.log('worker_recovery_action',{id:op.id,worker_id:n.id,state:done.state,proof});
  }catch(error){
    const reason=/^[a-z_]+$/.test(error.message)?error.message:'omlx_recovery_unverified';
    const transient=r.closed||reason==='controller_stopping'||reason.startsWith('adapter_')||reason==='omlx_transaction_ownership_unavailable';
    try{update({state:transient?'reconciling':'reconciliation_needed',error:reason});}catch{r.closed=true;}
  }
}
