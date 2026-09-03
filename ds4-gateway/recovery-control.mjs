// Explicit operator CLI. A canary is never exposed to the LLM or browser.
import { loadConfig } from './config.mjs';
import {randomUUID} from 'node:crypto';
import {workerControl} from './worker-client.mjs';
try {
  const {config}=loadConfig();
  const [command='status',argument]=process.argv.slice(2),control=(route,body)=>workerControl(config.control_socket,route,body);
  const registry=await control('/workers');let result;
  if(command==='status')result=registry.recovery;
  else if(command==='auto' && ['on','off'].includes(argument))result=await control('/recovery-policy',{enabled:argument==='on'});
  else if(['recover','canary'].includes(command)) {
    const worker=registry.recovery?.workers.find(w=>w.worker_id===argument);if(!worker)throw new Error('Unknown recovery worker');
    result=await control(command==='canary'?'/recovery-canary':'/recover-worker',{worker_id:argument,...(worker.evidence_id?{evidence_id:worker.evidence_id}:{}),action_id:randomUUID()});
  } else if(command==='recheck')result=await control('/recovery-recheck',{action_id:argument});
  else throw new Error('Usage: recovery-control.mjs status | auto on|off | recover ID | canary ID | recheck ACTION_ID');
  console.log(JSON.stringify(result,null,2));
} catch(e){console.error(e.message);process.exitCode=1;}
