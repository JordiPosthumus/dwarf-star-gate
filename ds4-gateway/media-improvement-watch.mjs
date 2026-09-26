// Follow the configured ACE improvement through actual Genie tool calls. The
// watcher has no native server authority and never replaces an uncertain job.
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const stages={prepare:'prepare_media_improvement',finish_preparation:'prepare_media_improvement',qualify:'qualify_media_improvement',finish_qualification:'qualify_media_improvement',promote:'promote_media_improvement'};
const mutations=new Set(Object.values(stages));
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const targetKey=offer=>JSON.stringify([offer.worker_id,offer.member??null]);
const replyFor=(conversation,id)=>{const at=conversation.messages.findIndex(m=>m.role==='user'&&m.request_id===id);return at<0?null:conversation.messages[at+1];};
const stopped=conversation=>!!conversation.queue_paused||conversation.messages.some(m=>m.role==='assistant'&&m.stop_requested_at!==undefined);

export class MediaImprovementWatch {
 constructor({filename,config,chat,read,isEnabled=()=>false}){
  Object.assign(this,{filename,config,chat,read,isEnabled});this.busy=false;this.closed=false;
  this.state=fs.existsSync(filename)?JSON.parse(fs.readFileSync(filename,'utf8')):{version:1,targets:{},records:{}};
  if(this.state?.version!==1||!this.state.targets||!this.state.records||Array.isArray(this.state.targets)||Array.isArray(this.state.records))throw Error('Invalid media improvement watch journal');
  for(const [key,row] of Object.entries(this.state.records))if(!/^[a-f0-9]{64}$/.test(key)||!uuid(row.conversation_id)||!stages[row.stage]||!['pending','dispatched','waiting','issued','needs_attention'].includes(row.state)||!Number.isSafeInteger(row.attempt)||row.attempt<1||!/^media-ace-[a-f0-9]{64}$/.test(row.request_id)||typeof row.text!=='string')throw Error('Invalid media improvement watch record');
 }
 enabled(){return !this.closed&&this.isEnabled()&&this.config.media_jobs?.improvements?.enabled===true&&this.config.media_jobs?.standard?.enabled===true;}
 configured(offer){return this.config.media_jobs?.standard?.targets?.some(t=>t.engine==='ace-step'&&t.worker_id===offer.worker_id&&(t.member??this.config.media_jobs?.workers?.[t.worker_id]?.engines?.music?.member??(offer.member===undefined?undefined:0))===offer.member);}
 save(){
  fs.mkdirSync(path.dirname(this.filename),{recursive:true,mode:0o700});
  const temp=this.filename+'.'+randomUUID()+'.tmp',fd=fs.openSync(temp,'wx',0o600);
  try{fs.writeFileSync(fd,JSON.stringify(this.state)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  fs.renameSync(temp,this.filename);const parent=fs.openSync(path.dirname(this.filename),'r');try{fs.fsyncSync(parent);}finally{fs.closeSync(parent);}
 }
 status(){return {enabled:this.enabled(),targets:Object.values(this.state.targets),error:this.error??null,scope:'Configured ACE improvement stages continued through Genie. Core/native receipts establish progress; missing or uncertain work is never replaced. This watcher does not mutate servers.'};}
 matches(event,offer){
  if(!mutations.has(event.tool))return false;
  if(event.request?.operation_id)return !!offer.operation_id&&event.request.operation_id===offer.operation_id;
  if(event.request?.worker_id!==offer.worker_id)return false;
  const member=event.result?.member??event.request.member??this.config.media_jobs?.workers?.[offer.worker_id]?.engines?.music?.member??(offer.member===undefined?undefined:0);
  return member===offer.member&&(!event.result?.operation_id||!offer.operation_id||event.result.operation_id===offer.operation_id);
 }
 conversation(offer,target){
  if(target.conversation_id)return this.chat.get(target.conversation_id);
  for(const summary of this.chat.status().conversations){
   const conversation=this.chat.get(summary.id);
   if(conversation.messages.some(m=>(m.media?.events??[]).some(e=>this.matches(e,offer))))return conversation;
  }
  return null;
 }
 async tick(){
  if(this.busy||!this.enabled())return;
  const status=this.chat.status();if(!status.available||status.conversations.some(c=>c.busy||c.queued))return;
  this.busy=true;
  try{
   const s=await this.read(),current=this.chat.status();
   if(!this.enabled()||!s.enabled||!s.improvements?.enabled||!current.available||current.conversations.some(c=>c.busy||c.queued))return;
   if(!Array.isArray(s.improvements.offers)||!Array.isArray(s.improvements.operations))throw Error('Current improvement offers unavailable');
   this.error=null;
   for(const offer of s.improvements.offers){
    if(!this.configured(offer)||offer.key!==targetKey(offer))continue;
    const target=this.state.targets[offer.key]??={worker_id:offer.worker_id,...(offer.member!==undefined?{member:offer.member}:{})};
    Object.assign(target,{phase:offer.phase==='promoted'?'promoted':offer.phase==='requires_reconciliation'?'needs_attention':'waiting',reason:offer.reason??null,operation_id:offer.operation_id??null,stage:offer.stage??null});
    let conversation=this.conversation(offer,target);
    if(conversation){target.conversation_id=conversation.id;if(stopped(conversation)){target.phase='paused';target.reason='owner_stopped_or_paused_conversation';continue;}}
    if(!stages[offer.stage])continue;
    if(offer.stage!=='prepare'&&!uuid(offer.operation_id))throw Error('Saved improvement operation required');
    // The stage identity excludes transient permission and capacity. They may
    // become eligible later without creating a second native action.
    const key=hash([offer.key,offer.operation_id??null,offer.stage]);let record=this.state.records[key];
    if(record){
     if(!conversation||record.conversation_id!==conversation.id){target.phase='needs_attention';target.reason='saved_conversation_unavailable';continue;}
     const reply=replyFor(conversation,record.request_id);
     if(reply?.stop_requested_at!==undefined){target.phase='paused';continue;}
     if(reply&&['queued','working'].includes(reply.state)){target.phase='observing';continue;}
     if(reply&&!['waiting','issued','needs_attention'].includes(record.state)){
      const events=reply.media?.events??[];
      if(events.some(e=>this.matches(e,offer))){record.state='issued';}
      else{
       const proof=events.filter(e=>e.tool==='media_job_status'&&e.state==='complete').at(-1)?.result;
       const declined=proof?.improvements?.offers?.find(o=>o.key===offer.key&&o.stage===offer.stage&&(o.operation_id??null)===(offer.operation_id??null));
       if(reply.state==='complete'&&declined?.eligible===false&&typeof declined.reason==='string'){record.state='waiting';record.reason=declined.reason;}
       else{record.state='needs_attention';record.reason='genie_reply_without_verified_progress';}
      }
     }
     if(record.state==='issued'){target.phase='observing';target.reason='stage_action_already_requested';continue;}
     if(record.state==='needs_attention'){target.phase='needs_attention';target.reason=record.reason;continue;}
     if(record.state==='dispatched'&&!reply){target.phase='observing';target.reason='saved_reply_unavailable';continue;}
    }else if(conversation){
     // A native tool attempt outside this watcher also owns its uncertainty.
     const attempted=conversation.messages.flatMap(m=>m.media?.events??[]).filter(e=>this.matches(e,offer)&&e.tool===stages[offer.stage]);
     if(attempted.length&&!offer.stage.startsWith('finish_')){target.phase='needs_attention';target.reason='prior_stage_attempt_without_native_progress';continue;}
    }
    if(!offer.eligible||!/^[a-f0-9]{64}$/.test(offer.evidence_id??''))continue;
    if(!conversation){conversation=this.chat.create({title:'Standard ACE improvements'});target.conversation_id=conversation.id;this.save();conversation=this.chat.get(conversation.id);}
    if(!record||record.state==='waiting'){
     const attempt=(record?.attempt??0)+1,args=offer.stage==='prepare'||offer.stage==='finish_preparation'?{worker_id:offer.worker_id,...(offer.member!==undefined?{member:offer.member}:{})}:{operation_id:offer.operation_id};
     record={conversation_id:conversation.id,stage:offer.stage,attempt,request_id:'media-ace-'+hash([key,attempt]),state:'pending',
      text:`Continue the owner's configured ACE improvement for target ${JSON.stringify({worker_id:offer.worker_id,member:offer.member})}. Read media_job_status first. The observed stage is ${offer.stage}, operation ${offer.operation_id??'not yet prepared'}. Only if the CURRENT improvements.offers entry has the same target, operation and stage and is still eligible, call ${stages[offer.stage]} once with ${JSON.stringify(args)}. ${offer.stage.startsWith('finish_')?'This observes and verifies the same saved completion; it must not launch another native operation.':'The native controller rechecks permission, exact identities and ownership. Preparation retains the stopped original; qualification uses the fixed recipe and returns the original GLM with real cache proof; promotion changes only the qualified ACE binding with rollback retained.'} If ineligible, retain the exact status-tool reason and finish; the watcher can continue when eligibility changes. Observe missing, pending, failed or uncertain work by its existing identity; never rebuild, resubmit generation or create a replacement. Preserve active requests, settings, files, owner pauses and a separate serving LLM. Do not change capability switches, dispatch unrelated jobs or use shell commands. Read media_job_status after the tool and report actual receipts briefly. A chat reply or accepted job is not native completion.`};
     this.state.records[key]=record;
    }
    target.phase='requesting';this.save();
    const final=this.chat.status();
    if(!this.enabled()||!this.configured(offer)||!final.available||final.conversations.some(c=>c.busy||c.queued)||stopped(this.chat.get(record.conversation_id)))return;
    this.chat.submit(record.conversation_id,record.text,record.request_id,{research:false});record.state='dispatched';target.phase='waiting_for_genie';this.save();return;
   }
   this.save();
  }catch{this.error='media_improvement_observation_or_submission_unavailable';}
  finally{this.busy=false;}
 }
 close(){this.closed=true;}
}
