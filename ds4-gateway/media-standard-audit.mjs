import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mediaEngine} from './media-enrollment.mjs';
import {mediaPair} from './media-pair.mjs';
import {mediaStandardTargets} from './media-standard-watch.mjs';

// Read-only native checks. Enrollment is retained even when its container is absent.
export function createMediaStandardAudit({config,store,workers,isEnabled,isInspectionEnabled,active,transport,backup,now=Date.now}){
 const hours=config.media_jobs?.standard?.audit_interval_hours??24;
 assert.ok(Number.isSafeInteger(hours)&&hours>=1,'Standard audit interval must be a positive whole number of hours');
 const interval=hours*3600000;
 const targets=()=>mediaStandardTargets(config);
 const selection=t=>{
  const e=mediaEngine(config,t.worker_id,t.engine==='h3'?'video':'music',t.member);if(!e)return null;
  const inspection=config.genie_chat?.inspection?.workers?.[t.worker_id],pair=mediaPair(config,workers().find(w=>w.id===t.worker_id));
  const member=pair?.members[t.member??e.member??0];
  if(t.member!==undefined&&!member)return null;
  const target={ssh:member?.ssh??inspection?.ssh?.[0]},expected=Object.fromEntries(['container','image','kind','port'].map(k=>[k,e[k]]));
  const llm_container=member?.container??inspection?.container;
  if(!target.ssh||!llm_container)return null;
  return {target,expected,llm_container,binding:createHash('sha256').update(JSON.stringify([target,expected,llm_container])).digest('hex')};
 };
 const enabled=()=>isEnabled()&&isInspectionEnabled()&&config.media_jobs?.standard?.enabled===true&&config.media_jobs.standard.audit_enabled!==false;
 const status=()=>({supported:true,enabled:enabled(),interval_ms:interval,targets:targets().map(t=>{
  const current=selection(t),saved=store.data.media_standard_audits?.[t.key],matches=current&&saved?.binding===current.binding;
  const enrolled=!!mediaEngine(config,t.worker_id,t.engine==='h3'?'video':'music',t.member);
  const row=matches?saved:{state:current?'not_observed':enrolled?'unavailable':'not_enrolled',observed_at:null,...(enrolled&&!current?{error:'Current physical host binding is unavailable'}:{})};
  const {binding,evidence,...publicRow}=row;
  return {...t,...publicRow,due:!!current&&(!matches||!Number.isFinite(Date.parse(saved.observed_at))||now()-Date.parse(saved.observed_at)>=interval)};
 }),scope:'Dated native container identity, image and port checks only. Present is not generation, model-file integrity or runtime readiness. Absent and changed are distinct from unavailable. No enrollment or service was changed.'});
 async function run(input){
  assert.ok(input&&Object.keys(input).length===0,'Audit takes no arguments; it uses the configured standard');
  assert.ok(enabled(),'Standard media audit or server inspection is switched off');
  const checked=[];
  const inspect=async t=>{
   const chosen=selection(t);if(!chosen)return;
   if(active(t.worker_id)){checked.push({...t,state:'deferred',reason:'A native setup owns this worker'});return;}
   let evidence;
   try{
    evidence=await transport(chosen.target,{action:'audit_media',engine:t.engine,expected:chosen.expected,llm_container:chosen.llm_container});
    assert.ok(['present','absent','changed'].includes(evidence.state));assert.deepEqual(evidence.expected,chosen.expected);assert.equal(evidence.engine,t.engine);
    assert.match(evidence.current_llm_container,/^[a-f0-9]{64}$/);
   }catch(error){evidence={state:'unavailable',error:'Read-only native audit unavailable; no service change was requested. '+error.message};}
   if(selection(t)?.binding!==chosen.binding){checked.push({...t,state:'deferred',reason:'Enrollment changed during observation'});return;}
   const row={binding:chosen.binding,state:evidence.state,observed_at:new Date(now()).toISOString(),evidence,...(evidence.error?{error:evidence.error}:{})};
   backup();store.save({...store.data,media_standard_audits:{...store.data.media_standard_audits,[t.key]:row}});checked.push({...t,state:row.state,observed_at:row.observed_at});
  }
  const selected=targets();for(let i=0;i<selected.length;i+=4)await Promise.all(selected.slice(i,i+4).map(inspect));
  return {...status(),checked};
 }
 return {status,run};
}
