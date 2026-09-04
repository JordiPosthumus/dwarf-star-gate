import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {FleetSpeed,FleetSpeedReader} from './fleet-speed.mjs';

const HOUR=3600000,now=48*HOUR,epoch='a'.repeat(64);
const sample=n=>n.toString(16).padStart(64,'0');
const row=(n,node,time,kind,extra={})=>({sample_id:sample(n),node,time,kind,backend_epoch:epoch,...extra});

test('fleet means difference cumulative counters and weight real active seconds, not repeated samples',()=>{
  const speed=new FleetSpeed();
  speed.accept(row(1,'spark-a',now-10000,'start'));
  speed.accept(row(2,'spark-a',now-5000,'decode',{generated:50,seconds:5,tps:10}));
  speed.accept(row(3,'spark-a',now,'decode',{generated:100,seconds:10,tps:10}));
  speed.accept(row(4,'spark-b',now-5000,'start'));
  speed.accept(row(5,'spark-b',now,'decode',{generated:100,seconds:5,tps:20}));
  // A replayed cumulative line has the same sample identity and contributes nothing.
  speed.accept(row(5,'spark-b',now,'decode',{generated:999,seconds:5,tps:999}));
  const snapshot=speed.snapshot(now+1,['spark-a','spark-b']),decode=snapshot.windows['1h'].decode;
  assert.ok(Math.abs(decode.mean_tps-200/15)<1e-9);assert.equal(decode.active_seconds,15);assert.equal(decode.samples,3);assert.equal(decode.observed_workers,2);
  assert.ok(Math.abs(decode.activity_lower_bound_pct-15/(2*3600)*100)<1e-9);
  assert.equal(snapshot.calibration.decode.max_tps,50);assert.equal(snapshot.intervals,3);
  assert.ok(!JSON.stringify(snapshot).includes('spark-a'),'the UI summary exports counts, not worker identities');
});

test('prefill uses processed/new-token deltas and clips an interval at the selected window boundary',()=>{
  const speed=new FleetSpeed();speed.accept(row(10,'one',now-HOUR-1000,'start'));
  speed.accept(row(11,'one',now-HOUR+1000,'prefill',{processed:1000,seconds:2,tps:500}));
  speed.accept(row(12,'one',now-HOUR+2000,'prefill_done',{new_tokens:1500,seconds:3}));
  const phase=speed.snapshot(now,['one']).windows['1h'].prefill;
  // The first 2-second interval straddles the exact boundary, so only half
  // its time/tokens is credited; the next full second is included.
  assert.equal(phase.active_seconds,2);assert.equal(phase.mean_tps,500);assert.equal(phase.samples,2);
});

test('counter regression, epoch change, malformed relevant rows and interval bounds fail closed',()=>{
  const speed=new FleetSpeed({maxIntervals:2});speed.accept(row(20,'one',now-4000,'start'));
  speed.accept(row(21,'one',now-3000,'decode',{generated:10,seconds:1}));
  speed.accept(row(22,'one',now-2000,'decode',{generated:5,seconds:2}));
  speed.accept(row(23,'one',now-1000,'decode',{generated:15,seconds:3}));
  speed.accept({...row(24,'one',now,'decode',{generated:20,seconds:4}),backend_epoch:'b'.repeat(64)});
  speed.accept({...row(25,'one',now,'decode',{generated:'private',seconds:5}),prompt:'PRIVATE'});
  const snapshot=speed.snapshot(now+1,['one']);assert.equal(snapshot.intervals,2);assert.ok(snapshot.rejected_records>=2);
  assert.ok(!JSON.stringify(snapshot).includes('PRIVATE'));
});

test('reader incrementally rebuilds two regular daily files and survives partial lines and replacement',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dsg-fleet-speed-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const old=path.join(dir,'metrics-2026-09-03.jsonl'),file=path.join(dir,'metrics-2026-09-04.jsonl');
  fs.writeFileSync(old,JSON.stringify(row(30,'one',now-20000,'start'))+'\n');
  const first=JSON.stringify(row(31,'one',now-10000,'decode',{generated:100,seconds:10}));fs.writeFileSync(file,first.slice(0,-2));
  const reader=new FleetSpeedReader(dir,{readBytes:1024});reader.poll(now);assert.equal(reader.snapshot(now,['one']).windows['1h'].decode.mean_tps,null);
  fs.appendFileSync(file,first.slice(-2)+'\n');reader.poll(now);assert.equal(reader.snapshot(now,['one']).windows['1h'].decode.mean_tps,10);
  fs.renameSync(file,path.join(dir,'replaced'));fs.writeFileSync(file,[JSON.stringify(row(32,'one',now-5000,'start')),JSON.stringify(row(33,'one',now,'decode',{generated:100,seconds:5}))].join('\n')+'\n');
  reader.poll(now);assert.equal(reader.status,'rescanning');reader.poll(now);assert.equal(reader.snapshot(now,['one']).windows['1h'].decode.mean_tps,20);
  const target=path.join(dir,'metrics-2026-09-05-real.jsonl');fs.writeFileSync(target,'');fs.symlinkSync(target,path.join(dir,'metrics-2026-09-05.jsonl'));
  reader.poll(now);assert.equal(reader.status,'rescanning');reader.poll(now);assert.equal(reader.status,'unavailable');
});

test('energy is estimated only when every current worker has dense measured power coverage',()=>{
  const speed=new FleetSpeed(),start=now-HOUR;
  for(let i=0;i<=60;i++)speed.accept(row(100+i,'one',start+i*60000,'hardware',{power_watts:100}));
  let energy=speed.snapshot(now,['one']).windows['1h'].energy;
  assert.equal(energy.status,'estimated_from_measured_power');assert.ok(Math.abs(energy.estimated_kwh-.1)<1e-9);assert.equal(energy.coverage_pct,100);
  energy=speed.snapshot(now,['one','two']).windows['1h'].energy;
  assert.equal(energy.estimated_kwh,null);assert.equal(energy.status,'insufficient_power_coverage');assert.equal(energy.coverage_pct,50);
});

test('power integration never bridges gaps or rolls its cursor backward',()=>{
  const speed=new FleetSpeed(),start=now-100000;
  speed.accept(row(200,'one',start,'hardware',{power_watts:100}));
  speed.accept(row(201,'one',start+61000,'hardware',{power_watts:100}));
  speed.accept(row(202,'one',start+30000,'hardware',{power_watts:500}));
  speed.accept(row(203,'one',start+91000,'hardware',{power_watts:100}));
  const snapshot=speed.snapshot(now,['one']);
  assert.equal(snapshot.power_intervals,1,'only the final 30-second adjacent interval is integrated');
  assert.ok(snapshot.rejected_records>=1);assert.equal(snapshot.windows['1h'].energy.estimated_kwh,null);
});
