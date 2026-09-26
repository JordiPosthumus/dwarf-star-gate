// The existing ten-second dashboard tick wakes Genie only for new actionable
// media demand. Native execution remains independent of this conversation.
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {priorityRank} from './job-priority.mjs';
export class MediaWatch {
  constructor({filename,chat,read,isEnabled=()=>false,now=Date.now}){
    Object.assign(this,{filename,chat,read,isEnabled,now});this.busy=false;this.closed=false;
    this.state=fs.existsSync(filename)?JSON.parse(fs.readFileSync(filename,'utf8')):{};
  }
  save(){fs.mkdirSync(path.dirname(this.filename),{recursive:true,mode:0o700});const temp=this.filename+'.tmp';fs.writeFileSync(temp,JSON.stringify(this.state)+'\n',{mode:0o600});fs.renameSync(temp,this.filename);}
  async tick(){
    if(this.busy||this.closed||!this.isEnabled())return;
    const chat=this.chat.status();if(!chat.available||chat.conversations.some(c=>c.busy||c.queued))return;
    this.busy=true;
    try{
      const s=await this.read();if(this.closed||!this.isEnabled()||!s.enabled)return;
      const candidates=(s.jobs??[]).filter(j=>j.state==='queued'&&!j.execution&&!j.dispatch_hold).sort((a,b)=>priorityRank(b)-priorityRank(a));
      if(this.state.pending&&!candidates.some(j=>j.id===this.state.pending.job_id)){
        // Preserve an old/uncertain chat intent, but do not reissue a prompt
        // whose job is now held, assigned, gone or lacks a bound job identity.
        this.state.deferred_pending=this.state.pending;delete this.state.pending;this.save();
      }
      const available=(w,kind)=>Array.isArray(s.hosts)?s.hosts.some(h=>h.id===w.id&&h.engines?.some(e=>e.kind===kind&&e.ready===true)):s.fleet.some(f=>f.id===w.id&&f.is_healthy&&!f.drained);
      const job=candidates.find(j=>s.workers.some(w=>!w.busy&&w.budget?.allowed!==false&&w.kinds.includes(j.kind)&&available(w,j.kind)&&s.fleet.some(f=>f.id!==w.id&&f.is_healthy&&!f.drained)));
      if(!job)return;
      const key=createHash('sha256').update(JSON.stringify({job:job.id,workers:s.workers,fleet:s.fleet})).digest('hex');
      if(!this.state.pending&&(key===this.state.key||this.now()-(this.state.last_at??0)<60000))return;
      if(!this.state.conversation_id){this.state.conversation_id=this.chat.create({title:'Automatic media dispatch'}).id;this.save();}
      if(!this.state.pending){
        this.state.pending={request_id:randomUUID(),job_id:job.id,text:`Automatic media dispatch: job ${job.id} is waiting. Read media_job_status for current queue, engine enrollment and LLM demand. Decide whether to serve this job now using start_media_job on a suitable enrolled host. If batch_jobs_supported and compatible jobs are already queued, consider following_job_ids to avoid repeatedly reloading the LLM between jobs; choose a small batch of the same engine and priority, not future arrivals. Jobs with dispatch_hold must stay queued and must not enter a batch. When a selected worker advertises this kind in parallel_kinds and two or more compatible jobs are queued, use parallel_members=true to run both enrolled members under one shared pair reservation, subject to current LLM demand and the physical budget. Preserve at least one other serving LLM and enough capacity for current text demand. The enabled media switch supplies standing permission; no separate approval is required. Never cancel active work or change settings. After one action or a concrete no-action decision, report at most 80 words and finish. Accepted execution continues independently.`,key};this.save();
      }
      const pending=this.state.pending;
      this.chat.submit(this.state.conversation_id,pending.text,pending.request_id,{research:false});
      this.state={conversation_id:this.state.conversation_id,key:pending.key,last_at:this.now(),...(this.state.deferred_pending?{deferred_pending:this.state.deferred_pending}:{})};this.save();
    }catch(e){this.state.error=e.message;this.save();}
    finally{this.busy=false;}
  }
  close(){this.closed=true;}
}
