import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {HardwareTelemetry,hardwareTelemetryConfig,nvidiaLinuxCommand,parseNvidiaLinux} from './hardware-telemetry.mjs';

const now=Date.UTC(2026,8,4,12),valid='DSG_HW_V1|131072,32768|88.5,42,1200';

test('Spark parser labels unified host memory and accepts only measured module power',()=>{
  assert.deepEqual(parseNvidiaLinux(valid,now),{time:now,memory_used_bytes:100663296,memory_total_bytes:134217728,memory_scope:'host_unified',accelerator_activity_pct:42,accelerator_scope:'gpu_kernel_time',power_watts:88.5,power_scope:'compute_module',clock_mhz:1200,clock_scope:'sm'});
  const partial=parseNvidiaLinux('DSG_HW_V1|131072,32768|,0,',now);assert.equal(partial.power_watts,undefined);assert.equal(partial.clock_mhz,undefined);assert.equal(partial.accelerator_activity_pct,0);
  for(const bad of ['',valid+'|private','DSG_HW_V1|x,y|x,y,z','DSG_HW_V1|x,y|,,'])assert.equal(parseNvidiaLinux(bad,now),null);
  const command=nvidiaLinuxCommand(10000);assert.match(command,/module\.power\.draw\.instant/);assert.match(command,/MemAvailable/);assert.doesNotMatch(command,/memory\.used/);assert.throws(()=>nvidiaLinuxCommand(9000));
});

test('configuration is explicit, bounded and rejects arbitrary commands or paths',()=>{
  assert.equal(hardwareTelemetryConfig().enabled,false);assert.equal(hardwareTelemetryConfig({enabled:false,workers:{private:{adapter:'nvidia-linux'}}}).enabled,false);
  const parsed=hardwareTelemetryConfig({enabled:true,interval_ms:15000,workers:{spark:{adapter:'nvidia-linux'},studio:{adapter:'jsonl-file',path:'/tmp/studio.jsonl'}}});
  assert.equal(parsed.workers.size,2);assert.equal(parsed.interval_ms,15000);
  for(const bad of [
    {enabled:true,workers:{spark:{adapter:'nvidia-linux',command:'reboot'}}},
    {enabled:true,interval_ms:9999,workers:{}},
    {enabled:true,workers:{studio:{adapter:'jsonl-file',path:'relative'}}},
    {enabled:true,workers:{spark:{adapter:'shell'}}},
  ])assert.throws(()=>hardwareTelemetryConfig(bad));
});

test('local JSONL adapter is bounded, privacy-safe and preserves unknown fields as unknown',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dsg-hardware-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,'studio.jsonl'),rows=[];
  fs.writeFileSync(file,JSON.stringify({schema:1,time:now,memory_used_bytes:64,memory_total_bytes:128,memory_scope:'host_unified',power_watts:57,power_scope:'system',private_note:'DO NOT EXPORT'})+'\n');
  const telemetry=new HardwareTelemetry({enabled:true,workers:{studio:{adapter:'jsonl-file',path:file}}},row=>rows.push(row),{now:()=>now});telemetry.sync([],[{id:'studio'}]);telemetry.poll(now);
  const snapshot=telemetry.snapshot('studio',now);assert.equal(snapshot.state,'connected');assert.equal(snapshot.current.power_watts,57);assert.equal(snapshot.current.accelerator_activity_pct,undefined);assert.equal(rows.length,1);assert.match(rows[0].sample_id,/^[\da-f]{64}$/);
  telemetry.accept('studio',{time:now-1,power_watts:500,power_scope:'system'});assert.equal(telemetry.snapshot('studio',now).current.power_watts,57);assert.equal(telemetry.snapshot('studio',now).rejected,1);assert.equal(rows.length,1);
  const exported=JSON.stringify({snapshot,row:rows[0]});assert.ok(!exported.includes(file));assert.ok(!exported.includes('DO NOT EXPORT'));assert.ok(!exported.includes('private_note'));telemetry.close();
});

test('remote adapter uses fixed SSH argv, records samples and never exports its route',()=>{
  const children=[],rows=[],timers=[];let time=now;
  const spawnImpl=(file,args)=>{const child=new EventEmitter();child.stdout=new PassThrough();child.kill=()=>{child.killed=true;};children.push({file,args,child});return child;};
  const telemetry=new HardwareTelemetry({enabled:true,interval_ms:10000,workers:{spark:{adapter:'nvidia-linux'}}},row=>rows.push(row),{spawnImpl,now:()=>time,setTimer:(fn,ms)=>{const token={fn,ms};timers.push(token);return token;},clearTimer:token=>{token.cleared=true;}});
  telemetry.sync([{id:'spark',ssh:'spark-private-alias'}],[{id:'spark'}]);assert.equal(children.length,1);assert.equal(children[0].file,'/usr/bin/ssh');assert.ok(children[0].args.includes('spark-private-alias'));assert.equal(children[0].args.at(-1),nvidiaLinuxCommand(10000));
  children[0].child.stdout.write(valid+'\n');const snapshot=telemetry.snapshot('spark',time);assert.equal(snapshot.state,'connected');assert.equal(snapshot.current.power_scope,'compute_module');assert.equal(rows.length,1);assert.ok(!JSON.stringify(snapshot).includes('spark-private-alias'));assert.ok(!JSON.stringify(rows[0]).includes('spark-private-alias'));
  time+=61000;assert.equal(telemetry.snapshot('spark',time).state,'stale');telemetry.close();assert.equal(children[0].child.killed,true);
});

test('remote adapter times out, preserves the bounded reason and reconnects',()=>{
  const children=[],timers=[];
  const spawnImpl=()=>{const child=new EventEmitter();child.stdout=new PassThrough();child.kill=()=>{child.killed=true;};children.push(child);return child;};
  const setTimer=(fn,ms)=>{const timer={fn,ms,cleared:false};timers.push(timer);return timer;},clearTimer=timer=>{timer.cleared=true;};
  const telemetry=new HardwareTelemetry({enabled:true,workers:{spark:{adapter:'nvidia-linux'}}},()=>{},{spawnImpl,setTimer,clearTimer,now:()=>now});telemetry.sync([{id:'spark',ssh:'spark'}],[{id:'spark'}]);
  const watchdog=timers.find(timer=>timer.ms===35000);watchdog.fn();assert.equal(children[0].killed,true);assert.equal(telemetry.snapshot('spark',now).reason,'adapter_timeout');
  children[0].emit('close',255);assert.equal(telemetry.snapshot('spark',now).reason,'adapter_timeout');const retry=timers.find(timer=>timer.ms===10000&&!timer.cleared);retry.fn();assert.equal(children.length,2);assert.equal(telemetry.snapshot('spark',now).state,'connecting');telemetry.close();
});

test('unregistered and transport-less workers stay explicit without spawning',()=>{
  let calls=0;const telemetry=new HardwareTelemetry({enabled:true,workers:{spark:{adapter:'nvidia-linux'}}},()=>{},{spawnImpl:()=>{calls++;}});
  telemetry.sync([],[{id:'spark'}]);assert.equal(telemetry.snapshot('spark').reason,'management_transport_unavailable');telemetry.sync([],[]);assert.equal(telemetry.snapshot('spark').reason,'worker_not_registered');assert.equal(calls,0);telemetry.close();
});
