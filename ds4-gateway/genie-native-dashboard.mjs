// Dashboard projection and input adapter. Native Hermes remains the sole
// transcript, scheduler and owner of pending questions. No production backend
// selects this facade until full profile, watcher and channel migration is verified.
import {createHash,randomUUID} from 'node:crypto';
import {nativeRequestId} from './genie-native-chat.mjs';
import fs from 'node:fs';
import {STUDY_INSTRUCTIONS} from './genie-study.mjs';
import {NativeGenieStudy} from './genie-native-study.mjs';

const digest=value=>createHash('sha256').update(value).digest('hex');
export const nativeReplyId=(id,turn)=>`native-turn-${digest(JSON.stringify([id,turn]))}`;
const holdId=(id,turn)=>nativeRequestId(id,`stop-${digest(turn)}`);
const unavailable=()=>Object.assign(Error('Current native chat evidence is unavailable.'),{code:'NATIVE_UNAVAILABLE'});

export function nativeDashboardView(conversation,previous,now=Date.now()){
  const view=structuredClone(conversation),hold=view.native_hold;
  if(view.history_complete!==true||typeof view.busy!=='boolean'||!Number.isInteger(view.queued)||view.queued<0)throw unavailable();
  // Missing final native messages remain unverified. In particular, do not
  // attach a new execution's Stop control to an old unfinished transcript row.
  for(const message of view.messages)if(message.state==='working'){
    message.state='unverified';
    message.error='The native transcript has not recorded a final response for this turn.';
  }
  view.queue_paused=null;view.queue_resume_supported=false;
  if(hold){
    if(typeof hold.turn_id!=='string'||typeof hold.hold_id!=='string'||!Number.isInteger(hold.queued)||hold.queued<0||!['preparing','stopping','held','resuming','uncertain'].includes(hold.state))throw unavailable();
    view.queue_paused=nativeReplyId(view.id,hold.turn_id);
    view.queue_resume_supported=hold.state==='held'&&!view.busy;
    view.queued=Math.max(view.queued,hold.queued);
    view.queue_pause_message=hold.state==='held'
      ?'This reply was stopped. Saved questions will resume in their original order when you continue. Previously accepted fleet operations may still be running.'
      :'The native queue control has not been confirmed. Saved questions remain held; review the native receipt before continuing.';
  }
  if(view.busy){
    const exact=typeof view.native_turn_id==='string'&&view.native_turn_id.length>0;
    const id=exact?nativeReplyId(view.id,view.native_turn_id):`native-execution-${digest(view.native_session_key)}`;
    const prior=previous?.messages.find(m=>m.id===id&&m.native_execution===true);
    view.messages.push({id,role:'assistant',state:exact&&!hold?'working':'unverified',text:'',at:prior?.at??now,
      native_execution:true,native_turn_id:exact?view.native_turn_id:null,
      native_observation:{observed_at:view.observed_at,stoppable:exact&&!hold},
      ...(!exact?{error:'Hermes reports an active session, but its exact turn identity is not yet available.'}:{})});
  }
  return view;
}

export class NativeDashboardChat{
  constructor({client,now=Date.now,isSuspended=()=>false,maxAgeMs=15000,info=()=>({}),directory}){
    this.client=client;this.now=now;this.isSuspended=isSuspended;this.maxAgeMs=maxAgeMs;
    this.info=info;
    this.sessions=new Map();this.observed=new Map();this.failures=new Set();this.closed=false;
    this.refreshing=null;this.catalogueObserved=false;
    this.directory=directory;this.provider={get info(){return info();}};
    if(directory){fs.mkdirSync(directory,{recursive:true,mode:0o700});this.study=new NativeGenieStudy(this,{now});}
  }
  async refresh(id){
    // Serial observations prevent a slower earlier read replacing fresher state.
    const prior=this.refreshing;
    const operation=(async()=>{
      if(prior)await prior.catch(()=>{});
      if(this.closed)throw unavailable();
      try{
        if(id===undefined)await this.client.discover();
        const ids=id===undefined?[...this.client.bindings.keys()]:[id];
        const observations=this.client.observe?await this.client.observe(ids):null;
        let cursor=0,failed=false;
        const reader=async()=>{while(cursor<ids.length){
          const key=ids[cursor++];
          try{
            const conversation=await this.client.read(key,{all:true,...(observations?{observation:observations.get(key)}:{})});
            if(this.closed)throw unavailable();
            this.sessions.set(key,nativeDashboardView(conversation,this.sessions.get(key),this.now()));
            // Cache reuse must not renew an old execution timestamp. Native
            // observations use the same host clock; unknown/stale stays unknown.
            const stamp=Date.parse(conversation.observed_at);
            if(!Number.isFinite(stamp))throw unavailable();
            this.observed.set(key,stamp);this.failures.delete(key);
          }catch{this.failures.add(key);failed=true;}
        }};
        await Promise.all(Array.from({length:Math.min(4,ids.length)},reader));
        if(failed)throw unavailable();
      }catch{if(id===undefined)this.failures.add('*');throw unavailable();}
      if(id===undefined){this.failures.delete('*');this.catalogueObserved=true;}
    })();
    this.refreshing=operation;
    try{await operation;}finally{if(this.refreshing===operation)this.refreshing=null;}
  }
  fresh(id){return !this.closed&&!this.failures.has('*')&&!this.failures.has(id)&&this.observed.has(id)&&this.now()-this.observed.get(id)>=0&&this.now()-this.observed.get(id)<=this.maxAgeMs;}
  get(id){if(!this.fresh(id)||!this.sessions.has(id))throw unavailable();return structuredClone(this.sessions.get(id));}
  observationAvailable(){return !this.closed&&this.catalogueObserved&&!this.failures.has('*')&&[...this.client.bindings.keys()].every(id=>this.fresh(id));}
  status(){
    const fresh=this.observationAvailable();
    return {...this.info(),engine:'Hermes',mode:'native',available:!this.closed&&fresh&&!this.isSuspended(),suspended:this.isSuspended(),
      stop_reply_supported:true,native_observation_available:fresh,unreadable_conversations:[...this.failures],...(this.study?{study:this.study.status()}:{}),
      conversations:[...this.sessions.values()].sort((a,b)=>b.updated_at-a.updated_at).map(c=>({id:c.id,title:c.title,updated_at:c.updated_at,
        busy:this.fresh(c.id)?c.busy:null,queued:this.fresh(c.id)?c.queued:null,queue_paused:c.queue_paused,observation_available:this.fresh(c.id)}))};
  }
  async create({id=randomUUID(),title='New conversation',purpose=null}={}){
    if(this.closed||this.isSuspended())throw Error('New Genie conversations are paused.');
    const conversation=await this.client.create({id,title,purpose});
    this.sessions.set(id,nativeDashboardView(conversation,null,this.now()));
    this.observed.set(id,this.now());this.failures.delete(id);
    return this.get(id);
  }
  async submit(id,text,requestId,{research}={}){
    if(this.closed||this.isSuspended())throw Error('New Genie questions are paused. Your draft has not been sent.');
    if(typeof text!=='string'||!text.trim()||text.length>32000)throw Error('Enter a message of up to 32,000 characters.');
    if(research!==undefined&&typeof research!=='boolean')throw Error('Research option must be boolean.');
    const identity=nativeRequestId(id,requestId),binding=this.client.binding(id);
    if(binding.purpose==='setup_research'&&!this.study)throw Error('Native setup-study submission is not connected yet.');
    let receipt=await this.client.receipt(id,requestId);
    if(receipt?.request_id!==identity)throw Error('Native dispatch identity could not be verified. Do not replay the question.');
    const absent=receipt.state==='unknown'&&Object.keys(receipt).sort().join(',')==='request_id,state';
    if(absent){
      const available=this.info().research_available===true;
      research??=available;
      if(research&&!available)throw Error('Web research is not configured or enabled for this installation.');
      let studyContext;
      if(binding.purpose==='setup_research'){
        await this.refresh();
        if(!this.observationAvailable())throw unavailable();
        studyContext={study_brief:STUDY_INSTRUCTIONS,previous_study:this.study.previousStudy(id)};
      }
      // Native Hermes persists this exact intent before admitting it. Never
      // retry this POST automatically when its acknowledgment is lost.
      receipt=await this.client.submit(id,text.trim(),requestId,{research,...(studyContext?{studyContext}:{})});
    }
    if(receipt?.request_id!==identity||receipt.source_request_id!==requestId||receipt.session_key!==binding.session_key||receipt.message!==text.trim()||
      (research!==undefined&&receipt.research!==research))throw Error('That request identity belongs to different input. No new question was sent.');
    if(receipt.state!=='accepted_unverified')throw Error('Native dispatch remains unconfirmed. Retain this request identity; do not replay it.');
    await this.refresh(id);
    const view=this.get(id);
    // An acceptance receipt is separate from native execution/history. In
    // particular, a queued question need not have a native transcript row yet.
    return {...view,native_submission:{request_id:requestId,native_request_id:identity,state:receipt.state,
      observed_in_history:view.messages.some(m=>m.role==='user'&&m.request_id===requestId)}};
  }
  async tick(){await this.study?.tick();}
  async stop(id,replyId){
    await this.refresh(id);const conversation=this.get(id);
    if(conversation.queue_paused===replyId&&conversation.native_hold?.state==='held')return conversation;
    const current=conversation.messages.find(m=>m.id===replyId&&m.native_execution===true&&m.native_observation?.stoppable);
    if(!current)throw Error('That native turn is no longer the current stoppable reply. Refresh before trying again.');
    // Deterministic per-turn identity also reconciles a lost response after the
    // dashboard restarts; it never targets a later turn.
    try{await this.client.stop(id,current.native_turn_id,holdId(id,current.native_turn_id));}
    finally{await this.refresh(id);}
    return this.get(id);
  }
  async resume(id,expectedReplyId){
    if(this.closed||this.isSuspended())throw Error('Chat is not ready to continue queued questions.');
    await this.refresh(id);const conversation=this.get(id);
    if(conversation.queue_paused!==expectedReplyId||!conversation.queue_resume_supported)throw Error('The held queue changed or continuation is unconfirmed. Review its latest state.');
    try{await this.client.resume(id,conversation.native_hold.hold_id);}
    finally{await this.refresh(id);}
    return this.get(id);
  }
  close(){this.closed=true;}
}
