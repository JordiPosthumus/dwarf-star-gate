// Conversational and dashboard fleet power tools: read status, and start/stop
// enrolled models through the shared power runner. Per the owner's autonomy
// model, Genie asks first in conversation; the human approves in that same
// conversation, so no separate per-request approval button exists. A deliberate
// dashboard action supplies the owner's intent directly. The scripts remain the
// source of truth; receipts record script exits and REAL endpoint verification.
import {createToolEndpoint} from './genie-tool-endpoint.mjs';
import {powerWorkers,powerScript,machineGroup} from './power-scripts.mjs';

export function fleetPowerEvidence({runner,workers=[],now=Date.now}){
  const byId=new Map(workers.map(w=>[w.id,w]));
  const members=powerWorkers().map(id=>{
    const w=byId.get(id);
    return {worker_id:id,machine:machineGroup(id),enrolled:true,
      script_available:Object.fromEntries(['status','start','stop'].map(a=>[a,!!powerScript(id,a)])),
      ...(w?{
        routing:{is_healthy:w.is_healthy===true,drained:w.drained===true,load:w.load??0,queued:w.queued??0,
          direct_reserved:w.direct_reserved===true,quarantined:!!w.quarantine},
        gateway_view:'Gateway routing view only. It does not prove the model process is running; use the status script for that.',
      }:{
        routing:null,
        gateway_view:'Not a current gateway worker; only script status applies.',
      })};
  });
  return {schema:1,observed_at:new Date(now()).toISOString(),members,
    recent:runner.receipts().slice(0,8),
    scope:'Enrolled power scripts with physical-machine groups and the last receipts of this dashboard process. Scripts remain the source of truth; start/stop receipts include real endpoint verification, and timeout means unproven, not failed. Stopping a Spark pair stops both machines of that pair, including any other model serving there.'};
}

export function createFleetPowerTools({runner,read,isTesting=()=>false,isEnabled=()=>true,directRunning=null}={}){
  if(!runner||typeof read!=='function')throw new Error('Fleet power tools need a script runner and gateway status reader.');
  if(directRunning!==null&&typeof directRunning!=='function')throw new Error('directRunning must be a function when provided');
  async function snapshotWorkers(){
    const value=await read();
    if(value?.version!==1||!Array.isArray(value.workers))throw new Error('Gateway worker registry is unavailable.');
    return value.workers;
  }
  // Synchronous-in-cost preflight: every refusal here is known before any
  // mutation starts. Returns {allowed,refusals} and never runs scripts.
  async function precheck(worker,power_action){
    const workers=await snapshotWorkers();
    const current=workers.find(w=>w.id===worker);
    if(!current)throw new Error('Worker is not a current gateway member; use the script directly.');
    const refusals=[];
    if(power_action==='stop'){
      const groups=machineGroup(worker)??[];
      if((current.load??0)>0||current.queued>0)refusals.push('Worker is serving or holds queued gateway work. Drain it first (drain-workers), let admitted work finish, then stop.');
      if(current.direct_reserved===true)refusals.push('The endpoint is in active direct owner use right now; stopping would interrupt it.');
      if(typeof directRunning==='function'){
        const running=await directRunning(worker);
        if(Number.isFinite(running)&&running>0)refusals.push(`The engine reports ${running} running request(s) outside gateway accounting; treat them as active work, not idle.`);
      }
      const busyMates=workers.filter(w=>w.id!==worker&&(machineGroup(w.id)??[]).some(group=>groups.includes(group))&&((w.load??0)>0||w.queued>0));
      if(busyMates.length)refusals.push(`Same-hardware model(s) ${busyMates.map(w=>w.id).join(', ')} still hold gateway work; stopping this model stops the shared machine(s).`);
      const healthy=workers.filter(w=>w.is_healthy&&!w.drained);
      if(healthy.length<=1&&current.is_healthy)refusals.push('This is the last healthy worker. Stopping it leaves no LLM; arrange a replacement first.');
    }
    return {allowed:refusals.length===0,refusals,worker,power_action,
      machine:machineGroup(worker),
      scope:power_action==='stop'?'Stopping a Spark pair stops both machines of that pair, including any other model serving there.':'Starting may conflict with a different model already serving the same machine; the script refuses that case and reports it.'};
  }
  async function tool(input){
    if(input?.action==='status'&&Object.keys(input).length===1)
      return fleetPowerEvidence({runner,workers:await snapshotWorkers()});
    if(input?.action!=='power'||Object.keys(input).sort().join(',')!=='action,action_id,power_action,worker')
      throw new Error('Specify worker, power_action and one action ID.');
    const {worker,power_action,action_id}=input;
    if(!/^[a-f0-9-]{36}$/.test(action_id??''))throw new Error('Provide one action ID for this power request.');
    if(!['start','stop'].includes(power_action))throw new Error('power_action must be start or stop; use action "status" for read-only evidence.');
    if(isTesting())throw new Error('Fleet power is suspended for testing.');
    if(!isEnabled())throw new Error('Fleet power is switched off.');
    if(!powerScript(worker,power_action))throw new Error(`No enrolled script for ${worker} ${power_action}; scripts remain the source of truth.`);
    const pre=await precheck(worker,power_action);
    if(!pre.allowed)throw new Error(pre.refusals.join(' '));
    if(input.mode==='check')return {allowed:true,action_id,worker,power_action,machine:pre.machine,scope:pre.scope,
      note:'Preflight only. The mutation runs through the same runner as Genie and reports real endpoint verification.'};
    const receipt=await runner.run(worker,power_action);
    return {receipt,action_id,
      next_step:power_action==='stop'
        ?receipt.verified?.state==='stopped'
          ?'Verified stopped: the endpoint no longer accepts connections. Gateway routing will mark it unavailable on its next probes.'
          :'Stop receipt recorded but shutdown is NOT verified. Read fleet_power_status or the card Status; do not claim the model is down.'
        :receipt.verified?.state==='ready'
          ?'Verified ready: the endpoint answers model-list requests. Routing needs the gateway probes to mark it healthy.'
          :'Start receipt recorded but readiness is NOT verified (possibly still loading). Poll Status; do not route expectations yet.'};
  }
  const endpoint=createToolEndpoint('/api/genie/power-tools','x-sg-power-tool',tool);
  return {...endpoint,precheck:(worker,power_action)=>precheck(worker,power_action),tool};
}