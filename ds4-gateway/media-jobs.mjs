import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {priorityRank,requestPriority,PRIORITY_HEADER} from './job-priority.mjs';

const states=new Set(['queued','submitting','submitted','pending','running','completed','failed','uncertain']);
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const fail=(status,message)=>Object.assign(new Error(message),{status});
const canonical=value=>Array.isArray(value)?value.map(canonical):object(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const now=()=>new Date().toISOString();

// The gateway's existing process lock owns this store. Media prompts and native
// receipts are private local state, never fleet telemetry or repository content.
export class MediaJobs {
  constructor(filename){
    this.filename=filename;
    fs.mkdirSync(path.dirname(filename),{recursive:true,mode:0o700});
    this.data=fs.existsSync(filename)?JSON.parse(fs.readFileSync(filename,'utf8')):{schema:1,jobs:[]};
    if(this.data.schema!==1||!Array.isArray(this.data.jobs)||this.data.jobs.some(j=>!uuid.test(j.id)||!states.has(j.state)||!['music','video'].includes(j.kind)||!object(j.payload)))throw new Error('Invalid saved media queue; preserved for inspection.');
    // A crashed submit is not evidence of rejection. Reconciliation may observe
    // a saved native ID, but must never automatically repeat the generation.
    if(this.data.jobs.some(j=>j.state==='submitting'))this.save({...this.data,jobs:this.data.jobs.map(j=>j.state==='submitting'?{...j,state:'uncertain',detail:'Gateway restarted during native submission; reconcile the original job.',updated_at:now()}:j)});
  }
  save(data){
    const temporary=`${this.filename}.${randomUUID()}.tmp`;
    let fd;
    try{
      fd=fs.openSync(temporary,'wx',0o600);fs.writeFileSync(fd,JSON.stringify(data)+'\n');fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
      fs.renameSync(temporary,this.filename);
      const directory=fs.openSync(path.dirname(this.filename),'r');try{fs.fsyncSync(directory);}finally{fs.closeSync(directory);}
      this.data=data;
    }finally{if(fd!==undefined)fs.closeSync(fd);if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
  }
  get(id){const job=this.data.jobs.find(j=>j.id===id);if(!job)throw fail(404,'Unknown media job');return structuredClone(job);}
  list(kind){return this.data.jobs.filter(j=>!kind||j.kind===kind).map(({payload,fingerprint,...job})=>structuredClone(job));}
  queued(){return this.list().filter(j=>j.state==='queued').sort((a,b)=>priorityRank(b)-priorityRank(a));}
  enqueue(kind,payload,{key,priority='normal'}={}){
    if(!['music','video'].includes(kind)||!object(payload))throw fail(400,'Media payload must be a JSON object');
    if(typeof key!=='string'||!/^[\x21-\x7e]{1,200}$/.test(key))throw fail(400,'An Idempotency-Key header (1–200 printable characters) is required');
    try{requestPriority(priority);}catch(e){throw fail(400,e.message);}
    const keyHash=createHash('sha256').update(key).digest('hex');
    const fingerprint=createHash('sha256').update(JSON.stringify(canonical({kind,payload,priority}))).digest('hex');
    const previous=this.data.jobs.find(j=>j.key_hash===keyHash);
    if(previous){if(previous.fingerprint!==fingerprint)throw fail(409,'Idempotency-Key already identifies a different media request');return {job:this.get(previous.id),created:false};}
    const job={id:randomUUID(),kind,payload:structuredClone(payload),priority,key_hash:keyHash,fingerprint,state:'queued',created_at:now(),updated_at:now()};
    this.save({...this.data,jobs:[...this.data.jobs,job]});return {job:this.get(job.id),created:true};
  }
  update(id,changes){const job=this.get(id),next={...job,...changes,updated_at:now()};this.save({...this.data,jobs:this.data.jobs.map(j=>j.id===id?next:j)});return this.get(id);}
  async dispatch(id,backend,worker){
    const job=this.get(id);
    if(job.state!=='queued')throw fail(409,'Media job has already been submitted or needs reconciliation');
    if(typeof worker!=='string'||!worker)throw fail(400,'A selected worker is required');
    if((job.kind==='music'&&backend.kind!=='ace-step')||(job.kind==='video'&&backend.kind!=='comfyui'))throw fail(400,'Media backend does not match the job kind');
    // Called only after the allocator has acquired the host and verified engine
    // readiness. This queue does not grant authority to stop an LLM server.
    this.update(id,{state:'submitting',worker,backend:backend.kind,native_id:backend.kind==='comfyui'?id:null});
    let receipt;
    try{receipt=await backend.submit(job.payload,id);}
    catch(e){return this.update(id,{state:e.uncertain===false?'failed':'uncertain',detail:e.message});}
    return this.update(id,{state:'submitted',native_id:receipt.native_id});
  }
  async observe(id,backend){
    const job=this.get(id);
    if(['completed','failed','queued'].includes(job.state)||!job.native_id)return job;
    if(job.state==='submitting')return job;
    if(job.backend!==backend.kind)throw fail(409,'Observe the originally selected media backend');
    const observation=await backend.observe(job.native_id);
    if(observation.state==='unknown')return this.update(id,{state:'uncertain',detail:observation.scope??observation.error??'Native job state is unknown; no resubmission performed.'});
    if(!['pending','running','completed','failed'].includes(observation.state))throw new Error('Invalid native media job state');
    return this.update(id,{state:observation.state,detail:observation.scope??null,...(observation.result!==undefined?{result:observation.result}:{})});
  }
}

const publicJob=({payload,fingerprint,key_hash,...job})=>job;
const respond=(res,status,value)=>{if(!res.destroyed&&!res.headersSent){res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));}};
export function handleMediaRequest(req,res,{jobs,accepting=true}){
  const match=/^\/v1\/(music|video)\/jobs(?:\/([a-f0-9-]{36}))?$/.exec(req.url);
  if(!match)return false;
  const [,kind,id]=match;
  const reject=e=>respond(res,e.status??500,{error:{code:'media_job_error',message:e.status?e.message:'Could not access the media queue; inspect the gateway log.'}});
  if(!jobs){req.resume();respond(res,503,{error:{code:'media_not_configured',message:'Media jobs are not configured on this gateway.'}});return true;}
  if(req.method==='GET'){
    try{if(id){const job=jobs.get(id);if(job.kind!==kind)throw fail(404,'Unknown media job');respond(res,200,publicJob(job));}else respond(res,200,{jobs:jobs.list(kind).map(publicJob)});}catch(e){reject(e);}return true;
  }
  if(req.method!=='POST'||id){req.resume();respond(res,405,{error:{code:'media_method',message:'Use POST to submit or GET to inspect jobs.'}});return true;}
  if(!accepting){req.resume();respond(res,503,{error:{code:'draining',message:'Gateway is draining; no new media job accepted.'}});return true;}
  if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']??'')){req.resume();reject(fail(415,'Media submission requires JSON'));return true;}
  const chunks=[];let bytes=0,finished=false;
  const timer=setTimeout(()=>{if(!finished){finished=true;reject(fail(408,'Incomplete media submission'));req.resume();}},10000);timer.unref();
  req.on('data',chunk=>{if(finished)return;bytes+=chunk.length;if(bytes>2*1024*1024){finished=true;clearTimeout(timer);reject(fail(413,'Media JSON exceeds 2 MiB; upload assets separately'));req.resume();}else chunks.push(chunk);});
  const abandoned=()=>{finished=true;clearTimeout(timer);};req.on('error',abandoned);req.on('aborted',abandoned);
  req.on('end',()=>{
    clearTimeout(timer);if(finished)return;finished=true;
    try{
      let payload;try{payload=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw fail(400,'Invalid media JSON');}
      const {job,created}=jobs.enqueue(kind,payload,{key:req.headers['idempotency-key'],priority:req.headers[PRIORITY_HEADER]});
      respond(res,created?202:200,{...publicJob(job),status_url:`/v1/${kind}/jobs/${job.id}`});
    }catch(e){reject(e);}
  });return true;
}
