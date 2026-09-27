// Preserve the existing schedule format while native creation/dispatch are async.
// This schedules ordinary questions; Hermes alone runs the agent and its queue.
import {randomUUID} from 'node:crypto';
import {GenieStudy,STUDY_PROMPT} from './genie-study.mjs';
const DAY=86400000;

export class NativeGenieStudy extends GenieStudy{
  constructor(chat,options){super(chat,options);this.changing=null;this.ticking=null;}
  status(){
    const value=super.status();
    value.available=value.available&&this.chat.observationAvailable();
    if(value.last_run?.state==='not_started')value.last_run.state='unverified';
    return value;
  }
  previousStudy(excludeId){
    const previous=super.previousStudy(excludeId);
    if(!previous)return null;
    const revisions=new Map(previous.configuration_snapshot_revisions.map(row=>[row.worker_id,row]));
    // Native evidence comes from actual record-read tool receipts, including
    // completed follow-up corrections, rather than an invented dashboard snapshot.
    const conversation=this.chat.sessions.get(previous.conversation_id);
    for(const reply of conversation?.messages??[])if(reply.role==='assistant'&&reply.state==='complete'){
      for(const event of reply.inspection?.events??[]){
        if(event.operation!=='read_server_configuration'||event.state!=='complete'||!event.result?.records)continue;
        const worker=event.worker_id??event.result.worker_id;if(typeof worker!=='string')continue;
        const records=event.result.records;
        revisions.set(worker,{worker_id:worker,approved:records.approved?.revision??null,observed:records.observed?.revision??null});
      }
    }
    return {...previous,configuration_snapshot_revisions:[...revisions.values()]};
  }
  async tick(){
    if(this.ticking)return this.ticking;
    const run=(async()=>{
      const plan=this.plan;
      if(plan.mode!=='automatic'||!plan.interval_days||plan.next_due_at>this.now()||this.dispatchError||this.chat.closed||this.chat.isSuspended())return;
      try{
        await this.chat.refresh();const status=this.status();
        if(!status.available||!status.due||status.mode!=='automatic'||['queued','working','unverified'].includes(status.last_run?.state))return;
        if([...this.chat.sessions.values()].some(c=>c.busy||c.queued||c.queue_paused))return;
        await this.change({action:'study-start',expected_revision:status.revision,request_id:randomUUID()});
      }catch{this.dispatchError='Scheduled research could not be confirmed. Inspect its saved request before starting another study.';}
    })();this.ticking=run;
    try{await run;}finally{if(this.ticking===run)this.ticking=null;}
  }
  change(input){
    const before=this.changing;
    const run=(async()=>{if(before)await before.catch(()=>{});return this.changeNow(input);})();this.changing=run;
    return run.finally(()=>{if(this.changing===run)this.changing=null;});
  }
  async changeNow(input){
    if(input?.action!=='study-start')return super.change(input);
    if(this.error)throw Error(this.error);
    if(Object.keys(input).sort().join(',')!=='action,expected_revision,request_id'||!/^[a-f0-9-]{36}$/.test(input.request_id??''))throw Error('Invalid study start request.');
    if(input.request_id===this.plan.last_run?.request_id)return this.status();
    if(input.expected_revision!==this.plan.revision)throw Error('Research controls changed. Refresh before trying again.');
    await this.chat.refresh();const status=this.status();
    if(!status.available)throw Error('Connect Genie and web research before starting a study.');
    if(['queued','working','unverified'].includes(status.last_run?.state))throw Error('The previous study is running or unverified. Inspect its existing request.');
    const now=this.now(),id=randomUUID(),p={...this.plan,revision:this.plan.revision+1,
      last_run:{conversation_id:id,request_id:input.request_id,at:now},
      next_due_at:this.plan.interval_days?now+this.plan.interval_days*DAY:null};
    // Record the exact conversation and request BEFORE either native mutation.
    // A process exit or lost response must never invent another study identity.
    this.save(p);
    try{
      await this.chat.create({id,title:`Setup research · ${new Date(now).toISOString().slice(0,10)}`,purpose:'setup_research'});
      await this.chat.submit(id,STUDY_PROMPT,input.request_id,{research:true});
      this.dispatchError=null;
    }catch(error){this.dispatchError='Native study creation or dispatch is unconfirmed. Retain its saved identities; do not replay it.';throw error;}
    return this.status();
  }
}
