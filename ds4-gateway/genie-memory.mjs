// Private operational notebook. No inference text, training labels or action offers.
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {safeQuarantine} from './generation-health.mjs';
import {validCallId} from './continuity.mjs';
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const workerId=x=>typeof x==='string'&&/^[a-zA-Z0-9][\w-]{0,63}$/.test(x);
const bool=x=>typeof x==='boolean'?x:null;
const uuid=x=>!!validCallId(x);
const recoveryStates=new Set(['queued','reconciling','restarting','verifying','recovered','verified_paused','failed','reconciliation_needed']);
const recoveryRecord=op=>workerId(op?.worker_id)&&uuid(op.id)&&recoveryStates.has(op.state)&&Number.isSafeInteger(op.updated_at)?{worker:op.worker_id,operation_id:op.id,state:op.state,recorded_at:op.updated_at}:null;
const incidentRecord=(worker,q)=>workerId(worker)&&uuid(q?.request_id)&&safeQuarantine(q)?.reason&&Number.isFinite(Date.parse(q.at))?{worker,request_id:q.request_id,reason:safeQuarantine(q).reason,recorded_at:Date.parse(q.at)}:null;
export const MEMORY_LIMIT=16*1024*1024;
export function workerObservation(worker){
  if(!workerId(worker?.id))return null;
  return {worker:worker.id,gateway_healthy:bool(worker.is_healthy),paused:bool(worker.drained),
    operator_paused:bool(worker.operator_paused),agent_hold_count:Array.isArray(worker.holds)?worker.holds.length:null,
    quarantine:safeQuarantine(worker.quarantine)?.reason??null,
    context_length:Number.isSafeInteger(worker.context_length)&&worker.context_length>0?worker.context_length:null,
    process_epoch:null,cache_epoch:null,generation_verified:null};
}
function validate(event,notes){
  if(event?.schema!==1||!Number.isSafeInteger(event.at)||event.at<0)throw new Error();
  if(event.kind==='settings'){
    if(Object.keys(event).sort().join(',')!=='at,enabled,kind,schema'||typeof event.enabled!=='boolean')throw new Error();
    return;
  }
  if(!['observation','recovery','incident','operator_note'].includes(event.kind)||Object.keys(event).sort().join(',')!=='at,data,id,kind,revision,schema,source_digest')throw new Error();
  const d=event.data;let canonical,expectedId;
  if(event.kind==='operator_note'){
    if((d?.worker!==null&&!workerId(d?.worker))||typeof d.text!=='string'||!d.text.trim()||d.text.length>1000||Buffer.byteLength(d.text)>2000||!['active','archived'].includes(d.state)||!/^[a-f0-9]{24}$/.test(event.id))throw new Error('Note must contain 1–1000 characters within 2000 UTF-8 bytes');
    canonical={worker:d.worker,text:d.text.trim(),state:d.state};expectedId=event.id;
  }else if(event.kind==='recovery'){
    canonical=recoveryRecord({worker_id:d?.worker,id:d?.operation_id,state:d?.state,updated_at:d?.recorded_at});expectedId=hash(['recovery',d?.worker,d?.operation_id]).slice(0,24);
  }else if(event.kind==='incident'){
    canonical=Number.isSafeInteger(d?.recorded_at)?incidentRecord(d.worker,{request_id:d.request_id,reason:d.reason,at:new Date(d.recorded_at).toISOString()}):null;expectedId=hash(['incident',d?.worker,d?.request_id]).slice(0,24);
  }else{
    canonical=workerObservation({id:d?.worker,is_healthy:d?.gateway_healthy,drained:d?.paused,operator_paused:d?.operator_paused,
    holds:d.agent_hold_count===null?undefined:Array.from({length:Number.isInteger(d.agent_hold_count)&&d.agent_hold_count>=0&&d.agent_hold_count<=1024?d.agent_hold_count:0}),
    quarantine:d.quarantine?{reason:d.quarantine}:null,context_length:d.context_length});
    expectedId=hash(['worker-observation',d.worker]).slice(0,24);
  }
  if(!canonical||JSON.stringify(canonical)!==JSON.stringify(d)||event.id!==expectedId||event.source_digest!==hash(d)||event.revision!==(notes.get(event.id)?.revision??0)+1||notes.has(event.id)&&notes.get(event.id).kind!==event.kind)throw new Error();
}
export class GenieMemory {
  constructor(directory,{maxBytes=MEMORY_LIMIT,now=Date.now,io=fs}={}){
    this.directory=directory;this.file=path.join(directory,'notebook.jsonl');this.maxBytes=maxBytes;this.now=now;this.io=io;
    this.notes=new Map();this.history=new Map();this.enabled=false;this.error=null;this.bytes=0;this.lastWrite=null;this.loaded=false;
    try{if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>MEMORY_LIMIT)throw new Error();
      if(fs.existsSync(directory))this.load();else this.loaded=true;
    }catch{this.error='Memory unavailable: inspect private storage, permissions or journal. No records changed.';}
  }
  checkDirectory(){
    const resolved=fs.realpathSync(this.directory),s=fs.lstatSync(this.directory);
    if(resolved!==path.resolve(this.directory)||!s.isDirectory()||(s.mode&0o777)!==0o700||s.uid!==process.getuid())throw new Error();
  }
  open(flags){
    const fd=fs.openSync(this.file,flags|fs.constants.O_NOFOLLOW,0o600);
    const s=fs.fstatSync(fd);if(!s.isFile()||s.nlink!==1||(s.mode&0o777)!==0o600||s.uid!==process.getuid()){fs.closeSync(fd);throw new Error();}return fd;
  }
  load(){
    this.checkDirectory();if(!fs.existsSync(this.file)){this.loaded=true;return;}
    const fd=this.open(fs.constants.O_RDONLY);let text;
    try{const s=fs.fstatSync(fd);if(s.size>this.maxBytes)throw new Error();text=fs.readFileSync(fd,'utf8');this.bytes=s.size;}finally{fs.closeSync(fd);}
    if(text&&!text.endsWith('\n'))throw new Error();
    const events=text.split('\n').filter(Boolean).map(line=>{if(Buffer.byteLength(line)>4096)throw new Error();return JSON.parse(line);});
    for(const e of events){validate(e,this.notes);this.apply(e);}
    this.loaded=true;
  }
  apply(event){
    if(event.kind==='settings')this.enabled=event.enabled;
    else{if(event.kind==='observation'){const prior=this.notes.get(event.id);if(prior)this.history.set(event.id,[prior,...(this.history.get(event.id)??[])].slice(0,7));}this.notes.set(event.id,event);}
    this.lastWrite=event.at;
  }
  append(event){
    if(this.error||!this.loaded)throw new Error('Memory storage unavailable');
    validate(event,this.notes);const bytes=Buffer.from(JSON.stringify(event)+'\n');let lock,fd;
    try{
      if(bytes.length>4096||this.bytes+bytes.length>this.maxBytes)throw new Error('ceiling');
      fs.mkdirSync(this.directory,{recursive:true,mode:0o700});this.checkDirectory();
      lock=fs.openSync(path.join(this.directory,'writer.lock'),fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
      fd=this.open(fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_APPEND);
      if(fs.fstatSync(fd).size!==this.bytes)throw new Error('changed');
      let at=0;while(at<bytes.length){const n=this.io.writeSync(fd,bytes,at,bytes.length-at);if(n<=0)throw new Error();at+=n;}
      this.io.fsyncSync(fd);
      const dir=fs.openSync(this.directory,fs.constants.O_RDONLY);try{this.io.fsyncSync(dir);}finally{fs.closeSync(dir);}
      this.bytes+=bytes.length;this.apply(event);return {id:event.id??null,revision:event.revision??null,saved_at:event.at};
    }catch(e){this.error=e.message==='ceiling'?'Memory storage ceiling reached; writes paused, nothing deleted.':'Memory write failed; inspect journal/lock privately. No automatic repair.';throw new Error(this.error);}
    finally{if(fd!==undefined)fs.closeSync(fd);if(lock!==undefined){fs.closeSync(lock);fs.unlinkSync(path.join(this.directory,'writer.lock'));}}
  }
  setEnabled(value){
    if(typeof value!=='boolean')throw new Error('Memory enabled must be boolean');
    if(value===this.enabled)return this.status();
    if(!value&&this.error){this.enabled=false;return this.status();}
    this.append({schema:1,kind:'settings',at:this.now(),enabled:value});return this.status();
  }
  observe(snapshot){
    if(!this.enabled||this.error||snapshot.gateway_error||!snapshot.gateway||!Number.isSafeInteger(snapshot.gateway_at)||this.now()-snapshot.gateway_at<0||this.now()-snapshot.gateway_at>10000)return;
    // Only actual fresh samples. Polling gaps, missing members and reboot identity
    // are unknown; no synthetic outage, uptime or successful generation labels.
    for(const worker of (snapshot.gateway.workers??[]).slice(0,128)){
      const data=workerObservation(worker);if(!data)continue;
      const id=hash(['worker-observation',data.worker]).slice(0,24),old=this.notes.get(id);
      if(old?.source_digest===hash(data))continue;
      try{this.append({schema:1,kind:'observation',at:snapshot.gateway_at,id,revision:(old?.revision??0)+1,data,source_digest:hash(data)});}catch{break;}
    }
    const add=(kind,data)=>{
      if(!data||data.recorded_at>snapshot.gateway_at||data.recorded_at<0)return;
      const id=hash([kind,data.worker,data.operation_id??data.request_id]).slice(0,24),old=this.notes.get(id);
      if(old?.source_digest===hash(data))return;
      this.append({schema:1,kind,at:snapshot.gateway_at,id,revision:(old?.revision??0)+1,data,source_digest:hash(data)});
    };
    try{
      for(const w of (snapshot.gateway.workers??[]).slice(0,128))add('incident',incidentRecord(w.id,w.quarantine));
      for(const op of (snapshot.gateway.recovery?.operations??[]).slice(0,20))add('recovery',recoveryRecord(op));
    }catch{/* Storage error is visible; inference and stateless reviews continue. */}
  }
  saveOperatorNote(input,snapshot){
    if(!this.enabled)throw new Error('Enable memory before saving a note');
    if(!input||Object.keys(input).some(k=>!['id','expected_revision','worker','text','state'].includes(k)))throw new Error('Invalid operator note');
    const old=input.id?this.notes.get(input.id):null;
    if(input.id&&(!old||old.kind!=='operator_note'||input.expected_revision!==old.revision))throw new Error('Note changed; refresh before editing');
    const data={worker:input.worker??null,text:typeof input.text==='string'?input.text.trim():input.text,state:input.state??'active'};
    if(data.worker!==null&&!(snapshot.gateway?.workers??[]).some(w=>w.id===data.worker))throw new Error('Choose a currently registered worker');
    const id=old?.id??hash(randomUUID()).slice(0,24);
    return this.append({schema:1,kind:'operator_note',at:this.now(),id,revision:(old?.revision??0)+1,data,source_digest:hash(data)});
  }
  retrieve(snapshot,{limit=12,maxBytes=16384}={}){
    const notes=[];let bytes=0;const workers=new Set((snapshot.gateway?.workers??[]).map(w=>w.id));
    if(!this.enabled||this.error)return {notes,truncated:false};
    const all=[...this.notes.values()].filter(n=>(n.data.worker===null||workers.has(n.data.worker))&&n.data.state!=='archived').sort((a,b)=>Number(b.kind==='operator_note')-Number(a.kind==='operator_note')||b.at-a.at||a.id.localeCompare(b.id));
    for(const n of all){const note={...n,provenance:n.kind==='operator_note'?'explicit_operator_note':n.kind==='recovery'?'executor_receipt':'deterministic_gateway_snapshot',verification:n.kind==='operator_note'?'operator_intent_not_authority':'historical_observation',review_due:this.now()-n.at>7*86400000,continuity:'unknown',...(n.kind==='observation'?{recent_transitions:(this.history.get(n.id)??[]).map(e=>({at:e.at,revision:e.revision,data:e.data,source_digest:e.source_digest}))}:{})};
      const size=Buffer.byteLength(JSON.stringify(note));if(notes.length>=Math.min(12,limit)||bytes+size>Math.min(16384,maxBytes))break;notes.push(note);bytes+=size;}
    return {notes,truncated:all.length>notes.length};
  }
  status(){return {available:this.loaded&&!this.error,enabled:this.enabled,error:this.error,note_count:this.notes.size,bytes:this.bytes,max_bytes:this.maxBytes,last_write:this.lastWrite,scope:'worker history, incident/recovery references and explicit operator notes; no new action authority'};}
}
