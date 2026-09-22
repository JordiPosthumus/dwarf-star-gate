// Conversational fleet power tools: Genie can read status and REQUEST start/stop.
// Per the owner's autonomy model, Genie asks first in conversation; the human
// approves in that same conversation, so no separate per-request approval button
// exists. The scripts remain the source of truth; this module only reports and
// forwards exact (worker,action) pairs to the power runner.
import {createToolEndpoint} from './genie-tool-endpoint.mjs';
import {powerWorkers,powerScript} from './power-scripts.mjs';

export function fleetPowerEvidence({runner,workers=[],now=Date.now}){
  const byId=new Map(workers.map(w=>[w.id,w]));
  const members=powerWorkers().map(id=>{
    const w=byId.get(id);
    return {worker_id:id,enrolled:true,
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
    scope:'Enrolled power scripts and the last receipts of this dashboard process. Scripts remain the source of truth; status is script truth and start/stop receipts are script exits, not model-readiness proof. Drain a serving worker before stopping it; stopping drops it from routing and recovery stays paused for it.'};
}

export function createFleetPowerTools({runner,read,isTesting=()=>false,isEnabled=()=>true}){
  if(!runner||typeof read!=='function')throw new Error('Fleet power tools need a script runner and gateway status reader.');
  async function tool(input){
    if(input?.action==='status'&&Object.keys(input).length===1)
      return fleetPowerEvidence({runner,workers:(await read())?.workers??[]});
    if(input?.action!=='power'||Object.keys(input).sort().join(',')!=='action,action_id,power_action,worker')
      throw new Error('Specify worker, power_action and one action ID.');
    const {worker,power_action,action_id}=input;
    if(!/^[a-f0-9-]{36}$/.test(action_id??''))throw new Error('Provide one action ID for this power request.');
    if(isTesting())throw new Error('Fleet power is suspended for testing.');
    if(!isEnabled())throw new Error('Fleet power is switched off.');
    if(!powerScript(worker,power_action))throw new Error(`No enrolled script for ${worker} ${power_action}; scripts remain the source of truth.`);
    if(power_action==='stop'){
      const snapshot=await read();
      const current=snapshot?.workers?.find(w=>w.id===worker);
      if(!current)throw new Error('Worker is not a current gateway member; use the script directly.');
      if((current.load??0)>0||current.queued>0)throw new Error('Worker is serving or holds queued gateway work. Drain it first (drain-workers), wait for admitted work to finish, then stop.');
      const healthy=snapshot.workers.filter(w=>w.is_healthy&&!w.drained).length;
      if(healthy<=1&&current.is_healthy)throw new Error('This is the last healthy worker. Stopping it leaves no LLM; arrange a replacement first.');
    }
    const receipt=await runner.run(worker,power_action);
    return {receipt,action_id,
      next_step:power_action==='stop'
        ?'Stop accepted by the script is not model-down proof. Read status for the worker; the gateway will drop it from routing as probes fail. Recovery stays paused for it.'
        :power_action==='start'
          ?'Start exit 0 is not readiness proof. Poll the status script and the gateway worker health before routing expectations.'
          :'Read status for the parsed engine/containers state.'};
  }
  return createToolEndpoint('/api/genie/power-tools','x-sg-power-tool',tool);
}