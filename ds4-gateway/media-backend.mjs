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
    let response;
    try{
      response=await this.fetch(new URL(route,this.url),{method:body===undefined?'GET':'POST',redirect:'error',signal:AbortSignal.timeout(30000),
        headers:{...(this.token?{authorization:`Bearer ${this.token}`} : {}),...(body===undefined?{}:{'content-type':'application/json'})},
        ...(body===undefined?{}:{body:JSON.stringify(body)})});
    }catch{throw new MediaBackendError('Native media response unavailable; observe the original job before another submission.',{uncertain:submission});}
    if(!response.ok){
      let detail='';
      // ComfyUI rejects missing models/files before creating native history.
      // Keep that actionable validation message with the existing failed job.
      if(this.kind==='comfyui'&&response.status===400){
        try{
          const value=await response.json(),messages=[];
          if(object(value.node_errors))for(const [node,row]of Object.entries(value.node_errors)){
            for(const error of Array.isArray(row?.errors)?row.errors:[]){
              const text=[error?.message,error?.details].filter(v=>typeof v==='string'&&v.trim()).join(': ');
              if(text)messages.push(`node ${node}${typeof row.class_type==='string'?` (${row.class_type})`:''}: ${text}`);
            }
          }
          if(!messages.length&&typeof value.error?.message==='string')messages.push(value.error.message);
          detail=messages.join('; ');
        }catch{/* Unreadable validation responses retain the HTTP error. */}
      }
      throw new MediaBackendError(`Native media HTTP ${response.status}${detail?`: ${detail}`:''}`,{uncertain:submission&&response.status>=500});
    }
    try{return await response.json();}catch{throw new MediaBackendError('Native media returned an unreadable receipt.',{uncertain:submission});}
  }
  async submit(payload,requestId){
    if(!object(payload)||typeof requestId!=='string'||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(requestId))throw new Error('Use a media request object and gateway job UUID');
    const value=await this.request(this.kind==='ace-step'?'/release_task':'/prompt',this.kind==='ace-step'?payload:{...payload,client_id:requestId,prompt_id:requestId},{submission:true});
    const nativeId=this.kind==='ace-step'?value?.data?.task_id:value?.prompt_id;
    if(!id(nativeId))throw new MediaBackendError('Native media acceptance was not established; do not replay this submission.',{uncertain:true});
    return {native_id:nativeId,state:'submitted'};
  }
  async uploadInput(blob,name){
    if(this.kind!=='comfyui'||!/^stargate\/[a-f0-9-]{36}\.[a-z0-9]+$/.test(name))throw Error('Use a stored Star Gate video input');
    const form=new FormData();form.append('image',blob,name.slice('stargate/'.length));form.append('type','input');form.append('subfolder','stargate');
    const response=await this.fetch(new URL('/upload/image',this.url),{method:'POST',redirect:'error',headers:this.token?{authorization:`Bearer ${this.token}`}:{},body:form});
    if(!response.ok)throw Error(`ComfyUI input upload failed (HTTP ${response.status}); no generation submitted.`);
    const result=await response.json();
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
      if(typeof result==='string'){try{result=JSON.parse(result);}catch{return {native_id:nativeId,state:'unknown',error:'Native result could not be decoded.'};}}
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
