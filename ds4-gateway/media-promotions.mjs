import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const get=(target,slot)=>slot==='default'?target?.engines?.music:target?.member_engines?.[slot.slice(-1)]?.music;
function put(target,slot,value){
 if(slot==='default'){target.engines??={};target.engines.music=structuredClone(value);}
 else {const member=slot.slice(-1);target.member_engines??={};target.member_engines[member]??={};target.member_engines[member].music=structuredClone(value);}
}
function validEngine(e){
 assert.ok(e&&['container,image,kind,port','container,image,kind,member,port'].includes(Object.keys(e).sort().join(','))&&e.kind==='ace-step'&&/^[a-f0-9]{64}$/.test(e.container)&&/^sha256:[a-f0-9]{64}$/.test(e.image)&&Number.isSafeInteger(e.port)&&e.port>0&&e.port<=65535&&(e.member===undefined||[0,1].includes(e.member)),'Exact ACE enrollment required');
}
function validate(record){
 assert.ok(record?.schema===1&&uuid(record.operation_id)&&typeof record.worker_id==='string'&&[0,1].includes(record.member)&&/^[a-f0-9]{64}$/.test(record.host_binding)&&uuid(record.qualification_job_id)&&/^[a-f0-9]{64}$/.test(record.proof_sha256)&&Number.isFinite(Date.parse(record.at)),'Promotion record is invalid');
 assert.ok(Array.isArray(record.cells)&&record.cells.length>0&&record.cells.length<=2&&new Set(record.cells.map(c=>c.slot)).size===record.cells.length,'Promotion selection is invalid');
 for(const c of record.cells){
  assert.ok(['default','member:'+record.member].includes(c.slot),'Promotion cannot change another member');validEngine(c.before);validEngine(c.after);
  if(c.configured_before!==null)validEngine(c.configured_before);
  assert.equal(c.before.member??0,record.member);assert.deepEqual(c.after,{...c.before,container:c.after.container,image:c.after.image},'Only exact container and image may change');
  assert.notEqual(c.before.container,c.after.container);assert.notEqual(c.before.image,c.after.image);
 }
 const first=record.cells[0];assert.ok(record.cells.every(c=>c.before.container===first.before.container&&c.before.image===first.before.image&&c.after.container===first.after.container&&c.after.image===first.after.image),'Default/member promotions must identify the same engines');
 return record;
}

// A recorded promotion is a narrow exception to ordinary setup's preservation
// rule. Store it with the changed enrollment and operation in one durable write.
// Restore applies no native commands and does not need new mutation permission.
export function createMediaPromotions(config,store,{hostIdentity,configuredWorkers=structuredClone(config.media_jobs?.workers??{})}){
 return {
  restore(){
   const errors={};
   for(const [id,history] of Object.entries(store.data.media_engine_promotions??{})){
    try{
     assert.ok(Array.isArray(history)&&history.length&&new Set(history.map(r=>r.operation_id)).size===history.length,'Promotion history is invalid');
     const latest=new Map();
     for(const raw of history){
      const r=validate(raw);assert.equal(r.worker_id,id);assert.equal(r.host_binding,hostIdentity(id),'Promotion physical binding changed');
      const owner=store.data.media_candidates?.[r.operation_id];assert.ok(owner?.phase==='promoted'&&owner.promotion?.record_sha256===hash(r),'Promotion commit record changed');
      for(const c of r.cells){if(latest.has(c.slot))assert.deepEqual(c.before,latest.get(c.slot).after,'Promotion chain changed');latest.set(c.slot,c);}
     }
     const next=structuredClone(config.media_jobs?.workers?.[id]??{}),retained=store.data.media_engine_enrollments?.[id];
     assert.equal(retained?.host_binding,hostIdentity(id),'Promoted enrollment host changed');
     for(const [slot,c] of latest){
      const current=get(next,slot)??null;
      assert.ok(isDeepStrictEqual(current,c.configured_before)||isDeepStrictEqual(current,c.after),'Configured engine changed since promotion');
      assert.deepEqual(get(retained,slot),c.after,'Retained promoted enrollment changed');put(next,slot,c.after);
     }
     config.media_jobs.workers??={};config.media_jobs.workers[id]=next;
    }catch(e){errors[id]=e.message;}
   }
   return errors;
  },
  propose({operation_id,worker_id,member,original,candidate,qualification_job_id,proof_sha256}){
   assert.ok([0,1].includes(member));validEngine(original);validEngine(candidate);
   assert.deepEqual(candidate,{...original,container:candidate.container,image:candidate.image},'Promotion preserves all engine settings');
   const current=config.media_jobs?.workers?.[worker_id];assert.ok(current,'Current engine enrollment required');
   const slots=[];
   if(current.member_engines?.[member]?.music)slots.push('member:'+member);
   if(current.engines?.music&&(current.engines.music.member??0)===member)slots.push('default');
   const cells=slots.map(slot=>{
    const before=get(current,slot);assert.equal(before.container,original.container);assert.equal(before.image,original.image);assert.equal(before.kind,original.kind);assert.equal(before.port,original.port);
    return {slot,before:structuredClone(before),after:{...before,container:candidate.container,image:candidate.image},configured_before:structuredClone(get(configuredWorkers[worker_id],slot)??null)};
   });
   const record=validate({schema:1,operation_id,worker_id,member,host_binding:hostIdentity(worker_id),qualification_job_id,proof_sha256,cells,at:new Date().toISOString()});
   assert.ok(!(store.data.media_engine_promotions?.[worker_id]??[]).some(r=>r.operation_id===operation_id),'Promotion already committed');
   const previous=store.data.media_engine_enrollments?.[worker_id];
   if(previous)assert.equal(previous.host_binding,record.host_binding,'Retained enrollment physical binding must be established');
   const retained=structuredClone(previous??{}),next=structuredClone(current);
   for(const c of cells){put(retained,c.slot,c.after);put(next,c.slot,c.after);}
   retained.host_binding=record.host_binding;
   return {record,record_sha256:hash(record),enrollment:retained,previous_enrollment:structuredClone(previous??null),next};
  },
  apply(proposal){config.media_jobs.workers[proposal.record.worker_id]=proposal.next;},
 };
}
