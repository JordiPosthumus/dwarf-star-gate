// Chat submits the same evidence-bound requests as the existing fleet reviewer.
import {createToolEndpoint} from './genie-tool-endpoint.mjs';
export function recoveryEvidence(status){
  const recovery=status?.recovery;
  if(status?.version!==1||!Array.isArray(recovery?.workers)||!Array.isArray(recovery.operations))throw new Error('Current recovery status is unavailable.');
  return {observed_at:new Date().toISOString(),...recovery,
    matched_bindings:recovery.workers.filter(w=>w.enrollment?.binding==='matched').map(w=>w.worker_id),
    unmatched_bindings:recovery.workers.filter(w=>w.enrollment?.binding!=='matched').map(w=>({worker_id:w.worker_id,binding:w.enrollment?.binding??'unknown'})),
    scope:'Current enrolled-service eligibility and existing recovery receipts. configured and adapter describe a registered definition, not a working connection. A mismatched or absent binding is NOT connected. The switch alone does not connect a service. A queued receipt is acceptance, not successful recovery. No enrollment, canary or server configuration changes are available here.'};
}
export function createRecoveryTools({read,recover,preparation=null,continuation=()=>null,isInspectionEnabled=()=>true,isTesting=()=>false,isEnabled=()=>true}){
  async function tool(input){
    if(input?.action==='status'&&Object.keys(input).length===1)return {...recoveryEvidence(await read()),...(preparation?{pair_preparations:await preparation.status(),pair_preparation_followup:continuation()}: {})};
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
