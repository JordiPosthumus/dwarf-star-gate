import {createToolEndpoint} from './genie-tool-endpoint.mjs';
import {priorityRank} from './job-priority.mjs';
export function createMediaTools({read,start,setup=null,resources=null,isTesting=()=>false}){
  return createToolEndpoint('/api/genie/media-tools','x-sg-media-tool',async input=>{
    if(input?.action==='status'&&Object.keys(input).length===1){
      const status=await read();
      const active=status.jobs.filter(j=>!['completed','failed'].includes(j.state)||j.execution&&!['returned','failed_returned','failed_unchanged'].includes(j.execution.phase));
      const recent=status.jobs.filter(j=>!active.includes(j)).reverse();
      const jobs=[...active.sort((a,b)=>priorityRank(b)-priorityRank(a)),...recent].slice(0,50);
      return {...status,jobs,resource_checks:resources?.status()??{},resource_inspection_connected:!!resources,truncated:status.jobs.length>jobs.length,scope:'Queued media jobs and observed independent execution. Select an enrolled host using current LLM demand. At least one other LLM must remain serving. No active work is cancelled. A completed native job does not prove its host has returned; read execution.phase. Resource checks are dated observations, not permission, installation or guaranteed fit.'};
    }
    if(input?.action==='inspect'&&Object.keys(input).sort().join(',')==='action,worker_id'){
      if(!resources)throw Error('Media resource inspection is not connected.');
      const host=(await read()).hosts?.find(h=>h.id===input.worker_id);
      if(!host)throw Error('Choose a registered worker for inspection.');
      return {...await resources.inspect(input.worker_id),existing_engines:host.engines??[],lifecycle:'The executor runs one media engine on the borrowed host, then restores its LLM. A selected batch runs jobs sequentially before one LLM return. H3 and ACE-Step do not need simultaneous residency. Recipe model-file totals are disk requirements, not measured RAM. Existing engine enrollment is separate from this resource observation; it is not erased or requalified by this check.'};
    }
    if(input?.action==='setup'&&Object.keys(input).sort().join(',')==='action,engine,worker_id'){
      if(isTesting())throw new Error('Media setup is suspended for testing.');
      if(!setup)throw new Error('Media setup is not connected.');
      return setup({worker_id:input.worker_id,engine:input.engine});
    }
    if(input?.action!=='start'||!['action,job_id,worker_id','action,following_job_ids,job_id,worker_id'].includes(Object.keys(input).sort().join(',')))throw new Error('Read media status, then select queued jobs and an enrolled worker.');
    if(isTesting())throw new Error('Media execution is suspended for testing.');
    return start({job_id:input.job_id,worker_id:input.worker_id,...(input.following_job_ids!==undefined?{following_job_ids:input.following_job_ids}:{})});
  });
}
