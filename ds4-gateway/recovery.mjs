import { createHash, randomUUID } from 'node:crypto';
import { recoveryConfig, recoveryCall } from './recovery-transport.mjs';
import { verifyRecovery } from './recovery-verify.mjs';
import {safeNativeRemoval,unavailableNativeRemoval} from './launchd-removal-evidence.mjs';
import {bootstrapEnrollmentMatches,bootstrapProofValid} from './recovery-bootstrap.mjs';

const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const terminal=new Set(['recovered','verified_paused','failed','reconciliation_needed']);
const faultReasons=new Set(['fatal_accelerator_error','accelerator_checkpoint_failure']);
const adapterReasons=new Set(['adapter_timeout','adapter_output_limit','adapter_spawn_failed','adapter_dns_failure','adapter_host_key_failure','adapter_auth_failure','adapter_connect_timeout','adapter_connection_refused','adapter_route_unreachable','adapter_connection_reset','adapter_unreachable','adapter_check_failed','adapter_local_unavailable','adapter_local_identity_unverified']);
const publicOperation=op=>Object.fromEntries(['id','worker_id','actor','service_action','state','created_at','updated_at','error','proof','service_action_issued','restart_issued','operator_override','profile_adopted','bootstrap_acknowledged'].filter(k=>op[k]!==undefined).map(k=>[k,op[k]]));
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const nativePolicyReason=(s,c)=>c?.adapter==='launchd'&&s?.native_disabled!==false?(s?.native_disabled===true?'launchd_native_disabled':'launchd_disable_state_unverified'):null;
function requireNativePolicy(s,c){const reason=nativePolicyReason(s,c);if(reason)throw new Error(reason);}
const identityFields=['enrollment','instance','machine','observed_at','pid','profile','service_profile','started_at'];
const bootUUID=value=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const validIdentityRecord=value=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===identityFields.join(',')&&
  ['enrollment','machine','profile','service_profile'].every(key=>digest(value[key]))&&/^[a-f0-9]{32}$/.test(value.instance)&&
  Number.isSafeInteger(value.pid)&&value.pid>=2&&value.pid<=2147483647&&Number.isSafeInteger(value.started_at)&&value.started_at>=0&&
  Number.isSafeInteger(value.observed_at)&&value.observed_at>=value.started_at;
const blankState=()=>({version:1,automatic:false,profile_handback_automatic:true,adopted_profiles:{},operations:[]});
const bootstrapOperationValid=op=>{
  if(op.service_action!=='bootstrap')return !Object.keys(op).some(k=>k.startsWith('bootstrap_'));
  const p=op.bootstrap_prior;if(!p||!bootUUID(p.boot_uuid))return false;
  const {boot_uuid,...record}=p;
  return validIdentityRecord(record)&&digest(op.bootstrap_enrollment)&&record.enrollment===op.bootstrap_enrollment&&
    digest(op.bootstrap_definition_sha256)&&op.instance===p.instance&&op.machine===p.machine&&op.profile===p.profile&&op.service_profile===p.service_profile&&
    typeof op.canary==='boolean'&&(!op.canary||op.actor==='operator')&&typeof op.was_paused==='boolean'&&
    Number.isSafeInteger(op.context_length)&&op.context_length>0&&(op.bootstrap_acknowledged===undefined||typeof op.bootstrap_acknowledged==='boolean');
};
const adoptionOperationValid=op=>{
  const adoption=['adopt_profile','adopt_service_profile','configured_profile'].some(k=>Object.hasOwn(op,k))||String(op.service_action).startsWith('adopt_');
  if(!adoption)return true;
  return ['adopt_restart','adopt_verify'].includes(op.service_action)&&digest(op.adopt_profile)&&digest(op.configured_profile)&&
    (op.adopt_service_profile===null||digest(op.adopt_service_profile))&&op.profile===op.adopt_profile&&digest(op.machine);
};

// Lives in the gateway, not the dashboard or LLM process. Intent and outcomes
// share the gateway's atomic/fsynced metadata store. No inference text is saved.
export class Recovery {
  constructor(raw,{store,nodes,model,stopping,reinstate,log=()=>{},call=recoveryCall,verify=verifyRecovery,now=Date.now}) {
    this.configs=recoveryConfig(raw);this.store=store;this.nodes=nodes;this.model=model;this.stopping=stopping;this.reinstate=reinstate;this.log=log;this.call=call;this.verify=verify;this.now=now;
    this.observations=new Map();this.stoppedSince=new Map();this.handbackSeen=new Map();this.busy=false;this.closed=false;this.task=null;this.abort=new AbortController();
    this.removals=new Map();
    const saved=store.data.recovery;
    if(saved?.last_identities!==undefined){
      if(!saved.last_identities||typeof saved.last_identities!=='object'||Array.isArray(saved.last_identities))throw new Error('Invalid recovery identity history');
      for(const [worker,value] of Object.entries(saved.last_identities))if(!/^[a-zA-Z0-9][\w-]{0,63}$/.test(worker)||!validIdentityRecord(value))throw new Error('Invalid recovery identity history');
    }
    if(saved && (saved.version!==1 || typeof saved.automatic!=='boolean' || (saved.profile_handback_automatic!==undefined&&typeof saved.profile_handback_automatic!=='boolean') || !Array.isArray(saved.operations) || (saved.adopted_profiles!==undefined&&(!saved.adopted_profiles||typeof saved.adopted_profiles!=='object'||Array.isArray(saved.adopted_profiles)))))throw new Error('Invalid recovery journal; inspect manually');
    for(const [worker,profile] of Object.entries(saved?.adopted_profiles??{}))if(!/^[a-zA-Z0-9][\w-]{0,63}$/.test(worker)||!profile||!digest(profile.config_profile)||!digest(profile.machine)||!digest(profile.profile)||(profile.service_profile!==null&&!digest(profile.service_profile))||!Number.isFinite(profile.adopted_at)||!/^[a-f0-9-]{36}$/.test(profile.operation_id))throw new Error('Invalid adopted recovery profile');
    for(const op of this.state.operations) {
      if(!/^[a-f0-9-]{36}$/.test(op.id) || typeof op.worker_id!=='string' || typeof op.state!=='string'||!adoptionOperationValid(op)||!bootstrapOperationValid(op))throw new Error('Invalid recovery operation');
      if(!terminal.has(op.state)) {
        // Resume observation/verification only. Never resend an uncertain command.
        const node=this.node(op.worker_id);if(node){node.recovering=true;node.healthy=false;}
      }
    }
  }
  get state(){const saved=this.store.data.recovery;return saved?{...saved,profile_handback_automatic:saved.profile_handback_automatic??true,adopted_profiles:saved.adopted_profiles??{}}:blankState();}
  node(id){return this.nodes.find(n=>n.id===id);}
  config(id){
    const base=this.configs.get(id),adopted=this.state.adopted_profiles[id];
    if(!base||!adopted||adopted.config_profile!==base.profile||adopted.machine!==base.machine)return base;
    const effective={...base,profile:adopted.profile};
    // A live-profile inspection may not be able to prove the static stopped-
    // service profile. Never retain the old value and accidentally authorize a
    // future start. That path stays disabled until deliberately re-enrolled.
    if(adopted.service_profile)effective.service_profile=adopted.service_profile;
    else {delete effective.service_profile;effective.start_stopped=false;}
    return effective;
  }
  commit(next){this.store.save({...this.store.data,recovery:next});}
  priorIdentity(id){
    const record=this.state.last_identities?.[id],c=this.config(id);
    if(c?.adapter!=='launchd'||!validIdentityRecord(record)||record.enrollment!==hash(c))return null;
    const boot=this.state.last_identity_boots?.[id];
    return boot&&typeof boot==='object'&&!Array.isArray(boot)&&Object.keys(boot).sort().join(',')==='boot_uuid,identity'&&bootUUID(boot.boot_uuid)&&boot.identity===hash(record)?{...record,boot_uuid:boot.boot_uuid}:record;
  }
  rememberIdentity(id,s,at){
    const c=this.config(id);
    // Preserve one private identity observation, not inference content or a
    // health verdict. Future removal evidence must join this exact PID/epoch.
    if(c?.adapter!=='launchd'||!this.valid(s,c)||s.fault)return;
    const record={enrollment:hash(c),instance:s.instance,machine:s.machine,observed_at:at,pid:s.pid,profile:s.profile,service_profile:s.service_profile,started_at:s.started_at};
    if(!validIdentityRecord(record))return;
    const previous=this.priorIdentity(id);
    if(previous&&identityFields.filter(key=>key!=='observed_at').every(key=>previous[key]===record[key])&&(!bootUUID(s.boot_uuid)||previous.boot_uuid===s.boot_uuid))return;
    // Keep the original identity schema readable by older controllers. A boot
    // companion must match its entire identity digest; stale companions convey nothing.
    const savedBoots=this.state.last_identity_boots;
    if(savedBoots!==undefined&&(!savedBoots||typeof savedBoots!=='object'||Array.isArray(savedBoots)))return;
    const boots={...savedBoots};delete boots[id];if(bootUUID(s.boot_uuid))boots[id]={identity:hash(record),boot_uuid:s.boot_uuid};
    this.commit({...this.state,last_identities:{...this.state.last_identities,[id]:record},...(savedBoots!==undefined||bootUUID(s.boot_uuid)?{last_identity_boots:boots}:{})});
  }
  update(op,fields){Object.assign(op,this.current(op),fields,{updated_at:this.now()});this.commit({...this.state,operations:this.state.operations.map(x=>x.id===op.id?{...op}:x)});this.log('worker_recovery_action',publicOperation(op));}
  setAutomatic(value){if(typeof value!=='boolean' || !this.configs.size)throw new Error('Recovery is not configured or enabled is invalid');this.commit({...this.state,automatic:value});this.log('worker_recovery_policy',{automatic:value});return this.status();}
  setProfileHandbackAutomatic(value){if(typeof value!=='boolean'||!this.configs.size)throw new Error('Profile hand-back is not configured or enabled is invalid');this.commit({...this.state,profile_handback_automatic:value});this.log('worker_recovery_handback_policy',{automatic:value});return this.status();}
  binding(n,c){return !!n && !!c && n.url===c.url && n.ssh===c.ssh && JSON.stringify(n.ssh_fallbacks??[])===JSON.stringify(c.ssh_fallbacks??[]) && (n.remote_port??8000)===(c.remote_port??8000);}
  valid(s,c){return s?.version===1 && s.machine===c.machine && s.profile===c.profile && s.active===true && s.listener===true && /^[a-f0-9]{32}$/.test(s.instance) && Number.isFinite(s.started_at);}
  validStopped(s,c){return c?.start_stopped===true && s?.version===1 && s.machine===c.machine && s.service_profile===c.service_profile && s.loaded===true && s.stopped===true && s.active===false && s.listener===false && /^[a-f0-9]{64}$/.test(s.stopped_epoch);}
  bootstrapCertified(n,c){return this.state.operations.some(op=>op.worker_id===n.id&&op.service_action==='bootstrap'&&bootstrapOperationValid(op)&&
    op.canary===true&&op.actor==='operator'&&op.state==='verified_paused'&&op.was_paused===true&&op.service_action_issued===true&&op.bootstrap_acknowledged===true&&!op.operator_override&&
    op.bootstrap_enrollment===hash(c)&&op.bootstrap_definition_sha256===c.retained_definition_sha256&&op.context_length===n.contextLength&&
    op.machine===c.machine&&op.profile===c.profile&&op.service_profile===c.service_profile&&
    /^[a-f0-9]{32}$/.test(op.new_instance)&&op.new_instance!==op.instance&&bootstrapProofValid(op.proof,n.contextLength)&&
    Date.parse(op.proof.verified_at)>=op.created_at&&Date.parse(op.proof.verified_at)<=op.updated_at+10000);}
  bootstrapHoldReason(n){
    const state=this.store.data.agent_control;if(state===undefined)return null;
    if(!state||!Array.isArray(state.holds)||!Array.isArray(state.maintenance_locks??[])||
      [...state.holds,...(state.maintenance_locks??[])].some(h=>!h||typeof h.worker_id!=='string'))return 'maintenance_state_unverified';
    return [...state.holds,...(state.maintenance_locks??[])].some(h=>h?.worker_id===n.id)?'maintenance_hold_active':null;
  }
  bootstrapReason(n,s,{canary=false,operationId=null}={}){
    const c=this.config(n.id),p=this.priorIdentity(n.id),r=this.removals.get(n.id)?.result;
    if(!bootstrapEnrollmentMatches(s,c))return 'launchd_bootstrap_enrollment_unverified';
    if(!p?.boot_uuid||s.version!==1||s.machine!==c.machine||p.boot_uuid!==s.boot_uuid||p.profile!==c.profile||p.service_profile!==c.service_profile||s.service_profile!==c.service_profile||
      s.loaded!==false||s.registration!=='absent'||s.active!==false||s.stopped!==false||s.listener!==false||s.pid!==0||s.instance!=='')return 'launchd_bootstrap_identity_unverified';
    if(nativePolicyReason(s,c))return nativePolicyReason(s,c);
    if(this.bootstrapHoldReason(n))return this.bootstrapHoldReason(n);
    if(n.active||n.queue.length)return 'wait_for_admitted_work';
    if(canary&&!n.drained)return 'drain_before_canary';
    if(!canary&&n.drained)return 'operator_paused';
    if(n.healthy!==false)return 'worker_health_not_failed';
    if(!r||this.now()-r.checked_at>60000||r.checked_at>this.now()+10000||!['exact_removal_observed','exact_stop_request_observed'].includes(r.status)||!r.source_complete||
      r.observations_omitted!==0||r.observations.length!==1)return 'launchd_bootstrap_removal_unverified';
    const observation=r.observations[0];
    if(r.status==='exact_stop_request_observed'&&!(canary&&observation.caller==='launchctl'))return 'launchd_bootstrap_caller_not_enrolled';
    if(observation.at<p.observed_at||!((canary&&observation.caller==='launchctl')||c.bootstrap_callers.includes(observation.caller)))return 'launchd_bootstrap_caller_not_enrolled';
    const previous=this.state.operations.filter(op=>op.worker_id===n.id&&op.id!==operationId);
    if(previous.some(op=>op.service_action==='bootstrap'&&op.instance===p.instance))return 'removed_instance_already_attempted';
    if(!canary&&!this.bootstrapCertified(n,c))return 'launchd_bootstrap_canary_required';
    if(!canary&&previous.some(op=>this.now()-op.created_at<30*60000))return 'recovery_cooldown';
    return null;
  }
  bootstrapExecutionVeto(n,op){
    if(n.removed||this.node(n.id)!==n||this.stopping()||this.closed)throw new Error('controller_stopping');
    if(hash(this.config(n.id))!==op.bootstrap_enrollment)throw new Error('bootstrap_enrollment_changed');
    if(n.contextLength!==op.context_length)throw new Error('recovery_context_changed');
    const held=this.bootstrapHoldReason(n);if(held)throw new Error(held);
    if(n.active||n.queue.length)throw new Error('worker_has_admitted_work');
    if(this.current(op).operator_override||(n.drained&&!op.was_paused)||(op.actor!=='operator'&&!this.state.automatic))throw new Error('operator_cancelled_before_bootstrap');
  }
  validBootstrapLive(s,c,op){return this.valid(s,c)&&bootstrapEnrollmentMatches(s,c)&&s.boot_uuid===op.bootstrap_prior.boot_uuid&&s.service_profile===op.service_profile;}
  profileCandidate(s,c){return !!c&&s?.version===1&&s.machine===c.machine&&digest(s.profile)&&s.profile!==c.profile&&s.active===true&&s.listener===true&&/^[a-f0-9]{32}$/.test(s.instance)&&Number.isFinite(s.started_at)?{profile:s.profile,service_profile:digest(s.service_profile)?s.service_profile:null,instance:s.instance}:null;}
  candidateStable(id,candidate){const seen=this.handbackSeen.get(id);return !!seen&&seen.profile===candidate.profile&&seen.service_profile===candidate.service_profile&&seen.instance===candidate.instance&&seen.count>=2&&seen.last_at-seen.first_at>=10000;}
  evidence(n,s){const c=this.config(n.id),candidate=this.profileCandidate(s,c);return c?.bootstrap_removed===true&&s?.registration==='absent'?hash([n.id,'bootstrap',this.priorIdentity(n.id),hash(c),this.removals.get(n.id)?.result]):candidate?hash([n.id,n.quarantine,'adopt',candidate.instance,s.machine,c.profile,candidate.profile,candidate.service_profile]):this.valid(s,c)?hash([n.id,n.quarantine,'restart',s.instance,s.machine,s.profile]):hash([n.id,n.quarantine,'start',s.stopped_epoch,s.machine,s.service_profile]);}
  reason(n,s,{canary=false,ignoreOwnership=false,ignorePause=false}={}) {
    const c=this.config(n?.id);
    if(!this.binding(n,c))return 'manual_recovery_required';
    if(this.closed || this.stopping())return 'gateway_stopping';
    if(!Number.isSafeInteger(n.contextLength) || n.contextLength<=0)return 'context_unverified';
    if(!ignoreOwnership && (this.task || this.state.operations.some(o=>!terminal.has(o.state))))return 'fleet_recovery_in_progress';
    // Identity drift is a durable enrollment problem, whereas admitted work is
    // transient. Report the durable gate even while a worker is busy so the UI,
    // operator and Genie do not imply that an empty queue alone restores
    // recovery authority. The executor still independently rechecks identity.
    const live=this.valid(s,c),stopped=this.validStopped(s,c),candidate=this.profileCandidate(s,c);
    // Missing registration is distinct from an unreadable domain. Only separate
    // bootstrap enrollment and its independent gates can turn absence into an offer.
    if(c.adapter==='launchd'&&s?.version===1&&s.machine===c.machine&&s.active===false&&s.stopped===false&&s.pid===0&&s.instance===''&&
      (!c.service_profile||s.service_profile===c.service_profile)){
      if(s.loaded===false&&s.registration==='absent')return c.bootstrap_removed===true?this.bootstrapReason(n,s,{canary}):'launchd_registration_absent';
      if(s.loaded===null&&s.registration==='gui_domain_unavailable')return 'launchd_gui_domain_unavailable';
      if(s.loaded===null&&s.registration==='unverified')return 'launchd_state_unverified';
    }
    if(!live&&!stopped&&!candidate)return s?.stopped===true&&c?.start_stopped!==true?'stopped_service_start_not_enrolled':'service_identity_or_profile_unverified';
    const nativeReason=nativePolicyReason(s,c);if(nativeReason)return nativeReason;
    if(candidate&&(n.active||n.queue.length))return 'profile_handback_wait_for_admitted_work';
    if(n.active || n.queue.length)return 'wait_for_admitted_work';
    if(canary) {
      if(!n.drained)return 'drain_before_canary';
      if(live)return null;
      if(stopped) {
        if(n.healthy!==false)return 'worker_health_not_failed';
        const observed=this.stoppedSince.get(n.id);
        return !observed||observed.epoch!==s.stopped_epoch||this.now()-observed.since<15000?'stopped_service_confirmation_pending':null;
      }
      return 'service_identity_or_profile_unverified';
    }
    if(n.drained&&!ignorePause)return 'operator_paused';
    if(candidate) {
      if(!this.state.profile_handback_automatic)return 'profile_handback_disabled';
      if(!n.quarantine)return 'profile_handback_requires_quarantine';
      const failedAt=Date.parse(n.quarantine.at),replaced=Number.isFinite(failedAt)&&s.started_at>failedAt+1000;
      if(!Number.isFinite(failedAt))return 'fault_time_unknown';
      if(!replaced&&(!faultReasons.has(n.quarantine.reason)||!s.fault||s.fault.reason!=='fatal_accelerator_error'||s.fault.at<failedAt-120000))return 'current_fatal_evidence_required';
      if(!this.candidateStable(n.id,candidate))return 'profile_handback_confirmation_pending';
      const previous=this.state.operations.filter(o=>o.worker_id===n.id);
      if(previous.some(o=>o.adopt_profile===candidate.profile&&o.instance===candidate.instance))return 'profile_candidate_already_attempted';
      if(previous.some(o=>this.now()-o.created_at<30*60000))return 'recovery_cooldown';
      return null;
    }
    if(stopped) {
      if(n.healthy!==false)return 'worker_health_not_failed';
      const observed=this.stoppedSince.get(n.id);
      if(!observed || observed.epoch!==s.stopped_epoch || this.now()-observed.since<15000)return 'stopped_service_confirmation_pending';
      const previous=this.state.operations.filter(o=>o.worker_id===n.id);
      if(previous.some(o=>o.stopped_epoch===s.stopped_epoch))return 'stopped_epoch_already_attempted';
      if(previous.some(o=>this.now()-o.created_at<30*60000))return 'recovery_cooldown';
      return null;
    }
    if(!n.quarantine)return 'no_supported_quarantine';
    const failedAt=Date.parse(n.quarantine.at);
    if(!Number.isFinite(failedAt))return 'fault_time_unknown';
    // A new invocation may already have auto-restarted. Verify, don't restart it.
    const replaced=s.started_at>failedAt+1000;
    // Any supported quarantine may be safely cleared after the enrolled service
    // manager has already produced a new exact-profile instance. DSG issues no
    // restart in this path; the same failed instance remains ineligible unless
    // it carries the separately supported fatal accelerator evidence below.
    if(!faultReasons.has(n.quarantine?.reason)&&!replaced)return 'no_supported_quarantine';
    if(!replaced && (!s.fault || s.fault.reason!=='fatal_accelerator_error' || s.fault.at<failedAt-120000))return 'current_fatal_evidence_required';
    const previous=this.state.operations.filter(o=>o.worker_id===n.id);
    if(previous.some(o=>o.instance===s.instance))return 'instance_already_attempted';
    if(previous.some(o=>this.now()-o.created_at<30*60000))return 'recovery_cooldown';
    return null;
  }
  workerStatus(n) {
    const observed=this.observations.get(n.id),s=observed?.value;
    const reason=!observed || this.now()-observed.at>90000?'service_inspection_pending':observed.error||this.reason(n,s);
    const configured=this.configs.has(n.id),last=this.state.operations.filter(o=>o.worker_id===n.id).at(-1);
    // Current worker state is not the last action's historical outcome. In
    // particular, a successful paused canary may since have been resumed.
    const state=n.recovering?'recovering':!configured?'manual':n.drained?'paused':n.quarantine?'quarantined':n.healthy===false?'unavailable':'monitoring';
    const effective=this.config(n.id),candidate=this.profileCandidate(s,effective),adopted=!!this.state.adopted_profiles[n.id]&&effective?.profile===this.state.adopted_profiles[n.id].profile;
    return {worker_id:n.id,configured,adapter:configured?this.configs.get(n.id).adapter:null,transport:configured?(this.configs.get(n.id).transport??'ssh'):null,reason:configured?reason:'manual_recovery_required',eligible:configured&&!reason,
      evidence_id:configured&&!reason?this.evidence(n,s):null,inspected_at:observed?.at??null,
      removal:this.removals.get(n.id)?.result??null,
      ...(effective?.bootstrap_removed===true?{bootstrap:{enrolled:true,certified:this.bootstrapCertified(n,effective)}}:{}),
      state,profile_handback:candidate?{candidate:true,stable:this.candidateStable(n.id,candidate),automatic:this.state.profile_handback_automatic}:adopted?{candidate:false,stable:true,automatic:this.state.profile_handback_automatic,adopted:true}:null,last_action:last?publicOperation(last):null};
  }
  profileHandbackOffer(n,{ignorePause=false}={}) {
    if(!this.state.automatic)throw new Error('automatic_recovery_off');
    const observed=this.observations.get(n?.id),s=observed?.value,c=this.config(n?.id);
    if(!n||!observed||this.now()-observed.at>90000)throw new Error('service_inspection_pending');
    if(!this.profileCandidate(s,c))throw new Error('no_profile_handback_candidate');
    const reason=observed.error||this.reason(n,s,{ignorePause});if(reason)throw new Error(reason);
    return {worker_id:n.id,evidence_id:this.evidence(n,s)};
  }
  status(){const adapters=[...new Set([...this.configs.values()].map(c=>c.adapter))];return {configured:!!this.configs.size,automatic:this.state.automatic,profile_handback_automatic:this.state.profile_handback_automatic,adapter:adapters.length===1?adapters[0]:adapters.length?'mixed':null,workers:this.nodes.map(n=>this.workerStatus(n)),operations:this.state.operations.slice(-30).reverse().map(publicOperation)};}
  async inspect(id,{freshRemoval=false}={}) {
    const c=this.config(id);
    try {
      const value=await this.call(c,{action:'inspect'}),at=this.now();this.observations.set(id,{at,value});
      this.rememberIdentity(id,value,at);
      await this.inspectRemoval(id,value,at,{force:freshRemoval});
      if(this.observations.get(id)?.value!==value)return value;
      const candidate=this.profileCandidate(value,c),prior=this.handbackSeen.get(id);
      if(candidate)this.handbackSeen.set(id,prior&&prior.profile===candidate.profile&&prior.service_profile===candidate.service_profile&&prior.instance===candidate.instance?{...prior,last_at:at,count:prior.last_at===at?prior.count:prior.count+1}:{...candidate,first_at:at,last_at:at,count:1});
      else this.handbackSeen.delete(id);
      if(this.validStopped(value,c)) {
        const prior=this.stoppedSince.get(id);if(!prior||prior.epoch!==value.stopped_epoch)this.stoppedSince.set(id,{epoch:value.stopped_epoch,since:at});
      } else this.stoppedSince.delete(id);
      return value;
    }
    catch(e) {this.stoppedSince.delete(id);this.observations.set(id,{at:this.now(),error:adapterReasons.has(e?.message)?e.message:'adapter_check_failed'});return null;}
  }
  async inspectRemoval(id,value,at,{force=false}={}){
    const c=this.config(id),prior=this.priorIdentity(id);
    if(c?.adapter!=='launchd'||value?.removal_capture_version!==1||value.registration!=='absent'||value.loaded!==false||value.active!==false||
      value.machine!==c.machine||!prior?.boot_uuid||value.service_profile!==prior.service_profile){this.removals.delete(id);return;}
    const key=hash([prior,value.boot_uuid,value.service_profile]),cached=this.removals.get(id);
    if(!force&&cached?.key===key&&at-cached.at<(c.bootstrap_removed===true?60000:5*60000))return;
    const pending={key,at,result:null};this.removals.set(id,pending);
    const {enrollment,...identity}=prior;
    let result;
    try{result=safeNativeRemoval(await this.call(c,{action:'inspect_removal',prior:identity}),{now:this.now(),after:at});}catch{/* Bounded unavailable evidence, not a recovery failure. */}
    if(this.removals.get(id)===pending){
      if(this.closed||hash(this.priorIdentity(id))!==hash(prior))this.removals.delete(id);
      else pending.result=result??unavailableNativeRemoval(this.now());
    }
  }
  request(input,actor='operator',{canary=false}={}) {
    if(!input || Object.keys(input).some(k=>!['worker_id','evidence_id','action_id'].includes(k)) || !['operator','genie','detector'].includes(actor))throw new Error('Invalid recovery request');
    const id=input.action_id??randomUUID();if(!/^[a-f0-9-]{36}$/.test(id))throw new Error('Invalid action ID');
    const duplicate=this.state.operations.find(o=>o.id===id);
    if(duplicate){if(duplicate.worker_id!==input.worker_id || duplicate.evidence_id!==input.evidence_id)throw new Error('Action ID conflict');return publicOperation(duplicate);}
    if(actor!=='operator' && !this.state.automatic)throw new Error('Automatic recovery is off');
    if(canary && actor!=='operator')throw new Error('Canary is operator-only');
    const n=this.node(input.worker_id),observed=this.observations.get(input.worker_id),s=observed?.value;
    if(!n || !observed || this.now()-observed.at>90000)throw new Error('Refresh service inspection first');
    const reason=this.reason(n,s,{canary});if(reason)throw new Error(reason);
    if(!canary && input.evidence_id!==this.evidence(n,s))throw new Error('Stale or invented recovery evidence');
    if(this.state.operations.length>=10000)throw new Error('Recovery journal full; review required');
    const c=this.config(n.id),candidate=this.profileCandidate(s,c),failedAt=Date.parse(n.quarantine?.at),replacement=!!candidate&&Number.isFinite(failedAt)&&s.started_at>failedAt+1000;
    const bootstrapping=c.bootstrap_removed===true&&s.registration==='absent',prior=bootstrapping?this.priorIdentity(n.id):null;
    const serviceAction=bootstrapping?'bootstrap':candidate?(replacement?'adopt_verify':'adopt_restart'):this.validStopped(s,c)?'start':'restart';
    const op={id,worker_id:n.id,actor,evidence_id:input.evidence_id??null,service_action:serviceAction,state:'queued',created_at:this.now(),updated_at:this.now(),instance:s.instance,
      stopped_epoch:serviceAction==='start'?s.stopped_epoch:null,service_profile:serviceAction==='start'?s.service_profile:null,
      machine:s.machine,profile:serviceAction==='start'?c.profile:s.profile,context_length:n.contextLength,canary,was_paused:n.drained,quarantine:n.quarantine?{...n.quarantine}:null,
      ...(candidate?{adopt_profile:candidate.profile,adopt_service_profile:candidate.service_profile,configured_profile:this.configs.get(n.id).profile}:{}),
      ...(bootstrapping?{instance:prior.instance,profile:prior.profile,service_profile:prior.service_profile,bootstrap_prior:prior,
        bootstrap_enrollment:hash(c),bootstrap_definition_sha256:c.retained_definition_sha256}:{}),
      binding:hash([n.url,n.ssh,n.ssh_fallbacks??[],n.remote_port??8000]),operator_override:false};
    this.commit({...this.state,operations:[...this.state.operations,op]});
    n.recovering=true;n.healthy=false;
    this.task=this.execute(op,false).finally(()=>{this.task=null;});
    return publicOperation(op);
  }
  operatorPause(ids){for(const op of this.state.operations.filter(o=>ids.includes(o.worker_id)&&!terminal.has(o.state)))this.update({...op},{operator_override:true});}
  reconcile(input) {
    if(!input || Object.keys(input).join(',')!=='action_id')throw new Error('Specify action_id only');
    const op=this.state.operations.find(o=>o.id===input.action_id),n=this.node(op?.worker_id);
    if(!op || !['reconciliation_needed','failed'].includes(op.state) || !(op.restart_issued||op.service_action_issued) || !n || n.active || n.queue.length || this.task || this.closed || this.stopping())throw new Error('Recovery cannot be rechecked now');
    this.update(op,{state:'reconciling',error:null});n.recovering=true;n.healthy=false;
    this.task=this.execute(op,true).finally(()=>{this.task=null;});return publicOperation(op);
  }
  current(op){return this.state.operations.find(o=>o.id===op.id)??op;}
  async execute(initial,reconcile) {
    let op={...initial};const enrolled=this.configs.get(op.worker_id),effective=this.config(op.worker_id),adopting=digest(op.adopt_profile),c=adopting?{...effective,profile:op.adopt_profile,...(digest(op.adopt_service_profile)?{service_profile:op.adopt_service_profile}:{})}:effective,n=this.node(op.worker_id);
    try {
      if(!n || !this.binding(n,enrolled) || hash([n.url,n.ssh,n.ssh_fallbacks??[],n.remote_port??8000])!==op.binding || c.profile!==op.profile || c.machine!==op.machine || (adopting&&op.configured_profile!==enrolled.profile))throw new Error('recovery_binding_changed');
      const bootstrapping=op.service_action==='bootstrap';
      if(bootstrapping&&(!bootstrapOperationValid(op)||hash(c)!==op.bootstrap_enrollment))throw new Error('bootstrap_enrollment_changed');
      const before=await this.inspect(n.id,{freshRemoval:bootstrapping}),starting=op.service_action==='start',adoptVerify=op.service_action==='adopt_verify';
      const activeBefore=bootstrapping?this.validBootstrapLive(before,c,op):this.valid(before,c),stoppedBefore=this.validStopped(before,c)&&before.stopped_epoch===op.stopped_epoch;
      if(!reconcile && !activeBefore && !(starting&&stoppedBefore)&&!bootstrapping)throw new Error('service_identity_or_profile_unverified');
      if(activeBefore||stoppedBefore)requireNativePolicy(before,c);
      if(bootstrapping)this.bootstrapExecutionVeto(n,op);
      if(n.active || n.queue.length)throw new Error('worker_has_admitted_work');
      if(this.closed)throw new Error('controller_stopping');
      const failedAt=Date.parse(op.quarantine?.at);
      const replacement=activeBefore && (starting || adoptVerify || before.instance!==op.instance || (!op.canary && before.started_at>failedAt+1000));
      if(!reconcile && !replacement) {
        if(bootstrapping){
          if(hash(this.priorIdentity(n.id))!==hash(op.bootstrap_prior))throw new Error('bootstrap_prior_identity_changed');
          const reason=this.bootstrapReason(n,before,{canary:op.canary,operationId:op.id});if(reason)throw new Error(reason);
        }else if(starting) {
          if(!stoppedBefore || before.service_profile!==op.service_profile)throw new Error('stopped_service_identity_changed');
        } else if(before.instance!==op.instance || (!op.canary && (!before.fault || before.fault.at<failedAt-120000)))throw new Error('current_fatal_evidence_required');
        if(this.current(op).operator_override || (op.actor!=='operator'&&!this.state.automatic))throw new Error(starting?'operator_cancelled_before_start':'operator_cancelled_before_restart');
        this.update(op,{state:bootstrapping?'bootstrapping':starting?'starting':'restarting',service_action_issued:true,...(starting||bootstrapping?{}:{restart_issued:true})}); // durable BEFORE command
        if(bootstrapping)this.bootstrapExecutionVeto(n,op);
        try {
          if(bootstrapping){
            const {enrollment,...prior}=op.bootstrap_prior;
            const receipt=await this.call(c,{action:'bootstrap',action_id:op.id,prior,definition_sha256:op.bootstrap_definition_sha256,canary:op.canary});
            const acknowledged=receipt?.state==='issued'&&receipt.operation==='bootstrap'&&receipt.instance===op.instance&&receipt.definition_sha256===op.bootstrap_definition_sha256;
            this.update(op,{bootstrap_acknowledged:acknowledged});
          }else await this.call(c,starting?{action:'start',action_id:op.id,stopped_epoch:before.stopped_epoch,machine:c.machine,service_profile:c.service_profile}:{action:'restart',action_id:op.id,instance:before.instance,machine:c.machine,profile:c.profile,canary:op.canary,fault_after:op.canary?0:failedAt-120000});
        }
        catch {this.update(op,{state:'reconciling'});} // Never replay after lost acknowledgement.
      } else if(reconcile && !replacement) {
        this.update(op,{state:'reconciling'});
      }
      const deadline=this.now()+15*60000;
      let after=before;
      while(!this.closed) {
        after=await this.inspect(n.id);
        if((bootstrapping?this.validBootstrapLive(after,c,op):this.valid(after,c)) && (starting || after.instance!==op.instance || replacement))break;
        if(this.now()>=deadline)throw new Error(bootstrapping?'bootstrap_not_verified':starting?'start_not_verified':'restart_not_verified');
        await new Promise(resolve=>{this.wake=resolve;this.waitTimer=setTimeout(resolve,3000);});this.wake=null;
      }
      if(this.closed)throw new Error('controller_stopping');
      if(!this.valid(after,c) || after.fault)throw new Error('replacement_identity_or_health_failed');
      requireNativePolicy(after,c);
      if(bootstrapping)this.bootstrapExecutionVeto(n,op);
      this.update(op,{state:'verifying',new_instance:after.instance});
      const proof=await this.verify(n.url,this.model,op.context_length,{signal:this.abort.signal});
      const final=await this.inspect(n.id);
      if(!this.valid(final,c) || final.instance!==after.instance || final.fault)throw new Error('identity_changed_during_verification');
      requireNativePolicy(final,c);
      if(bootstrapping){
        if(!this.validBootstrapLive(final,c,op)||!bootstrapProofValid(proof,op.context_length))throw new Error('bootstrap_generation_or_identity_unverified');
        this.bootstrapExecutionVeto(n,op);
      }
      op={...this.current(op)};
      const held=op.operator_override || op.was_paused || n.removed || this.node(n.id)!==n || n.drained || this.stopping();
      const adoption=adopting?{config_profile:enrolled.profile,machine:enrolled.machine,profile:op.adopt_profile,service_profile:digest(op.adopt_service_profile)?op.adopt_service_profile:null,adopted_at:this.now(),operation_id:op.id}:null;
      const nextState={...this.state,adopted_profiles:adoption?{...this.state.adopted_profiles,[n.id]:adoption}:this.state.adopted_profiles,operations:this.state.operations.map(x=>x.id===op.id?{...op,profile_adopted:!!adoption,state:held?'verified_paused':'recovered',proof,updated_at:this.now()}:x)};
      if(!held) {
        Object.assign(op,{state:'recovered',proof,profile_adopted:!!adoption,updated_at:this.now()});
        this.reinstate(n,op.quarantine,nextState);
        this.log('worker_recovery_action',publicOperation(op));
      } else {this.commit(nextState);this.log('worker_recovery_action',publicOperation({...op,state:'verified_paused',proof,profile_adopted:!!adoption,updated_at:this.now()}));}
    } catch(e) {
      const issued=op.restart_issued||op.service_action_issued;
      const state=this.closed&&issued?'reconciling':issued && !op.new_instance?'reconciliation_needed':'failed';
      const code=/^[a-z_]+$/.test(e.message)?e.message:'recovery_verification_failed';
      try {this.update({...this.current(op)},{state,error:code});}catch{this.closed=true;}
    } finally {
      if(n){n.recovering=false;if(this.current(op).state!=='recovered')n.healthy=false;}
    }
  }
  async tick() {
    if(this.busy || this.closed || this.stopping() || this.task || !this.configs.size)return;
    this.busy=true;
    try {
      const pending=this.state.operations.find(o=>!terminal.has(o.state));
      if(pending){this.task=this.execute(pending,true).finally(()=>{this.task=null;});return;}
      for(const [id] of this.configs) {
        if(this.closed)return;
        const n=this.node(id);if(!n)continue;
        await this.inspect(id);
        const status=this.workerStatus(n);
        if(this.state.automatic && status.eligible){this.request({worker_id:id,evidence_id:status.evidence_id},'detector');break;}
      }
    } catch {this.log('worker_recovery_monitor_error');}
    finally{this.busy=false;}
  }
  async close(){this.closed=true;this.abort.abort();clearTimeout(this.waitTimer);this.wake?.();await this.task;}
}
