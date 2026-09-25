import {mediaEngine,mediaNativeEnrollments} from './media-enrollment.mjs';
import {mediaPair} from './media-pair.mjs';
import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
import {machinesFor} from './fleet-machines.mjs';

export const mediaEngines=[
  {id:'ace-step',label:'ACE-Step',kind:'music',supported:true},
  {id:'h3',label:'MiniMax H3',kind:'video',supported:true},
  {id:'minimax-m3',label:'MiniMax M3',kind:'video',supported:false},
  {id:'ltx',label:'LTX',kind:'video',supported:false},
  {id:'qwen-image',label:'Qwen Image',kind:'image',supported:false,machines:['m3-ultra']},
];
const terminal=new Set(['returned','failed_returned','failed_unchanged']);
// Choices express placement permission, never installation or native readiness.
export function createMediaHosts(config,store,{workers,binding,enrollmentWorker=id=>config.workers?.find(w=>w.id===id)}){
  const enrolled=(id,kind)=>!!config.media_jobs?.workers?.[id]?.engines?.[kind];
  const allowed=(id,kind)=>store.data.media_host_eligibility?.[id]?.[kind]??enrolled(id,kind);
  return {allowed,
    change(input){
      if(!input||Object.keys(input).sort().join(',')!=='allowed,kind,worker_id'||typeof input.allowed!=='boolean'||!['music','video'].includes(input.kind)||!workers().some(w=>w.id===input.worker_id))throw new Error('Choose a registered machine, music or video, and boolean allowed.');
      if(fs.existsSync(store.filename))fs.copyFileSync(store.filename,`${store.filename}.media-${Date.now()}-${randomUUID()}.bak`,fs.constants.COPYFILE_EXCL);
      store.save({...store.data,media_host_eligibility:{...store.data.media_host_eligibility,[input.worker_id]:{...store.data.media_host_eligibility?.[input.worker_id],[input.kind]:input.allowed}}});
      return {worker_id:input.worker_id,kind:input.kind,allowed:input.allowed,scope:'Placement choice saved. Existing execution continues; no engine was installed or started.'};
    },
    status(jobs=[]){
      const fleet=workers(),borrowable=w=>w.is_healthy&&(!w.drained||w.operator_paused===true)&&!w.quarantine&&!w.recovering&&!(w.holds?.length)&&!(w.maintenance_locks?.length),serving=w=>w.is_healthy&&!w.drained&&!w.quarantine&&!w.recovering&&!(w.holds?.length)&&!(w.maintenance_locks?.length);
      // Media borrows whole physical machines. The borrowed host's machines may
      // not overlap the machines of the LLM that must keep serving (owner
      // decision: a Spark pair goes down together, the other pair stays up).
      const otherServingKeepsMachines=w=>{const taken=machinesFor(w.id,config);return fleet.some(other=>other.id!==w.id&&serving(other)&&!machinesFor(other.id,config).some(machine=>taken.includes(machine)));};
      return {media_host_controls_version:1,native_targets:mediaNativeEnrollments(config),engines:mediaEngines,hosts:fleet.map(w=>{
        const active=jobs.find(j=>j.execution?.worker_id===w.id&&!terminal.has(j.execution.phase));
        const machines=machinesFor(w.id,config),pairEnrollment=mediaPair(config,enrollmentWorker(w.id));
        const members=pairEnrollment?pairEnrollment.members.map((m,member)=>({member,machine:machines[member]??m.ssh,engines:mediaEngines.filter(e=>e.supported).map(e=>{const engine=mediaEngine(config,w.id,e.kind,member),permission=allowed(w.id,e.kind);return {id:e.id,kind:e.kind,allowed:permission,enrolled:!!engine,ready:!!(engine&&permission&&!active&&borrowable(w)&&otherServingKeepsMachines(w))};})})):undefined;
        return {id:w.id,machines,...(members?{members}:{}),pair:machines.length>1,llm_serving:serving(w),active_requests:w.load??0,queued_requests:w.queued??0,execution:active?{job_id:active.id,...active.execution}:null,
          engines:mediaEngines.filter(e=>e.supported).map(e=>{
            const installed=enrolled(w.id,e.kind),permission=allowed(w.id,e.kind);
            const recovery=config.recovery?.workers?.find(r=>r.id===w.id),inspection=config.genie_chat?.inspection?.workers?.[w.id];
            const pair=mediaPair(config,enrollmentWorker(w.id));
            const bound=installed&&!!inspection?.container&&(!!pair||(recovery?.adapter==='docker'&&recovery.verification==='qwen_vllm'&&binding(w.id,recovery)));
            const reason=!permission?'Placement is off':!installed?'Setup and qualification needed':!bound?'LLM return binding needs attention':active?'A media operation is already in progress':!borrowable(w)?'Machine is unavailable or held for maintenance':!otherServingKeepsMachines(w)?'Another serving LLM on separate machines is required':(w.load||w.queued)?'Existing LLM jobs will drain first':w.drained?'LLM routing paused; available for Genie media selection':'Available for Genie to select';
            return {id:e.id,kind:e.kind,allowed:permission,enrolled:installed,ready:!!(permission&&bound&&!active&&borrowable(w)&&otherServingKeepsMachines(w)),reason};
          })};
      })};
    },
  };
}
