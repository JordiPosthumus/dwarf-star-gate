// Chat submits the same evidence-bound requests as the existing fleet reviewer.
import {createToolEndpoint} from './genie-tool-endpoint.mjs';
export function recoveryEvidence(status){
  const recovery=status?.recovery;
  if(status?.version!==1||!Array.isArray(recovery?.workers)||!Array.isArray(recovery.operations))throw new Error('Current recovery status is unavailable.');
  return {observed_at:new Date().toISOString(),...recovery,
    matched_bindings:recovery.workers.filter(w=>w.enrollment?.binding==='matched').map(w=>w.worker_id),
    unmatched_bindings:recovery.workers.filter(w=>w.enrollment?.binding!=='matched').map(w=>({worker_id:w.worker_id,binding:w.enrollment?.binding??'unknown'})),
    scope:'Current enrolled-service eligibility and existing recovery receipts. configured and adapter describe a registered definition, not a working connection. A mismatched or absent binding is NOT connected. The switch alone does not connect a service. A queued receipt is acceptance, not successful recovery. Explicitly opted-in pairs may be enrolled from native capture receipts. Enrollment does not qualify a restart. Explicitly opted-in idle healthy pairs offer evidence-bound restart qualification; it requires native GLM proof and preserves operator pauses. No arbitrary server configuration changes are available here.'};
}
export function createRecoveryTools({read,recover,preparation=null,enroll=null,enrollOmlx=null,qualify=null,isChangesEnabled=()=>false,continuation=()=>null,enrollmentContinuation=()=>null,qualificationContinuation=()=>null,omlxEnrollmentContinuation=()=>null,isInspectionEnabled=()=>true,isTesting=()=>false,isEnabled=()=>true}){
  async function tool(input){
    if(input?.action==='status'&&Object.keys(input).length===1)return {...recoveryEvidence(await read()),...(enrollOmlx?{omlx_enrollment_followup:omlxEnrollmentContinuation()}:{}),...(preparation?{pair_preparations:await preparation.status(),pair_preparation_followup:continuation(),pair_enrollment_followup:enrollmentContinuation(),pair_qualification_followup:qualificationContinuation()}: {})};
    if(input?.action==='enroll-omlx'){
      if(!enrollOmlx||isTesting()||!isEnabled()||!isInspectionEnabled()||!isChangesEnabled())throw Error('Local oMLX recovery enrollment is unavailable or suspended.');
      if(Object.keys(input).sort().join(',')!=='action,action_id,worker_id')throw Error('Specify one configured local worker and action ID');
      return enrollOmlx({worker_id:input.worker_id,action_id:input.action_id});
    }
    if(input?.action==='qualify-pair'){
      if(!qualify||isTesting()||!isEnabled()||!isInspectionEnabled()||!isChangesEnabled())throw Error('Pair qualification is unavailable or suspended.');
      if(Object.keys(input).sort().join(',')!=='action,action_id,evidence_id,worker_id'||typeof input.worker_id!=='string'||!/^[a-f0-9]{64}$/.test(input.evidence_id??'')||!/^[a-f0-9-]{36}$/.test(input.action_id??''))throw Error('Specify current pair qualification evidence and one action ID');
      const receipt=await qualify({worker_id:input.worker_id,evidence_id:input.evidence_id,action_id:input.action_id});
      if(receipt?.id!==input.action_id||receipt.worker_id!==input.worker_id||receipt.actor!=='genie'||receipt.pair_qualification!==true)throw Error('Qualification acknowledgement is uncertain; inspect the same action ID without replaying.');
      return receipt;
    }
    if(input?.action==='enroll-pair'){
      if(!enroll||isTesting()||!isEnabled()||!isInspectionEnabled()||!isChangesEnabled())throw Error('Pair recovery enrollment is unavailable or suspended.');
      if(Object.keys(input).sort().join(',')!=='action,action_id,capture_id,worker_id')throw Error('Specify a worker and existing capture ID');
      return enroll({worker_id:input.worker_id,capture_id:input.capture_id,action_id:input.action_id});
    }
    if(input?.action==='prepare-pair'){
      if(!preparation||!isInspectionEnabled()||isTesting())throw Error('Native pair inspection is unavailable or suspended.');
      if(Object.keys(input).sort().join(',')!=='action,action_id,worker_id')throw Error('Specify one configured pair and capture action ID');
      return preparation.prepare({worker_id:input.worker_id,action_id:input.action_id});
    }
    if(input?.action!=='recover'||Object.keys(input).sort().join(',')!=='action,action_id,evidence_id,worker_id'||
      typeof input.worker_id!=='string'||!/^[a-f0-9]{64}$/.test(input.evidence_id??'')||!/^[a-f0-9-]{36}$/.test(input.action_id??''))throw new Error('Use the current worker evidence and a single recovery action ID.');
    if(isTesting())throw new Error('Recovery is suspended for testing.');
    if(!isEnabled())throw new Error('Server recovery is switched off.');
    const exact={worker_id:input.worker_id,evidence_id:input.evidence_id,action_id:input.action_id};
    // The existing core checks fresh evidence, policy, enrollment and active work.
    const receipt=await recover(exact);
    if(receipt?.id!==exact.action_id||receipt.worker_id!==exact.worker_id||receipt.actor!=='genie')throw new Error('Recovery acknowledgement could not be confirmed. Read recovery_status for this action ID; do not repeat it.');
    return {receipt,next_step:'Read recovery_status for this action ID. Acceptance is not completion; already issued work continues independently of this chat.'};
  }
  return createToolEndpoint('/api/genie/recovery-tools','x-sg-recovery-tool',tool);
}
