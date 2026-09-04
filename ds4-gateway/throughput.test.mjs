import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {FleetThroughput} from './throughput.mjs';
import {AnalyticsReader} from './analytics.mjs';
const HOUR=3600000,now=48*HOUR;
const finish=(id,at,usage={completion_tokens:100,prompt_tokens:1000,cached_tokens:800},extra={})=>({schema:1,run_id:'run-a',request_id:id,event_id:id,node:'worker-a',time:new Date(at).toISOString(),kind:'finish',outcome:'complete',usage,...extra});
test('rolling output, peak hour, token-weighted cache reuse and request counts have exact boundaries',()=>{
  const f=new FleetThroughput();
  for(const r of [finish('a',now-HOUR+1),finish('b',now-1,{completion_tokens:200,prompt_tokens:9000,cached_tokens:4500}),finish('boundary',now-HOUR),finish('past-a',now-3*HOUR),finish('past-b',now-3*HOUR+1,{completion_tokens:500,prompt_tokens:10,cached_tokens:0}),finish('old',now-24*HOUR),finish('future',now+1)])f.accept(r);
  const s=f.snapshot(now);assert.equal(s.completed_1h,2);assert.equal(s.output_tokens_1h,300);
  assert.equal(s.peak_output_tokens_1h,600);assert.equal(s.peak_hour_end_at,now-3*HOUR+1);
  assert.equal(s.cached_tokens_1h,5300);assert.equal(s.cache_reuse_pct_1h,53);assert.equal(s.completed_24h,5);
  assert.equal(f.snapshot(now+25*HOUR).completed_1h,0);
});
test('missing usage, failed work, invalid cached totals and genuine zeros stay distinct',()=>{
  const f=new FleetThroughput();f.accept(finish('none',now,null));let s=f.snapshot(now);
  assert.equal(s.output_tokens_1h,null);assert.equal(s.cached_tokens_1h,null);assert.equal(s.peak_output_tokens_1h,null);assert.equal(s.completed_1h,1);
  f.accept(finish('zero',now,{completion_tokens:0,prompt_tokens:100,cached_tokens:0}));f.accept(finish('failed',now,undefined,{outcome:'client_cancelled'}));
  f.accept(finish('bad-cache',now,{completion_tokens:10,prompt_tokens:100,cached_tokens:101}));
  s=f.snapshot(now);assert.equal(s.output_tokens_1h,10);assert.equal(s.cache_reuse_pct_1h,0);assert.equal(s.output_known_1h,2);assert.equal(s.cache_known_1h,1);assert.equal(s.excluded_terminal_1h,1);
  f.accept({...finish('fraction',now),usage:{completion_tokens:1.5,prompt_tokens:'100',cached_tokens:0}});assert.equal(f.snapshot(now).output_tokens_1h,10);
});
test('duplicates, conflicting terminal records, process runs and bounds cannot inflate totals',()=>{
  const f=new FleetThroughput({maxRecords:3}),a=finish('a',now);f.accept(a);f.accept(a);assert.equal(f.snapshot(now).completed_1h,1);
  f.accept({...a,usage:{completion_tokens:999}});assert.equal(f.snapshot(now).completed_1h,0);
  f.accept({...a,run_id:'run-b'});assert.equal(f.snapshot(now).completed_1h,1);
  f.accept(finish('b',now));f.accept(finish('c',now));assert.equal(f.records.size,3);assert.equal(f.snapshot(now).evicted_records,1);
  f.accept({...finish('bad',now),time:'invalid'});assert.equal(f.snapshot(now).rejected_records,2);
});
test('overflow is unknown and exports never contain worker/session/prompt/embedding content',()=>{
  const f=new FleetThroughput();for(const id of ['a','b'])f.accept(finish(id,now,{completion_tokens:Number.MAX_SAFE_INTEGER,prompt_tokens:1,cached_tokens:0},{session:'PRIVATE',prompt:'PRIVATE',vectors:'PRIVATE'}));
  const s=f.snapshot(now);assert.equal(s.output_tokens_1h,null);assert.equal(s.peak_output_tokens_1h,null);assert.ok(!/PRIVATE|worker-a|run-a/.test(JSON.stringify(s)));
  f.accept({...finish('bad',now),time:'invalid'});assert.equal(f.snapshot(now).rejected_records,1);
});
test('reader rebuilds counters after file replacement and survives a dashboard-reader restart without duplication',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dsg-throughput-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'routing-2000-01-01.jsonl'),write=r=>fs.writeFileSync(file,JSON.stringify(r)+'\n');write(finish('a',now));
  const reader=new AnalyticsReader(dir,{enabled:true});reader.poll(now);reader.poll(now);assert.equal(reader.snapshot(now).throughput.output_tokens_1h,100);
  const again=new AnalyticsReader(dir,{enabled:true});again.poll(now);assert.equal(again.snapshot(now).throughput.output_tokens_1h,100);
  fs.renameSync(file,path.join(dir,'old'));write(finish('b',now,{completion_tokens:200,prompt_tokens:300,cached_tokens:200}));reader.poll(now);assert.equal(reader.status,'rescanning');reader.poll(now);assert.equal(reader.snapshot(now).throughput.output_tokens_1h,200);
  assert.equal(new AnalyticsReader(dir).snapshot(now).status,'disabled');
});
