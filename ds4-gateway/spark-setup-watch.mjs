// Continue explicitly requested setup through Genie, using the existing dashboard tick.
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
const binding=target=>createHash('sha256').update(JSON.stringify([target.ssh,target.directory])).digest('hex');
export class SparkSetupWatch {
  constructor({filename,targets,chat,read,isEnabled}){
    Object.assign(this,{filename,targets,chat,read,isEnabled});this.busy=false;this.closed=false;
    this.requests=fs.existsSync(filename)?JSON.parse(fs.readFileSync(filename,'utf8')):{};
  }
  save(){fs.mkdirSync(path.dirname(this.filename),{recursive:true,mode:0o700});const temp=this.filename+'.tmp';fs.writeFileSync(temp,JSON.stringify(this.requests,null,2)+'\n',{mode:0o600});fs.renameSync(temp,this.filename);}
  status(id){const r=Object.hasOwn(this.requests,id)?this.requests[id]:null;return r?{...r,...(this.error?{state:'observing',error:this.error}:{})}:null;}
  request(id){
    if(!Object.hasOwn(this.targets,id))throw Error('Select an enrolled new Spark.');
    if(Object.hasOwn(this.requests,id))return this.requests[id];
    this.requests[id]={target_id:id,binding:binding(this.targets[id]),state:'requested',requested_at:new Date().toISOString(),scope:'Prepare and test the engines, qualify the LLM and its dedicated restart helper, then register its qualified services. Existing media/recovery switches still control use.'};this.save();return this.requests[id];
  }
  async tick(){
    if(this.closed||this.busy||!this.isEnabled()||!Object.values(this.requests).some(r=>!['complete','needs_attention'].includes(r.state)))return;
    const chat=this.chat.status();if(!chat.available||chat.conversations.some(c=>c.busy||c.queued))return;
    this.busy=true;
    try{
      const snapshot=await this.read();this.error=null;if(this.closed||!this.isEnabled())return;
      for(const [id,r] of Object.entries(this.requests)){
        if(['complete','needs_attention'].includes(r.state))continue;
        const target=this.targets[id];
        if(!target||binding(target)!==r.binding){r.state='needs_attention';r.error='Setup enrollment changed; inspect this request before continuing.';this.save();continue;}
        const s=snapshot.targets.find(t=>t.target_id===id);if(!s)continue;
        const states=[s.state,s.media_qualification?.state,s.qualification?.state,s.registration?.state];
        if(states.includes('needs_attention')||states.includes('registered_paused')){r.state='needs_attention';r.error=s.registration?.error??s.media_qualification?.error??s.qualification?.error??s.error??'Inspect the retained setup result before continuing.';this.save();continue;}
        if(states.some(s=>['unavailable','unconfirmed'].includes(s))){r.state='observing';r.error='Remote status is uncertain; existing work may continue.';this.save();continue;}
        if(s.registration?.state==='registered_serving'){r.state='complete';r.finished_at=new Date().toISOString();delete r.error;delete r.pending;this.save();continue;}
        const mediaPending=s.media_qualification_required&&!s.qualification&&s.media_qualification?.state!=='qualified_stopped';
        const stage=mediaPending?(s.state==='not_started'?'prepare_spark':s.state==='prepared_stopped'&&!s.media_qualification&&!s.qualification?'qualify_spark_media':null):s.qualification?.state==='qualified_serving'?'register_spark_llm':s.state==='prepared_stopped'&&!s.qualification?'qualify_spark_llm':s.state==='not_started'?'prepare_spark':null;
        if(!stage){r.state='working';delete r.error;this.save();continue;}
        // A no-action/failed Genie reply is visible, never an automatic retry loop.
        if(r.dispatched_stage===stage&&!r.pending){r.state='needs_attention';r.error=`Genie's ${stage} reply ended without observed stage progress; inspect its conversation.`;this.save();continue;}
        if(!r.conversation_id){r.conversation_id=this.chat.create({title:'Spark setup: '+id}).id;this.save();}
        if(r.pending?.stage!==stage){r.pending={stage,request_id:randomUUID(),text:`Continue the owner's saved setup request for ${id}. Read spark_setup_status. The last observed next step is ${stage}; verify current status and perform that step once if still appropriate. The enabled New Spark setup switch grants standing permission. Do not ask again. Never stop existing workloads or invent another target/directory. Check status once after the action, report actual progress or failure in at most 80 words, then finish. The setup watcher will wake you for the next completed stage. This request covers engine preparation, native media samples where connected, LLM/recovery qualification, and registration of the proven services. Report the actual registration.services fields; older LLM-only receipts do not imply media or recovery enrollment. Existing capability switches still control operation.`};this.save();}
        const pending=r.pending;
        this.chat.submit(r.conversation_id,pending.text,pending.request_id,{research:false});
        r.dispatched_stage=stage;r.state='waiting_for_genie';delete r.pending;delete r.error;this.save();break;
      }
    }catch(error){this.error=error.message;}
    finally{this.busy=false;}
  }
  close(){this.closed=true;}
}
