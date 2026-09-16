import {createToolEndpoint} from './genie-tool-endpoint.mjs';
export function createMediaTools({read,start,isTesting=()=>false}){
  return createToolEndpoint('/api/genie/media-tools','x-sg-media-tool',async input=>{
    if(input?.action==='status'&&Object.keys(input).length===1){
      const status=await read();
      return {...status,jobs:status.jobs.slice(-50),scope:'Queued media jobs and observed independent execution. Select an enrolled host using current LLM demand. At least one other LLM must remain serving. No active work is cancelled. A completed native job does not prove its host has returned; read execution.phase.'};
    }
    if(input?.action!=='start'||Object.keys(input).sort().join(',')!=='action,job_id,worker_id')throw new Error('Read media status, then select one queued job and enrolled worker.');
    if(isTesting())throw new Error('Media execution is suspended for testing.');
    return start({job_id:input.job_id,worker_id:input.worker_id});
  });
}
