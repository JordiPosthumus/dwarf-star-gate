// Explicit operator CLI. A canary is never exposed to the LLM or browser.
import { loadConfig } from './config.mjs';
import {randomUUID} from 'node:crypto';
import {workerControl} from './worker-client.mjs';
try {
  const {config}=loadConfig();
  const [command='status',argument]=process.argv.slice(2),control=(route,body)=>workerControl(config.control_socket,route,body,{channel:'recovery_cli'});
  const registry=await control('/workers');let result;
  if(command==='status')result=registry.recovery;
  else if(command==='check') {
    const workers=registry.recovery?.workers??[];
    if(argument&&!workers.some(worker=>worker.worker_id===argument))throw new Error('Unknown recovery worker');
    result={schema:1,mode:'read_only_enrollment_check',workers:workers.filter(worker=>!argument||worker.worker_id===argument).map(worker=>({worker_id:worker.worker_id,
      checklist:worker.enrollment??null,...(!worker.enrollment?{reason:'checklist_not_available_in_running_core'}:{})})),
      note:'Reads existing core evidence only. No inspection, configuration change, service action or canary is issued.'};
  }
  else if(command==='auto' && ['on','off'].includes(argument))result=await control('/recovery-policy',{enabled:argument==='on'});
  else if(['recover','canary'].includes(command)) {
    const worker=registry.recovery?.workers.find(w=>w.worker_id===argument);if(!worker)throw new Error('Unknown recovery worker');
    result=await control(command==='canary'?'/recovery-canary':'/recover-worker',{worker_id:argument,...(worker.evidence_id?{evidence_id:worker.evidence_id}:{}),action_id:randomUUID()});
  } else if(command==='recheck')result=await control('/recovery-recheck',{action_id:argument});
  else throw new Error('Usage: recovery-control.mjs status | check [ID] | auto on|off | recover ID | canary ID | recheck ACTION_ID');
  console.log(JSON.stringify(result,null,2));
} catch(e){console.error(e.message);process.exitCode=1;}
