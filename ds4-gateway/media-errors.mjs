const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const text=v=>typeof v==='string'?v.replace(/[\x00-\x1f\x7f]/g,' ').trim().slice(0,1000):'';

// Keep useful native fields, not whole responses, prompts or Python tracebacks.
export function nativeHttpDetail(value){
  if(!object(value))return '';
  const messages=[];
  if(object(value.node_errors))for(const [id,node] of Object.entries(value.node_errors)){
    for(const error of Array.isArray(node?.errors)?node.errors:[]){
      const detail=[text(error?.message),text(error?.details)].filter(Boolean).join(': ');
      if(detail)messages.push(`node ${text(id)}${text(node.class_type)?` (${text(node.class_type)})`:''}: ${detail}`);
    }
  }
  if(Array.isArray(value.detail))for(const error of value.detail){
    const field=Array.isArray(error?.loc)?error.loc.filter(v=>typeof v==='string'||typeof v==='number').join('.'):'';
    if(text(error?.msg))messages.push(`${text(field)||'request'}: ${text(error.msg)}`);
  }
  if(!messages.length)messages.push(...[value.detail,value.error?.message,value.error,value.message].map(text).filter(Boolean));
  return messages.slice(0,12).join('; ').slice(0,6000);
}

export function nativeFailureDetail(job){
  if(job.state!=='failed')return null;
  if(job.backend==='ace-step'){
    const rows=Array.isArray(job.result)?job.result:[job.result];
    const detail=rows.map(row=>typeof row==='string'?text(row):nativeHttpDetail(row)).filter(Boolean).join('; ').slice(0,3000);
    return `ACE-Step generation failed${detail?`: ${detail}`:'. The native task reported failure without an explanation; inspect its task ID in the ACE-Step log.'}`;
  }
  if(job.backend!=='comfyui')return null;
  const messages=job.result?.status?.messages;
  if(!Array.isArray(messages))return null;
  const error=messages.findLast(item=>Array.isArray(item)&&item[0]==='execution_error'&&object(item[1]))?.[1];
  if(!error)return null;
  return `ComfyUI node ${text(error.node_id)||'?'}${text(error.node_type)?` (${text(error.node_type)})`:''}: ${text(error.exception_message)||text(error.exception_type)||'Execution failed'}`;
}

export function mediaErrorAdvice(message){
  if(/out of memory|OutOfMemory|CUDA.*alloc/i.test(message))return 'The engine ran out of memory. Inspect competing GPU work and this job’s requested dimensions/duration/batch size. Settings were not reduced automatically.';
  if(/no space left|disk full/i.test(message))return 'The engine disk is full. Free space or select another prepared worker before a new job; retained files were not deleted.';
  if(/not in list|not installed|not available on this engine|Missing native node/i.test(message))return 'Match the workflow to the selected engine’s installed nodes, models and filenames.';
  if(/file.*not found|no such file|invalid image|cannot identify image|failed to decode/i.test(message))return 'Check the reference file can be decoded, its loader name matches the upload receipt, and its ID is included in input_files.';
  return null;
}
