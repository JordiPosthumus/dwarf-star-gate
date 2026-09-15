// Approval and durable launch receipts for a separately supervised operation.
// Transport/qualification are injected; this store never changes a worker itself.
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';

const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const ID=/^[a-zA-Z0-9][\w-]{0,63}$/;
const DIGEST=/^[a-f0-9]{64}$/;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const encode=value=>JSON.stringify(value,null,2)+'\n';
const exact=(input,keys)=>input&&typeof input==='object'&&!Array.isArray(input)&&Object.keys(input).sort().join(',')===[...keys].sort().join(',');

export class ServerOperations {
  constructor({directory,workers,prepare,launch,observe,recordRevision,now=Date.now,proposalKind='serving'}) {
    if(!Array.isArray(workers)||workers.some(id=>!ID.test(id))||[prepare,launch,observe,recordRevision].some(f=>typeof f!=='function'))throw new Error('Operation enrollment and runner callbacks are required.');
    if(!['serving','hourglass'].includes(proposalKind))throw new Error('Unsupported enrolled operation kind.');
    this.proposalKind=proposalKind;
    this.directory=path.resolve(directory);this.workers=new Set(workers);this.prepare=prepare;this.launch=launch;this.observe=observe;this.recordRevision=recordRevision;this.now=now;
    this.preparing=new Map();this.launching=new Map();this.closed=false;this.approvals=Promise.resolve();
    fs.mkdirSync(this.directory,{recursive:true,mode:0o700});
    // A constructor never replays prepare, approval or launch. It reads receipts.
  }
  folder(id){if(!UUID.test(id))throw new Error('Invalid operation ID.');const folder=path.join(this.directory,id);if(fs.existsSync(folder)&&fs.lstatSync(folder).isSymbolicLink())throw new Error('Symlink operation directory is not accepted.');return folder;}
  read(id,name){
    const file=path.join(this.folder(id),name);let fd;
    try{
      fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
      const info=fs.fstatSync(fd);if(!info.isFile()||info.size>2*1024*1024)throw new Error('Invalid operation receipt.');
      return JSON.parse(fs.readFileSync(fd,'utf8'));
    }catch(e){if(e.code==='ENOENT')return null;throw e;}
    finally{if(fd!==undefined)fs.closeSync(fd);}
  }
  write(id,name,value){
    const folder=this.folder(id),file=path.join(folder,name),temp=file+'.'+randomUUID()+'.tmp';let fd;
    const bytes=encode(value);if(Buffer.byteLength(bytes)>2*1024*1024)throw new Error('Operation receipt exceeds the supported size.');
    try{
      fd=fs.openSync(temp,'wx',0o600);fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
      // link gives atomic, exclusive publication. Existing evidence is preserved.
      fs.linkSync(temp,file);fs.unlinkSync(temp);
      fd=fs.openSync(folder,'r');fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
    }finally{if(fd!==undefined)fs.closeSync(fd);if(fs.existsSync(temp))fs.unlinkSync(temp);}
    return value;
  }
  list(){
    const result=[];
    for(const entry of fs.readdirSync(this.directory,{withFileTypes:true})){
      if(!entry.isDirectory()||!UUID.test(entry.name))continue;
      try{result.push(this.status(entry.name));}catch{result.push({id:entry.name,state:'unreadable',error:'Existing operation files were preserved. Inspect this operation before acting.'});}
    }
    return result.sort((a,b)=>(b.created_at??0)-(a.created_at??0));
  }
  status(id){
    const proposal=this.read(id,'proposal.json');if(!proposal)throw new Error('Operation not found.');
    const prepared=this.read(id,'prepared.json'),failed=this.read(id,'prepare-failed.json'),declined=this.read(id,'declined.json');
    const approval=this.read(id,'approved.json'),intent=this.read(id,'launch-intent.json'),started=this.read(id,'launched.json'),uncertain=this.read(id,'launch-uncertain.json');
    return {id,worker_id:proposal.worker_id,reason:proposal.reason,created_at:proposal.created_at,
      state:declined?'declined':intent?(started?'submitted':'launch_uncertain'):approval?'approved_unsubmitted':failed?'prepare_failed':prepared?'awaiting_approval':this.preparing.has(id)?'preparing':'preparation_interrupted',
      ...(prepared?{plan_revision:prepared.plan_revision,review:prepared.review,record_revision:prepared.record_revision}:{}),
      ...(approval?{approved_at:approval.at}:{}),...(started?{launch_receipt:started.receipt}:{}),
      ...(failed||uncertain?{error:(failed??uncertain).error}:{}),
      scope:'Saved proposal and launch receipts. Submitted is not completed; current runner state requires observation.'};
  }
  propose(input,{conversation_id=null,reply_id=null}={}){
    if(this.closed)throw new Error('Operation proposals are closed.');
    const validShape=this.proposalKind==='hourglass'
      ?exact(input,['id','worker_id','model','reason'])&&typeof input.model==='string'&&input.model.trim()&&input.model.length<=256
      :exact(input,['id','worker_id','image','command','reason'])&&/^sha256:[a-f0-9]{64}$/.test(input.image)&&Array.isArray(input.command)&&input.command.length&&!input.command.some(s=>typeof s!=='string'||s.includes('\0'))&&Buffer.byteLength(JSON.stringify(input.command))<=65536;
    if(!validShape||!UUID.test(input.id)||!ID.test(input.worker_id)||!this.workers.has(input.worker_id)||typeof input.reason!=='string'||!input.reason.trim()||input.reason.length>2000)throw new Error(this.proposalKind==='hourglass'?'Specify an enrolled worker and saved measurement.':'Specify a configured worker, exact image, complete command and reason.');
    for(const id of [conversation_id,reply_id])if(id!==null&&!UUID.test(id))throw new Error('Invalid originating conversation.');
    const folder=this.folder(input.id),existing=fs.existsSync(folder)?this.read(input.id,'proposal.json'):null;
    if(existing){if(existing.input_digest!==hash(JSON.stringify(input)))throw new Error('Operation ID already belongs to another proposal.');return this.status(input.id);}
    if(fs.existsSync(folder))throw new Error('Incomplete operation directory was preserved; inspect it before proceeding.');
    fs.mkdirSync(folder,{mode:0o700});
    const proposal=this.write(input.id,'proposal.json',{...structuredClone(input),reason:input.reason.trim(),input_digest:hash(JSON.stringify(input)),conversation_id,reply_id,created_at:this.now()});
    const job=this.finishPreparation(proposal).finally(()=>this.preparing.delete(input.id));this.preparing.set(input.id,job);
    return this.status(input.id);
  }
  async finishPreparation(proposal){
    try{
      const record_revision=await this.recordRevision(proposal.worker_id);
      if(!DIGEST.test(record_revision))throw new Error('Approved configuration record unavailable.');
      const result=await this.prepare(structuredClone(proposal),record_revision);
      if(!exact(result,['plan','review'])||!result.plan||!result.review)throw new Error('Incomplete operation plan.');
      const planBytes=encode(result.plan);
      this.write(proposal.id,'plan.json',result.plan);
      this.write(proposal.id,'prepared.json',{at:this.now(),plan_revision:hash(planBytes),record_revision,review:result.review});
    }catch{
      this.write(proposal.id,'prepare-failed.json',{at:this.now(),error:'The exact change could not be prepared. Existing configuration and proposal files were preserved; no operation was launched.'});
    }
  }
  change(input){
    const saved=structuredClone(input),task=this.approvals.then(()=>this.changeSerial(saved));this.approvals=task.catch(()=>{});return task;
  }
  async changeSerial(input){
    if(this.closed)throw new Error('Operation approvals are closed.');
    if(!exact(input,['action','id','plan_revision'])||!['approve','decline'].includes(input.action)||!UUID.test(input.id)||!DIGEST.test(input.plan_revision))throw new Error('Specify the displayed operation and exact plan revision.');
    const id=input.id,prepared=this.read(id,'prepared.json'),proposal=this.read(id,'proposal.json');
    if(!proposal||!prepared||prepared.plan_revision!==input.plan_revision||hash(encode(this.read(id,'plan.json')))!==input.plan_revision)throw new Error('The reviewed plan changed or is unavailable.');
    if(this.read(id,'declined.json')){if(input.action==='decline')return this.status(id);throw new Error('This proposal was declined.');}
    if(input.action==='decline'){
      if(this.read(id,'approved.json')||this.read(id,'launch-intent.json'))throw new Error('An approved operation cannot be cancelled by declining its proposal.');
      this.write(id,'declined.json',{at:this.now(),plan_revision:input.plan_revision});return this.status(id);
    }
    // The endpoint calling this method must require an explicit owner action.
    // This method is deliberately not exposed to the Genie tool catalog.
    if(this.read(id,'launch-intent.json'))return this.status(id);
    if(await this.recordRevision(proposal.worker_id)!==prepared.record_revision)throw new Error('The approved configuration record changed. Prepare a new proposal.');
    const operations=this.list();if(operations.some(row=>row.state==='unreadable'))throw new Error('Inspect the preserved unreadable operation before starting another server change.');
    for(const other of operations.filter(row=>row.id!==id&&row.worker_id===proposal.worker_id&&['submitted','launch_uncertain','approved_unsubmitted'].includes(row.state))){
      const current=await this.current(other.id);
      if(!['completed','restored','failed_unchanged'].includes(current.runner?.state))throw new Error('Observe or finish the existing operation on this worker first.');
    }
    // Check again after the await: another request may have approved or declined.
    if(this.read(id,'declined.json'))throw new Error('This proposal was declined.');
    if(this.read(id,'launch-intent.json'))return this.status(id);
    if(!this.read(id,'approved.json'))this.write(id,'approved.json',{at:this.now(),actor:'owner',plan_revision:input.plan_revision,record_revision:prepared.record_revision});
    this.write(id,'launch-intent.json',{at:this.now(),plan_revision:input.plan_revision});
    const task=(async()=>{
      try{
        const receipt=await this.launch({id,directory:this.folder(id),plan_revision:input.plan_revision});
        this.write(id,'launched.json',{at:this.now(),receipt});
      }catch{
        this.write(id,'launch-uncertain.json',{at:this.now(),error:'Operation launch could not be confirmed. Observe the existing operation; it will not be submitted again.'});
      }
    })().finally(()=>this.launching.delete(id));this.launching.set(id,task);
    return this.status(id);
  }
  async current(id){
    const saved=this.status(id);
    if(!this.read(id,'launch-intent.json'))return saved;
    try{return {...saved,runner:await this.observe({id,directory:this.folder(id)})};}
    catch{return {...saved,runner:{state:'observation_unavailable',scope:'The existing operation may still be running. No action was replayed.'}};}
  }
  async resumeApproved(){
    // Approval without a launch intent proves this store never called launch.
    // A saved launch intent, even without a PID, is always observed instead.
    for(const row of this.list().filter(row=>row.state==='approved_unsubmitted')){
      try{await this.change({action:'approve',id:row.id,plan_revision:row.plan_revision});}catch{/* Status remains available for owner review. */}
    }
  }
  async idle(){await Promise.all([...this.preparing.values(),...this.launching.values()]);}
  close(){this.closed=true;} // Existing independent runners are not signalled.
}
