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
  assert.deepEqual(snapshot.windows['1h'].energy.workers.map(row=>row.worker),['spark-a','spark-b'],'energy coverage names the current configured workers');
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
  for(let i=0;i<=60;i++)speed.accept(row(100+i,'one',start+i*60000,'hardware',{power_watts:100,power_scope:'compute_module'}));
  let energy=speed.snapshot(now,['one']).windows['1h'].energy;
  assert.equal(energy.status,'estimated_from_measured_power');assert.ok(Math.abs(energy.estimated_kwh-.1)<1e-9);assert.equal(energy.coverage_pct,100);
  energy=speed.snapshot(now,['one','two']).windows['1h'].energy;
  assert.equal(energy.estimated_kwh,null);assert.equal(energy.status,'insufficient_power_coverage');assert.equal(energy.coverage_pct,50);
});

test('power integration never bridges gaps or rolls its cursor backward',()=>{
  const speed=new FleetSpeed(),start=now-100000;
  speed.accept(row(200,'one',start,'hardware',{power_watts:100,power_scope:'system'}));
  speed.accept(row(201,'one',start+61000,'hardware',{power_watts:100,power_scope:'system'}));
  speed.accept(row(202,'one',start+30000,'hardware',{power_watts:500,power_scope:'system'}));
  speed.accept(row(203,'one',start+91000,'hardware',{power_watts:100,power_scope:'system'}));
  const snapshot=speed.snapshot(now,['one']);
  assert.equal(snapshot.power_intervals,1,'only the final 30-second adjacent interval is integrated');
  assert.ok(snapshot.rejected_records>=1);assert.equal(snapshot.windows['1h'].energy.estimated_kwh,null);
});

test('power without an honest whole-device scope is never integrated',()=>{
  const speed=new FleetSpeed();speed.accept(row(300,'one',now-10000,'hardware',{power_watts:100}));speed.accept(row(301,'one',now,'hardware',{power_watts:100,power_scope:'gpu_only'}));
  const snapshot=speed.snapshot(now,['one']);assert.equal(snapshot.power_intervals,0);assert.equal(snapshot.rejected_records,1);assert.equal(snapshot.excluded_power_records,1);
});


test('older GPU-only observations cannot erase the measured-system integration cursor',()=>{
 const speed=new FleetSpeed();
 speed.accept(row(401,'one',now-30000,'hardware',{power_watts:100,power_scope:'system',power_sensor:'smc_pstr'}));
 speed.accept(row(402,'one',now-40000,'hardware',{power_watts:50,power_scope:'gpu_only'}));
 speed.accept(row(403,'one',now,'hardware',{power_watts:200,power_scope:'system',power_sensor:'smc_pstr'}));
 const energy=speed.snapshot(now,['one','missing']).windows['1h'].energy;
 assert.ok(Math.abs(energy.measured_kwh-150*30/3600000)<1e-12);
 assert.deepEqual(energy.workers[0].sensors,['smc_pstr']);assert.equal(energy.workers[1].coverage_pct,0);
 assert.equal(energy.estimated_kwh,null);assert.equal(speed.snapshot(now,[]).windows['1h'].energy.measured_kwh,0);
});

test('scope changes break adjacency and thermal-only rows add no power coverage',()=>{
 const speed=new FleetSpeed();
 speed.accept(row(410,'one',now-40000,'hardware',{power_watts:100,power_scope:'system'}));
 speed.accept(row(411,'one',now-30000,'hardware',{power_watts:100,power_scope:'compute_module'}));
 speed.accept(row(412,'one',now-20000,'hardware',{temperatures:[{celsius:70}]}));
 speed.accept(row(413,'one',now-10000,'hardware',{power_watts:100,power_scope:'compute_module'}));
 const energy=speed.snapshot(now,['one']).windows['1h'].energy;
 assert.ok(Math.abs(energy.measured_kwh-100*20/3600000)<1e-12);assert.equal(speed.energy.length,1);
});


test('a clipped energy interval integrates its linear power curve at the window boundary',()=>{
 const speed=new FleetSpeed(),from=now-HOUR;
 speed.accept(row(420,'one',from-30000,'hardware',{power_watts:100,power_scope:'system'}));
 speed.accept(row(421,'one',from+30000,'hardware',{power_watts:300,power_scope:'system'}));
 const energy=speed.snapshot(now,['one']).windows['1h'].energy;
 assert.ok(Math.abs(energy.measured_kwh-250*30/3600000)<1e-12);
});

test('worker rolling averages weight active time, clip six-hour edges, and compare adjacent halves',()=>{
  const reader=new FleetSpeedReader('/tmp/unused-rolling-rates');reader.status='ready';
  const add=(end,duration,rate,kind='prefill',node='spark-a')=>reader.speed.intervals.push({node,kind,start:end-duration*1000,end,seconds:duration,tokens:duration*rate,rate});
  // Half of this interval is outside the six-hour window.
  add(now-6*HOUR+30000,60,100);
  for(let i=0;i<3;i++){add(now-4*HOUR+i*60000,30,100);add(now-HOUR+i*60000,60,200);}
  add(now-HOUR,60,999,'prefill','another-worker');
  let r=reader.workerRates('spark-a',now).prefill;
  assert.equal(r.mean_tps,160);assert.equal(r.active_seconds,300);assert.equal(r.samples,7);
  assert.equal(r.change_pct,100);assert.equal(r.trend,'up');assert.equal(r.history_span_ms,6*HOUR);
  assert.equal(reader.workerRates('spark-a',now).decode.mean_tps,null);
  assert.equal(reader.workerRates('spark-a',now+7*HOUR).prefill.mean_tps,null,'idle history expires');
  reader.speed.intervals.forEach(r=>{if(r.end>now-3*HOUR&&r.node==='spark-a'){r.tokens=r.seconds*50;r.rate=50;}});
  assert.equal(reader.workerRates('spark-a',now).prefill.trend,'down');
  reader.speed.intervals.forEach(r=>{if(r.end>now-3*HOUR&&r.node==='spark-a'){r.tokens=r.seconds*102;r.rate=102;}});
  assert.equal(reader.workerRates('spark-a',now).prefill.trend,'steady');
  reader.status='catching_up';assert.equal(reader.workerRates('spark-a',now).prefill.mean_tps,null);
  reader.status='ready';reader.malformed=1;r=reader.workerRates('spark-a',now).prefill;
  assert.equal(r.trend,'insufficient');assert.equal(r.partial_history,true);
});

test('rolling rates recover persisted cumulative samples without double-counting request totals or replay',t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'rolling-rates-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const rows=[row(1,'spark-a',now-10000,'start'),row(2,'spark-a',now-5000,'prefill',{processed:500,seconds:5}),row(3,'spark-a',now,'prefill_done',{new_tokens:1000,seconds:10})];
  fs.writeFileSync(path.join(directory,'metrics-2026-09-07.jsonl'),[...rows,...rows].map(r=>JSON.stringify(r)).join('\n')+'\n');
  for(let i=0;i<2;i++){
    const reader=new FleetSpeedReader(directory);reader.poll(now);const r=reader.workerRates('spark-a',now).prefill;
    assert.equal(r.mean_tps,100);assert.equal(r.active_seconds,10);assert.equal(r.samples,2);assert.equal(r.trend,'insufficient');
  }
});
