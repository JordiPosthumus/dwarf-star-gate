import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {setImmediate as tick} from 'node:timers/promises';
import {MediaJobs} from './media-jobs.mjs';
import {runParallelMediaCycle} from './media-parallel-cycle.mjs';

function fixture(t,count=4){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sg-parallel-media-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const jobs=new MediaJobs(path.join(dir,'jobs.json'));
  const ids=Array.from({length:count},(_,i)=>jobs.enqueue('video',{prompt:{one:{class_type:'Fixture'}}},{key:`job-${i}`}).job.id);
  const container=(digit,running)=>({Id:digit.repeat(64),Image:'sha256:'+'f'.repeat(64),Config:{intentional:true},HostConfig:{},Mounts:[],State:{Running:running,StartedAt:'original'}});
  const head=container('a',true),rank=container('b',true),engines=[container('c',false),container('d',false)],events=[],receipts={},progress=[];
  const plan={operation_id:ids[0],job_ids:ids,worker_id:'pair',llm_container:head.Id,llm_pair:{},recovery:{profile:'glm53-docker-pair'},
    media_lanes:engines.map((c,member)=>({member,engine:{kind:'comfyui',container:c.Id,image:c.Image},job_ids:ids.filter((_,i)=>i%2===member)}))};
  let held=false,active=0,maximum=0,firstSubmitted=Promise.withResolvers(),startCount=0;
  const backends=engines.map((c,member)=>({kind:'comfyui',request:async route=>route==='/object_info'?{Fixture:{}}:route==='/queue'?{queue_running:[],queue_pending:[]}: {},
    submit:async(_payload,id)=>{events.push(`submit:${member}:${id}`);maximum=Math.max(maximum,++active);if(++startCount===2)firstSubmitted.resolve();return {native_id:id};},
    observe:async id=>{await firstSubmitted.promise;events.push(`observed:${member}:${id}`);active--;return {state:'completed',result:{}};}}));
  jobs.collect=async id=>{events.push(`collect:${id}`);return jobs.update(id,{outputs:{state:'ready',files:[]}});};
  const pair={capture:async()=>events.push('capture'),check:async()=>{},stop:async()=>{events.push('stop-pair');head.State.Running=false;rank.State.Running=false;},
    restore:async()=>{assert.equal(active,0,'never restore over accepted generation');assert.ok(engines.every(c=>!c.State.Running));events.push('restore-pair');head.State.Running=true;rank.State.Running=true;}};
  const io={jobs,pair,inspect:async()=>structuredClone(head),save:(name,value)=>receipts[name]=structuredClone(value),delay:tick,hasMaintenanceIntent:()=>held,
    progress:(phase,detail,context)=>progress.push({phase,detail,...structuredClone(context)}),continueBatch:async()=>true,
    maintenance:async action=>{events.push(action);if(action==='prepare')held=true;return action==='finish'?{state:'readmitted'}:{owned:true};},
    recoveryInspect:async()=>({profile:plan.recovery.profile,listener:true,fault:null,instance:createHash('sha256').update(JSON.stringify([head.Id,head.State.StartedAt])).digest('hex').slice(0,32)}),
    verify:async()=>{events.push('verify');return {fixture:true};},watchProgress:()=>({snapshot:()=>({connected:true,node:'sample',value:1,max:20}),close:()=>{}}),
    forMember:lane=>({inspect:async()=>structuredClone(engines[lane.member]),start:async()=>{events.push(`start:${lane.member}`);engines[lane.member].State.Running=true;},
      stop:async()=>{events.push(`stop:${lane.member}`);engines[lane.member].State.Running=false;},connect:async()=>({backend:backends[lane.member],close:()=>events.push(`close:${lane.member}`)})})};
  return {jobs,ids,plan,io,events,receipts,progress,engines,head,backends,maximum:()=>maximum,firstSubmitted:firstSubmitted.promise};
}
test('two physical members overlap generation but share one drain and one verified pair restoration',async t=>{
  const f=fixture(t,8),result=await runParallelMediaCycle(f.plan,f.io);
  assert.equal(f.maximum(),2);assert.deepEqual(result.completed_job_ids,f.ids);assert.equal(result.llm_return_verified,true);
  for(const name of ['capture','prepare','stop-pair','restore-pair','verify','finish','start:0','start:1','stop:0','stop:1'])assert.equal(f.events.filter(e=>e===name).length,1,name);
  const lastCollect=Math.max(...f.events.map((e,i)=>e.startsWith('collect:')?i:-1));assert.ok(f.events.indexOf('restore-pair')>lastCollect);
  assert.equal(f.progress.at(-1).phase,'returned');assert.equal(f.progress.at(-1).lanes.length,2);
  for(const id of f.ids)assert.equal(f.events.filter(e=>e.endsWith(':'+id)&&e.startsWith('submit:')).length,1);
});
test('one failed member waits for the other accepted native job; later clips stay queued',async t=>{
  const f=fixture(t),release=Promise.withResolvers(),observed=f.backends[1].observe;
  f.backends[0].observe=async()=>{await f.firstSubmitted;return {state:'failed',result:{}};};
  f.backends[1].observe=async id=>{await release.promise;return observed(id);};
  // A failed native job has finished, so remove its fixture active count using
  // the normal observation before returning the failure state.
  const normal=f.backends[0].submit;let failedId;
  f.backends[0].submit=async(payload,id)=>{failedId=id;return normal(payload,id);};
  f.backends[0].observe=async id=>{await observed(id);return {state:'failed',result:{}};};
  const running=runParallelMediaCycle(f.plan,f.io);const outcome=assert.rejects(running,/generation failed/);
  await f.firstSubmitted;await tick();await tick();
  assert.ok(!f.events.includes('restore-pair'));assert.ok(!f.events.includes('stop:1'));assert.equal(f.jobs.get(f.ids[1]).state,'submitted');
  release.resolve();await outcome;
  assert.equal(f.jobs.get(failedId).state,'failed');assert.equal(f.jobs.get(f.ids[1]).outputs.state,'ready');
  assert.ok(f.ids.slice(2).every(id=>f.jobs.get(id).state==='queued'));assert.equal(f.progress.at(-1).phase,'failed_returned');
});
test('transient native observation failure never resubmits and retains the shared pair',async t=>{
  const f=fixture(t,2),observe=f.backends[0].observe;let attempts=0;
  f.backends[0].observe=async id=>{if(++attempts===1)throw Error('connection lost');return observe(id);};
  await runParallelMediaCycle(f.plan,f.io);assert.equal(attempts,2);assert.equal(f.events.filter(e=>e.startsWith('submit:0:')).length,1);
  assert.ok(f.progress.some(p=>p.lanes.some(l=>l.phase==='observing_media')));
});
test('uncertain native submission keeps its original ID and blocks restoration until observed completion',async t=>{
  const f=fixture(t,2),submit=f.backends[0].submit,observe=f.backends[0].observe;let observations=0;
  f.backends[0].submit=async(payload,id)=>{await submit(payload,id);throw Error('native acknowledgement lost');};
  f.backends[0].observe=async id=>{assert.equal(id,f.ids[0]);if(++observations===1)return {state:'unknown'};return observe(id);};
  await runParallelMediaCycle(f.plan,f.io);
  assert.equal(f.events.filter(e=>e.startsWith('submit:0:')).length,1);assert.equal(observations,2);
  assert.equal(f.jobs.get(f.ids[0]).native_id,f.ids[0]);assert.ok(f.progress.some(p=>p.lanes.some(l=>l.detail.includes('uncertain'))));
});
test('one media startup failure submits no clips and restores both original LLM members once',async t=>{
  const f=fixture(t),member=f.io.forMember;
  f.io.forMember=lane=>{const io=member(lane);if(lane.member===1)io.start=async()=>{throw Error('fixture start refused');};return io;};
  await assert.rejects(runParallelMediaCycle(f.plan,f.io),/start refused/);
  assert.equal(f.events.filter(e=>e.startsWith('submit:')).length,0);assert.equal(f.events.filter(e=>e==='restore-pair').length,1);
  assert.equal(f.progress.at(-1).phase,'failed_returned');assert.equal(f.head.State.Running,true);
});
test('unavailable ownership or native idle evidence prevents pair readmission',async t=>{
  for(const fault of ['ownership','native-idle']){
    const f=fixture(t,2),maintenance=f.io.maintenance,request=f.backends[1].request;
    if(fault==='ownership')f.io.maintenance=async action=>action==='owned'?{owned:false}:maintenance(action);
    else f.backends[1].request=async route=>{if(route==='/queue'&&f.jobs.get(f.ids[1]).state==='completed')throw Error('native queue unavailable');return request(route);};
    await assert.rejects(runParallelMediaCycle(f.plan,f.io));assert.equal(f.progress.at(-1).phase,'needs_attention');
    assert.ok(!f.events.includes('restore-pair'));assert.ok(!f.events.includes('finish'));
    assert.ok(f.ids.every(id=>f.jobs.get(id).outputs.state==='ready'));
  }
});
test('invalid overlapping lane assignments refuse before capturing or changing any host',async t=>{
  const f=fixture(t);f.plan.media_lanes[1].job_ids.push(f.ids[0]);
  await assert.rejects(runParallelMediaCycle(f.plan,f.io),/exactly one/);assert.deepEqual(f.events,[]);
});
