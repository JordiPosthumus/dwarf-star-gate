import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createMediaSetup} from './media-setup.mjs';

function fixture(t){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'sg-promoted-enrollment-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const engine=member=>({kind:'ace-step',member,container:(member?'b':'a').repeat(64),image:'sha256:'+'c'.repeat(64),port:8002});
 const worker={id:'pair',url:'http://fixture'},video={kind:'comfyui',container:'8'.repeat(64),image:'sha256:'+'9'.repeat(64),port:8188};
 const baseline={media_jobs:{enabled:true,workers:{pair:{engines:{music:engine(0),video},member_engines:{0:{music:engine(0),video:{...video,member:0}},1:{music:engine(1),video:{...video,member:1}}}}},pairs:{pair:{kind:'glm53-docker-pair',model:'glm',worker_binding:worker,members:[{ssh:'head',container:'llm-head'},{ssh:'rank',container:'llm-rank'}]}}},genie_chat:{python:'/fixture/python',inspection:{workers:{pair:{ssh:['head'],container:'llm-head'}}}},control_socket:'/fixture.sock'};
 const store={filename:path.join(directory,'state.json'),data:{other:{keep:1}},save(value){this.data=structuredClone(value);fs.writeFileSync(this.filename,JSON.stringify(value),{mode:0o600});}};
 const options={directory:path.join(directory,'setups'),workers:()=>[worker],binding:()=>true,isEnabled:()=>false,isAllowed:()=>false,transport:async()=>{throw Error('No native action expected');}};
 const config=structuredClone(baseline),setup=createMediaSetup(config,store,options);
 const commit=(member,letter='d')=>{
  const original=config.media_jobs.workers.pair.member_engines?.[member]?.music??config.media_jobs.workers.pair.engines.music;
  const proposal=setup.promotions.propose({operation_id:randomUUID(),worker_id:'pair',member,original,candidate:{...original,container:letter.repeat(64),image:'sha256:'+letter.repeat(64)},qualification_job_id:randomUUID(),proof_sha256:'f'.repeat(64)});
  store.save({...store.data,media_candidates:{...store.data.media_candidates,[proposal.record.operation_id]:{phase:'promoted',promotion:{record_sha256:proposal.record_sha256}}},media_engine_promotions:{pair:[...(store.data.media_engine_promotions?.pair??[]),proposal.record]},media_engine_enrollments:{pair:proposal.enrollment}});setup.promotions.apply(proposal);return proposal;
 };
 return {config,baseline,store,setup,options,commit};
}
test('member-only promotion survives normal setup restore without changing the default, H3 or other member',async t=>{
 const f=fixture(t),old=structuredClone(f.config.media_jobs.workers.pair);const proposal=f.commit(1);
 assert.deepEqual(proposal.record.cells.map(c=>c.slot),['member:1']);
 assert.deepEqual(f.config.media_jobs.workers.pair.engines,old.engines);assert.deepEqual(f.config.media_jobs.workers.pair.member_engines[0],old.member_engines[0]);
 assert.deepEqual(f.config.media_jobs.workers.pair.member_engines[1].video,old.member_engines[1].video);
 const restart=structuredClone(f.baseline),setup=createMediaSetup(restart,f.store,f.options);
 assert.equal(setup.status().hosts[0].error,null);assert.deepEqual(restart.media_jobs.workers,f.config.media_jobs.workers);assert.equal(f.store.data.other.keep,1);
 await assert.rejects(setup.start({worker_id:'pair',member:1,engine:'ace-step'}),/switched off|already enrolled/);
});
test('default and corresponding member move together; later independent H3 configuration is preserved',t=>{
 const f=fixture(t),proposal=f.commit(0);assert.equal(proposal.record.cells.length,2);
 const restart=structuredClone(f.baseline);restart.media_jobs.workers.pair.engines.video.port=8288;
 const setup=createMediaSetup(restart,f.store,f.options);assert.equal(setup.status().hosts[0].error,null);
 assert.equal(restart.media_jobs.workers.pair.engines.music.container,'d'.repeat(64));assert.equal(restart.media_jobs.workers.pair.member_engines[0].music.container,'d'.repeat(64));assert.equal(restart.media_jobs.workers.pair.engines.video.port,8288);
});
test('changed configured selection or physical host refuses restoration atomically and reports the conflict',t=>{
 for(const fault of ['default','host']){
  const f=fixture(t);f.commit(0);const restart=structuredClone(f.baseline);
  if(fault==='default')restart.media_jobs.workers.pair.engines.music.container='7'.repeat(64);
  else {restart.genie_chat.inspection.workers.pair.ssh=['other-head'];restart.media_jobs.pairs.pair.members[0].ssh='other-head';}
  const before=structuredClone(restart.media_jobs.workers),setup=createMediaSetup(restart,f.store,f.options);
  assert.match(setup.status().hosts[0].error,/changed/);assert.deepEqual(restart.media_jobs.workers,before);
 }
});
test('a promotion receipt alone cannot override setup preservation without the matching atomic owner and enrollment records',t=>{
 for(const fault of ['owner','retained']){
  const f=fixture(t),proposal=f.commit(0);
  if(fault==='owner')delete f.store.data.media_candidates[proposal.record.operation_id];
  else f.store.data.media_engine_enrollments.pair.engines.music.port=9999;
  const restart=structuredClone(f.baseline),before=structuredClone(restart.media_jobs.workers),setup=createMediaSetup(restart,f.store,f.options);
  assert.match(setup.status().hosts[0].error,/changed/);assert.deepEqual(restart.media_jobs.workers,before);
 }
});
test('successive qualified replacements retain a checked chain and restore the latest without requiring enabled mutation policy',t=>{
 const f=fixture(t),first=f.commit(0,'d'),second=f.commit(0,'e');assert.deepEqual(second.record.cells[0].before,first.record.cells[0].after);
 const restart=structuredClone(f.baseline);restart.media_jobs.improvements={enabled:false};const setup=createMediaSetup(restart,f.store,f.options);
 assert.equal(setup.status().hosts[0].error,null);assert.equal(restart.media_jobs.workers.pair.engines.music.container,'e'.repeat(64));assert.equal(f.store.data.media_engine_promotions.pair.length,2);
 const persisted=structuredClone(f.config);const already=createMediaSetup(persisted,f.store,f.options);assert.equal(already.status().hosts[0].error,null);assert.deepEqual(persisted.media_jobs.workers,f.config.media_jobs.workers);
});
test('legacy default-only enrollment is replaced narrowly without inventing a member override',t=>{
 const f=fixture(t);delete f.config.media_jobs.workers.pair.member_engines;delete f.config.media_jobs.workers.pair.engines.music.member;
 // This fixture change is a new initial configuration, before its first promotion.
 f.baseline=structuredClone(f.config);const setup=createMediaSetup(f.config,f.store,f.options),original=f.config.media_jobs.workers.pair.engines.music;
 const proposal=setup.promotions.propose({operation_id:randomUUID(),worker_id:'pair',member:0,original,candidate:{...original,container:'d'.repeat(64),image:'sha256:'+'d'.repeat(64)},qualification_job_id:randomUUID(),proof_sha256:'f'.repeat(64)});
 assert.deepEqual(proposal.record.cells.map(c=>c.slot),['default']);assert.equal(proposal.next.member_engines,undefined);assert.equal(proposal.next.engines.music.member,undefined);
});
test('replacement cannot alter port or nonidentity engine settings',t=>{
 const f=fixture(t),original=f.config.media_jobs.workers.pair.engines.music;
 assert.throws(()=>f.setup.promotions.propose({operation_id:randomUUID(),worker_id:'pair',member:0,original,candidate:{...original,container:'d'.repeat(64),image:'sha256:'+'d'.repeat(64),port:9999},qualification_job_id:randomUUID(),proof_sha256:'f'.repeat(64)}),/preserves all/);
 assert.equal(f.store.data.media_engine_enrollments,undefined);
});

test('engines installed only in retained state promote and restore from an empty configured music slot',t=>{
 const f=fixture(t),initial=f.commit(0),host=initial.record.host_binding,old=structuredClone(f.baseline.media_jobs.workers.pair);
 f.store.save({other:{keep:1},media_engine_enrollments:{pair:{...old,host_binding:host}}});
 const absent=structuredClone(f.baseline);delete absent.media_jobs.workers.pair.engines.music;delete absent.media_jobs.workers.pair.member_engines[0].music;delete absent.media_jobs.workers.pair.member_engines[1].music;
 const configured=structuredClone(absent),setup=createMediaSetup(configured,f.store,f.options);assert.equal(setup.status().hosts[0].error,null);const original=configured.media_jobs.workers.pair.member_engines[0].music;
 const proposal=setup.promotions.propose({operation_id:randomUUID(),worker_id:'pair',member:0,original,candidate:{...original,container:'e'.repeat(64),image:'sha256:'+'e'.repeat(64)},qualification_job_id:randomUUID(),proof_sha256:'f'.repeat(64)});
 assert.ok(proposal.record.cells.every(c=>c.configured_before===null));
 f.store.save({...f.store.data,media_candidates:{[proposal.record.operation_id]:{phase:'promoted',promotion:{record_sha256:proposal.record_sha256}}},media_engine_promotions:{pair:[proposal.record]},media_engine_enrollments:{pair:proposal.enrollment}});
 const restarted=structuredClone(absent),again=createMediaSetup(restarted,f.store,f.options);assert.equal(again.status().hosts[0].error,null);
 assert.equal(restarted.media_jobs.workers.pair.engines.music.container,'e'.repeat(64));assert.equal(restarted.media_jobs.workers.pair.member_engines[1].music.container,'b'.repeat(64));assert.deepEqual(restarted.media_jobs.workers.pair.engines.video,old.engines.video);
});
