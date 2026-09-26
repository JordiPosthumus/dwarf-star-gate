// Continue an existing Genie enrollment when its next opted-in stage becomes
// eligible. Only Genie calls native tools; this observer never mutates a server.
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const digest=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const toolFor=stage=>stage==='enroll_demand'?'enroll_omlx_recovery':'qualify_omlx_recovery';
const offered=(s,id,stage)=>stage==='enroll_demand'?s.omlx_enrollment?.demand_start_offers?.find(o=>o.worker_id===id):s.workers?.find(w=>w.worker_id===id)?.omlx_qualification;
function replyFor(conversation,requestId){
  const index=conversation.messages.findIndex(m=>m.role==='user'&&m.request_id===requestId);
  return index<0?null:conversation.messages[index+1];
}
function enrollmentSources(chat,targets){
  const found=new Map();
  // GenieChat lists conversations newest first. Prefer the latest actual tool
  // handle for each worker, including reading handles with an uncertain reply.
  for(const summary of chat.status().conversations){
    const conversation=chat.get(summary.id);
    for(let i=conversation.messages.length-1;i>=0;i--){
      const message=conversation.messages[i];
      if(message.role!=='assistant')continue;
      const events=message.recovery?.events??[];
      for(let eventIndex=events.length-1;eventIndex>=0;eventIndex--){
        const event=events[eventIndex];
        const id=event.request?.worker_id;
        if(event.tool!=='enroll_omlx_recovery'||!uuid(event.action_id)||!targets.has(id)||found.has(id))continue;
        found.set(id,{worker_id:id,action_id:event.action_id,conversation_id:conversation.id,message_index:i,event_index:eventIndex,
          stopped:!!conversation.queue_paused||conversation.messages.slice(i).some(m=>m.role==='assistant'&&m.stop_requested_at!==undefined)});
      }
    }
  }
  return found;
}
export class OmlxSetupWatch {
  constructor({filename,config,chat,read,isEnabled=()=>false}){
    Object.assign(this,{filename,config,chat,read,isEnabled});this.busy=false;this.closed=false;
    this.state=fs.existsSync(filename)?JSON.parse(fs.readFileSync(filename,'utf8')):{version:1,records:{},targets:{}};
    if(this.state?.version!==1||!this.state.records||!this.state.targets||Array.isArray(this.state.records)||Array.isArray(this.state.targets))throw Error('Invalid oMLX setup watch journal');
    for(const [key,row] of Object.entries(this.state.records))if(!digest(key)||!uuid(row.conversation_id)||!uuid(row.source_action_id)||
      typeof row.worker_id!=='string'||!['enroll_demand','qualify'].includes(row.stage)||!['pending','dispatched','waiting','issued','needs_attention','superseded'].includes(row.state)||
      !Number.isSafeInteger(row.attempt)||row.attempt<1||typeof row.request_id!=='string'||!/^omlx-setup-[a-f0-9]{64}$/.test(row.request_id)||typeof row.text!=='string')throw Error('Invalid oMLX setup watch journal');
  }
  targets(){return new Set(Object.entries(this.config.omlx_recovery_setup?.workers??{}).filter(([,p])=>p?.exclusive===true&&p.start_on_demand===true&&p.qualify_restart===true).map(([id])=>id));}
  save(){
    fs.mkdirSync(path.dirname(this.filename),{recursive:true,mode:0o700});
    const temporary=this.filename+'.'+randomUUID()+'.tmp',fd=fs.openSync(temporary,'wx',0o600);
    try{fs.writeFileSync(fd,JSON.stringify(this.state)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    fs.renameSync(temporary,this.filename);const parent=fs.openSync(path.dirname(this.filename),'r');try{fs.fsyncSync(parent);}finally{fs.closeSync(parent);}
  }
  status(){return {enabled:this.isEnabled()&&this.targets().size>0,targets:Object.values(this.state.targets),error:this.error??null,
    scope:'Eligibility-driven continuation of existing Genie enrollment requests. An offer or accepted tool call is not native qualification; owner stops and uncertain actions are retained.'};}
  async tick(){
    if(this.closed||this.busy||!this.isEnabled()||!this.targets().size)return;
    const status=this.chat.status();if(!status.available||status.conversations.some(c=>c.busy||c.queued))return;
    this.busy=true;
    try{
      const s=await this.read();
      if(!Array.isArray(s?.workers)||!Array.isArray(s?.operations)||!Array.isArray(s?.omlx_enrollment?.operations))throw Error('Current recovery status unavailable');
      const fresh=this.chat.status();if(this.closed||!this.isEnabled()||!s.automatic||!fresh.available||fresh.conversations.some(c=>c.busy||c.queued))return;
      this.error=null;
      for(const source of enrollmentSources(this.chat,this.targets()).values()){
        const id=source.worker_id,conversation=this.chat.get(source.conversation_id),worker=s.workers.find(w=>w.worker_id===id);
        const target={worker_id:id,conversation_id:source.conversation_id,source_action_id:source.action_id,phase:'waiting',reason:null};
        this.state.targets[id]=target;
        if(source.stopped){target.phase='paused';target.reason='owner_stopped_or_paused_conversation';continue;}
        const enrollment=s.omlx_enrollment.operations.find(o=>o.action_id===source.action_id&&o.worker_id===id);
        if(!enrollment){target.phase='observing';target.reason='enrollment_receipt_unavailable';continue;}
        if(enrollment.state!=='enrolled'){target.phase=enrollment.state==='failed'?'needs_attention':'observing';target.reason=enrollment.state;continue;}
        if(worker?.enrollment?.binding!=='matched'){target.phase='needs_attention';target.reason='enrollment_binding_unverified';continue;}
        const startEnrolled=worker.enrollment.permissions?.start_stopped_enrolled===true;
        if(startEnrolled&&worker.omlx_qualification?.certified===true){target.phase='qualified';continue;}
        const stage=startEnrolled?'qualify':'enroll_demand',offer=offered(s,id,stage);
        target.stage=stage;
        const laterActions=conversation.messages.slice(source.message_index).flatMap((m,index)=>(m.recovery?.events??[]).slice(index===0?source.event_index+1:0))
          .filter(e=>['qualify_omlx_recovery','recover_server'].includes(e.tool)&&e.request?.worker_id===id&&uuid(e.action_id))
          // A previously completed restart belongs to the old restart-only
          // binding. It does not prevent the separately opted-in enrollment
          // upgrade. Only an authoritative successful receipt clears this gate;
          // a tool acknowledgement or narrative is not completion evidence.
          .filter(e=>stage!=='enroll_demand'||!s.operations.some(o=>o.id===e.action_id&&o.worker_id===id&&o.state==='recovered'));
        if(laterActions.length){target.phase='observing';target.reason='native_action_already_requested';continue;}
        const key=hash([source.conversation_id,id,source.action_id,stage]);let record=this.state.records[key];
        if(record){
          const reply=replyFor(conversation,record.request_id);
          if(reply?.stop_requested_at!==undefined){target.phase='paused';target.reason='owner_stopped_reply';continue;}
          if(reply&&['queued','working'].includes(reply.state)){target.phase='observing';target.reason='genie_reply_active';continue;}
          if(reply&&!['waiting','issued','needs_attention'].includes(record.state)){
            const events=reply.recovery?.events??[];
            const mutations=events.filter(e=>['enroll_omlx_recovery','qualify_omlx_recovery','recover_server'].includes(e.tool)&&e.request?.worker_id===id&&uuid(e.action_id));
            if(mutations.length){record.state='issued';record.action_ids=[...new Set(mutations.map(e=>e.action_id))];}
            else {
              const observed=events.filter(e=>e.tool==='recovery_status'&&e.state==='complete').at(-1)?.result;
              const declined=offered(observed??{},id,stage);
              // Only a real status-tool receipt proving ineligibility can turn a
              // completed no-action reply into another future eligibility wait.
              if(reply.state==='complete'&&declined?.eligible===false&&typeof declined.reason==='string'){
                record.state='waiting';record.reason=declined.reason;
              }else {record.state='needs_attention';record.reason='genie_reply_without_verified_progress';}
            }
          }
          if(record.state==='issued'){target.phase='observing';target.reason='native_action_already_requested';continue;}
          if(record.state==='needs_attention'){target.phase='needs_attention';target.reason=record.reason;continue;}
          if(record.state==='dispatched'&&!reply){target.phase='observing';target.reason='saved_genie_reply_unavailable';continue;}
        }
        if(!offer?.eligible||(stage==='qualify'&&!digest(offer.evidence_id))){target.reason=offer?.reason??'next_stage_offer_unavailable';continue;}
        if(!record||record.state==='waiting'){
          const attempt=(record?.attempt??0)+1,request_id='omlx-setup-'+hash([key,attempt]);
          record={...source,source_action_id:source.action_id,stage,attempt,request_id,state:'pending',
            text:`Continue the owner's explicitly configured local oMLX on-demand setup for worker ${id}, following enrollment action ${source.action_id}. Read recovery_status first. The next observed stage is ${stage}. ${stage==='enroll_demand'?'Only if the current omlx_enrollment.demand_start_offers entry for this worker is still eligible, call enroll_omlx_recovery once with that worker ID. This creates a new backed-up stopped-start binding and does not launch or stop the model.':'Only if the current worker omlx_qualification offer is eligible and not already certified, call qualify_omlx_recovery once with this worker and its CURRENT evidence_id. The native controller requires an idle worker, a separate serving LLM, preserved settings and native correctness/cache proof.'} If ineligible, record its exact current status-tool reason and finish; the watcher will wake you when it becomes eligible. If an existing operation is pending, missing, failed or uncertain, observe its original action ID; never replay it or create a replacement. Preserve owner pauses and all settings, launchers, caches, model files and active requests. Do not alter capability switches or use shell commands. Check recovery_status once after an action and report the actual receipt briefly. Acceptance is not completion.`};
          delete record.stopped;delete record.action_id;this.state.records[key]=record;
        }
        // Save intent before crossing the chat submission boundary. An unknown
        // acknowledgement keeps the exact request and text for idempotent retry.
        target.phase='requesting';this.save();
        const current=this.chat.status();
        if(this.closed||!this.isEnabled()||!this.targets().has(id)||!current.available||current.conversations.some(c=>c.busy||c.queued))return;
        const latest=enrollmentSources(this.chat,this.targets()).get(id);
        if(!latest||latest.stopped||latest.action_id!==source.action_id||latest.conversation_id!==source.conversation_id)return;
        this.chat.submit(record.conversation_id,record.text,record.request_id,{research:false});record.state='dispatched';target.phase='waiting_for_genie';this.save();return;
      }
      this.save();
    }catch{this.error='omlx_setup_observation_or_submission_unavailable';}
    finally{this.busy=false;}
  }
  close(){this.closed=true;}
}
