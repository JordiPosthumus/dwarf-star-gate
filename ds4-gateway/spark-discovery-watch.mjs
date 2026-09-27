// Report a requested scan in its original conversation; never launch a scan.
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';

const terminal=new Set(['complete','failed','observation_lost']);
const validId=id=>/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id??'');
function receipts(conversation){
  const requested=new Map(),observed=new Set();
  for(const message of conversation.messages){
    if(message.role!=='assistant')continue;
    for(const event of message.spark_setup?.events??[]){
      if(event.state!=='complete'||!validId(event.result?.scan_id))continue;
      const id=event.result.scan_id;
      if(event.tool==='discover_sparks')requested.set(id,{scan_id:id,stopped:message.stop_requested_at!==undefined});
      if(['discover_sparks','spark_discovery_status'].includes(event.tool)&&terminal.has(event.result.state))observed.add(id);
    }
  }
  return {requested:[...requested.values()],observed};
}
export class SparkDiscoveryWatch {
  constructor({filename,chat,read,isEnabled}){
    Object.assign(this,{filename,chat,read,isEnabled});this.closed=false;this.busy=false;
    this.records=fs.existsSync(filename)?JSON.parse(fs.readFileSync(filename,'utf8')):{};
  }
  save(){
    fs.mkdirSync(path.dirname(this.filename),{recursive:true,mode:0o700});
    const temp=this.filename+'.'+randomUUID(),fd=fs.openSync(temp,'wx',0o600);
    try{fs.writeFileSync(fd,JSON.stringify(this.records,null,2)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    fs.renameSync(temp,this.filename);
  }
  async tick(){
    if(this.closed||this.busy||!this.isEnabled())return;
    const summary=this.chat.status();
    if(!summary.available||summary.conversations.some(c=>c.busy||c.queued))return;
    this.busy=true;
    try{
      for(const s of summary.conversations){
        if(s.queue_paused)continue;
        const conversation=this.chat.get(s.id),{requested,observed}=receipts(conversation);
        for(const request of requested){
          if(request.stopped)continue;
          const key='discovery-result-'+createHash('sha256').update(JSON.stringify([s.id,request.scan_id])).digest('hex');
          let record=this.records[key];
          if(observed.has(request.scan_id)){if(record&&record.state!=='observed'){record.state='observed';this.save();}continue;}
          if(record&&record.state!=='pending')continue;
          const result=await this.read(request.scan_id);
          if(result?.scan_id!==request.scan_id||!terminal.has(result.state))continue;
          const fresh=this.chat.status(),current=this.chat.get(s.id),now=receipts(current);
          if(this.closed||!this.isEnabled()||!fresh.available||fresh.conversations.some(c=>c.busy||c.queued))return;
          if(current.queue_paused||now.requested.find(r=>r.scan_id===request.scan_id)?.stopped||now.observed.has(request.scan_id))continue;
          if(!record){
            record={conversation_id:s.id,scan_id:request.scan_id,request_id:key.replace('discovery-result-','discovery-'),state:'pending',
              text:`The previously requested Spark discovery scan ${request.scan_id} has reached ${result.state}. Read spark_discovery_status with this exact scan_id once and report the observed candidates, existing machines, SSH prerequisites and coverage limits in this original conversation. Do not start another scan merely to repeat this observation. If the original owner request was discovery only, do not enroll a host or change it. If the owner explicitly requested onboarding, continue that existing request using eligible request_spark_access or enroll_discovered_spark evidence and the existing capability gates. Do not infer permission for a different recipe, networking changes, firmware or reboot. Discovery does not establish setup or firmware readiness. If the receipt is missing or disagrees, report uncertainty and finish. This follow-up reports the original discovery request; it does not grant new maintenance authority.`};
            this.records[key]=record;
          }
          // The first release's 81-character ID was rejected before submission
          // by GenieChat's 80-character limit. Repair only that impossible-to-
          // accept pending ID; never replace a valid or dispatched request ID.
          if(record.state==='pending'&&record.request_id===key)record.request_id=key.replace('discovery-result-','discovery-');
          this.save();
          this.chat.submit(s.id,record.text,record.request_id,{research:false});
          record.state='dispatched';this.save();this.error=null;return;
        }
      }
      this.error=null;
    }catch(error){this.error=error.message;}
    finally{this.busy=false;}
  }
  close(){this.closed=true;}
}
