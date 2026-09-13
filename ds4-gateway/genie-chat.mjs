import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

// The conversation store is private runtime data, never the operational notebook
// or the model's authority to change a server. No background model calls here.
export function chatContext(snapshot={}) {
  const g=snapshot.gateway;
  const take=(value,keys)=>Object.fromEntries(keys.filter(k=>value?.[k]!==undefined).map(k=>[k,value[k]]));
  return {
    observed_at:snapshot.gateway_at??snapshot.time??null,
    source:snapshot.demo?'example setup':'dashboard observation',
    unavailable:!g||Boolean(snapshot.gateway_error),
    gateway:take(g,['model','context_length','request_timeout_ms','queue_timeout_ms','healthy','total','active','queued','available','draining']),
    servers:(g?.workers??[]).map(w=>take(w,['id','model','backend','context_length','is_healthy','drained','load','queued','active_seconds','quarantine','model_aliases'])),
    scope:'Observed setup only. Missing fields are unknown. No credentials, raw requests or server-control tools are available in this chat.',
  };
}

export class GenieChat {
  constructor({directory,provider,getSnapshot=()=>({}),isSuspended=()=>false,now=Date.now}) {
    this.directory=path.resolve(directory);this.provider=provider;this.getSnapshot=getSnapshot;this.now=now;
    this.loadErrors=[];this.sessions=new Map();this.jobs=new Map();this.closed=false;this.isSuspended=isSuspended;
    fs.mkdirSync(this.directory,{recursive:true,mode:0o700});
    for(const name of fs.readdirSync(this.directory)) {
      if(!/^[a-f0-9-]{36}\.json$/.test(name))continue;
      const file=path.join(this.directory,name);
      try {
      const s=JSON.parse(fs.readFileSync(file,'utf8'));
      if(s.version!==1||name!==`${s.id}.json`||!Array.isArray(s.messages)||s.messages.some(m=>!m||!['user','assistant'].includes(m.role)||typeof m.text!=='string'||!['working','complete','failed','interrupted'].includes(m.state)||(m.context&&!Array.isArray(m.context.servers))))throw new Error('Invalid Genie conversation file; existing data was preserved.');
      // A server restart is not permission to replay an uncertain request.
      let changed=false;
      for(const m of s.messages)if(m.state==='working'){m.state='interrupted';m.error='The chat service restarted before this reply finished. Your message was kept; unsaved partial output may be missing.';changed=true;}
      if(changed)this.save(s);this.sessions.set(s.id,s);
      } catch {this.loadErrors.push(name);} // Preserve unreadable files verbatim; other chats remain usable.
    }
  }
  save(s) {
    const file=path.join(this.directory,`${s.id}.json`),temp=`${file}.${randomUUID()}.tmp`;
    try{fs.writeFileSync(temp,JSON.stringify(s),{mode:0o600,flag:'wx'});fs.renameSync(temp,file);}
    finally{if(fs.existsSync(temp))fs.unlinkSync(temp);}
  }
  status() {
    return {available:Boolean(this.provider)&&!this.closed&&!this.isSuspended(),suspended:this.isSuspended(),...(this.provider?.info??{}),
      unreadable_conversations:[...this.loadErrors],conversations:[...this.sessions.values()].sort((a,b)=>b.updated_at-a.updated_at).map(s=>({id:s.id,title:s.title,updated_at:s.updated_at,busy:this.jobs.has(s.id)}))};
  }
  create() {
    const s={version:1,id:randomUUID(),title:'New conversation',created_at:this.now(),updated_at:this.now(),messages:[]};
    this.save(s);this.sessions.set(s.id,s);return this.get(s.id);
  }
  get(id) {
    const s=this.sessions.get(id);if(!s)throw new Error('Conversation not found.');
    return structuredClone({...s,busy:this.jobs.has(id)});
  }
  submit(id,text,requestId) {
    if(this.closed||!this.provider)throw new Error('Hermes chat is not configured.');
    if(this.isSuspended())throw new Error('New Genie questions are paused while testing mode is active. Your draft has not been sent.');
    if(typeof text!=='string'||!text.trim()||text.length>32000)throw new Error('Enter a message of up to 32,000 characters.');
    if(typeof requestId!=='string'||!/^[a-zA-Z0-9-]{8,80}$/.test(requestId))throw new Error('A message identifier is required.');
    const s=this.sessions.get(id);if(!s)throw new Error('Conversation not found.');
    const existing=s.messages.find(m=>m.role==='user'&&m.request_id===requestId);
    if(existing){if(existing.text!==text.trim())throw new Error('That message identifier was already used.');return this.get(id);}
    if(this.jobs.has(id))throw new Error('Genie is answering in this conversation. Your draft has not been sent.');
    const previous=structuredClone(s);
    const history=s.messages.filter(m=>m.state==='complete').map(m=>({role:m.role,content:m.text}));
    const context=chatContext(this.getSnapshot());
    const user={id:randomUUID(),request_id:requestId,role:'user',text:text.trim(),state:'complete',at:this.now()};
    const reply={id:randomUUID(),role:'assistant',text:'',state:'working',at:this.now(),context};
    s.messages.push(user,reply);s.updated_at=this.now();if(s.messages.length===2)s.title=user.text.slice(0,64);
    try{this.save(s);}catch{this.sessions.set(id,previous);throw new Error('Could not save your message. Nothing was sent to the model.');}
    // Yield before generation, ensuring busy and the accepted receipt exist first.
    const job=Promise.resolve().then(async()=>{
      try{
        const result=await this.provider.generate({message:user.text,history,context,sessionId:id,onDelta:delta=>{if(typeof delta==='string')reply.text+=delta;}});
        if(typeof result?.text!=='string'||!result.text.trim())throw new Error('Hermes returned no answer.');
        reply.text=result.text;reply.state='complete';
      }catch(e){reply.state='failed';reply.error=e.publicMessage??'Genie could not finish this reply. Your conversation is saved; you can ask again.';}
      finally{
        s.updated_at=this.now();reply.finished_at=this.now();
        try{this.save(s);}catch{reply.state='failed';reply.error='This reply could not be saved. Copy it before leaving this page; your earlier conversation remains on disk.';}
        this.jobs.delete(id);
      }
    });
    this.jobs.set(id,job);return this.get(id);
  }
  async idle(){await Promise.all([...this.jobs.values()]);}
  close(){this.closed=true;this.provider?.close?.();}
}
