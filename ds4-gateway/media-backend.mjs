import {nativeHttpDetail} from './media-errors.mjs';
// Async native jobs: submit once, then observe the saved receipt. Engine startup,
// host allocation and durable output storage belong to the gateway coordinator.
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const id=v=>typeof v==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(v);
export class MediaBackendError extends Error {
  constructor(message,{uncertain=false}={}){super(message);this.name='MediaBackendError';this.uncertain=uncertain;}
}
export class MediaBackend {
  constructor({kind,url,token}, {fetchImpl=fetch}={}){
    if(!['ace-step','comfyui'].includes(kind))throw new Error('Unsupported media backend');
    const endpoint=new URL(url);
    if(!['http:','https:'].includes(endpoint.protocol)||endpoint.username||endpoint.password||endpoint.search||endpoint.hash)throw new Error('Use an enrolled media endpoint');
    this.kind=kind;this.url=endpoint;this.token=token;this.fetch=fetchImpl;
  }
  async request(route,body,{submission=false}={}){
    const engine=this.kind==='ace-step'?'ACE-Step':'ComfyUI/H3';
    let response;
    try{
      response=await this.fetch(new URL(route,this.url),{method:body===undefined?'GET':'POST',redirect:'error',signal:AbortSignal.timeout(30000),
        headers:{...(this.token?{authorization:`Bearer ${this.token}`} : {}),...(body===undefined?{}:{'content-type':'application/json'})},
        ...(body===undefined?{}:{body:JSON.stringify(body)})});
    }catch{throw new MediaBackendError(`${engine} ${route}: response unavailable. Check engine connectivity and observe the original job before another submission; a timeout does not mean generation stopped.`,{uncertain:submission});}
    if(!response.ok){
      let detail='';
      try{detail=nativeHttpDetail(await response.json());}catch{/* Keep HTTP status when the native response is not JSON. */}
      throw new MediaBackendError(`${engine} ${route}: HTTP ${response.status}${detail?`: ${detail}`:''}. ${response.status>=500?'Engine response failed; inspect the original job before another submission.':response.status===401||response.status===403?'Check the enrolled engine credentials.':response.status===404?'Check the enrolled endpoint and engine API version.':response.status===429?'The engine is busy; check its queue before a new submission.':'Correct the reported inputs before submitting a new job.'}`,{uncertain:submission&&response.status>=500});
    }
    try{return await response.json();}catch{throw new MediaBackendError(`${engine} ${route}: returned an unreadable receipt; observe the original job before another submission.`,{uncertain:submission});}
  }
  async submit(payload,requestId){
    if(!object(payload)||typeof requestId!=='string'||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(requestId))throw new Error('Use a media request object and gateway job UUID');
    const value=await this.request(this.kind==='ace-step'?'/release_task':'/prompt',this.kind==='ace-step'?payload:{...payload,client_id:requestId,prompt_id:requestId},{submission:true});
    const nativeId=this.kind==='ace-step'?value?.data?.task_id:value?.prompt_id;
    if(!id(nativeId))throw new MediaBackendError(`Native media acceptance was not established${nativeHttpDetail(value)?`: ${nativeHttpDetail(value)}`:''}; inspect the original job before another submission.`,{uncertain:true});
    return {native_id:nativeId,state:'submitted'};
  }
  async uploadInput(blob,name){
    if(this.kind!=='comfyui'||!/^stargate\/[a-f0-9-]{36}\.[a-z0-9]+$/.test(name))throw Error('Use a stored Star Gate video input');
    const form=new FormData();form.append('image',blob,name.slice('stargate/'.length));form.append('type','input');form.append('subfolder','stargate');
    let response;
    try{response=await this.fetch(new URL('/upload/image',this.url),{method:'POST',redirect:'error',headers:this.token?{authorization:`Bearer ${this.token}`}:{},body:form});}
    catch{throw Error('ComfyUI reference transfer lost its connection. Inspect the engine and original upload receipt; no generation submitted.');}
    if(!response.ok){
      let detail='';try{detail=nativeHttpDetail(await response.json());}catch{}
      throw Error(`ComfyUI input upload failed (HTTP ${response.status})${detail?`: ${detail}`:''}; check engine storage, credentials and the input file. No generation submitted.`);
    }
    let result;try{result=await response.json();}catch{throw Error('ComfyUI returned an unreadable upload receipt; the reference name was not confirmed. No generation submitted.');}
    if(result.type!=='input'||result.subfolder!=='stargate'||result.name!==name.slice('stargate/'.length))throw Error('ComfyUI input upload name was not confirmed; no generation submitted.');
    return {name};
  }
  async observe(nativeId){
    if(!id(nativeId))throw new Error('Invalid native media job ID');
    if(this.kind==='ace-step'){
      const value=await this.request('/query_result',{task_id_list:[nativeId]});
      const row=Array.isArray(value?.data)?value.data.find(r=>r.task_id===nativeId):null;
      if(!row||![0,1,2].includes(row.status))return {native_id:nativeId,state:'unknown'};
      if(row.status===0)return {native_id:nativeId,state:'pending',scope:'ACE-Step reports queued or running; this response does not distinguish them.'};
      let result=row.result;
      if(typeof result==='string'){try{result=JSON.parse(result);}catch{return {native_id:nativeId,state:'unknown',error:'Native result could not be decoded; observe the same task without resubmitting.'};}}
      // ACE's cache wrapper can report status 2 merely because its timer
      // expired, while the inner record still says running. That is not a
      // confirmed failure and must not trigger engine shutdown.
      if(row.status===2&&Array.isArray(result)&&result.some(item=>item?.status===0))return {native_id:nativeId,state:'unknown',scope:'ACE-Step cache reports a timeout but its task still reports running; observing the same task without cancelling or resubmitting.'};
      return {native_id:nativeId,state:row.status===1?'completed':'failed',result};
    }
    const history=await this.request(`/history/${encodeURIComponent(nativeId)}`),row=history?.[nativeId];
    if(row){
      if(row.status?.status_str==='error')return {native_id:nativeId,state:'failed',result:row};
      if(row.status?.completed===true&&row.status?.status_str==='success')return {native_id:nativeId,state:'completed',result:row};
      return {native_id:nativeId,state:'unknown',result:row};
    }
    const queue=await this.request('/queue');
    for(const [key,state] of [['queue_running','running'],['queue_pending','pending']]){
      if(Array.isArray(queue?.[key])&&queue[key].some(item=>Array.isArray(item)&&item[1]===nativeId))return {native_id:nativeId,state};
    }
    return {native_id:nativeId,state:'unknown',scope:'Absent from current queue/history; absence does not establish completion or permission to replay.'};
  }
}
