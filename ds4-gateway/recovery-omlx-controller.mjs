// Qualification and separately opted-in demand starts use the original launcher.
// Neither a stalled live process nor an old demand receipt is start authority.
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
export const omlxRequest=op=>op.omlx_demand_start?{action:'start-transaction',action_id:op.id,stopped_epoch:op.stopped_epoch,demand_id:op.demand_id,machine:op.machine,profile:op.profile}:
  {action:'transaction',action_id:op.id,instance:op.instance,machine:op.machine,profile:op.profile,canary:true};
export const omlxQualificationEnabled=(r,id)=>r.state.automatic&&r.isOmlxQualificationEnabled()&&
  r.fleetConfig.omlx_recovery_setup?.workers?.[id]?.exclusive===true&&r.fleetConfig.omlx_recovery_setup.workers[id].qualify_restart===true;
export const omlxQualificationEvidence=(r,n,s)=>hash([n.id,'omlx-restart-qualification',omlxBinding(r,r.config(n.id)),s.instance,n.contextLength,requestCapacity(n)]);
export function omlxOperationValid(op){
  const base=uuid(op.id)&&op.was_paused===false&&typeof op.omlx_reserved==='boolean'&&digest(op.evidence_id)&&digest(op.omlx_enrollment)&&
    digest(op.machine)&&digest(op.profile)&&Number.isSafeInteger(op.context_length)&&op.context_length>0&&Number.isSafeInteger(op.omlx_concurrency)&&op.omlx_concurrency>0;
  return base&&(op.omlx_demand_start===true?op.omlx_qualification===undefined&&['genie','detector'].includes(op.actor)&&op.canary===false&&op.service_action==='start'&&
    op.instance===''&&digest(op.stopped_epoch)&&uuid(op.demand_id)&&op.service_profile===op.profile:
    op.omlx_demand_start===undefined&&op.omlx_qualification===true&&op.actor==='genie'&&op.canary===true&&op.service_action==='restart'&&instance(op.instance));
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
  return r.state.operations.some(op=>omlxOperationValid(op)&&op.omlx_qualification===true&&op.worker_id===n.id&&op.state==='recovered'&&
    !op.operator_override&&op.omlx_reserved===false&&op.omlx_dispatched===true&&op.omlx_transaction_completed===true&&
    op.service_action_issued===true&&op.machine===c.machine&&op.profile===c.profile&&op.omlx_enrollment===omlxBinding(r,c)&&op.context_length===n.contextLength&&
    op.omlx_concurrency===requestCapacity(n)&&instance(op.new_instance)&&op.new_instance!==op.instance&&
    glmRecoveryProofValid(op.proof,n.contextLength,'glm53_omlx'));
}
function anotherLlm(r,n){
  const peers=omlxPeers(r,n.id);
  return r.nodes.some(other=>!peers.includes(other)&&other.healthy&&!other.drained&&!other.quarantine&&!other.recovering&&!other.removed);
}
export const omlxDemandEnabled=(r,id)=>r.state.automatic&&r.isOmlxQualificationEnabled()&&
  r.fleetConfig.omlx_recovery_setup?.workers?.[id]?.exclusive===true&&r.fleetConfig.omlx_recovery_setup.workers[id].start_on_demand===true&&
  r.config(id)?.start_stopped===true&&r.config(id).service_profile===r.config(id).profile;
const demandPresent=(r,n)=>uuid(r.omlxDemand(n));
export const omlxDemandEvidence=(r,n,s)=>hash([n.id,'omlx-demand-start',omlxBinding(r,r.config(n.id)),s.stopped_epoch,n.contextLength,requestCapacity(n)]);
export function omlxDemandReason(r,n,s){
  const c=r.config(n?.id);
  if(!n||c?.adapter!=='omlx'||c.transport!=='local'||c.verification!=='glm53_omlx'||!r.binding(n,c))return 'omlx_demand_binding_unverified';
  if(!omlxDemandEnabled(r,n.id))return 'omlx_demand_start_policy_disabled';
  if(r.closed||r.stopping())return 'gateway_stopping';
  if(n.drained)return 'operator_paused';
  if(n.removed||n.recovering||n.healthy!==false||!r.validStopped(s,c)||s.pid!==0||s.instance!==''||s.fault||s.profile!==c.profile)return 'omlx_verified_stopped_service_required';
  if(!Number.isSafeInteger(n.contextLength)||n.contextLength<=0)return 'context_unverified';
  if(typeof r.fleetConfig.control_socket!=='string'||!path.isAbsolute(r.fleetConfig.control_socket))return 'omlx_private_socket_required';
  if(r.task||r.state.operations.some(o=>!terminal.has(o.state)||o.omlx_reserved||o.pair_reserved))return 'fleet_recovery_in_progress';
  const ownership=r.ownershipReason(n);if(ownership)return ownership;
  try{if(omlxPeers(r,n.id).some(p=>p!==n&&p.healthy))return 'omlx_shared_service_running';}catch{return 'omlx_physical_mapping_unverified';}
  if(!omlxCertified(r,n,c))return 'omlx_restart_qualification_required';
  const seen=r.stoppedSince.get(n.id);
  if(!seen||seen.epoch!==s.stopped_epoch||r.now()-seen.since<15000)return 'stopped_service_confirmation_pending';
  if(r.state.operations.some(o=>o.worker_id===n.id&&o.stopped_epoch===s.stopped_epoch&&o.omlx_dispatched))return 'stopped_epoch_already_attempted';
  if(!demandPresent(r,n))return 'omlx_waiting_for_demand';
  return null;
}
export function requestOmlxDemand(r,input,actor='detector'){
  if(!input||Object.keys(input).sort().join(',')!=='action_id,evidence_id,worker_id'||!uuid(input.action_id)||!digest(input.evidence_id)||!['detector','genie'].includes(actor))throw Error('omlx_demand_request_invalid');
  const prior=r.state.operations.find(o=>o.id===input.action_id);
  if(prior){if(!prior.omlx_demand_start||prior.worker_id!==input.worker_id||prior.evidence_id!==input.evidence_id)throw Error('omlx_demand_action_conflict');return prior;}
  const n=r.node(input.worker_id),observed=r.observations.get(input.worker_id),s=observed?.value;
  if(!observed||observed.error||observed.at>r.now()||r.now()-observed.at>90000)throw Error('service_inspection_pending');
  const reason=omlxDemandReason(r,n,s);if(reason)throw Error(reason);
  if(input.evidence_id!==omlxDemandEvidence(r,n,s))throw Error('omlx_demand_evidence_changed');
  if(r.state.operations.length>=10000)throw Error('recovery_journal_full');
  const c=r.config(n.id),op={id:input.action_id,worker_id:n.id,actor,evidence_id:input.evidence_id,omlx_demand_start:true,
    demand_id:randomUUID(),service_action:'start',state:'queued',created_at:r.now(),updated_at:r.now(),instance:'',machine:s.machine,profile:s.profile,
    service_profile:s.service_profile,stopped_epoch:s.stopped_epoch,context_length:n.contextLength,canary:false,was_paused:false,
    quarantine:n.quarantine?{...n.quarantine}:null,operator_override:false,binding:hash([n.url,n.ssh,n.ssh_fallbacks??[],n.remote_port??8000]),
    omlx_reserved:true,omlx_enrollment:omlxBinding(r,c),omlx_concurrency:requestCapacity(n)};
  if(!r.store.filename)throw Error('omlx_metadata_backup_unavailable');
  op.qualification_backup=r.store.filename+'.omlx-demand-'+r.now()+'-'+randomUUID()+'.bak';
  fs.copyFileSync(r.store.filename,op.qualification_backup,fs.constants.COPYFILE_EXCL);fs.chmodSync(op.qualification_backup,0o600);
  r.commit({...r.state,operations:[...r.state.operations,op]});reserveOmlx(r,op,true);
  r.task=r.execute(op,false).finally(()=>{r.task=null;});return op;
}
// Match Python json.dumps(sort_keys=True) for this flat private protocol, even
// when an installation's socket path contains non-ASCII characters.
export const omlxNativeRequestHash=(r,op)=>{
  const request={...omlxRequest(op),gateway_socket:r.fleetConfig.control_socket};
  const json=value=>JSON.stringify(value).replace(/[\x7f-\uffff]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'));
  return createHash('sha256').update('{'+Object.keys(request).sort().map(k=>json(k)+': '+json(request[k])).join(', ')+'}').digest('hex');
};
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
  if(op.omlx_demand_start?!omlxDemandEnabled(r,n.id):!omlxQualificationEnabled(r,n.id))return denied(op.omlx_demand_start?'omlx_demand_start_policy_disabled':'omlx_qualification_policy_disabled');
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
  if(op.omlx_demand_start){
    if(!omlxCertified(r,n,c))return denied('omlx_restart_qualification_required');
    if(!readmit&&!op.omlx_transaction_completed&&!op.omlx_launch_observed&&!demandPresent(r,n))return denied('omlx_waiting_for_demand');
    return {allowed:true,action_id:op.id,stopped_epoch:op.stopped_epoch,profile:op.profile,demand_id:op.demand_id};
  }
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
    if(op.omlx_demand_start&&!op.omlx_dispatched&&!demandPresent(r,n)){
      update({state:'failed',error:'omlx_demand_withdrawn_before_dispatch',omlx_reserved:false});reserveOmlx(r,op,false);return;
    }
    if(!op.service_action_issued)update({service_action_issued:true,...(!op.omlx_demand_start?{restart_issued:true}:{})});
    let savedReceipt;
    if(op.omlx_demand_start&&op.omlx_dispatched){
      savedReceipt=await r.call(c,{action:'transaction-status',action_id:op.id});
      if(savedReceipt.action_id!==op.id||!['not_found','pending','running','waiting_for_ownership','uncertain','completed'].includes(savedReceipt.state)||
        savedReceipt.state!=='not_found'&&savedReceipt.request_hash!==omlxNativeRequestHash(r,op))throw Error('omlx_runner_receipt_unverified');
      const phases=['prepared','stopped','launch_intent','launch_observed','completed'];
      if(savedReceipt.phase!==undefined&&!phases.includes(savedReceipt.phase)||
        (savedReceipt.state==='completed')!==(savedReceipt.phase==='completed')||
        ['not_found','pending'].includes(savedReceipt.state)&&savedReceipt.phase!==undefined||
        !['not_found','pending'].includes(savedReceipt.state)&&savedReceipt.phase===undefined)throw Error('omlx_runner_receipt_unverified');
      update({omlx_native_observation:{state:savedReceipt.state,phase:savedReceipt.phase??null,at:r.now()}});
      if(savedReceipt.state==='uncertain'){update({state:'reconciliation_needed',error:savedReceipt.reason??'omlx_native_action_uncertain'});return;}
      if(savedReceipt.state==='completed'){
        if(!instance(savedReceipt.new_instance))throw Error('omlx_runner_receipt_unverified');
        update({omlx_transaction_completed:true,new_instance:savedReceipt.new_instance});
      }else if(['launch_intent','launch_observed'].includes(savedReceipt.phase)){
        const current=await r.inspect(n.id);
        if(r.valid(current,c)&&!current.fault)update({omlx_launch_observed:true,new_instance:current.instance});
      }
    }
    // Verification can be interrupted too. No native permit is available until
    // this controller has resumed observation of the same saved operation.
    if(op.state==='verifying')update({state:'reconciling'});
    const permit=omlxPermit(r,omlxRequest(op));
    if(!permit.allowed){update({state:'waiting_for_ownership',error:permit.reason});return;}
    const before=await r.inspect(n.id);
    if(!before){update({state:'reconciling',error:r.observations.get(n.id)?.error??'adapter_check_failed'});return;}
    if(before.machine!==op.machine||before.profile!==op.profile)throw Error('omlx_binding_changed');
    if(!op.omlx_dispatched&&(op.omlx_demand_start?
      !r.validStopped(before,c)||before.stopped_epoch!==op.stopped_epoch||before.pid!==0||before.instance!==''||before.fault:
      !r.valid(before,c)||before.instance!==op.instance||before.fault))throw Error('omlx_original_instance_changed');
    const fresh=omlxPermit(r,omlxRequest(op));if(!fresh.allowed){update({state:'waiting_for_ownership',error:fresh.reason});return;}
    update({state:op.omlx_dispatched?'reconciling':op.omlx_demand_start?'starting':'restarting',omlx_dispatched:true,error:null});
    const receipt=savedReceipt?.state==='completed'?savedReceipt:await r.call(c,{...omlxRequest(op),gateway_socket:r.fleetConfig.control_socket});
    if(receipt.action_id!==op.id)throw Error('omlx_runner_receipt_unverified');
    if(receipt.state!=='completed'){
      if(!['running','pending','waiting_for_ownership','uncertain'].includes(receipt.state))throw Error('omlx_runner_receipt_unverified');
      update({state:receipt.state==='uncertain'?'reconciliation_needed':receipt.state==='waiting_for_ownership'?'waiting_for_ownership':'reconciling',error:receipt.reason??null});return;
    }
    if(!instance(receipt.new_instance)||receipt.new_instance===op.instance)throw Error('omlx_runner_receipt_unverified');
    if(op.omlx_demand_start)update({omlx_transaction_completed:true,new_instance:receipt.new_instance});
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
