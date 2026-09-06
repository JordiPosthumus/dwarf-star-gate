import {createHash,randomUUID} from 'node:crypto';
import {resumeReviewInput, resumeAdvice} from './proactive-resume-reviewer.mjs';

function fingerprint(value){return createHash('sha256').update(JSON.stringify(value)).digest('hex');}

function reviewText(message){
  if(typeof message.content==='string')return message.content;
  if(!Array.isArray(message.content))throw new Error('Unsupported review content');
  return message.content.map(part=>{
    if(part.type==='text'&&typeof part.text==='string')return part.text;
    if(part.type==='thinking')return '';
    if(part.type==='toolCall'&&typeof part.name==='string')return JSON.stringify({tool:part.name,arguments:part.arguments});
    throw new Error('Unsupported review content');
  }).filter(Boolean).join('\n');
}

/** Text snapshot of the full effective Pi context; never silently truncates it. */
export function piResumeReviewInput(messages,taskIndex,ticket){
  return resumeReviewInput({scope_id:ticket.scopeId,ticket_id:ticket.id,task_message_id:'m'+taskIndex,
    messages:messages.map((message,index)=>{
      const role=message.role==='toolResult'||message.role==='custom'?'tool':message.role;
      if(!['user','assistant','tool'].includes(role))throw new Error('Unsupported review message');
      let text=reviewText(message);
      if(message.role==='toolResult')text=JSON.stringify({tool:message.toolName,result:text,isError:message.isError===true});
      if(message.role==='custom')text=JSON.stringify({customType:message.customType,content:text});
      return {id:'m'+index,role,text};
    })});
}

/**
 * Experimental in-process bridge. The trusted host supplies an already enrolled
 * native capability and explicit review consent. No remote route, tool or
 * inference credential can construct that authority through this module.
 */
export class ProactiveResumePi {
  constructor({session,control,reviewer,taskMessage,scopeId,consent}={}){
    if(!session||!control||!reviewer||taskMessage?.role!=='user'||!session.messages.includes(taskMessage))throw new Error('Select an existing authorized user task');
    if(typeof scopeId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(scopeId))throw new Error('Invalid task scope');
    if(consent?.reviewText!==true||!Array.isArray(consent.providers)||!consent.providers.length||consent.providers.length>2||consent.providers.some(p=>typeof p.url!=='string'||typeof p.model!=='string'||!p.model.trim()))throw new Error('Explicit content and provider consent required');
    this.session=session;this.control=control;this.reviewer=reviewer;this.scopeId=scopeId;
    this.providers=consent.providers.map(({url,model})=>({url,model}));
    this.sessionId=session.sessionId;this.taskIndex=session.messages.indexOf(taskMessage);
    this.humanContext=fingerprint(session.messages.filter(message=>message.role==='user'));
    this.busy=false;this.closed=false;this.abort=null;this.unsubscribe=null;this.last=null;this.lastReviewed=null;this.receipt=null;
  }
  close(){
    if(this.closed)return;
    this.closed=true;this.control.revoke();this.abort?.abort();this.unsubscribe?.();this.unsubscribe=null;
    this.record({state:'closed',reason:'revoked'});
  }
  record(value){this.last=value;try{this.onStatus?.({...value});}catch{}return value;}
  start(){
    if(!this.closed&&!this.unsubscribe)this.unsubscribe=this.session.subscribe(event=>{
      if(event.type==='agent_settled')void this.runOnce().catch(()=>{this.record({state:'blocked',reason:'bridge_failed'});});
    });
    return this.runOnce();
  }
  taskIsCurrent(){
    return this.session.sessionId===this.sessionId&&fingerprint(this.session.messages.filter(message=>message.role==='user'))===this.humanContext;
  }
  async runOnce(){
    if(this.closed||this.busy)return {state:'blocked',reason:this.closed?'bridge_closed':'bridge_busy'};
    if(!this.taskIsCurrent()){this.close();return this.record({state:'blocked',reason:'task_input_changed'});}
    const inspected=this.control.inspect();
    if(!inspected.ticket)return this.record({state:'blocked',reason:inspected.blockedReason});
    const ticket=inspected.ticket;
    if(ticket.scopeId!==this.scopeId){this.close();return this.record({state:'blocked',reason:'scope_mismatch'});}
    const latest=fingerprint(this.session.messages.at(-1));
    if(latest===this.lastReviewed)return {state:'blocked',reason:'settlement_already_reviewed'};
    let input;
    try{input=piResumeReviewInput(this.session.messages,this.taskIndex,ticket);}
    catch{return this.record({state:'blocked',reason:'review_context_unsupported'});}
    this.busy=true;this.lastReviewed=latest;const abort=new AbortController();this.abort=abort;
    try{
      const result=await this.reviewer.review(input,{disclosedProviders:this.providers,signal:abort.signal});
      if(this.closed||abort.signal.aborted)return this.record({state:'blocked',reason:'review_revoked'});
      if(!this.taskIsCurrent()){this.close();return this.record({state:'blocked',reason:'task_input_changed'});}
      if(result.state!=='reviewed')return this.record({state:'blocked',reason:'review_unavailable'});
      if(result.scope_id!==ticket.scopeId||result.ticket_id!==ticket.id)throw new Error('Review binding mismatch');
      if(!this.providers.some(p=>p.url.replace(/\/$/,'')===result.provider?.url.replace(/\/$/,'')&&p.model===result.provider.model))throw new Error('Review provider mismatch');
      const advice=resumeAdvice(result.advice,input);
      if(advice.verdict!=='continue'){
        if(advice.verdict==='completed')this.close();
        return this.record({state:'reviewed',verdict:advice.verdict,reason:advice.reason});
      }
      // inspect is for visible preflight; native accept rechecks after durable I/O.
      const current=this.control.inspect();
      if(current.ticket?.id!==ticket.id)return this.record({state:'blocked',reason:current.blockedReason||'review_stale'});
      const proposalId=randomUUID();
      this.receipt={proposal_id:proposalId,receipt_status:'pending'};
      try{
        const acceptance=await this.control.accept(ticket.id,proposalId);
        this.receipt={proposal_id:proposalId,receipt_status:acceptance.receipt.status};
        const state=['accepted','progress_confirmed'].includes(acceptance.receipt.status)?'submitted':acceptance.receipt.status==='rejected'?'blocked':'reconciliation_required';
        return this.record({state,...this.receipt});
      }catch{
        // A failed acknowledgment is not permission to issue another proposal.
        let receipt;try{receipt=await this.control.getReceipt(proposalId);}catch{}
        this.receipt={proposal_id:proposalId,receipt_status:receipt?.status||'unknown'};
        return this.record({state:'reconciliation_required',...this.receipt});
      }
    }catch{return this.record({state:'blocked',reason:'review_invalid_or_failed'});}
    finally{input.messages=[];this.abort=null;this.busy=false;}
  }
}
