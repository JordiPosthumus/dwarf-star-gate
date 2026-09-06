// Disposable user excerpts for Priority Lens. This store has no persistence or
// logging. Inference never waits for an envelope, a lease or its recommendation.
import {createHash,randomUUID} from 'node:crypto';
import {PRIORITIES,PRIORITY_REASONS} from './priority-lens.mjs';

export const PRIORITY_INTENT_HEADER='x-dsg-priority-intent';
export const PRIORITY_INTENT_ROUTE='/gateway/priority-intent';
export const PRIORITY_REVIEW_CEILING_MS=60000;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const chatKey=/^[a-f0-9]{64}$/;
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===keys.sort().join(',');
const text=(value,max)=>typeof value==='string'&&value.trim().length>0&&Buffer.byteLength(value)<=max&&!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);
export const validPriorityTitle=value=>text(value,256)&&!/[\r\n\t]/.test(value);
const validAdvice=value=>exact(value,['priority','reason'])&&PRIORITIES.includes(value.priority)&&Object.hasOwn(PRIORITY_REASONS,value.reason)&&(value.reason!=='uncertain'||value.priority==='Medium');
export const validPriorityIntentId=id=>typeof id==='string'&&uuid.test(id)?id:null;
export function priorityEnvelope(input){
  const legacy=input?.schema===1;
  if(!exact(input,legacy?['schema','id','session','client','title','excerpt']:['schema','id','client','title','excerpt'])||(!legacy&&input.schema!==2)||!validPriorityIntentId(input.id)||input.client!=='pi'||(legacy&&!text(input.session,256))||!(input.title===null&&!legacy||text(input.title,256))||!text(input.excerpt,1024))throw new Error('Invalid priority intent');
  return {id:input.id,chat:legacy?createHash('sha256').update(input.session).digest('hex'):null,title:input.title,excerpt:input.excerpt};
}

export class PriorityIntents {
  constructor({lens,now=()=>performance.now(),capacity=1024,ttlMs=600000}={}){
    if(!lens||!Number.isSafeInteger(capacity)||capacity<1||capacity>4096||!Number.isSafeInteger(ttlMs)||ttlMs<PRIORITY_REVIEW_CEILING_MS)throw new Error('Invalid priority intent store');
    this.lens=lens;this.now=now;this.capacity=capacity;this.ttlMs=ttlMs;
    this.entries=new Map();this.current=new Map();this.expiredReviews=0;
  }
  sweep(){
    const now=this.now();
    for(const [id,entry] of this.entries){
      const current=this.current.get(entry.chat);
      const revoked=entry.lease&&(!this.lens.enabled||entry.lease.ticket.policy_epoch!==this.lens.epoch||!this.isCurrent(entry));
      if(entry.lease&&(now>=entry.lease.deadline||revoked)){
        if(now>=entry.lease.deadline)this.expiredReviews++;
        entry.lease=null;entry.excerpt=null;entry.attempted=true;
      }
      if(!this.lens.enabled)entry.excerpt=null;
      if(now>=entry.expires){
        this.entries.delete(id);
        if(current?.id===id){this.current.delete(entry.chat);this.lens.forget(entry.chat);}
      }
    }
  }
  entry(id,chat){
    this.sweep();
    if(!this.lens.enabled||!validPriorityIntentId(id)||(chat!==null&&!chatKey.test(chat??'')))return null;
    let entry=this.entries.get(id);
    if(entry){
      if(chat===null)return entry;
      if(entry.chat===null){if(entry.sequence!==null)return null;entry.chat=chat;}
      return entry.chat===chat?entry:null;
    }
    if(this.entries.size>=this.capacity)return null;
    entry={id,chat,title:null,suppliedTitle:null,titleSource:null,received:false,excerptDigest:null,excerpt:null,sequence:null,expires:this.now()+this.ttlMs,attempted:false,lease:null};
    this.entries.set(id,entry);return entry;
  }
  receive(input){
    const envelope=priorityEnvelope(input),entry=this.entry(envelope.id,envelope.chat);
    if(!entry)return false;
    // One immutable envelope per client intent; duplicates cannot rewrite the
    // meaning of an already accepted request or renew an advisory deadline.
    if(entry.received)return entry.suppliedTitle===envelope.title;
    entry.received=true;entry.suppliedTitle=envelope.title;entry.title=envelope.title;entry.titleSource=envelope.title?'client':null;
    entry.excerptDigest=createHash('sha256').update(envelope.excerpt).digest('hex');
    if(!entry.attempted)entry.excerpt=envelope.excerpt;
    return true;
  }
  observeRequest(job,excerpt){
    this.sweep();
    if(!this.lens.enabled||!Number.isSafeInteger(job?.sequence)||job.sequence<0)return null;
    if(!text(excerpt,1024)){this.bind(null,job);return null;}
    const digest=createHash('sha256').update(excerpt).digest('hex');
    const current=this.current.get(job.key),previous=this.entries.get(current?.id);
    if(current&&job.sequence<current.sequence)return null;
    if(previous?.excerptDigest===digest&&this.bind(previous.id,job))return previous.id;
    const id=randomUUID(),entry=this.entry(id,job.key);
    if(!entry){this.bind(null,job);return null;}
    entry.received=true;entry.excerptDigest=digest;entry.excerpt=excerpt;
    if(!this.bind(id,job)){this.entries.delete(id);return null;}
    return id;
  }
  bind(id,job){
    if(!Number.isSafeInteger(job?.sequence)||job.sequence<0)return false;
    const entry=validPriorityIntentId(id)&&(job.key===null||chatKey.test(job.key??''))?this.entry(id,job.key):null;
    if(!entry){
      const previous=this.current.get(job.key);
      if(previous&&job.sequence>previous.sequence){
        this.current.delete(job.key);this.lens.forget(job.key);
        const entry=this.entries.get(previous.id);if(entry){entry.excerpt=null;entry.lease=null;entry.attempted=true;}
      }
      return false;
    }
    if(job.key===null){
      if(entry.chat!==null)return false;
      entry.sequence??=job.sequence;entry.expires=this.now()+this.ttlMs;return true;
    }
    const current=this.current.get(job.key);
    if(current&&job.sequence<=current.sequence)return current.id===id;
    if(current?.id!==id){
      this.lens.forget(job.key);
      const previous=this.entries.get(current?.id);
      if(previous){previous.excerpt=null;previous.lease=null;previous.attempted=true;}
    }
    // Repeated model calls for the same genuine user turn keep its advice and
    // lease revision. Gateway admission order decides which intent is current.
    entry.sequence??=job.sequence;
    this.current.set(job.key,{id,sequence:job.sequence});
    entry.expires=this.now()+this.ttlMs;return true;
  }
  isCurrent(entry){return entry.sequence!==null&&(entry.chat===null||this.current.get(entry.chat)?.id===entry.id);}
  claim(){
    this.sweep();
    for(const entry of this.entries.values()){
      if(entry.attempted||!entry.excerpt||!this.isCurrent(entry))continue;
      const ticket=this.lens.ticket(entry.chat,entry.sequence)??{policy_epoch:this.lens.epoch};
      entry.attempted=true;
      entry.lease={id:randomUUID(),ticket,deadline:this.now()+PRIORITY_REVIEW_CEILING_MS};
      return {schema:1,lease:entry.lease.id,intent_id:entry.id,title:entry.title,excerpt:entry.excerpt,rules:[...this.lens.state.rules],deadline_ms:PRIORITY_REVIEW_CEILING_MS};
    }
    return null;
  }
  complete(input){
    this.sweep();
    if(!(exact(input,['lease','intent_id','advice'])||exact(input,['lease','intent_id','advice','title'])&&validPriorityTitle(input.title))||!validPriorityIntentId(input.lease)||!validPriorityIntentId(input.intent_id))return false;
    const entry=this.entries.get(input.intent_id);
    if(!entry?.lease||entry.lease.id!==input.lease)return false;
    const lease=entry.lease;entry.lease=null;entry.excerpt=null;
    if(!this.isCurrent(entry)||!validAdvice(input.advice))return false;
    const advised=lease.ticket.chat?this.lens.advise(lease.ticket,input.advice,entry.sequence):false;
    if(input.title&&!entry.suppliedTitle){entry.title=input.title.trim();entry.titleSource='genie';return true;}
    return advised||Boolean(input.title&&entry.suppliedTitle);
  }
  resolve(id,chat){const entry=this.entries.get(id===undefined?this.current.get(chat)?.id:id);return entry?.chat===chat?entry:null;}
  title(id,chat){this.sweep();return this.resolve(id,chat)?.title??null;}
  preview(id,chat){
    this.sweep();const entry=this.resolve(id,chat);
    if(entry?.title||!entry?.excerpt)return null;
    // Derive on read from the existing transient excerpt. Do not retain a copy
    // after its review deadline, opt-out, supersession or expiration.
    const chars=[...entry.excerpt.replace(/\s+/gu,' ').trim()];
    return {text:chars.slice(0,160).join('')+(chars.length>160?'…':''),previous_observation:id===undefined};
  }
  titleState(id,chat){this.sweep();const entry=this.resolve(id,chat);return !entry?'no_excerpt':entry.title?id?'ready':'previous_observation':entry.lease?'reviewing':entry.excerpt&&!entry.attempted?'pending_review':'unavailable';}
  titleSource(id,chat){return this.resolve(id,chat)?.titleSource??null;}
  status(){this.sweep();return {pending:[...this.entries.values()].filter(entry=>entry.excerpt&&!entry.attempted&&this.isCurrent(entry)).length,reviewing:[...this.entries.values()].filter(entry=>entry.lease).length,expired_reviews:this.expiredReviews,genie_wait_ms:0};}
}
