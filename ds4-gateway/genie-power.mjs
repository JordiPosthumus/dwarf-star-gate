// Conversational and dashboard fleet power tools: read status, and start/stop
// enrolled models through the shared power runner. Per the owner's autonomy
// model, Genie asks first in conversation; the human approves in that same
// conversation, so no separate per-request approval button exists. A deliberate
// dashboard action supplies the owner's intent directly. The scripts remain the
// source of truth; receipts record script exits and REAL endpoint verification.
import {createToolEndpoint} from './genie-tool-endpoint.mjs';
import {powerWorkers,powerScript,machineGroup} from './power-scripts.mjs';

export function fleetPowerEvidence({runner,workers=[],now=Date.now,catalogue=null}){
  const byId=new Map(workers.map(w=>[w.id,w]));
  const members=powerWorkers().map(id=>{
    const w=byId.get(id);
    return {worker_id:id,machine:machineGroup(id),enrolled:true,busy:runner.busy(id),
      script_available:Object.fromEntries(['status','start','stop'].map(a=>[a,!!(runner.script??powerScript)(id,a)])),
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
    ...(catalogue?{catalogue}:{}),
    recent:runner.receipts().slice(0,8),
    scope:'Enrolled power scripts with physical-machine groups and the last receipts of this dashboard process. Scripts remain the source of truth; start/stop receipts include real endpoint verification, and timeout means unproven, not failed. Stopping a Spark pair stops both machines of that pair, including any other model serving there.'};
}

export function createFleetPowerTools({runner,read,isTesting=()=>false,isEnabled=()=>true,directRunning=null,catalogue=null,control=null,recipes=null}={}){
  if(!runner||typeof read!=='function')throw new Error('Fleet power tools need a script runner and gateway status reader.');
  if(directRunning!==null&&typeof directRunning!=='function')throw new Error('directRunning must be a function when provided');
  if(catalogue!==null&&typeof catalogue!=='function')throw new Error('catalogue must be a function when provided');
  const requests=new Map(),routingReceipts=new Map();
  let admission=Promise.resolve();
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
    if(recipes?.busy(worker))refusals.push('An enrolled recipe trial owns this hardware; inspect its restoration receipt before another lifecycle change.');
    if(power_action==='stop'){
      const groups=machineGroup(worker)??[];
      if(current.is_healthy&&!current.drained)refusals.push('Drain the worker before stopping so new gateway work cannot be admitted.');
      if((current.load??0)>0||current.queued>0)refusals.push('Worker is serving or holds queued gateway work. Drain it first (drain-workers), let admitted work finish, then stop.');
      if(current.direct_reserved===true)refusals.push('The endpoint is in active direct owner use right now; stopping would interrupt it.');
      if(typeof directRunning==='function'){
        const running=await directRunning(worker);
        if(!Number.isFinite(running)&&current.is_healthy)refusals.push('Native activity is unknown; obtain a fresh idle observation before stopping.');
        if(Number.isFinite(running)&&running>0)refusals.push(`The engine reports ${running} running request(s) outside gateway accounting; treat them as active work, not idle.`);
      }
      const mates=workers.filter(w=>w.id!==worker&&(machineGroup(w.id)??[]).some(group=>groups.includes(group)));
      const busyMates=mates.filter(w=>(w.load??0)>0||w.queued>0||w.direct_reserved===true||(w.is_healthy&&!w.drained));
      if(busyMates.length)refusals.push(`Same-hardware model(s) ${busyMates.map(w=>w.id).join(', ')} still hold gateway work; stopping this model stops the shared machine(s).`);
      for(const mate of mates.filter(w=>w.is_healthy))if(directRunning){
        const n=await directRunning(mate.id);
        if(!Number.isFinite(n)||n>0)refusals.push(`Same-hardware model ${mate.id} has active or unknown native work.`);
      }
      const healthy=workers.filter(w=>w.is_healthy&&!w.drained&&!runner.busy(w.id)&&!(machineGroup(w.id)??[]).some(group=>groups.includes(group)));
      if(!healthy.length)refusals.push('This hardware contains the last healthy worker. Stopping it leaves no LLM; arrange a replacement first.');
    }
    return {allowed:refusals.length===0,refusals,worker,power_action,
      machine:machineGroup(worker),
      scope:power_action==='stop'?'Stopping a Spark pair stops both machines of that pair, including any other model serving there.':'Starting may conflict with a different model already serving the same machine; the script refuses that case and reports it.'};
  }
  async function runTool(input){
    if(input?.action==='status'&&Object.keys(input).length===1){
      const cat=catalogue?await catalogue().catch(e=>({unavailable:e.message})):null;
      return {...fleetPowerEvidence({runner,workers:await snapshotWorkers(),catalogue:cat}),routing_recent:[...routingReceipts.values()].slice(-16).reverse(),recipe_trials:recipes?.status()??[]};
    }
    if(input?.action==='recipe-trial'){
      if(Object.keys(input).sort().join(',')!=='action,profile,stage,trial_id'||!recipes)throw Error('Use an enrolled recipe trial profile and stage');
      if(isTesting()||!isEnabled())throw Error('Recipe trials are suspended or fleet power is switched off');
      return recipes.start(input);
    }
    if(input?.action==='routing'){
      const {worker,routing_action,action_id,expected_operator_action}=input;
      const keys=Object.keys(input).sort().join(',');
      if(!['action,action_id,routing_action,worker','action,action_id,expected_operator_action,routing_action,worker'].includes(keys)||!['drain','resume'].includes(routing_action)||!/^[a-f0-9-]{36}$/.test(action_id??''))throw Error('Specify an exact worker, routing action and action ID.');
      const previous=routingReceipts.get(action_id);
      if(previous){if(previous.worker!==worker||previous.routing_action!==routing_action)throw Error('Action ID belongs to another routing action');return previous;}
      if(requests.has(action_id))throw Error('Action ID belongs to a power action');
      if(isTesting()||!isEnabled()||!control)throw Error('Fleet routing control is unavailable or switched off.');
      const workers=await snapshotWorkers(),current=workers.find(w=>w.id===worker);
      if(!current||!machineGroup(worker))throw Error('Use an enrolled current fleet worker');
      if(routing_action==='drain'&&!workers.some(w=>w.id!==worker&&w.is_healthy&&!w.drained&&!runner.busy(w.id)&&!(machineGroup(w.id)??[]).some(g=>(machineGroup(worker)??[]).includes(g))))throw Error('Keep a healthy worker on separate hardware before draining.');
      if(routing_action==='resume'&&(runner.busy(worker)||!Object.hasOwn(input,'expected_operator_action')||(expected_operator_action!==null&&!/^[a-f0-9-]{36}$/.test(expected_operator_action))))throw Error('Wait for power completion and supply the observed operator-action ID before resuming.');
      const receipt={worker,routing_action,action_id,state:'running',was_drained:current.drained===true};routingReceipts.set(action_id,receipt);
      try{
        await control(routing_action==='drain'?'/drain-workers':'/resume-workers',{workers:[worker],...(routing_action==='resume'?{expected_operator_actions:{[worker]:expected_operator_action}}:{})});
        const after=(await snapshotWorkers()).find(w=>w.id===worker);
        if(!after||after.drained!==(routing_action==='drain'))throw Error('Routing state was not confirmed');
        Object.assign(receipt,{state:'complete',drained:after.drained,load:after.load,queued:after.queued,operator_action:after.last_operator_action?.id??null,scope:'Routing only; existing work continues and the model process is unchanged. Preserve preexisting pauses.'});
      }catch(error){Object.assign(receipt,{state:'unverified',error:error.message});}
      return receipt;
    }
    const keys=Object.keys(input??{}).sort().join(',');
    if(input?.action!=='power'||!['action,action_id,power_action,worker','action,action_id,mode,power_action,worker'].includes(keys)||('mode' in input&&input.mode!=='check'))
      throw new Error('Specify worker, power_action and one action ID.');
    const {worker,power_action,action_id}=input;
    if(!/^[a-f0-9-]{36}$/.test(action_id??''))throw new Error('Provide one action ID for this power request.');
    if(!['start','stop','status'].includes(power_action))throw new Error('power_action must be start, stop or status.');
    if(!(runner.script??powerScript)(worker,power_action))throw new Error(`No enrolled script for ${worker} ${power_action}; scripts remain the source of truth.`);
    if(routingReceipts.has(action_id))throw Error('Action ID belongs to a routing action');
    const prior=requests.get(action_id);
    if(prior){
      if(prior.worker!==worker||prior.power_action!==power_action)throw new Error('Action ID already belongs to a different request.');
      return prior.result??{accepted:true,action_id,worker,power_action,state:'running',next_step:'Read fleet_power_status for this action ID. Do not repeat the mutation.'};
    }
    if(power_action!=='status'){
      if(isTesting())throw new Error('Fleet power is suspended for testing.');
      if(!isEnabled())throw new Error('Fleet power is switched off.');
    }
    if(power_action==='status'){
      if(input.mode==='check')return {allowed:true,action_id,worker,power_action,machine:machineGroup(worker),scope:'Read-only status script.'};
      const receipt=await runner.run(worker,'status',{actionId:action_id});
      return {receipt,action_id,next_step:'Script output is in the receipt; it describes serving engine and containers, not gateway routing.'};
    }
    const pre=await precheck(worker,power_action);
    if(!pre.allowed)throw new Error(pre.refusals.join(' '));
    if(input.mode==='check')return {allowed:true,action_id,worker,power_action,machine:pre.machine,scope:pre.scope,
      note:'Preflight only. The mutation runs through the same runner as Genie and reports real endpoint verification.'};
    if(requests.has(action_id))return runTool(input);
    const request={worker,power_action};requests.set(action_id,request);
    void runner.run(worker,power_action,{actionId:action_id}).then(receipt=>{request.result={receipt,action_id,
      next_step:power_action==='stop'
        ?receipt.verified?.state==='stopped'
          ?'Verified stopped: the endpoint no longer accepts connections. Gateway routing will mark it unavailable on its next probes.'
          :'Stop receipt recorded but shutdown is NOT verified. Read fleet_power_status or the card Status; do not claim the model is down.'
        :receipt.verified?.state==='ready'
          ?'Verified ready: the endpoint answers model-list requests. Routing needs the gateway probes to mark it healthy.'
          :'Start receipt recorded but readiness is NOT verified (possibly still loading). Poll Status; do not route expectations yet.'};
    }).catch(error=>{request.result={action_id,worker,power_action,error:error.message,state:'unverified'};});
    return {accepted:true,action_id,worker,power_action,state:'running',next_step:'Read fleet_power_status for this action ID. Accepted means the operation is running, not verified complete.'};
  }
  const tool=input=>{
    if(input?.action==='recipe-trial'||input?.action==='routing'||(input?.action==='power'&&input.power_action!=='status'&&input.mode!=='check')){
      const next=admission.then(()=>runTool(input));admission=next.then(()=>undefined,()=>undefined);return next;
    }
    return runTool(input);
  };
  const endpoint=createToolEndpoint('/api/genie/power-tools','x-sg-power-tool',tool);
  return {...endpoint,precheck:(worker,power_action)=>precheck(worker,power_action),tool};
}
