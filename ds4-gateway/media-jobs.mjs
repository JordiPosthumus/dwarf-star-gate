import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {priorityRank,requestPriority,PRIORITY_HEADER} from './job-priority.mjs';
import {MediaResults} from './media-results.mjs';
import {MediaInputs} from './media-inputs.mjs';
import {prepareVideoPrompt} from './video-prompt.mjs';
import {validateVideoReferences} from './media-validation.mjs';
import {nativeFailureDetail,mediaErrorAdvice} from './media-errors.mjs';

const states=new Set(['queued','submitting','submitted','pending','running','completed','failed','uncertain']);
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const fail=(status,message)=>Object.assign(new Error(message),{status});
const canonical=value=>Array.isArray(value)?value.map(canonical):object(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const now=()=>new Date().toISOString();
// The gateway's existing process lock owns this store. Media prompts and native
// receipts are private local state, never fleet telemetry or repository content.
export class MediaJobs {
  constructor(filename,{resultsDirectory,inputsDirectory,inputLimits}={}){
    this.filename=filename;
    this.results=new MediaResults(resultsDirectory??path.join(path.dirname(filename),'media-results'));
    this.inputs=new MediaInputs(inputsDirectory??path.join(path.dirname(filename),'media-inputs'),inputLimits);
    this.collecting=new Map();
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
  executionFolder(id){if(!uuid.test(id))throw fail(400,'Invalid media job');return path.join(path.dirname(this.filename),'media-operations',id);}
  get(id){
    const saved=this.data.jobs.find(j=>j.id===id);if(!saved)throw fail(404,'Unknown media job');
    let job=structuredClone(saved);
    if(saved.execution){
      try{
        const folder=this.executionFolder(saved.execution.operation_id??id),native=path.join(folder,'media-jobs.json'),progress=path.join(folder,'progress.json');
        if(fs.existsSync(native)){
          const row=JSON.parse(fs.readFileSync(native,'utf8')).jobs?.find(j=>j.id===id);
          if(!row||row.fingerprint!==saved.fingerprint)throw new Error('Execution does not match the original media request');
          for(const key of ['state','worker','backend','native_id','detail','outputs','result','updated_at'])if(Object.hasOwn(row,key))job[key]=row[key];
        }
        if(fs.existsSync(progress))job.execution={...saved.execution,...JSON.parse(fs.readFileSync(progress,'utf8'))};
        // A finite batch can end early. Only unsubmitted jobs are released, and
        // only after its original LLM returned (or no machine change occurred).
        if(job.state==='queued'&&['returned','failed_returned','failed_unchanged'].includes(job.execution.phase)){
          delete job.execution;job.detail='Previous batch ended before this job started; it remains queued.';
        }
      }catch{job.execution={...saved.execution,phase:'observation_failed',detail:'Saved media execution could not be read; inspect its original process. No job was repeated.'};}
    }
    if(!job.detail)job.detail=nativeFailureDetail(job);
    if(job.state==='failed'&&job.detail)job.next_step=mediaErrorAdvice(job.detail);
    return job;
  }
  list(kind){return this.data.jobs.filter(j=>!kind||j.kind===kind).map(j=>{const {payload,fingerprint,key_hash,...job}=this.get(j.id);return job;});}
  queued(){return this.list().filter(j=>j.state==='queued'&&!j.execution).sort((a,b)=>priorityRank(b)-priorityRank(a));}
  assignExecution(ids,execution){
    const selected=ids.map(id=>this.get(id));
    if(new Set(ids).size!==ids.length||selected.some(j=>j.state!=='queued'||j.execution))throw fail(409,'Every selected job must still be queued and unassigned');
    const replacements=new Map(selected.map(j=>[j.id,{...j,execution:structuredClone(execution),updated_at:now()}]));
    this.save({...this.data,jobs:this.data.jobs.map(j=>replacements.get(j.id)??j)});
  }
  enqueue(kind,payload,{key,priority='normal'}={}){
    if(!['music','video'].includes(kind)||!object(payload))throw fail(400,'Media payload must be a JSON object');
    if(typeof key!=='string'||!/^[\x21-\x7e]{1,200}$/.test(key))throw fail(400,'An Idempotency-Key header (1–200 printable characters) is required');
    try{requestPriority(priority);}catch(e){throw fail(400,e.message);}
    const keyHash=createHash('sha256').update(key).digest('hex');
    const fingerprint=createHash('sha256').update(JSON.stringify(canonical({kind,payload,priority}))).digest('hex');
    const previous=this.data.jobs.find(j=>j.key_hash===keyHash);
    if(previous){if(previous.fingerprint!==fingerprint)throw fail(409,'Idempotency-Key already identifies a different media request');return {job:this.get(previous.id),created:false};}
    // Fingerprint the caller's request before expansion. Retries retain the
    // original seed/workflow even if the bundled recipe later changes.
    const prepared=kind==='video'&&typeof payload.prompt==='string'?prepareVideoPrompt(payload):{payload:structuredClone(payload)};
    if(kind==='video')validateVideoReferences(prepared.payload,this.inputs.forJob(payload.input_files));
    const job={id:randomUUID(),kind,...prepared,priority,key_hash:keyHash,fingerprint,state:'queued',created_at:now(),updated_at:now()};
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
    try{const {input_files,...nativePayload}=job.payload;receipt=await backend.submit(job.kind==='video'?nativePayload:job.payload,id);}
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
  async collect(id,backend,options){
    if(this.collecting.has(id))return this.collecting.get(id);
    const job=this.get(id);if(job.outputs?.state==='ready')return job;
    const work=(async()=>{
      this.update(id,{outputs:{state:'copying'}});
      try{return this.update(id,{outputs:await this.results.collect(job,backend,options)});}
      catch(e){this.update(id,{outputs:{state:'failed',detail:e.message}});throw e;}
    })();
    this.collecting.set(id,work);
    try{return await work;}finally{this.collecting.delete(id);}
  }
}

const publicJob=({payload,fingerprint,key_hash,...job})=>({...job,...(job.outputs?.files?{outputs:{...job.outputs,files:job.outputs.files.map(file=>({...file,url:`/v1/${job.kind}/jobs/${job.id}/files/${file.id}`}))}}:{})});
const respond=(res,status,value)=>{if(!res.destroyed&&!res.headersSent){res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));}};
export function handleMediaRequest(req,res,{jobs,accepting=true}){
  // gateway.mjs verifies the gateway bearer key before calling this handler.
  const input=/^\/v1\/video\/inputs(?:\/([a-f0-9-]{36}))?$/.exec(req.url);
  if(input){
    const reject=e=>respond(res,e.status??500,{error:{code:'video_input_error',message:e.status?e.message:'Video input could not be stored; inspect the gateway log.'}});
    if(!jobs){req.resume();reject(fail(503,'Media jobs are not configured.'));return true;}
    if(req.method==='GET'&&input[1]){try{respond(res,200,jobs.inputs.info(input[1]));}catch(e){reject(e);}return true;}
    if(req.method==='DELETE'&&input[1]){
      req.resume();try{
        if(jobs.data.jobs.some(saved=>{if(saved.kind!=='video'||!saved.payload.input_files?.includes(input[1]))return false;const j=jobs.get(saved.id);return !['completed','failed'].includes(j.state)||j.execution&&!['returned','failed_returned','failed_unchanged'].includes(j.execution.phase);}))throw fail(409,'Video input is used by an unfinished job');
        respond(res,200,jobs.inputs.remove(input[1]));
      }catch(e){reject(e);}return true;
    }
    if(req.method!=='POST'||input[1]){req.resume();reject(fail(405,'POST raw file bytes to /v1/video/inputs, or GET/DELETE its input ID.'));return true;}
    if(!accepting){req.resume();reject(fail(503,'Gateway is draining; no new video input accepted.'));return true;}
    void jobs.inputs.receive(req).then(value=>respond(res,201,{...value,status_url:`/v1/video/inputs/${value.id}`})).catch(e=>{req.resume();reject(e);});return true;
  }
  const match=/^\/v1\/(music|video)\/jobs(?:\/([a-f0-9-]{36})(?:\/files\/([a-f0-9-]{36}))?)?$/.exec(req.url);
  if(!match)return false;
  const [,kind,id,fileId]=match;
  const reject=e=>respond(res,e.status??500,{error:{code:'media_job_error',message:e.status?e.message:'Could not access the media queue; inspect the gateway log.'}});
  if(!jobs){req.resume();respond(res,503,{error:{code:'media_not_configured',message:'Media jobs are not configured on this gateway.'}});return true;}
  if(req.method==='GET'){
    try{if(id){const job=jobs.get(id);if(job.kind!==kind)throw fail(404,'Unknown media job');if(fileId){if(!jobs.results.serve(req,res,job,fileId))throw fail(404,'Retained media file is not available');}else respond(res,200,publicJob(job));}else respond(res,200,{jobs:jobs.list(kind).map(publicJob)});}catch(e){reject(e);}return true;
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
