// Scoped agent ingress to the existing gateway executor. This is not a sandbox
// against processes that already possess the operator's OS account/socket.
import {createHash,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
const hash=value=>createHash('sha256').update(value).digest('hex');
const identifier=value=>typeof value==='string'&&/^[a-zA-Z0-9][\w-]{0,63}$/.test(value);
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const blank=()=>({schema:1,agents:[],holds:[],operations:[],manual_paused:{},maintenance_locks:[],maintenance_operations:[]});
function fail(code,message,status=400){throw Object.assign(new Error(message),{code,status});}
function exact(input,keys){if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).sort().join(',')!==keys.sort().join(','))fail('invalid_fields','Unexpected or missing action fields');}
const publicAgent=a=>({agent_id:a.id,enabled:a.enabled,workers:a.workers,created_at:a.created_at});

export class AgentControl {
  constructor({store,nodes,canResume,canHandback=null,onPause=()=>{},onHandback=()=>{},log=()=>{},now=Date.now}) {
    Object.assign(this,{store,nodes,canResume,canHandback,onPause,onHandback,log,now});
    const s=this.state;
    if(!s||s.schema!==1||!Array.isArray(s.agents)||s.agents.length>128||!Array.isArray(s.holds)||s.holds.length>1024||!Array.isArray(s.operations)||s.operations.length>10000||!s.manual_paused||typeof s.manual_paused!=='object'||Array.isArray(s.manual_paused)||!Array.isArray(s.maintenance_locks)||s.maintenance_locks.length>1024||!Array.isArray(s.maintenance_operations)||s.maintenance_operations.length>10000)throw new Error('Invalid agent control state');
    if(s.agents.some(a=>!identifier(a.id)||typeof a.enabled!=='boolean'||!Number.isFinite(a.created_at)||!Array.isArray(a.workers)||a.workers.length>128||new Set(a.workers).size!==a.workers.length||a.workers.some(w=>!identifier(w))||!/^[a-f0-9]{64}$/.test(a.token_hash))||new Set(s.agents.map(a=>a.id)).size!==s.agents.length)throw new Error('Invalid agent grants');
    if(s.holds.some(h=>!uuid(h.id)||!identifier(h.worker_id)||!s.agents.some(a=>a.id===h.owner_id)||typeof h.reason!=='string'||h.reason.length>256||!Number.isFinite(h.created_at))||new Set(s.holds.map(h=>h.id)).size!==s.holds.length)throw new Error('Invalid agent holds');
    if(s.operations.some(o=>!uuid(o.request_id)||!s.agents.some(a=>a.id===o.actor_id)||!Number.isFinite(o.time)||!['drain','resume'].includes(o.action)||!/^[a-f0-9]{64}$/.test(o.fingerprint)||!o.result||!uuid(o.result.hold_id)||!identifier(o.result.worker_id)||typeof o.result.routing_resumed!=='boolean')||new Set(s.operations.map(o=>o.request_id)).size!==s.operations.length)throw new Error('Invalid agent receipts');
    if(s.maintenance_locks.some(l=>!uuid(l.id)||!identifier(l.worker_id)||typeof l.name!=='string'||!l.name.trim()||l.name.length>64||/[\x00-\x1f\x7f]/.test(l.name)||typeof l.reason!=='string'||!l.reason.trim()||l.reason.length>256||/[\x00-\x1f\x7f]/.test(l.reason)||!Number.isFinite(l.created_at)||(l.review_at!==null&&(!Number.isFinite(l.review_at)||l.review_at<=l.created_at))||typeof l.control_channel!=='string'||!/^[a-z][a-z0-9_]{0,31}$/.test(l.control_channel))||new Set(s.maintenance_locks.map(l=>l.id)).size!==s.maintenance_locks.length)throw new Error('Invalid maintenance locks');
    if(s.maintenance_operations.some(o=>!uuid(o.request_id)||!Number.isFinite(o.time)||!['lock','release'].includes(o.action)||!/^[a-f0-9]{64}$/.test(o.fingerprint)||typeof o.control_channel!=='string'||!/^[a-z][a-z0-9_]{0,31}$/.test(o.control_channel)||!o.result||!uuid(o.result.lock_id)||!identifier(o.result.worker_id)||typeof o.result.routing_resumed!=='boolean')||new Set(s.maintenance_operations.map(o=>o.request_id)).size!==s.maintenance_operations.length)throw new Error('Invalid maintenance receipts');
    if(Object.values(s.manual_paused).some(v=>typeof v!=='boolean'))throw new Error('Invalid operator pause state');
    for(const n of nodes)if((Object.hasOwn(s.manual_paused,n.id)||this.holds(n.id).length||this.maintenanceLocks(n.id).length)&&n.drained!==(this.holds(n.id).length>0||this.maintenanceLocks(n.id).length>0||this.manualPaused(n.id)))throw new Error('Pause ownership conflicts with saved routing state');
    if(s.holds.some(h=>!nodes.some(n=>n.id===h.worker_id)))throw new Error('Held worker missing from registry');
    if(s.maintenance_locks.some(l=>!nodes.some(n=>n.id===l.worker_id)))throw new Error('Maintenance-locked worker missing from registry');
  }
  get state(){
    const state=Object.hasOwn(this.store.data,'agent_control')?this.store.data.agent_control:blank();
    // Schema-1 deployments predate operator maintenance locks. Missing arrays
    // migrate in memory and are persisted with the next control mutation.
    return {...state,maintenance_locks:state.maintenance_locks??[],maintenance_operations:state.maintenance_operations??[]};
  }
  holds(workerId){return this.state.holds.filter(h=>h.worker_id===workerId);}
  maintenanceLocks(workerId){return this.state.maintenance_locks.filter(l=>l.worker_id===workerId);}
  manualPaused(workerId){return Object.hasOwn(this.state.manual_paused,workerId)?this.state.manual_paused[workerId]:this.store.data.drained?.[workerId]===true;}
  pauseStatus(workerId,{includeReason=false}={}){return {operator_paused:this.manualPaused(workerId),holds:this.holds(workerId).map(({reason,...h})=>({...h,...(includeReason?{reason}:{})})),maintenance_locks:this.maintenanceLocks(workerId).map(({reason,...l})=>({...l,...(includeReason?{reason}:{})}))};}
  commit(next,drained=this.store.data.drained??{}) {
    this.store.save({...this.store.data,agent_control:next,drained});
    for(const n of this.nodes)n.drained=drained[n.id]===true;
  }
  manualUpdate(ids,paused) {
    if(!paused&&ids.some(id=>this.holds(id).length))fail('agent_hold_present','Release the named agent holds before enabling this worker',409);
    if(!paused&&ids.some(id=>this.maintenanceLocks(id).length))fail('maintenance_lock_present','Release the exact maintenance lock before enabling this worker',409);
    const state=structuredClone(this.state),drained={...this.store.data.drained};
    for(const id of ids){state.manual_paused[id]=paused;drained[id]=paused||this.holds(id).length>0||this.maintenanceLocks(id).length>0;}
    return {agent_control:state,drained};
  }
  forgetWorker(id) {
    if(this.holds(id).length)fail('agent_hold_present','Release agent holds before removing this worker',409);
    if(this.maintenanceLocks(id).length)fail('maintenance_lock_present','Release maintenance locks before removing this worker',409);
    const s=structuredClone(this.state);delete s.manual_paused[id];
    for(const a of s.agents)a.workers=a.workers.filter(w=>w!==id);
    return s;
  }
  grant(input) {
    exact(input,['agent_id','workers']);
    if(!identifier(input.agent_id)||!Array.isArray(input.workers)||!input.workers.length||input.workers.length>128||new Set(input.workers).size!==input.workers.length||input.workers.some(id=>!this.nodes.some(n=>n.id===id)))fail('invalid_grant','Specify a new agent ID and distinct registered worker IDs');
    if(this.state.agents.some(a=>a.id===input.agent_id))fail('agent_exists','Agent ID already exists; use a new ID rather than silently transferring ownership',409);
    if(this.state.agents.length>=128)fail('grant_limit','Agent grant budget reached; operator review required',409);
    const token=randomBytes(32).toString('base64url'),agent={id:input.agent_id,workers:[...input.workers],enabled:true,token_hash:hash(token),created_at:this.now()};
    this.commit({...this.state,agents:[...this.state.agents,agent]});this.log('agent_granted',publicAgent(agent));
    return {...publicAgent(agent),token}; // Once, through the private operator socket.
  }
  revoke(input) {
    exact(input,['agent_id']);const a=this.state.agents.find(a=>a.id===input.agent_id);
    if(!a)fail('unknown_agent','Unknown agent');
    this.commit({...this.state,agents:this.state.agents.map(x=>x.id===a.id?{...x,enabled:false}:x)});
    this.log('agent_revoked',{agent_id:a.id});return {agent_id:a.id,enabled:false,holds_retained:true};
  }
  authenticate(header) {
    if(typeof header!=='string'||!/^Bearer [A-Za-z0-9_-]{43}$/.test(header))return null;
    const supplied=Buffer.from(hash(header.slice(7)),'hex');
    return this.state.agents.find(a=>a.enabled&&timingSafeEqual(supplied,Buffer.from(a.token_hash,'hex')))?.id??null;
  }
  agent(id) {
    const a=this.state.agents.find(a=>a.id===id&&a.enabled);
    if(!a)fail('unauthorized','Agent credential is invalid or revoked',401);return a;
  }
  worker(id){const n=this.nodes.find(n=>n.id===id);if(!n)fail('unknown_worker','Worker is not registered',404);return n;}
  status(actor) {
    const a=this.agent(actor);
    return {schema:1,observed_at:this.now(),agent:publicAgent(a),allowed_actions:['status','drain','resume_own_holds','receipt'],workers:this.nodes.map(n=>({
      id:n.id,can_manage:a.workers.includes(n.id),is_healthy:n.healthy,drained:n.drained,
      gateway_drained:n.drained&&!n.active&&!n.queue.length,load:Number(!!n.active),queued:n.queue.length,
      quarantined:!!n.quarantine,recovering:!!n.recovering,context_length:n.contextLength??null,
      ...this.pauseStatus(n.id,{includeReason:true})})),operations:this.state.operations.filter(o=>o.actor_id===actor).slice(-20).map(({fingerprint,...o})=>o)};
  }
  adminStatus(){return {schema:1,agents:this.state.agents.map(publicAgent),holds:this.state.holds,operations:this.state.operations.slice(-20).map(({fingerprint,...o})=>o),maintenance_locks:this.state.maintenance_locks,maintenance_operations:this.state.maintenance_operations.slice(-20).map(({fingerprint,...o})=>o)};}
  maintenanceReceipt(input) {
    exact(input,['request_id']);if(!uuid(input.request_id))fail('invalid_request_id','Use a UUID request_id');
    const op=this.state.maintenance_operations.find(o=>o.request_id===input.request_id);
    if(!op)fail('receipt_not_found','No committed maintenance receipt for this request ID',404);
    const {fingerprint,...receipt}=op;return receipt;
  }
  maintenanceLock(input,controlChannel='unidentified_local_client') {
    exact(input,['name','reason','request_id','review_after_hours','worker_id']);
    if(!uuid(input.request_id))fail('invalid_request_id','Use a UUID request_id');
    if(!identifier(input.worker_id)||!this.nodes.some(n=>n.id===input.worker_id))fail('unknown_worker','Worker is not registered',404);
    if(typeof input.name!=='string'||!input.name.trim()||input.name.length>64||/[\x00-\x1f\x7f]/.test(input.name))fail('invalid_name','Use a short maintenance name without control characters');
    if(typeof input.reason!=='string'||!input.reason.trim()||input.reason.length>256||/[\x00-\x1f\x7f]/.test(input.reason))fail('invalid_reason','Use a short operational reason without control characters');
    if(input.review_after_hours!==null&&(!Number.isSafeInteger(input.review_after_hours)||input.review_after_hours<1||input.review_after_hours>8760))fail('invalid_review_time','Review time must be null or 1–8760 whole hours');
    const channel=typeof controlChannel==='string'&&/^[a-z][a-z0-9_]{0,31}$/.test(controlChannel)?controlChannel:'unidentified_local_client';
    const fingerprint=hash(JSON.stringify({action:'lock',worker_id:input.worker_id,name:input.name.trim(),reason:input.reason.trim(),review_after_hours:input.review_after_hours}));
    const old=this.state.maintenance_operations.find(o=>o.request_id===input.request_id);
    if(old){if(old.fingerprint!==fingerprint)fail('request_id_conflict','Request ID was already used for a different maintenance action',409);return this.maintenanceReceipt({request_id:input.request_id});}
    if(this.state.maintenance_operations.length>=10000)fail('receipt_limit','Maintenance receipt budget reached; operator review required',409);
    if(this.state.maintenance_locks.length>=1024)fail('lock_limit','Maintenance lock budget reached; operator review required',409);
    const created=this.now(),lock={id:randomUUID(),worker_id:input.worker_id,name:input.name.trim(),reason:input.reason.trim(),created_at:created,review_at:input.review_after_hours===null?null:created+input.review_after_hours*3600000,control_channel:channel};
    const result={lock_id:lock.id,worker_id:lock.worker_id,routing_resumed:false,state:'maintenance_locked'};
    const op={request_id:input.request_id,control_channel:channel,action:'lock',fingerprint,time:created,result};
    const next=structuredClone(this.state);next.manual_paused[lock.worker_id]=this.manualPaused(lock.worker_id);next.maintenance_locks.push(lock);next.maintenance_operations.push(op);
    this.commit(next,{...this.store.data.drained,[lock.worker_id]:true});this.onPause([lock.worker_id]);
    this.log('maintenance_lock_changed',{request_id:op.request_id,action:'lock',worker_id:lock.worker_id,lock_id:lock.id,control_channel:channel,review_at:lock.review_at});
    return this.maintenanceReceipt({request_id:op.request_id});
  }
  maintenanceRelease(input,controlChannel='unidentified_local_client') {
    exact(input,['lock_id','reason','request_id']);
    if(!uuid(input.request_id))fail('invalid_request_id','Use a UUID request_id');
    if(typeof input.reason!=='string'||!input.reason.trim()||input.reason.length>256||/[\x00-\x1f\x7f]/.test(input.reason))fail('invalid_reason','Use a short release reason without control characters');
    const channel=typeof controlChannel==='string'&&/^[a-z][a-z0-9_]{0,31}$/.test(controlChannel)?controlChannel:'unidentified_local_client';
    const fingerprint=hash(JSON.stringify({action:'release',lock_id:input.lock_id,reason:input.reason.trim()}));
    const old=this.state.maintenance_operations.find(o=>o.request_id===input.request_id);
    if(old){if(old.fingerprint!==fingerprint)fail('request_id_conflict','Request ID was already used for a different maintenance action',409);return this.maintenanceReceipt({request_id:input.request_id});}
    const lock=this.state.maintenance_locks.find(l=>l.id===input.lock_id);if(!lock)fail('unknown_lock','Unknown maintenance lock',404);
    if(this.state.maintenance_operations.length>=10000)fail('receipt_limit','Maintenance receipt budget reached; operator review required',409);
    // Removing authority never silently resumes work. An explicit, freshly
    // checked Resume is a separate action after the exact lock is released.
    const result={lock_id:lock.id,worker_id:lock.worker_id,routing_resumed:false,state:'maintenance_released_paused'};
    const op={request_id:input.request_id,control_channel:channel,action:'release',fingerprint,time:this.now(),result,release_reason:input.reason.trim()};
    const next=structuredClone(this.state);next.maintenance_locks=next.maintenance_locks.filter(l=>l.id!==lock.id);next.manual_paused[lock.worker_id]=true;next.maintenance_operations.push(op);
    this.commit(next,{...this.store.data.drained,[lock.worker_id]:true});
    this.log('maintenance_lock_changed',{request_id:op.request_id,action:'release',worker_id:lock.worker_id,lock_id:lock.id,control_channel:channel});
    return this.maintenanceReceipt({request_id:op.request_id});
  }
  receipt(actor,input) {
    exact(input,['request_id']);this.agent(actor);if(!uuid(input.request_id))fail('invalid_request_id','Use a UUID request_id');
    const op=this.state.operations.find(o=>o.request_id===input.request_id&&o.actor_id===actor);
    if(!op)fail('receipt_not_found','No committed receipt for this agent/request ID',404);
    const {fingerprint,...result}=op;return result;
  }
  async act(actor,action,input) {
    exact(input,action==='drain'?['worker_id','reason','request_id']:['hold_id','request_id']);
    const a=this.agent(actor);if(!uuid(input.request_id))fail('invalid_request_id','Use a UUID request_id');
    const fingerprint=hash(JSON.stringify(action==='drain'?{action,worker_id:input.worker_id,reason:input.reason}:{action,hold_id:input.hold_id}));
    const old=this.state.operations.find(o=>o.request_id===input.request_id);
    if(old){if(old.actor_id!==actor||old.fingerprint!==fingerprint)fail('request_id_conflict','Request ID was already used for a different action',409);return this.receipt(actor,{request_id:input.request_id});}
    if(this.state.operations.length>=10000)fail('receipt_limit','Receipt budget reached; operator review required',409);
    let result,next;
    if(action==='drain') {
      const n=this.worker(input.worker_id);
      if(!a.workers.includes(n.id))fail('forbidden_worker','Agent is not granted this worker',403);
      if(typeof input.reason!=='string'||!input.reason.trim()||input.reason.length>256||/[\x00-\x1f\x7f]/.test(input.reason))fail('invalid_reason','Use a short operational reason without control characters');
      if(this.state.holds.length>=1024)fail('hold_limit','Hold budget reached; operator review required',409);
      const hold={id:randomUUID(),worker_id:n.id,owner_id:actor,reason:input.reason.trim(),created_at:this.now()};
      next=structuredClone(this.state);next.manual_paused[n.id]=this.manualPaused(n.id);next.holds.push(hold);
      result={hold_id:hold.id,worker_id:n.id,routing_resumed:false,state:'hold_created'};
    }else if(action==='resume') {
      const h=this.state.holds.find(h=>h.id===input.hold_id);
      if(!h||h.owner_id!==actor)fail('not_hold_owner','No hold owned by this agent with that ID',403);
      const n=this.worker(h.worker_id);if(!a.workers.includes(n.id))fail('forbidden_worker','Agent is not granted this worker',403);
      const other=this.holds(n.id).filter(x=>x.id!==h.id),manual=this.manualPaused(n.id),maintenance=this.maintenanceLocks(n.id);
      let handback=false;
      if(!other.length&&!manual&&!maintenance.length){
        if(n.recovering)fail('recovery_required','Recovery already owns this worker; hold retained',409);
        if(n.quarantine){
          if(!this.canHandback)fail('recovery_required','Recovery or quarantine requires operator review; hold retained',409);
          try {await this.canHandback(n);} catch(error) {fail('recovery_required',`${error.message}; hold retained`,409);}
          handback=true;
        }else await this.canResume(n);
        this.agent(actor); // Recheck after asynchronous probe/offer.
      }
      next=structuredClone(this.state);next.holds=next.holds.filter(x=>x.id!==h.id);
      result={hold_id:h.id,worker_id:n.id,routing_resumed:!other.length&&!manual&&!maintenance.length&&!handback,state:handback?'handback_released':'hold_released',remaining_holds:other.map(x=>x.id),operator_paused:manual,maintenance_locks:maintenance.map(x=>x.id),...(handback?{recovery_pending:true}:{})};
    }else fail('unsupported_action','Unsupported agent action');
    const op={request_id:input.request_id,actor_id:actor,action,fingerprint,time:this.now(),result};next.operations.push(op);
    const paused=next.manual_paused[result.worker_id]===true||next.holds.some(h=>h.worker_id===result.worker_id)||next.maintenance_locks.some(l=>l.worker_id===result.worker_id);
    this.commit(next,{...this.store.data.drained,[result.worker_id]:paused});
    if(action==='drain')this.onPause([result.worker_id]);
    if(result.recovery_pending)try{this.onHandback(this.worker(result.worker_id));}catch{this.log('agent_handback_schedule_failed',{worker_id:result.worker_id});}
    this.log('agent_worker_action',{request_id:op.request_id,actor_id:actor,action,worker_id:result.worker_id,hold_id:result.hold_id,routing_resumed:result.routing_resumed});
    return this.receipt(actor,{request_id:op.request_id});
  }
  clearHold(input) {
    exact(input,['hold_id']);const h=this.state.holds.find(h=>h.id===input.hold_id);
    if(!h)fail('unknown_hold','Unknown hold');
    const next=structuredClone(this.state);next.holds=next.holds.filter(x=>x.id!==h.id);next.manual_paused[h.worker_id]=true;
    this.commit(next,{...this.store.data.drained,[h.worker_id]:true});
    this.log('agent_hold_cleared',{hold_id:h.id,worker_id:h.worker_id,owner_id:h.owner_id});
    return {hold_id:h.id,worker_id:h.worker_id,operator_paused:true,routing_resumed:false};
  }
}
