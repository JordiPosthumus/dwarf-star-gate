// Core-owned queue policy. No model calls, timers, request bodies or I/O here.
// The gateway supplies currently eligible conversation heads and durable writes.
// A model recommendation can change a future selection, never an active request.
export const PRIORITIES=Object.freeze(['High','Medium','Low']);
export const DEFAULT_PRIORITY_WEIGHTS=Object.freeze({High:3,Medium:1,Low:0.5});
export const PRIORITY_REASONS=Object.freeze({
  urgent:'Recent user words indicate urgency',
  deadline:'Recent user words indicate a deadline',
  preference:'Matches a confirmed priority preference',
  background:'Recent user words describe background work',
  routine:'Routine work with no clear urgency',
  uncertain:'Importance is uncertain; using Medium',
});
const keyPattern=/^[a-f0-9]{64}$/;
const levels=new Set(PRIORITIES);
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===keys.slice().sort().join(',');
const validKey=key=>typeof key==='string'&&keyPattern.test(key);
const validRevision=value=>Number.isSafeInteger(value)&&value>=0&&value<Number.MAX_SAFE_INTEGER;
const MAX_MANUAL=16384,MAX_RULES=30,MAX_RULE_BYTES=256,MAX_RECEIPTS=32;
export function priorityWeights(value){
  if(!exact(value,PRIORITIES)||PRIORITIES.some(level=>!Number.isFinite(value[level])||value[level]<0.1||value[level]>10))throw new Error('Each priority weight must be between 0.1 and 10');
  return {...value};
}
function rules(value){
  if(!Array.isArray(value)||value.length>MAX_RULES||value.some(line=>typeof line!=='string'||!line.trim()||/[\r\n\x00-\x1f\x7f]/.test(line)||Buffer.byteLength(line)>MAX_RULE_BYTES))throw new Error('Use at most 30 single-line preference rules, each at most 256 bytes');
  return value.map(line=>line.trim());
}
function waitLimit(value){
  // Null means the operator has not agreed an activation threshold yet.
  if(value!==null&&(!Number.isSafeInteger(value)||value<1000||value>86400000))throw new Error('Eligible-wait backstop must be 1 second to 24 hours');
  return value;
}
export function priorityState(raw){
  if(!exact(raw,['schema','revision','enabled','weights','max_eligible_wait_ms','manual','rules'])||raw.schema!==1||!validRevision(raw.revision)||typeof raw.enabled!=='boolean'||!raw.manual||typeof raw.manual!=='object'||Array.isArray(raw.manual)||Object.keys(raw.manual).length>MAX_MANUAL||Object.entries(raw.manual).some(([key,value])=>!validKey(key)||!levels.has(value)))throw new Error('Invalid saved Priority Lens state; preserve it for inspection');
  return {schema:1,revision:raw.revision,enabled:raw.enabled,weights:priorityWeights(raw.weights),max_eligible_wait_ms:waitLimit(raw.max_eligible_wait_ms),manual:{...raw.manual},rules:rules(raw.rules)};
}

export class PriorityLens {
  constructor({state,save=()=>{},random=Math.random,now=()=>performance.now(),maxEligibleWaitMs=null,enabled=true}={}){
    this.state=priorityState(state??{schema:1,revision:0,enabled,weights:{...DEFAULT_PRIORITY_WEIGHTS},max_eligible_wait_ms:maxEligibleWaitMs,manual:{},rules:[]});
    this.save=save;this.random=random;this.now=now;
    this.decisions=new Map();this.waits=new Map();this.receipts=[];
    this.epoch=0;this.selections=0;this.fallbacks=0;
  }
  get enabled(){return this.state.enabled;}
  get active(){return this.enabled&&this.state.max_eligible_wait_ms!==null;}
  commit(next){
    const checked=priorityState({...next,revision:this.state.revision+1});
    // Publish only after the caller's atomic durable write succeeds. A failed
    // write must not silently replace a user's prior override or preference.
    this.save(structuredClone(checked));this.state=checked;return this.settings();
  }
  settings(){return {...structuredClone(this.state),manual:undefined,activation:this.active?'active':this.enabled?'awaiting_aging_agreement':'off',manual_overrides:Object.keys(this.state.manual).length};}
  configure(input){
    if(!exact(input,['expected_revision','enabled','weights','max_eligible_wait_ms'])||input.expected_revision!==this.state.revision)throw new Error('Priority settings changed; refresh before editing');
    const result=this.commit({...this.state,enabled:input.enabled,weights:priorityWeights(input.weights),max_eligible_wait_ms:waitLimit(input.max_eligible_wait_ms)});
    this.epoch++;
    // Opt-out invalidates in-flight advice and transient classification state.
    if(!this.enabled)this.decisions.clear();
    return result;
  }
  setManual(input){
    if(!exact(input,['chat','priority','expected_revision'])||!validKey(input.chat)||input.expected_revision!==this.state.revision||input.priority!==null&&!levels.has(input.priority))throw new Error('Specify a current chat and High, Medium, Low or Return to automatic');
    const manual={...this.state.manual};
    if(input.priority===null)delete manual[input.chat];else manual[input.chat]=input.priority;
    const result=this.commit({...this.state,manual});
    this.epoch++;return result;
  }
  setRules(input){
    if(!exact(input,['expected_revision','rules'])||input.expected_revision!==this.state.revision)throw new Error('Preferences changed; refresh before editing');
    const result=this.commit({...this.state,rules:rules(input.rules)});
    this.epoch++;this.decisions.clear();return result;
  }
  ticket(chat,intentRevision){
    if(!this.enabled||!validKey(chat)||!validRevision(intentRevision)||Object.hasOwn(this.state.manual,chat))return null;
    return {chat,intent_revision:intentRevision,policy_epoch:this.epoch};
  }
  advise(ticket,input,currentIntentRevision){
    if(!exact(ticket,['chat','intent_revision','policy_epoch'])||!validKey(ticket.chat)||!this.enabled||ticket.policy_epoch!==this.epoch||ticket.intent_revision!==currentIntentRevision||Object.hasOwn(this.state.manual,ticket.chat))return false;
    if(!exact(input,['priority','reason'])||!levels.has(input.priority)||!Object.hasOwn(PRIORITY_REASONS,input.reason)||input.reason==='uncertain'&&input.priority!=='Medium')return false;
    // Only allowlisted metadata, never a model's free-text explanation or an
    // excerpt, enters this decision cache or the selection receipts.
    this.decisions.set(ticket.chat,{priority:input.priority,reason:input.reason,intent_revision:ticket.intent_revision});
    return true;
  }
  forget(chat){this.decisions.delete(chat);}
  decision(chat){
    if(validKey(chat)&&Object.hasOwn(this.state.manual,chat))return {priority:this.state.manual[chat],source:'user',reason:'User-set priority'};
    const advice=this.decisions.get(chat);
    return advice?{priority:advice.priority,source:'genie',reason:PRIORITY_REASONS[advice.reason]}:{priority:'Medium',source:'default',reason:'No current advice; using ordinary scheduling'};
  }
  heads(jobs){
    const seen=new Set();
    return jobs.filter(job=>!job.cancelled&&!job.dispatched&&!job.upstream).sort((a,b)=>a.sequence-b.sequence).filter(job=>{
      // Requests without a conversation identity have no claimed shared owner.
      const key=validKey(job.key)?job.key:job.id;
      if(seen.has(key))return false;seen.add(key);return true;
    });
  }
  observe(jobs,{eligible=()=>true,complete=true}={}){
    const now=this.now(),heads=new Set(this.heads(jobs).map(job=>job.id)),present=new Set(jobs.map(job=>job.id));
    if(complete)for(const id of this.waits.keys())if(!present.has(id))this.waits.delete(id);
    for(const job of jobs){
      const previous=this.waits.get(job.id),elapsed=previous?Math.max(0,now-previous.at):0;
      this.waits.set(job.id,{at:now,elapsed:(previous?.elapsed??0)+(previous?.eligible?elapsed:0),eligible:heads.has(job.id)&&!job.cancelled&&!job.dispatched&&!job.upstream&&eligible(job)});
    }
  }
  eligibleWait(job){return this.waits.get(job.id)?.elapsed??0;}
  select(jobs,{eligible=()=>true}={}){
    // observe() must also run when eligibility changes (holds, ownership,
    // health). The policy never invents time before it first observed a job.
    this.observe(jobs,{eligible,complete:false});
    const candidates=this.heads(jobs).filter(eligible);if(!candidates.length)return null;
    let selected=candidates[0],method='fifo',sample=null;
    const classified=candidates.some(job=>this.decision(job.key).source!=='default');
    if(this.active){
      const aged=candidates.filter(job=>this.eligibleWait(job)>=this.state.max_eligible_wait_ms).sort((a,b)=>this.eligibleWait(b)-this.eligibleWait(a)||a.sequence-b.sequence);
      if(aged.length){selected=aged[0];method='aging';}
      else if(classified&&candidates.length>1){
        sample=this.random();
        if(Number.isFinite(sample)&&sample>=0&&sample<1){
          const weights=candidates.map(job=>this.state.weights[this.decision(job.key).priority]);
          let point=sample*weights.reduce((sum,weight)=>sum+weight,0);
          selected=candidates.at(-1);
          for(let i=0;i<candidates.length;i++){point-=weights[i];if(point<0){selected=candidates[i];break;}}
          method='weighted_lottery';
        }else{sample=null;this.fallbacks++;method='random_unavailable_fifo';}
      }
    }
    this.selections++;
    const receipt={schema:1,selection:this.selections,method,policy_revision:this.state.revision,request_id:selected.id,
      priority:this.decision(selected.key).priority,source:this.decision(selected.key).source,
      eligible_wait_ms:this.eligibleWait(selected),eligible_conversations:candidates.length,sample,
      weights:{...this.state.weights},max_eligible_wait_ms:this.state.max_eligible_wait_ms,
      candidates:candidates.slice(0,128).map(job=>({request_id:job.id,priority:this.decision(job.key).priority,eligible_wait_ms:this.eligibleWait(job)})),
      candidates_truncated:candidates.length>128,genie_wait_ms:0};
    this.receipts.unshift(receipt);this.receipts.length=Math.min(this.receipts.length,MAX_RECEIPTS);
    return {job:selected,receipt:structuredClone(receipt)};
  }
}
