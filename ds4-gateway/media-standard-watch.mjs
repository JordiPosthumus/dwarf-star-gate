// Reconcile the owner's explicit per-machine media standard through actual Genie.
// This watcher never installs, changes placement, or retries native work itself.
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {machinesFor} from './fleet-machines.mjs';
const terminal=new Set(['enrolled','failed_unchanged','failed_returned','needs_attention']);
const failed=new Set(['failed_unchanged','failed_returned','needs_attention']);
export function mediaStandardTargets(config){
 const standard=config.media_jobs?.standard;
 if(!standard?.enabled)return [];
 if(!Array.isArray(standard.targets)||!standard.targets.length)throw Error('Media standard needs explicit targets.');
 const keys=new Set();
 return standard.targets.map(target=>{
  if(!target||!['engine,member,worker_id','engine,worker_id'].includes(Object.keys(target).sort().join(','))||typeof target.worker_id!=='string'||!target.worker_id||!['h3','ace-step'].includes(target.engine)||(target.member!==undefined&&![0,1].includes(target.member)))throw Error('Choose registered workers, optional pair members and supported standard engines.');
  const key=JSON.stringify([target.worker_id,target.member??null,target.engine]);
  if(keys.has(key))throw Error('Duplicate media standard target.');keys.add(key);
  return {...target,key};
 });
}
export class MediaStandardWatch {
 constructor({filename,config,chat,read,isEnabled=()=>false,now=Date.now}){
  Object.assign(this,{filename,config,chat,read,isEnabled,now});this.targets=mediaStandardTargets(config);this.busy=false;this.closed=false;
  this.state=fs.existsSync(filename)?JSON.parse(fs.readFileSync(filename,'utf8')):{targets:{}};
 }
 save(){fs.mkdirSync(path.dirname(this.filename),{recursive:true,mode:0o700});const temp=this.filename+'.tmp';fs.writeFileSync(temp,JSON.stringify(this.state)+'\n',{mode:0o600});fs.renameSync(temp,this.filename);}
 status(){return {enabled:this.targets.length>0&&this.isEnabled(),targets:this.targets.map(t=>({...t,...this.state.targets?.[t.key]})),error:this.error??null,scope:'Owner-requested standard, reconciled through Genie and native receipts. Enrolled is distinct from currently running; missing or uncertain work is never replayed.'};}
 async tick(){
  if(this.closed||this.busy||!this.targets.length||!this.isEnabled())return;
  const chat=this.chat.status();if(!chat.available||chat.conversations.some(c=>c.busy||c.queued))return;
  this.busy=true;
  try{
   const s=await this.read();if(this.closed||!this.isEnabled()||!s.enabled)return;
   this.error=null;this.state.targets??={};let chosen=null;
   for(const t of this.targets){
    const old=this.state.targets[t.key]??{},host=s.hosts?.find(h=>h.id===t.worker_id);
    const engines=t.member===undefined?host?.engines:host?.members?.find(m=>m.member===t.member)?.engines;
    const engine=engines?.find(e=>e.id===t.engine);
    const op=s.setup?.operations?.find(o=>o.worker_id===t.worker_id&&o.engine===t.engine&&o.member===t.member);
    let phase,reason,action;
    if(!host||!engine){phase='needs_attention';reason='Configured worker/member is not observed.';}
    else if(engine.enrolled){phase='enrolled';}
    else if(op?.phase==='failed_unchanged'&&op.retry_ready===true){phase='retry_available';action='retry';}
    else if(op?.phase==='failed_unchanged'&&op.failure_context?.stage==='read_only_preflight'&&op.failure_context?.selected_media_container&&s.setup?.source_repair_supported===true){phase='source_repair_needed';action='repair';}
    else if(op&&failed.has(op.phase)){phase='needs_attention';reason=op.detail??op.phase;action='inspect';}
    else if(op&&op.phase==='qualified_returned'){phase='enrollment_pending';action='finish';}
    else if(op){phase='working';reason=op.phase;}
    else if(!engine.allowed){phase='waiting_permission';reason='Placement is off.';}
    else {
     const active=s.setup?.operations?.some(o=>o.worker_id===t.worker_id&&!terminal.has(o.phase));
     const worker=s.fleet?.find(w=>w.id===t.worker_id),taken=machinesFor(t.worker_id,this.config);
     const spare=s.fleet?.some(w=>w.id!==t.worker_id&&w.is_healthy&&!w.drained&&!machinesFor(w.id,this.config).some(m=>taken.includes(m)));
     const capable=s.setup?.hosts?.find(h=>h.worker_id===t.worker_id)?.available===true;
     if(active||host.execution||!worker?.is_healthy||worker.load||worker.queued||!spare||!capable){phase='waiting';reason='Waiting for setup support, idle hardware and a separate serving LLM.';}
     else {phase='setup_needed';action='setup';}
    }
    const fingerprint=createHash('sha256').update(JSON.stringify([t,phase,op?.operation_id,failed.has(op?.phase)?op.at:null,reason])).digest('hex');
    if(action&&old.dispatched===fingerprint&&!old.pending&&['setup_needed','source_repair_needed','retry_available'].includes(phase)){phase='needs_attention';reason='Genie ended its setup reply without an observed operation; inspect the standard conversation.';action=null;}
    const row={...old,phase,reason:reason??null,operation_id:op?.operation_id??null,observed_at:this.now()};this.state.targets[t.key]=row;
    if(!chosen&&action&&old.dispatched!==fingerprint)chosen={t,row,action,fingerprint};
   }
   this.save();if(!chosen)return;
   const {t,row,action,fingerprint}=chosen;
   if(!this.state.conversation_id){this.state.conversation_id=this.chat.create({title:'Standard media configuration'}).id;this.save();}
   // Persist before submit. A lost reply repeats the same chat request identity.
   if(!row.pending||row.pending.fingerprint!==fingerprint){
    const args=Object.fromEntries(Object.entries(t).filter(([k])=>k!=='key'));
    if(['retry','repair'].includes(action))args.expected_failed_at=s.setup.operations.find(o=>o.operation_id===row.operation_id).at;
    const target=JSON.stringify(args);
    const inspection=JSON.stringify({worker_id:t.worker_id,...(t.member!==undefined?{member:t.member}:{})});
    row.pending={fingerprint,request_id:randomUUID(),text:`Continue the owner's configured standard media setup for target ${target}. Read media_job_status, then call inspect_media_host with ${inspection} (no engine argument). ${action==='repair'?'The saved evidence identifies a retained MEDIA source failure before any maintenance or LLM stop. Call repair_media_setup once with this exact target and failure timestamp. Its native reader must prove the old media container absent on the current LLM host; otherwise it refuses without changes. It can save only a unique stopped known source or separate fresh preparation, preserving all old files. Do not infer that the selected media ID names the LLM. Read status once afterward; the watcher will wake you for the permitted same-ID retry.':action==='retry'?'The configured reuse candidate was corrected after a confirmed read-only failure, and the executor reports retry_ready. Call setup_media_host once with this exact target and failure timestamp. It must archive the prior attempt and retain the same operation ID; all native gates still apply.':action==='inspect'?'The retained setup needs attention. Diagnose it using read-only observations and explain the specific blocker. Do not repeat setup, change its identity, replace a container or infer that a missing observation proves absence.':action==='finish'?'Native qualification and LLM return are observed; call setup_media_host once with this exact target to finish pending enrollment.':'If current status still shows this engine missing, call setup_media_host once with this exact target. The enabled standard configuration grants standing setup authority. Preserve existing engines, model/cache files, settings and another serving LLM; native controls enforce idle and restoration.'} Do not dispatch unrelated queued media jobs or change capability switches. Check the saved operation once after an action and finish with a short factual result. Acceptance is not completion. This watcher observes the operation and wakes you for the next missing engine after completion; the owner need not say proceed.`};this.save();
   }
   const pending=row.pending;this.chat.submit(this.state.conversation_id,pending.text,pending.request_id,{research:false});row.dispatched=pending.fingerprint;delete row.pending;this.save();
  }catch(error){this.error=error.message;}
  finally{this.busy=false;}
 }
 close(){this.closed=true;}
}
