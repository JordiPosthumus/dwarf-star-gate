import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {HardwareTelemetry,hardwareTelemetryConfig,nvidiaLinuxCommand,parseNvidiaLinux,nvidiaThermalCommand,parseNvidiaThermal} from './hardware-telemetry.mjs';
import {evidence} from './dataset.mjs';
import {parseMacActivity,sampleMacHardware,parseMacSensors} from './macos-hardware.mjs';
import {MacSource} from './hardware-telemetry.mjs';

test('unprivileged Mac samples expose occupied RAM and one driver activity reading, never guessed power',async()=>{
  const text='"PerformanceStatistics" = {"Device Utilization %"=99}';
  assert.equal(parseMacActivity(text),99);assert.equal(parseMacActivity(text+'\n'+text),null);assert.equal(parseMacActivity(text.replace('99','199')),null);
  const sample=await sampleMacHardware({platform:'darwin',totalmem:()=>128,freemem:()=>32,now:()=>1000,exec:async(file,args,options)=>{assert.equal(file,'/usr/sbin/ioreg');assert.equal(options.timeout,4000);return {stdout:text};}});
  assert.equal(sample.memory_used_bytes,96);assert.equal(sample.accelerator_activity_pct,99);assert.equal(sample.power_watts,undefined);
  const partial=await sampleMacHardware({platform:'darwin',totalmem:()=>128,freemem:()=>32,exec:async()=>{throw new Error();}});assert.equal(partial.memory_used_bytes,96);assert.equal(partial.accelerator_activity_pct,undefined);
  await assert.rejects(sampleMacHardware({platform:'linux'}),/macos_local_unavailable/);
});

test('Mac sampling coalesces polls and drops a late result after close',async()=>{
  let resolve,calls=0,accepted=0,signal;const source=new MacSource(()=>accepted++,()=>{},{sample:options=>{calls++;signal=options.signal;return new Promise(r=>resolve=r);}});
  source.poll();source.poll();await Promise.resolve();assert.equal(calls,1);source.close();assert.equal(signal.aborted,true);resolve({time:1000});await new Promise(r=>setImmediate(r));assert.equal(accepted,0);
});

test('Mac adapter cannot attribute local metrics to an SSH-backed worker',()=>{
  const h=new HardwareTelemetry({enabled:true,workers:{remote:{adapter:'macos-local'}}});
  h.sync([{id:'remote',ssh:'remote-alias'}],[{id:'remote'}]);
  assert.equal(h.snapshot('remote').reason,'local_adapter_remote_worker');assert.equal(h.sources.size,0);h.close();
});

const now=Date.UTC(2026,8,4,12),valid='DSG_HW_V1|131072,32768|88.5,42,1200';

test('GPU-only power is measured but never labelled as module power',()=>{
  const sample=parseNvidiaLinux('DSG_HW_V2|131072,32768|[N/A],25.6,91,2177',now);
  assert.equal(sample.power_watts,25.6);assert.equal(sample.power_scope,'gpu_only');
  assert.equal(sample.accelerator_activity_pct,91);assert.equal(sample.clock_mhz,2177);
  assert.equal(parseNvidiaLinux('DSG_HW_V2|131072,32768|80,25.6,91,2177',now).power_scope,'compute_module');
  assert.equal(parseNvidiaLinux('DSG_HW_V2|131072,32768|0,25.6,91,2177',now).power_watts,0);
  assert.equal(parseNvidiaLinux('DSG_HW_V2|131072,32768|[N/A],[N/A],91,2177',now).power_watts,undefined);
});

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
  telemetry.sync([{id:'spark',ssh:'spark-private-alias'}],[{id:'spark'}]);assert.equal(children.length,2);assert.equal(children[0].file,'/usr/bin/ssh');assert.ok(children[0].args.includes('spark-private-alias'));assert.equal(children[0].args.at(-1),nvidiaLinuxCommand(10000));
  children[0].child.stdout.write(valid+'\n');const snapshot=telemetry.snapshot('spark',time);assert.equal(snapshot.state,'connected');assert.equal(snapshot.current.power_scope,'compute_module');assert.equal(rows.length,1);assert.ok(!JSON.stringify(snapshot).includes('spark-private-alias'));assert.ok(!JSON.stringify(rows[0]).includes('spark-private-alias'));
  time+=61000;assert.equal(telemetry.snapshot('spark',time).state,'stale');telemetry.close();assert.equal(children[0].child.killed,true);assert.equal(children[1].child.killed,true);
});

test('remote adapter times out, preserves the bounded reason and reconnects',()=>{
  const children=[],timers=[];
  const spawnImpl=()=>{const child=new EventEmitter();child.stdout=new PassThrough();child.kill=()=>{child.killed=true;};children.push(child);return child;};
  const setTimer=(fn,ms)=>{const timer={fn,ms,cleared:false};timers.push(timer);return timer;},clearTimer=timer=>{timer.cleared=true;};
  const telemetry=new HardwareTelemetry({enabled:true,workers:{spark:{adapter:'nvidia-linux'}}},()=>{},{spawnImpl,setTimer,clearTimer,now:()=>now});telemetry.sync([{id:'spark',ssh:'spark'}],[{id:'spark'}]);
  const watchdog=timers.find(timer=>timer.ms===35000);watchdog.fn();assert.equal(children[0].killed,true);assert.equal(telemetry.snapshot('spark',now).reason,'adapter_timeout');
  children[0].emit('close',255);assert.equal(telemetry.snapshot('spark',now).reason,'adapter_timeout');const retry=timers.find(timer=>timer.ms===10000&&!timer.cleared);retry.fn();assert.equal(children.length,3);assert.equal(telemetry.snapshot('spark',now).state,'connecting');telemetry.close();
});

test('unregistered and transport-less workers stay explicit without spawning',()=>{
  let calls=0;const telemetry=new HardwareTelemetry({enabled:true,workers:{spark:{adapter:'nvidia-linux'}}},()=>{},{spawnImpl:()=>{calls++;}});
  telemetry.sync([],[{id:'spark'}]);assert.equal(telemetry.snapshot('spark').reason,'management_transport_unavailable');telemetry.sync([],[]);assert.equal(telemetry.snapshot('spark').reason,'worker_not_registered');assert.equal(calls,0);telemetry.close();
});


test('Mac SMC samples preserve system sensor identity, reject sentinels and isolate query failures',async()=>{
 const text=JSON.stringify({schema:1,values:{PSTR:123.5,Tf14:72,Tf04:65,PRIVATE:'private sensor'}});
 const parsed=parseMacSensors(text,now);assert.equal(parsed.power_scope,'system');assert.equal(parsed.power_sensor,'smc_pstr');
 assert.deepEqual(parsed.temperatures.map(row=>row.scope),['gpu','cpu']);assert.ok(!JSON.stringify(parsed).includes('PRIVATE'));
 assert.deepEqual(parseMacSensors(JSON.stringify({schema:1,values:{PSTR:0,Tf14:151,Tf04:'65'}})),{});
 const calls=[];const sample=await sampleMacHardware({platform:'darwin',totalmem:()=>128,freemem:()=>32,now:()=>now,exec:async(file,args,options)=>{
  calls.push({file,args,options});if(file==='/usr/sbin/ioreg')throw new Error('driver unavailable');return {stdout:text};
 }});
 assert.equal(calls.length,2);assert.equal(sample.memory_used_bytes,96);assert.equal(sample.power_watts,123.5);assert.equal(sample.temperatures[0].time,now);
 const smc=calls.find(call=>call.file.endsWith('/python3'));assert.equal(smc.options.maxBuffer,16384);assert.equal(smc.args.length,1);assert.ok(smc.args[0].endsWith('/macos-smc.py'));
});

test('thermal observer preserves independent freshness and does not turn unsupported flags into false',()=>{
 assert.equal(parseNvidiaThermal('DSG_THERMAL_V1|72,Not Active,Active',now).thermal_throttling,true);
 assert.equal(parseNvidiaThermal('DSG_THERMAL_V1|72,[N/A],Not Active',now).thermal_throttling,undefined);
 assert.equal(parseNvidiaThermal('DSG_THERMAL_V1|[N/A],[N/A],[N/A]',now),null);
 assert.match(nvidiaThermalCommand(),/sleep 60/);assert.throws(()=>nvidiaThermalCommand(10000));
 let time=now;const rows=[],h=new HardwareTelemetry({enabled:true,workers:{one:{adapter:'nvidia-linux'}}},row=>rows.push(row),{now:()=>time});
 h.accept('one',{time,power_watts:100,power_scope:'compute_module'});
 time+=61000;h.accept('one',parseNvidiaThermal('DSG_THERMAL_V1|72,Not Active,Not Active',time));
 let snapshot=h.snapshot('one',time);assert.equal(snapshot.state,'stale');assert.equal(snapshot.last_sample_at,now);assert.equal(snapshot.temperature_state,'connected');assert.equal(snapshot.temperature_at,time);assert.equal(snapshot.current.power_watts,100);
 time+=120001;snapshot=h.snapshot('one',time);assert.equal(snapshot.temperature_state,'stale');h.close();
});
