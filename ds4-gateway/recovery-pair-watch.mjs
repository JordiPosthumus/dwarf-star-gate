// Resume the originating conversation when its native capture finishes.
// This observer never starts a capture, enrolls a service or restarts a server.
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';

const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const kinds={
  'omlx-enrollment':{tool:'enroll_omlx_recovery',rows:r=>r?.omlx_enrollment?.operations??[],states:['enrolled','failed'],prefix:'omlx-enroll-',label:'oMLX enrollment',limit:'Enrolled means the existing local oMLX binding was captured and installed without a restart. Native restart qualification remains required.'},
  capture:{tool:'prepare_pair_recovery',rows:r=>r?.pair_preparations??[],states:['prepared','failed'],prefix:'pair-result-',label:'capture',limit:'Prepared means inspection evidence only; recovery enrollment and restart qualification remain separate.'},
  qualification:{tool:'qualify_pair_recovery',rows:r=>(r?.operations??[]).filter(o=>o.pair_qualification===true).map(o=>({...o,action_id:o.id})),states:['recovered','verified_paused','failed','reconciliation_needed'],prefix:'pair-qual-',label:'restart qualification',limit:'Recovered with native proof qualifies this exact pair. Failed, uncertain or paused outcomes do not authorize another restart. After reading the terminal receipt, you may continue an original request to qualify other explicitly opted-in pairs only when their fresh pair_qualification evidence is eligible. Never replay any existing action, override a pause, enroll a new binding or change settings.'},
  enrollment:{tool:'enroll_pair_recovery',rows:r=>r?.pair_enrollment?.operations??[],states:['enrolled','failed'],prefix:'pair-enroll-',label:'enrollment',limit:'Enrolled means an exact recovery binding was installed; native restart qualification remains required.'}
};
const terminal=(row,kind)=>kind.states.includes(row?.state);
const receiptKey=row=>JSON.stringify([row.action_id,row.worker_id,row.state,row.evidence_sha256??null,row.reason??null,row.finished_at??null]);
function captures(conversation,kind){
  const latest=new Map(),observed=new Set(),observedActions=new Set();
  for(const message of conversation.messages){
    if(message.role!=='assistant')continue;
    for(const event of message.recovery?.events??[]){
      if(event.tool===kind.tool&&uuid.test(event.action_id??'')&&typeof event.request?.worker_id==='string'){
        // A reading event retains the handle even if the HTTP acknowledgement was lost.
        latest.set(event.request.worker_id,{action_id:event.action_id,worker_id:event.request.worker_id,stopped:message.stop_requested_at!==undefined});
      }
      if(event.tool==='recovery_status'&&event.state==='complete'){
        for(const row of kind.rows(event.result))if(terminal(row,kind)){observed.add(receiptKey(row));observedActions.add(row.action_id);}
      }
    }
  }
  return {latest:[...latest.values()],observed,observedActions};
}

export class PairPreparationWatch {
  constructor({filename,chat,read,isEnabled,kind='capture'}){
    if(!Object.hasOwn(kinds,kind))throw Error('Unknown pair follow-up kind');this.kind=kinds[kind];
    Object.assign(this,{filename,chat,read,isEnabled});this.busy=false;this.closed=false;
    this.records=fs.existsSync(filename)?JSON.parse(fs.readFileSync(filename,'utf8')):{};
  }
  save(){
    fs.mkdirSync(path.dirname(this.filename),{recursive:true,mode:0o700});
    const temp=this.filename+'.'+randomUUID()+'.tmp',fd=fs.openSync(temp,'wx',0o600);
    try{fs.writeFileSync(fd,JSON.stringify(this.records,null,2)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    fs.renameSync(temp,this.filename);
    const parent=fs.openSync(path.dirname(this.filename),'r');try{fs.fsyncSync(parent);}finally{fs.closeSync(parent);}
  }
  status(){return {error:this.error??null,requests:Object.values(this.records).map(r=>({conversation_id:r.conversation_id,request_id:r.request_id,action_ids:r.action_ids,state:r.state}))};}
  async tick(){
    if(this.closed||this.busy||!this.isEnabled())return;
    const summary=this.chat.status();
    if(!summary.available||summary.conversations.some(c=>c.busy||c.queued))return;
    this.busy=true;
    try{
      const conversations=summary.conversations.filter(c=>!c.queue_paused).map(c=>this.chat.get(c.id)).filter(conversation=>{
        const {latest,observed,observedActions}=captures(conversation,this.kind);
        const records=Object.values(this.records).filter(r=>r.conversation_id===conversation.id);
        for(const r of records.filter(r=>!['pending','superseded'].includes(r.state))){
          const next=r.receipts.every(key=>observed.has(key))?'observed':'needs_attention';
          if(r.state!==next){r.state=next;this.save();}
        }
        const covered=new Set(records.flatMap(r=>r.action_ids));
        return records.some(r=>r.state==='pending')||latest.some(c=>!c.stopped&&!covered.has(c.action_id)&&!observedActions.has(c.action_id));
      });
      if(!conversations.length)return;
      const rows=await this.read();this.error=null;
      if(this.closed||!this.isEnabled()||!this.chat.status().available)return;
      for(const original of conversations){
        // Owner stop/pause or new work may have arrived while native status was read.
        const currentSummary=this.chat.status();
        if(currentSummary.conversations.some(c=>c.busy||c.queued))return;
        const conversation=this.chat.get(original.id);
        if(conversation.queue_paused)continue;
        const {latest,observed}=captures(conversation,this.kind);
        const matched=latest.filter(c=>!c.stopped).map(c=>rows.find(r=>r.action_id===c.action_id&&r.worker_id===c.worker_id));
        // Missing, lease-held and uncertain results cannot be treated as completion.
        if(!matched.length||matched.some(r=>!terminal(r,this.kind)))continue;
        const unseen=matched.filter(r=>!observed.has(receiptKey(r)));
        // A persisted pending submit takes priority; never generate a new request ID
        // after an uncertain acknowledgement, even if subsequent observations changed.
        let record=Object.values(this.records).find(r=>r.conversation_id===conversation.id&&r.state==='pending');
        if(record&&record.action_ids.some(id=>!latest.some(c=>c.action_id===id&&!c.stopped))){
          record.state='superseded';this.save();record=null;
        }
        if(!record){
          const covered=new Set(Object.values(this.records).filter(r=>r.conversation_id===conversation.id).flatMap(r=>r.action_ids));
          const needed=unseen.filter(r=>!covered.has(r.action_id));
          if(!needed.length)continue;
          const action_ids=needed.map(r=>r.action_id).sort();
          const request_id=this.kind.prefix+createHash('sha256').update(JSON.stringify([conversation.id,action_ids])).digest('hex');
          record={conversation_id:conversation.id,request_id,action_ids,receipts:needed.map(receiptKey),state:'pending',
            text:`The native pair ${this.kind.label} watcher has terminal receipts for these previously requested action IDs: ${action_ids.join(', ')}. Read recovery_status once and report their actual states, worker IDs and evidence hashes in at most 100 words. This is an automatic completion follow-up to the existing ${this.kind.label} requests. ${this.kind===kinds.qualification?'Do not repeat the completed or uncertain qualification.':'Do not start or retry a capture, enroll recovery, run a canary, restart a service or change configuration.'} ${this.kind.limit} If evidence is unavailable or disagrees, report that uncertainty and finish.`};
          this.records[request_id]=record;this.save();
        }
        this.save(); // Retry a failed durable write before crossing the submission boundary.
        this.chat.submit(record.conversation_id,record.text,record.request_id,{research:false});
        record.state='dispatched';this.save();break;
      }
    }catch(error){this.error=error.message;}
    finally{this.busy=false;}
  }
  close(){this.closed=true;}
}
