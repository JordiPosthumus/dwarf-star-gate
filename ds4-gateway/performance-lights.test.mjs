import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {PerformanceHistory,PerformanceReader,performanceProfile,performanceThresholds,performanceActive} from './performance-lights.mjs';
const M=60000,now=Date.parse('2026-09-06T14:00:00Z'),epoch='a'.repeat(64);let serial=0;
const row=(node,time,kind,extra={})=>({node,time,kind,sample_id:(++serial).toString(16).padStart(64,'0'),backend_epoch:epoch,...extra});
const device=(id='spark-a',extra={})=>({id,backend_epoch:epoch,connected:true,active:true,decode:{time:now},prefill:{time:now},...extra});
function request(history,at,rate=20,{node='spark-a',prompt=8192,cached=0,backend_epoch=epoch,profile=null,seconds=30,mode=null}={}){
  const common={backend_epoch};
  if(mode==='disk')history.accept(row(node,at-1,'disk_restore',{...common,cached:cached||1,load_ms:10000}));
  history.accept(row(node,at,'start',{...common,prompt,cached,new_tokens:prompt-cached,performance_profile:profile}));
  history.accept(row(node,at+1000,'prefill_done',{...common,prompt,cached,new_tokens:prompt-cached,seconds:1}));
  history.accept(row(node,at+seconds*1000+1000,'decode',{...common,generated:rate*seconds,seconds,thinking:true}));
  history.accept(row(node,at+seconds*1000+1001,'finish',common));
}
function populate(h,rate=20,options={}){
  for(const offset of [180,170,160,150])request(h,now-offset*M,20,options);
  for(const offset of [19,16,9,6,2])request(h,now-offset*M,rate,options);
}
test('decode compares weighted token/time deltas with self history independently of unsupported peers',()=>{
 const h=new PerformanceHistory();populate(h);const s=h.snapshot(now,[device()]),d=s.workers['spark-a'].decode;
 assert.equal(d.level,'green');assert.equal(d.basis,'self');assert.equal(d.recent.tps,20);assert.equal(d.self.baseline_tps,20);
 assert.equal(d.peers.reason,'peer_configuration_unverified');assert.equal(d.recent.seconds,150);assert.equal(d.recent.requests,5);
 assert.ok(!JSON.stringify(s).includes(epoch),'raw process and request digests are internal');
});
test('slowdowns require disjoint sustained evidence; a lone slow request is grey',()=>{
 for(const [rate,level] of [[16,'amber'],[12,'red']]){const h=new PerformanceHistory();populate(h,rate);assert.equal(h.snapshot(now,[device()]).workers['spark-a'].decode.level,level);}
 const h=new PerformanceHistory();for(const offset of [180,170,160])request(h,now-offset*M);request(h,now-2*M,10,{seconds:90});
 assert.equal(h.snapshot(now,[device()]).workers['spark-a'].decode.level,'grey');
 const oneBlock=new PerformanceHistory();for(const offset of [180,170,160])request(oneBlock,now-offset*M);
 for(const offset of [9,6,2])request(oneBlock,now-offset*M,10);
 assert.equal(oneBlock.snapshot(now,[device()]).workers['spark-a'].decode.reason,'awaiting_sustained_confirmation');
});
test('context shifts, restarts without build identity, stale and idle remain unknown without erasing history',()=>{
 const h=new PerformanceHistory();populate(h);
 for(const offset of [19,16,9,6,2])request(h,now-offset*M,10,{node:'long',prompt:131072});
 assert.equal(h.snapshot(now,[device('long')]).workers.long.decode.level,'grey');
 const count=h.intervals.length;
 for(const d of [device('spark-a',{backend_epoch:'b'.repeat(64)}),device('spark-a',{connected:false}),device('spark-a',{active:false}),device('spark-a',{decode:{time:now-16000}})])assert.equal(h.snapshot(now,[d]).workers['spark-a'].decode.level,'grey');
 assert.equal(h.intervals.length,count);
});
test('equivalent attested peers can support a comparison; other hardware and builds cannot',()=>{
 const profile=performanceProfile({hardware:'GB10',model:'DS4',quantization:'Q2',engine_build:'build-a',concurrency:1});
 const other=performanceProfile({hardware:'M3',model:'DS4',quantization:'Q2',engine_build:'build-a',concurrency:1});
 const h=new PerformanceHistory();
 for(const offset of [19,16,9,6,2]){request(h,now-offset*M,12,{profile});request(h,now-offset*M,20,{node:'spark-b',profile});request(h,now-offset*M,200,{node:'mac',profile:other});}
 const d=h.snapshot(now,[device()]).workers['spark-a'].decode;assert.equal(d.level,'red');assert.equal(d.basis,'peers');assert.equal(d.baseline_tps,20);
 assert.equal(performanceProfile({hardware:'GB10',concurrency:2}),null);
});
test('prefill compares cold, cached suffix and restored suffix work separately and excludes restore duration',()=>{
 const h=new PerformanceHistory();populate(h,20,{cached:4096,mode:'disk'});
 const p=h.snapshot(now,[device()]).workers['spark-a'].prefill;
 assert.equal(p.level,'grey','five seconds of prefill is insufficient, even with large token counts');
 assert.equal(h.intervals.filter(r=>r.kind==='prefill').reduce((n,r)=>n+r.seconds,0),9);
 assert.ok(h.intervals.filter(r=>r.kind==='prefill').every(r=>r.cohort.includes('restored_suffix')));
});
test('counter regression, overlapping starts and replay cannot fabricate healthy observations',()=>{
 const h=new PerformanceHistory();const start=row('spark-a',now-10000,'start',{prompt:8192,cached:0,new_tokens:8192});h.accept(start);
 const first=row('spark-a',now-9000,'decode',{generated:20,seconds:1});h.accept(first);h.accept(first);
 h.accept(row('spark-a',now-8000,'decode',{generated:10,seconds:2}));h.accept(row('spark-a',now-7000,'decode',{generated:30,seconds:3}));
 assert.equal(h.intervals.length,1);
 h.accept(row('spark-a',now-6000,'start',{prompt:8192,cached:0,new_tokens:8192}));assert.equal(h.intervals.length,0);
 h.accept(row('spark-a',now-5000,'decode',{generated:20,seconds:1}));assert.equal(h.intervals.length,0);
});
test('seven-day reader retains history across reconstruction and exposes bounded or unavailable evidence',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dsg-performance-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const rows=[],collector={accept:r=>rows.push(r)};populate(collector);
 // History really lives in a third daily file, outside the old two-file pulse.
 fs.writeFileSync(path.join(dir,'metrics-2026-09-04.jsonl'),rows.slice(0,16).map(r=>JSON.stringify({...r,private_text:'NEVER EXPORT'})).join('\n')+'\n');
 fs.writeFileSync(path.join(dir,'metrics-2026-09-05.jsonl'),'');fs.writeFileSync(path.join(dir,'metrics-2026-09-06.jsonl'),rows.slice(16).map(r=>JSON.stringify(r)).join('\n')+'\n');
 for(let i=0;i<2;i++){const reader=new PerformanceReader(dir);reader.poll(now);const s=reader.snapshot(now,[device()]);assert.equal(s.workers['spark-a'].decode.level,'green');assert.ok(!JSON.stringify(s).includes('NEVER EXPORT'));assert.equal(reader.snapshot(now+16000,[device()]).workers['spark-a'].decode.reason,'history_reader_unavailable');}
 assert.throws(()=>performanceThresholds({amber_slowdown:.4,red_slowdown:.3}));
 assert.deepEqual(performanceThresholds({amber_slowdown:.1,red_slowdown:.2}),{amber:.1,red:.2});
});

test('workload mix is standardized by matched context instead of producing a false slowdown',()=>{
 const h=new PerformanceHistory();
 for(let i=0;i<10;i++)request(h,now-(200-i*2)*M,20,{prompt:8192});
 for(let i=0;i<3;i++)request(h,now-(150-i*2)*M,10,{prompt:65536});
 for(let i=0;i<3;i++)request(h,now-(28-i)*M,20,{prompt:8192});
 for(let i=0;i<12;i++)request(h,now-(24-i)*M,10,{prompt:65536});
 const d=h.snapshot(now,[device()]).workers['spark-a'].decode;
 assert.equal(d.level,'green');assert.equal(d.recent.tps,12);assert.equal(d.baseline_tps,12);assert.equal(d.slowdown,0);
});
test('prefill cold and restored-suffix baselines cannot stand in for an unsupported cached suffix',()=>{
 const h=new PerformanceHistory();
 const add=(at,cached,mode)=>{
   if(mode==='disk')h.accept(row('spark-a',at-1,'disk_restore',{cached,load_ms:5000}));
   h.accept(row('spark-a',at,'start',{prompt:8192,cached,new_tokens:8192-cached}));
   h.accept(row('spark-a',at+30000,'prefill_done',{prompt:8192,cached,new_tokens:8192-cached,seconds:30}));
   h.accept(row('spark-a',at+30001,'finish'));
 };
 for(const n of [180,170,160])add(now-n*M,0);
 for(const n of [150,140,130])add(now-n*M,4096,'disk');
 for(const n of [19,16,9,6,2])add(now-n*M,4096);
 const p=h.snapshot(now,[device()]).workers['spark-a'].prefill;
 assert.equal(p.level,'grey');assert.equal(p.self.matched_fraction,0);
 for(const n of [120,110,100])add(now-n*M,4096);
 // The backfill in the test is accepted only after the previous requests have
 // finished; snapshot uses event timestamps, not insertion order, for windows.
 assert.equal(h.snapshot(now,[device()]).workers['spark-a'].prefill.level,'green');
});

test('worker metadata is bounded independently of interval history',()=>{
 const h=new PerformanceHistory();
 for(let i=0;i<600;i++){
   h.accept(row(`worker-${i}`,now-1000,'start',{prompt:8192,cached:0,new_tokens:8192}));
   h.accept(row(`disk-${i}`,now,'disk_restore',{cached:100,load_ms:10}));
 }
 assert.equal(h.contexts.size,512);assert.ok(h.states.size<=512);assert.equal(h.restore.size,512);
 assert.ok(h.snapshot(now,[]).exclusion_reasons.metadata_budget>0);
});

test('unchanged attested configurations support history across restarts; changed builds do not',()=>{
 const original=performanceProfile({hardware:'GB10',model:'DS4',quantization:'Q2',engine_build:'one',concurrency:1}),changed=performanceProfile({hardware:'GB10',model:'DS4',quantization:'Q2',engine_build:'two',concurrency:1});
 for(const [profile,level] of [[original,'green'],[changed,'grey']]){
   const h=new PerformanceHistory();for(const n of [180,170,160])request(h,now-n*M,20,{profile:original});
   for(const n of [19,16,9,6,2])request(h,now-n*M,20,{profile,backend_epoch:'b'.repeat(64)});
   assert.equal(h.snapshot(now,[device('spark-a',{backend_epoch:'b'.repeat(64)})]).workers['spark-a'].decode.level,level);
   assert.ok(h.intervals.some(r=>r.epoch===epoch),'old evidence remains retained');
 }
});
test('direct engine activity is observed without inventing idle or zero speed from absent gateway occupancy',()=>{
 assert.equal(performanceActive({connected:true,last_event:now,phase:'thinking'},{load:0},now),true);
 assert.equal(performanceActive({connected:true,last_event:now,phase:'idle'},{load:0},now),false);
 assert.equal(performanceActive({connected:true,last_event:now-16000,phase:'decode'},{load:0},now),null);
 assert.equal(performanceActive({connected:false},{load:1},now),true);
});
