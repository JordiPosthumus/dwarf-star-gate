// Continue the original onboarding conversation after a local grant or receipt.
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
const valid=id=>/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id??'');
function requests(conversation){
  const found=new Map();
  for(const message of conversation.messages??[]){
    for(const event of message.spark_setup?.events??[]){
      const id=event.result?.access_id??event.request?.access_id;
      if(!valid(id))continue;
      if(event.tool==='request_spark_access'&&event.state==='complete'&&!found.has(id))found.set(id,{id,stopped:false,observed:null});
      const row=found.get(id);if(!row)continue;
      if(message.stop_requested_at!==undefined)row.stopped=true;
      if(['spark_access_status','bootstrap_spark_access'].includes(event.tool)&&event.state==='complete')row.observed=event.result;
    }
  }
  return [...found.values()];
}
const outcome=op=>JSON.stringify([op.state,op.authorization_generation,op.endpoints?.map(e=>[e.state,e.reason??null])]);
export class SparkAccessWatch {
  constructor({filename,chat,access,isEnabled}){
    Object.assign(this,{filename,chat,access,isEnabled});this.busy=false;this.closed=false;
    this.records=fs.existsSync(filename)?JSON.parse(fs.readFileSync(filename,'utf8')):{};
  }
  save(){
    fs.mkdirSync(path.dirname(this.filename),{recursive:true,mode:0o700});const temp=this.filename+'.'+randomUUID();
    fs.writeFileSync(temp,JSON.stringify(this.records,null,2)+'\n',{mode:0o600,flag:'wx'});fs.renameSync(temp,this.filename);
  }
  async tick(){
    if(this.closed||this.busy||!this.isEnabled()||this.access.status().busy)return;
    const summary=this.chat.status();if(!summary.available||summary.conversations.some(c=>c.busy||c.queued))return;
    this.busy=true;
    try{
      for(const conversation of summary.conversations){
        if(conversation.queue_paused)continue;
        for(const request of requests(this.chat.get(conversation.id))){
          if(request.stopped)continue;
          const op=this.access.status({access_id:request.id});
          if(!op.authorization_generation||op.state==='running')continue;
          const grant=op.state==='authorized'&&op.credential_available;
          if(!grant&&request.observed&&outcome(request.observed)===outcome(op))continue;
          const phase=grant?'grant-'+op.authorization_generation:'result-'+outcome(op);
          const id='access-'+createHash('sha256').update(JSON.stringify([conversation.id,request.id,phase])).digest('hex');
          let record=this.records[id];if(record&&record.state!=='pending')continue;
          if(!record){
            record={request_id:id,conversation_id:conversation.id,access_id:request.id,state:'pending',text:grant?
              `The owner supplied the local credential grant for initial Spark access ${request.id}. Read spark_access_status for this exact ID. If the grant remains available and the original owner request authorized onboarding, call bootstrap_spark_access once with this same access_id, read its status once, then finish. The saved watcher will report the result here. Never ask for or repeat passwords in chat. This continues the original request and does not grant new authority.`:
              `Initial Spark access ${request.id} has a new saved outcome (${op.state}). Read spark_access_status for this exact ID and report it. If key access is complete and the owner originally requested onboarding, use fresh discover_sparks evidence to continue that requested enrollment; access alone is not model or firmware readiness. For credentials_required direct the owner to the local New Spark access form. For verification_pending or uncertainty report the retained operation without automatically replaying a key write. Do not infer permission for firmware, reboot or a different recipe. This continues only the original owner request.`};
            this.records[id]=record;
          }
          this.save();this.chat.submit(conversation.id,record.text,record.request_id,{research:false});record.state='dispatched';this.save();this.error=null;return;
        }
      }
      this.error=null;
    }catch{this.error='Initial-access follow-up could not be confirmed; the same saved request is retained.';}
    finally{this.busy=false;}
  }
  close(){this.closed=true;}
}
