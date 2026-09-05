import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import vm from 'node:vm';
import { setTimeout as delay } from 'node:timers/promises';
import { parseTiming, safeGatewayEvent, DeviceTelemetry, JournalReader, journalProcessEpoch } from './telemetry.mjs';
import { createDashboard, runDashboard } from './dashboard.mjs';
import { FileLogReader, parseLocalProcessStart, parseLocalTiming, telemetryFiles } from './file-telemetry.mjs';
import {cacheInventoryDirectories} from './cache-inventory.mjs';
const parse = (s, t = 1000) => parseTiming(`0902 14:00:00 ds4-server: ${s}`, t);

test('dashboard folds connection and diagnostics into its single identity header',()=>{
  const html=fs.readFileSync(new URL('./ui/index.html',import.meta.url),'utf8');
  assert.equal((html.match(/<header\b/g)||[]).length,1);
  const header=html.match(/<header\b[^>]*>[\s\S]*?<\/header>/)[0];
  for(const id of ['connection','control-mode','control-note','model'])assert.ok(header.includes(`id="${id}"`));
  assert.match(header,/<h1>Dwarf Star Gate<\/h1>/);
  assert.match(header,/<p class="tagline">Seamless Continuity<\/p>/);
  assert.match(html,/<title>Dwarf Star Gate · Seamless Continuity<\/title>/);
  assert.match(header,/href="\/api\/diagnostics" download/);
  assert.match(header,/aria-label="Download a DSG debug snapshot"/);
  assert.doesNotMatch(header,/control room|class="brand"/);
});

test('rate charts bridge measurement pauses with red-dot markers without inventing observations',()=>{
  const source=fs.readFileSync(new URL('./ui/ui.js',import.meta.url),'utf8').replace(/^import .*;\n/,'').split('\npoll();')[0];
  const context=vm.createContext({});vm.runInContext(source,context);
  const render=(series,now=500000)=>vm.runInContext(`chart(${JSON.stringify(series)},'decode',${now},40)`,context);
  const series=[{kind:'decode',time:410000,tps:20},{kind:'decode',time:200000,tps:10},{kind:'decode',time:210000,tps:12},{kind:'decode',time:400000,tps:18}];
  const before=JSON.stringify(series),svg=render(series);
  assert.equal((svg.match(/class="chart-bridge"/g)||[]).length,1);
  assert.equal((svg.match(/class="chart-pause-dot"/g)||[]).length,1);
  assert.equal((svg.match(/<polyline/g)||[]).length,2,'measured runs remain distinct from the visual connector');
  assert.match(svg,/190s between rate measurements/);assert.match(svg,/not a measured rate or proof of idle/);
  assert.match(svg,/tabindex="0" role="img"/);assert.equal(JSON.stringify(series),before);
  assert.doesNotMatch(svg,/chart-last chart-pause-dot/,'exactly 90 seconds does not mark a trailing pause');
  const stopped=render(series,500001);assert.match(stopped,/chart-last chart-pause-dot/);
  assert.match(stopped,/line ends at the last observation/);assert.doesNotMatch(stopped,/d="M300.0 /,'do not extend a stale rate to now');
  assert.doesNotMatch(render([{kind:'decode',time:400000,tps:10},{kind:'decode',time:490000,tps:11}]),/class="chart-bridge"/);
  assert.doesNotMatch(render([]),/<circle|<polyline|class="chart-bridge"/);
  const bad=[{kind:'decode',time:500001,tps:20},{kind:'decode',time:100000,tps:-1},{kind:'decode',time:null,tps:20},{kind:'prefill',time:400000,tps:100}];
  assert.doesNotMatch(render(bad),/<circle|<polyline/);
  assert.doesNotMatch(vm.runInContext("chart([{kind:'decode',time:400000,tps:NaN},{kind:'decode',time:Infinity,tps:20}], 'decode', 500000, Infinity)",context),/NaN|Infinity/);
});

test('forecast labels never present stale snapshots or total service time as a live ETA',()=>{
  const source=fs.readFileSync(new URL('./ui/ui.js',import.meta.url),'utf8').replace(/^import .*;\n/,'').split('\npoll();')[0];
  const context=vm.createContext({});vm.runInContext(source,context);
  const label=(f,now=100000,stale=false)=>vm.runInContext(`forecastLabel(${JSON.stringify(f)},${now},${stale})`,context);
  assert.equal(label({at:90000,seconds:50,stage:'remaining'}),'ETA ~40s');
  assert.equal(label({at:0,seconds:50,stage:'remaining'}),'Forecast stale');
  assert.equal(label({at:90000,seconds:10,stage:'remaining'}),'Estimate exceeded');
  assert.equal(label({at:90000,seconds:50,stage:'upload'}),'Total est. 50s');
  assert.equal(label({at:90000,seconds:50,stage:'remaining'},100000,true),'Forecast stale');
  assert.equal(label({at:100001,seconds:50,stage:'remaining'}),'ETA unknown');
  assert.equal(label({at:90000,seconds:null,stage:'remaining'}),'ETA unknown');
});

const logTime = +new Date(2026,8,2,14,0,5);
const logLine = message => `0902 14:00:00 ds4-server: ${message}\n`;
function logFixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dsg-local-log-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'engine.txt'), device=new DeviceTelemetry('studio'), events=[];
  return {dir,file,device,events,reader:new FileLogReader(device,file,e=>events.push(e))};
}
test('local timestamps use the host clock, handle year rollover and reject stale/malformed text', () => {
  const msg='chat ctx=0..100:100 prompt start';
  assert.equal(parseLocalTiming(logLine(msg).trim(),logTime).time,+new Date(2026,8,2,14));
  assert.equal(parseLocalTiming(`1231 23:59:59 ds4-server: ${msg}`,+new Date(2027,0,1,0,0,1)).time,+new Date(2026,11,31,23,59,59));
  for(const line of [`0230 14:00:00 ds4-server: ${msg}`,`0902 25:00:00 ds4-server: ${msg}`,`0902 13:40:00 ds4-server: ${msg}`,`0902 14:01:00 ds4-server: ${msg}`,`private prompt ${logLine(msg)}`,logLine('private answer')]) assert.equal(parseLocalTiming(line,logTime),null);
});
test('local stock listen markers provide a bounded private process epoch',t=>{
  const {file,device,events,reader}=logFixture(t),listen=logLine('listening on http://127.0.0.1:8000');
  assert.equal(parseLocalProcessStart(listen.trim(),logTime).kind,'process_start');
  assert.equal(parseLocalProcessStart(logLine('private answer').trim(),logTime),null);
  fs.writeFileSync(file,listen+'padding\n'.repeat(140000)+logLine('chat ctx=0..10:10 prompt start'));
  reader.poll(logTime);const first=device.backend_epoch;
  assert.match(first,/^[\da-f]{64}$/);assert.equal(device.backend_epoch_source,'local_listen_marker');assert.equal(device.backend_epoch_confidence,'bounded');assert.equal(device.cache.starts,1);
  assert.ok(events.some(e=>e.kind==='process_start'));assert.ok(!JSON.stringify(events).includes('127.0.0.1'));
  const firstStart=events.find(e=>e.kind==='start');assert.equal(firstStart.backend_epoch,first);assert.equal(firstStart.backend_epoch_source,'local_listen_marker');assert.equal(firstStart.backend_epoch_confidence,'bounded');
  fs.appendFileSync(file,`0902 14:00:04 ds4-server: listening on http://127.0.0.1:8000\n`+`0902 14:00:05 ds4-server: chat ctx=0..20:20 prompt start\n`);
  reader.poll(logTime+5000);assert.notEqual(device.backend_epoch,first);assert.equal(device.backend_epoch_changes,1);assert.equal(device.cache.starts,1);
  const starts=events.filter(e=>e.kind==='start');assert.equal(starts.length,2);assert.equal(starts[1].backend_epoch,device.backend_epoch);assert.notEqual(starts[1].backend_epoch,first);
});
test('local epoch inheritance follows file order and never crosses a marker or rotated file',t=>{
  const {dir,file,events,reader}=logFixture(t),listen=logLine('listening on http://127.0.0.1:8000');
  fs.writeFileSync(file,logLine('chat ctx=0..10:10 prompt start')+listen+logLine('chat ctx=0..20:20 prompt start'));reader.poll(logTime);
  const first=events.filter(e=>e.kind==='start');assert.equal(first.length,2);assert.equal(first[0].backend_epoch,undefined);assert.match(first[1].backend_epoch,/^[\da-f]{64}$/);
  fs.renameSync(file,path.join(dir,'old.txt'));fs.writeFileSync(file,logLine('chat ctx=0..30:30 prompt start'));reader.poll(logTime);
  const afterRotation=events.filter(e=>e.kind==='start').at(-1);assert.equal(afterRotation.prompt,30);assert.equal(afterRotation.backend_epoch,undefined);
});
test('local log parses prefill/decode and disk reuse once, buffers partial lines, and exports no raw data', t => {
  const {file,device,events,reader}=logFixture(t);
  fs.writeFileSync(file,logLine('private prompt: NEVER_EXPORT')+logLine('live kv cache miss live=500 prompt=600 common=1')+logLine('kv cache hit text tokens=512 text=2000 quant=2 key=token-text load=12.3 ms file=/private/NEVER_EXPORT.kv')+logLine('chat ctx=512..612:100 prompt start'));
  reader.poll(logTime);assert.equal(device.prompt.cache,'disk restore');
  fs.appendFileSync(file,logLine('chat ctx=512..612:100 prefill chunk 100/100 (100.0%) chunk=500.0 t/s avg=500.0 t/s 0.200s')+logLine('chat ctx=512..612:100 prompt done 0.200s'));
  const decode=logLine('chat ctx=612..662:50 gen=50 THINKING decoding chunk=35.0 t/s avg=34.0 t/s 1.470s');
  fs.appendFileSync(file,decode.slice(0,-1));reader.poll(logTime);
  assert.equal(device.decode,null);assert.equal(device.prefill.tps,500);
  fs.appendFileSync(file,'\n');reader.poll(logTime);reader.poll(logTime);
  assert.equal(device.decode.tps,35);assert.equal(device.phase,'thinking');assert.equal(device.connected,true);
  assert.deepEqual(device.cache,{starts:1,reused:1,cold:0,resident_misses:1,disk_restores:1});
  assert.equal(events.length,6);assert.ok(!/NEVER_EXPORT|engine.txt|private prompt/.test(JSON.stringify({events,snapshot:device.snapshot()})));
  const replay=[];new FileLogReader(new DeviceTelemetry('studio'),file,e=>replay.push(e)).poll(logTime);
  assert.deepEqual(replay.map(e=>e.sample_id),events.map(e=>e.sample_id));
});
test('local reader handles rename rotation, truncation and regrowth beyond the previous offset', t => {
  const {dir,file,device,reader}=logFixture(t);
  fs.writeFileSync(file,logLine('chat ctx=0..10:10 prompt start'));reader.poll(logTime);
  fs.renameSync(file,path.join(dir,'old.txt'));
  fs.writeFileSync(file,logLine('chat ctx=0..20:20 prompt start'));reader.poll(logTime);
  assert.equal(device.cache.starts,2);
  fs.writeFileSync(file,'');reader.poll(logTime);
  fs.appendFileSync(file,logLine('chat ctx=0..30:30 prompt start'));reader.poll(logTime);
  fs.writeFileSync(file,logLine('chat ctx=0..40:40 prompt start')+'private padding\n'.repeat(100));reader.poll(logTime);reader.poll(logTime);
  assert.equal(device.prompt.prompt,40);assert.equal(device.cache.starts,4);
});
test('local reads and partial lines stay bounded and oversized lines cannot become false events', t => {
  const {file,device,reader}=logFixture(t);
  fs.writeFileSync(file,'x'.repeat(1024*1024));reader.poll(logTime);
  assert.ok(reader.fragment.length<=65536);assert.ok(reader.anchor.length<=64);
  fs.appendFileSync(file,logLine('chat ctx=0..999:999 prompt start')+logLine('chat ctx=0..10:10 prompt start'));reader.poll(logTime);
  assert.equal(device.cache.starts,1);assert.equal(device.prompt.prompt,10);
  fs.appendFileSync(file,'x'.repeat(300000));const old=reader.offset;reader.poll(logTime);
  assert.ok(reader.offset-old<=262144);assert.ok(reader.fragment.length<=65536);
});
test('missing and nonregular local logs fail closed without fabricating zero speeds and recover', t => {
  const {dir,file,device,reader}=logFixture(t);
  reader.poll(logTime);assert.equal(device.connected,false);assert.equal(device.decode,null);
  fs.mkdirSync(file);reader.poll(logTime);assert.equal(device.connected,false);fs.rmdirSync(file);
  fs.writeFileSync(path.join(dir,'real.txt'),logLine('chat ctx=0..10:10 prompt start'));
  fs.symlinkSync(path.join(dir,'real.txt'),file);reader.poll(logTime);assert.equal(device.connected,false);fs.unlinkSync(file);
  fs.writeFileSync(file,logLine('chat ctx=0..10:10 prompt start'));reader.poll(logTime);assert.equal(device.connected,true);
  fs.unlinkSync(file);reader.poll(logTime);assert.equal(device.connected,false);assert.equal(device.cache.starts,1);
});
test('local telemetry configuration requires an explicit private absolute path, never a command', () => {
  assert.equal(telemetryFiles().size,0);assert.equal(telemetryFiles({studio:'/var/log/ds4/engine.txt'}).size,1);
  for(const input of [null,[],{studio:'relative.txt'},{studio:'ssh worker cat file'},{studio:'/tmp/bad\0file'},{'bad id':'/tmp/log'}, {studio:{command:'tail'}}]) assert.throws(()=>telemetryFiles(input));
});
test('UI distinguishes local model logs from journal connectivity', () => {
  const source=fs.readFileSync(new URL('./ui/ui.js',import.meta.url),'utf8').replace(/^import .*;\n/,'').split('\npoll();')[0];
  const context=vm.createContext({});vm.runInContext(source,context);
  const label=d=>vm.runInContext(`telemetryStatus(${JSON.stringify(d)})`,context);
  assert.equal(label({telemetry_source:'file',connected:true}),'Model log connected');
  assert.equal(label({telemetry_source:'file',connected:false}),'Model log disconnected');
  assert.equal(label({telemetry_source:'journal',connected:true}),'Journal connected');
  assert.equal(label({telemetry_configured:false}),'Engine timings not configured');
});

test('activity view uses three honest operational colors and folds thinking into generation', () => {
  const source=fs.readFileSync(new URL('./ui/ui.js',import.meta.url),'utf8').replace(/^import .*;\n/,'').split('\npoll();')[0];
  const context=vm.createContext({});vm.runInContext(source,context);
  const now=1_000_000;
  const html=vm.runInContext(`timeline(${JSON.stringify({activity:[
    {phase:'idle',start:now-10_000,end:now-8_000},
    {phase:'prefill',start:now-8_000,end:now-6_000},
    {phase:'thinking',start:now-6_000,end:now-4_000},
    {phase:'decode',start:now-4_000,end:now-2_000},
    {phase:'unavailable',start:now-2_000,end:now-1_000},
    {phase:'unknown',start:now-1_000,end:now}
  ]})},${now})`,context);
  assert.match(html,/phase-idle-off/);assert.match(html,/phase-prefill/);
  assert.equal((html.match(/phase-decode/g)||[]).length,2,'thinking and answering share the generation band');
  assert.match(html,/phase-unknown/);assert.doesNotMatch(html,/phase-thinking|phase-unavailable/);
  assert.match(html,/Idle \/ off/);assert.match(html,/Prefill/);assert.match(html,/Decode \/ generation/);
  assert.doesNotMatch(html,/>Thinking<|>Answering<|>Unknown \/ working</);
  assert.match(html,/aria-label="Observed activity over the last fifteen minutes:/);
  assert.doesNotMatch(html,/15m activity|sampled every 2s|status badge distinguishes/);
  const css=fs.readFileSync(new URL('./ui/brand.css',import.meta.url),'utf8');
  assert.match(css,/\.phase-prefill\{fill:#78aee8\}/);assert.match(css,/\.phase-decode\{fill:#b9d889\}/);assert.match(css,/\.phase-idle-off\{fill:#c48787\}/);
});

test('worker controls show escaped hold ownership and block ordinary Enable/Remove',()=>{
  const source=fs.readFileSync(new URL('./ui/ui.js',import.meta.url),'utf8').replace(/^import .*;\n/,'').split('\npoll();')[0];
  const context=vm.createContext({});vm.runInContext(source,context);
  const row=w=>vm.runInContext(`workerRows(${JSON.stringify([w])})`,context);
  const w={id:'worker-a',is_healthy:true,drained:true,load:0,queued:0,operator_paused:false,holds:[{owner_id:'tester',reason:'<script>bad</script>'}]};
  const html=row(w);assert.match(html,/Held by tester/);assert.ok(!html.includes('<script>'));assert.match(html,/&lt;script&gt;/);
  assert.match(html,/data-action="resume"[^>]*disabled/);assert.match(html,/data-action="remove"[^>]*disabled/);assert.match(html,/>Keep paused</);
  assert.ok(!row({...w,operator_paused:true}).includes('>Keep paused<'));assert.match(row({...w,operator_paused:true}),/Operator pause/);
  const free=row({...w,holds:[]});assert.ok(!/data-action="resume"[^>]*disabled/.test(free));assert.ok(!/data-action="remove"[^>]*disabled/.test(free));
});
test('named maintenance locks are obvious, escaped and require exact release before Resume',()=>{
  const source=fs.readFileSync(new URL('./ui/ui.js',import.meta.url),'utf8').replace(/^import .*;\n/,'').split('\npoll();')[0];
  const context=vm.createContext({});vm.runInContext(source,context);
  const lock={id:'7d71fa8b-46ef-43e1-a212-1ea26c5ba901',name:'speed <test>',reason:'external benchmark',created_at:1,review_at:2,control_channel:'dashboard'};
  const worker={id:'worker-a',is_healthy:true,drained:true,load:0,queued:0,operator_paused:false,holds:[],maintenance_locks:[lock]};
  const row=vm.runInContext(`workerRows(${JSON.stringify([worker])})`,context),info=vm.runInContext(`routingInfo(${JSON.stringify(worker)})`,context);
  assert.match(row,/MAINTENANCE LOCK · NOT ROUTING/);assert.match(row,/Maintenance: speed &lt;test&gt;/);assert.doesNotMatch(row,/<test>/);
  assert.match(row,/data-action="resume"[^>]*disabled/);assert.match(row,/data-action="remove"[^>]*disabled/);assert.match(row,/data-action="unlock"/);assert.match(row,/data-lock-id="7d71fa8b/);
  assert.match(row,/>Maintenance lock</);assert.match(row,/>Release speed &lt;test&gt;</);assert.equal(info.blocked,true);assert.match(info.title,/never auto-release/);
});

test('recovery recheck UI covers uncertain start and restart actions',()=>{
  const source=fs.readFileSync(new URL('./ui/ui.js',import.meta.url),'utf8').replace(/^import .*;\n/,'').split('\npoll();')[0];
  const context=vm.createContext({});vm.runInContext(source,context);
  const check=action=>vm.runInContext(`recoveryRecheckable(${JSON.stringify(action)})`,context);
  assert.equal(check({state:'reconciliation_needed',restart_issued:true}),true);
  assert.equal(check({state:'failed',service_action_issued:true,service_action:'start'}),true);
  assert.equal(check({state:'failed',service_action:'start'}),false);
  assert.equal(check({state:'recovered',service_action_issued:true,service_action:'start'}),false);
  assert.equal(check({state:'reconciliation_needed',service_action_issued:true,service_action:'bootstrap'}),true);
  const text=action=>vm.runInContext(`recoveryIssuanceText(${JSON.stringify(action)})`,context);
  assert.equal(text({service_action:'bootstrap'}),'');
  assert.match(text({service_action:'bootstrap',service_action_issued:true}),/acknowledgement unknown/);
  assert.equal(text({service_action:'bootstrap',service_action_issued:true,bootstrap_acknowledged:true}),' · bootstrap acknowledged');
  assert.equal(text({service_action:'start',service_action_issued:true}),' · start issued');
});
test('verified profile hand-back is a visible independent default-on recovery policy',()=>{
  const html=fs.readFileSync(new URL('./ui/index.html',import.meta.url),'utf8'),js=fs.readFileSync(new URL('./ui/ui.js',import.meta.url),'utf8');
  assert.match(html,/id="recovery-handback-toggle"/);assert.match(html,/Verified profile hand-back starts enabled/);
  assert.match(html,/A pause, named maintenance lock or agent hold always blocks it/);assert.match(js,/profile_handback_automatic/);
  assert.match(js,/workerAction\('recovery-handback-policy'/);assert.match(js,/verified hand-back eligible/);
});

test('recovery enrollment links to an agent guide without granting control authority',()=>{
  const html=fs.readFileSync(new URL('./ui/index.html',import.meta.url),'utf8');
  const guide=fs.readFileSync(new URL('../docs/agent-recovery-enrollment.md',import.meta.url),'utf8');
  assert.match(html,/<a id="recovery-enrollment-guide" href="https:\/\/github\.com\/JordiPosthumus\/dwarf-star-gate\/blob\/main\/docs\/agent-recovery-enrollment\.md" target="_blank" rel="noopener noreferrer">Setup guide for your agent/);
  assert.match(html,/Connecting an endpoint does not grant restart permission/);
  assert.match(guide,/inspection and a proposed plan only/);
  assert.match(guide,/Automatic recovery is a fleet-wide policy/);
  assert.match(guide,/Never repeatedly invoke/);
  assert.match(guide,/cold-to-warm conversations with numerical cache-reuse evidence/);
  for(const [,relative] of guide.matchAll(/\]\(([^)#]+)(?:#[^)]+)?\)/g))assert.ok(fs.existsSync(new URL('../docs/'+relative,import.meta.url)),`Missing enrollment reference: ${relative}`);
});

test('worker enrollment offers bounded SSH fallback aliases without accepting SSH options',()=>{
  const html=fs.readFileSync(new URL('./ui/index.html',import.meta.url),'utf8');
  const source=fs.readFileSync(new URL('./ui/ui.js',import.meta.url),'utf8');
  assert.match(html,/name="ssh_fallbacks"/);assert.match(html,/host-key-verified SSH aliases/);
  assert.match(source,/ssh_fallbacks\.value\.split\(','\)/);assert.match(source,/worker\.ssh_fallbacks=fallbacks/);
  const executable=source.replace(/^import .*;\n/,'').split('\npoll();')[0],context=vm.createContext({});vm.runInContext(executable,context);
  const row=vm.runInContext(`workerRows(${JSON.stringify([{id:'remote',ssh:'primary',ssh_fallbacks:['backup'],is_healthy:true,drained:false,load:1,queued:0}])})`,context);
  assert.match(row,/data-action="fallbacks"/);assert.match(row,/>Routes 2</);
  assert.doesNotMatch(html,/ProxyCommand|StrictHostKeyChecking=no/);
});

test('excluded routing states are explicit; quarantine offers checked readmission even without a pause',()=>{
  const source=fs.readFileSync(new URL('./ui/ui.js',import.meta.url),'utf8').replace(/^import .*;\n/,'').split('\npoll();')[0];
  const context=vm.createContext({});vm.runInContext(source,context);vm.runInContext('workerControlsReady=true',context);
  const state=(w,options={})=>vm.runInContext(`routingInfo(${JSON.stringify(w)},${JSON.stringify(options)})`,context);
  const markup=(w,options={})=>vm.runInContext(`routingMarkup(${JSON.stringify(w)},${JSON.stringify(options)})`,context);
  const q={id:'worker-a',is_healthy:false,drained:false,load:0,queued:0,quarantine:{reason:'repeated_inference_failures',at:'2026-01-01T00:00:00Z'}};
  assert.equal(state(q).button,'Verify & readmit');assert.equal(state(q).action,'resume');assert.equal(state(q).blocked,false);
  assert.match(markup(q),/QUARANTINED · NOT ROUTING/);assert.match(markup(q),/repeated inference failures/);assert.match(markup(q),/recorded by DSG/);
  assert.ok(!/data-action="resume"[^>]*disabled/.test(markup(q)),'original UI offered Drain or disabled Enable forever');
  for(const w of [{...q,load:1},{...q,queued:1},{...q,holds:[{owner_id:'test-agent'}]}])assert.ok(state(w).blocked);
  assert.ok(state({...q,quarantine:null,drained:true,maintenance_locks:[{name:'DS4 test'}]}).blocked);
  assert.ok(state(q,{recovering:true}).blocked);
  assert.equal(state({...q,quarantine:null,drained:true,operator_paused:true}).button,'Resume routing');
  assert.equal(state({...q,quarantine:null,drained:true,operator_paused:true}).blocked,false,'fresh probe may restore a previously unavailable paused server');
  const ready={...q,quarantine:null,is_healthy:true};assert.equal(state(ready).button,'Pause routing');assert.equal(state(ready).excluded,false);
  const compact=markup(ready);assert.match(compact,/class="worker-routing"/);assert.match(compact,/data-action="drain"/);assert.match(compact,/<svg/);
  assert.match(compact,/data-tooltip="ROUTING ENABLED[^\"]*New requests may use this server[^\"]*admitted requests finish/);
  assert.match(compact,/aria-label="ROUTING ENABLED/);assert.doesNotMatch(compact,/<p(?:\s|>)|<strong|Pause routing<\/button>/);
  const paused=markup({...ready,drained:true,operator_paused:true});assert.match(paused,/data-action="resume"/);assert.match(paused,/operator paused gateway routing/);
  const attributed=markup({...ready,drained:true,operator_paused:true,last_operator_action:{action:'pause',control_channel:'dashboard',time:'2026-09-04T03:12:44Z'}});
  assert.match(attributed,/Last local operator control: pause via dashboard/);assert.match(attributed,/source label identifies the client path, not a human identity/);
  assert.equal(state(ready,{stale:true}).action,null);assert.ok(!markup(ready,{controls:false}).includes('<button'));
  assert.ok(!markup({...q,holds:[{owner_id:'<script>evil</script>'}]}).includes('<script>'));
  assert.match(markup({...q,holds:[{owner_id:'<script>evil</script>'}]}),/&lt;script&gt;/);
  const html=fs.readFileSync(new URL('./ui/index.html',import.meta.url),'utf8');
  assert.ok(html.includes('id="routing-summary"'));assert.ok(html.indexOf('id="routing-message"')>html.indexOf('</details>'));
  assert.match(source,/\$\('devices'\)\.addEventListener\('click',handleWorkerClick\)/);
  assert.match(source,/Verify and readmit.*small test response/);
  const css=fs.readFileSync(new URL('./ui/brand.css',import.meta.url),'utf8');
  assert.match(css,/\.device\{container:device-card \/ inline-size\}/);assert.match(css,/\.device-status\{display:flex/);assert.match(css,/@container device-card \(min-width:780px\)/);assert.match(css,/\.routing-toggle\{[^}]*width:29px;height:29px/);
  assert.match(css,/content:attr\(data-tooltip\)/);assert.doesNotMatch(css,/\.worker-routing\{margin:/);
});

test('routing control updates preserve focused buttons until state changes and refocus the replacement',()=>{
  const source=fs.readFileSync(new URL('./ui/ui.js',import.meta.url),'utf8').replace(/^import .*;\n/,'').split('\npoll();')[0];
  const active={},doc={activeElement:active},focusCalls=[];let writes=0,value='<button>Resume routing</button>';
  const current={dataset:{level:'paused'},contains:el=>el===active,querySelector:()=>({focus:options=>focusCalls.push(options)})};
  Object.defineProperty(current,'innerHTML',{get:()=>value,set:v=>{value=v;writes++;}});
  const context=vm.createContext({document:doc,current,fresh:{dataset:{level:'paused'},innerHTML:value}});vm.runInContext(source,context);
  for(let i=0;i<4;i++)vm.runInContext('updateRoutingNode(current,fresh)',context);
  assert.equal(writes,0);assert.equal(focusCalls.length,0);
  context.fresh={dataset:{level:'ok'},innerHTML:'<button>Pause routing</button>'};vm.runInContext('updateRoutingNode(current,fresh)',context);
  assert.equal(writes,1);assert.equal(focusCalls.length,1);assert.equal(focusCalls[0].preventScroll,true);assert.equal(current.dataset.level,'ok');
});

test('prefill measures newly processed tokens, not the reused prefix', () => {
  const e = parse('chat ctx=143360..145009:1649 TOOLS prefill chunk 1649/1649 (100.0%) chunk=479.41 t/s avg=479.34 t/s 3.440s');
  assert.equal(e.cached, 143360); assert.equal(e.total, 1649); assert.equal(e.tps, 479.41); assert.equal(e.average, 479.34);
  const done = parse('chat ctx=143360..145009:1649 prompt done 3.440s');
  assert.ok(Math.abs(done.average - 479.36) < .02);
});
test('decode includes thinking and tool flags without retaining their text', () => {
  const e = parse('chat ctx=13000..13050:50 gen=150 TOOLS THINKING decoding chunk=14.57 t/s avg=14.56 t/s 10.305s');
  assert.deepEqual(e, { time:1000, kind:'decode', generated:150, tps:14.57, average:14.56, seconds:10.305, thinking:true });
});
test('a resident miss followed by disk restore is not a cold prompt', () => {
  const d = new DeviceTelemetry('spark1');
  d.accept(parse('live kv cache miss live=150000 prompt=145009 common=1'));
  d.accept(parse('kv cache hit text tokens=143360 text=645151 quant=2 key=token-text load=1618.3 ms file=/private/secret.kv', 1100));
  d.accept(parse('chat ctx=143360..145009:1649 prompt start', 1200));
  assert.deepEqual(d.cache, { starts:1, reused:1, cold:0, resident_misses:1, disk_restores:1 });
  assert.equal(d.prompt.cache, 'disk restore'); assert.ok(!JSON.stringify(d.snapshot()).includes('/private'));
});
test('cold, reused, unknown and partial observations remain distinct', () => {
  const d = new DeviceTelemetry('spark1');
  d.accept(parse('chat ctx=0..12892:12892 TOOLS prompt start'));
  assert.equal(d.prompt.cache, 'cold');
  d.accept(parse('chat ctx=12892..13000:108 prompt start', 2000));
  assert.equal(d.prompt.cache, 'prefix reuse');
  assert.equal(d.cache.starts, 2); assert.equal(d.cache.cold, 1);
  const partial = new DeviceTelemetry('spark2'); partial.accept(parse('chat ctx=0..10:10 gen=4 finish=stop'));
  assert.equal(partial.cache.starts, 0); assert.equal(partial.prompt, null);
});
test('unrelated messages, tool arguments and error snippets are never retained', () => {
  assert.equal(parse('tool calls args={"secret":"private input"}'), null);
  assert.equal(parse('invalid tool call returned as assistant text finish=stop [text_snippet: secret]'), null);
  const e = parse('chat ctx=0..10:10 gen=1 finish=error error="private response" 1.0s');
  assert.equal(e.outcome, 'error'); assert.ok(!JSON.stringify(e).includes('private'));
});
test('journal cursors deduplicate reconnect replay and reject command-shaped input', () => {
  const d = new DeviceTelemetry('spark1'), r = new JournalReader(d);
  const record = { __CURSOR:'s=abc;i=123;t=def', __REALTIME_TIMESTAMP:'1000000', MESSAGE:'ds4-server: chat ctx=0..10:10 prompt start', _SYSTEMD_INVOCATION_ID:'0123456789abcdef0123456789abcdef' };
  assert.ok(r.accept(record)); assert.equal(r.accept(record), null); assert.equal(d.cache.starts, 1);
  assert.equal(r.accept({ ...record, __CURSOR:"';echo private;'" }), null);
  assert.equal(r.accept({ ...record, __CURSOR:'s=abc;i=124', __REALTIME_TIMESTAMP:'invalid' }), null);
});
test('journal process epochs are stable, private and explicit about fallback strength', () => {
  const invocation='0123456789abcdef0123456789abcdef',other='1123456789abcdef0123456789abcdef';
  const a=journalProcessEpoch({_SYSTEMD_INVOCATION_ID:invocation},'spark1');
  assert.match(a.backend_epoch,/^[\da-f]{64}$/);assert.equal(a.backend_epoch_source,'systemd_invocation');assert.equal(a.backend_epoch_confidence,'strong');
  assert.deepEqual(journalProcessEpoch({_SYSTEMD_INVOCATION_ID:invocation},'spark1'),a);
  assert.notEqual(journalProcessEpoch({_SYSTEMD_INVOCATION_ID:other},'spark1').backend_epoch,a.backend_epoch);
  assert.notEqual(journalProcessEpoch({_SYSTEMD_INVOCATION_ID:invocation},'spark2').backend_epoch,a.backend_epoch);
  const fallback=journalProcessEpoch({_BOOT_ID:other,_PID:'4321'},'spark1');
  assert.equal(fallback.backend_epoch_source,'boot_pid_fallback');assert.equal(fallback.backend_epoch_confidence,'bounded');
  assert.ok(!JSON.stringify({a,fallback}).includes(invocation));assert.ok(!JSON.stringify({a,fallback}).includes('4321'));
  for(const record of [{},{_SYSTEMD_INVOCATION_ID:'bad'},{_BOOT_ID:other,_PID:'0'},{_BOOT_ID:other,_PID:'1;id'}])assert.equal(journalProcessEpoch(record,'spark1'),null);
  assert.equal(journalProcessEpoch({_SYSTEMD_INVOCATION_ID:invocation},'bad worker'),null);
});
test('a backend restart invalidates telemetry spans while a reader reconnect does not', () => {
  const d=new DeviceTelemetry('spark1'),invocation='0123456789abcdef0123456789abcdef';
  const record=(cursor,message,id=invocation)=>({__CURSOR:cursor,__REALTIME_TIMESTAMP:String(1000000+Number(cursor.match(/\d+$/)?.[0]??0)*1000),MESSAGE:`ds4-server: ${message}`,_SYSTEMD_INVOCATION_ID:id});
  const r1=new JournalReader(d);
  r1.accept(record('s=a;i=1','kv cache hit text tokens=512 load=12.3 ms'));
  r1.accept(record('s=a;i=2','chat ctx=512..612:100 prompt start'));
  assert.equal(d.cache.disk_restores,1);assert.equal(d.cache.starts,1);assert.equal(d.backend_epoch_changes,0);
  const first=d.backend_epoch;
  const r2=new JournalReader(d);r2.accept(record('s=a;i=3','chat ctx=512..612:100 prompt done 0.2s'));
  assert.equal(d.backend_epoch,first);assert.equal(d.backend_epoch_changes,0);assert.equal(d.cache.starts,1);
  r2.accept(record('s=b;i=4','chat ctx=0..40:40 prompt start','1123456789abcdef0123456789abcdef'));
  assert.notEqual(d.backend_epoch,first);assert.equal(d.backend_epoch_changes,1);
  assert.deepEqual(d.cache,{starts:1,reused:0,cold:1,resident_misses:0,disk_restores:0});
  assert.equal(d.costs.samples.length,0);assert.equal(d.decode,null);assert.equal(d.prefill,null);
  assert.equal(d.snapshot().cache_cost.backend_epoch,d.backend_epoch);assert.equal(d.snapshot().cache_cost.backend_epoch_confidence,'strong');
});
test('missing journal identity stays unverified and cannot contaminate epoch-scoped cache evidence', () => {
  const d=new DeviceTelemetry('spark1'),r=new JournalReader(d);
  const base={__REALTIME_TIMESTAMP:'1000000',MESSAGE:'ds4-server: chat ctx=0..10:10 prompt start'};
  const e=r.accept({...base,__CURSOR:'s=a;i=1'});
  assert.equal(e.backend_epoch,null);assert.equal(d.backend_epoch,null);assert.equal(d.cache.starts,0);assert.equal(d.backend_epoch_evidence_gaps,1);
  const known='0123456789abcdef0123456789abcdef';
  r.accept({...base,__CURSOR:'s=a;i=2',_SYSTEMD_INVOCATION_ID:known});assert.equal(d.cache.starts,1);
  r.accept({...base,__CURSOR:'s=a;i=3'});assert.equal(d.cache.starts,1);assert.equal(d.backend_epoch_evidence_gaps,2);
});
test('dashboard requests process identity fields but exported telemetry contains digests only', () => {
  const source=fs.readFileSync(new URL('./dashboard.mjs',import.meta.url),'utf8');
  for(const field of ['_SYSTEMD_INVOCATION_ID','_BOOT_ID','_PID'])assert.match(source,new RegExp(`output-fields=[^\\n]+${field}`));
  const invocation='0123456789abcdef0123456789abcdef',d=new DeviceTelemetry('spark1'),r=new JournalReader(d);
  const e=r.accept({__CURSOR:'s=a;i=1',__REALTIME_TIMESTAMP:'1000000',MESSAGE:'ds4-server: chat ctx=0..10:10 prompt start',_SYSTEMD_INVOCATION_ID:invocation,_BOOT_ID:'1123456789abcdef0123456789abcdef',_PID:'4321'});
  for(const exported of [JSON.stringify(e),JSON.stringify(d.snapshot())]){assert.ok(!exported.includes(invocation));assert.ok(!exported.includes('4321'));assert.ok(!exported.includes('_SYSTEMD'));}
});
test('rates are bounded historical samples; new prompts do not erase last observed speed', () => {
  const d = new DeviceTelemetry('spark1');
  for (let i = 0; i < 500; i++) d.accept({ time:1000+i*5000, kind:'decode', tps:14, average:14 });
  assert.ok(d.series.length <= 180);
  d.accept(parse('chat ctx=100..200:100 prompt start', 3000000));
  assert.equal(d.decode.tps, 14); assert.equal(d.phase, 'prefill'); assert.ok(d.decode.time < d.prompt.time);
});
test('gateway diagnostics allowlist IDs and numeric usage, not headers, bodies or error text', () => {
  const e = safeGatewayEvent({ event:'request_finished', time:'2026-09-02T00:00:00Z', node:'spark1', request_id:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', session:'abcdef012345',
    outcome:'client_cancelled', elapsed_ms:1000, detail:'secret diagnostic text', headers:{ authorization:'secret' }, prompt:'secret', usage:{ prompt_tokens:10, cached_tokens:8, completion_tokens:2, content:'secret' } });
  assert.equal(e.outcome, 'client_cancelled'); assert.equal(e.usage.cached_tokens, 8); assert.ok(!JSON.stringify(e).includes('secret'));
  assert.equal(safeGatewayEvent({ event:'raw_prompt', prompt:'secret' }), null);
  assert.equal(safeGatewayEvent({ event:'request_finished', outcome:'incomplete_sse' }).outcome, 'incomplete_sse');
});
test('requested-thinking diagnostics include only scalar metadata and reject arbitrary strings', () => {
  const e = safeGatewayEvent({event:'request_finished',requested_thinking:{status:'specified',prompt:'SECRET',fields:{reasoning_effort:'xhigh','thinking.type':'SECRET','thinking.budget_tokens':100000,answer:'SECRET'}}});
  assert.deepEqual(e.requested_thinking,{status:'specified',fields:{reasoning_effort:'xhigh','thinking.type':'unrecognized','thinking.budget_tokens':100000}});
  assert.ok(!JSON.stringify(e).includes('SECRET'));
});
test('thinking UI distinguishes requested controls, omitted/unknown, current/last and stale values', () => {
  const source = fs.readFileSync(new URL('./ui/ui.js',import.meta.url),'utf8').replace(/^import .*;\n/,'').split('\npoll();')[0];
  const context = vm.createContext({}); vm.runInContext(source,context);
  const info = input => vm.runInContext(`thinkingInfo(${JSON.stringify(input)})`,context);
  assert.equal(info({status:'specified',fields:{reasoning_effort:'xhigh'}}).label,'XHIGH');
  assert.equal(info({status:'specified',fields:{thinking:false}}).label,'OFF');
  assert.equal(info({status:'specified',fields:{'thinking.type':'disabled',reasoning_effort:'xhigh'}}).label,'OFF · XHIGH');
  assert.equal(info({status:'specified',fields:{reasoning_effort:null}}).label,'Not set');
  assert.equal(info({status:'not_specified'}).label,'Not specified');
  assert.equal(info({status:'pending'}).label,'Reading request');
  assert.equal(info({status:'unavailable',reason:'capture_limit'}).label,'Unknown');
  assert.equal(info(null).label,'Unavailable');
  const worker = {load:1,requested_thinking:{status:'specified',fields:{reasoning_effort:'low'}},last_requested_thinking:{status:'specified',fields:{reasoning_effort:'high'}},last_request_finished_at:'2026-09-02T00:00:00Z'};
  const current = vm.runInContext(`thinkingIndicator(${JSON.stringify(worker)},false,1788310000000)`,context);
  assert.match(current,/>LOW</); assert.match(current,/Current request/); assert.doesNotMatch(current,/>HIGH</);
  worker.load=0;
  const last = vm.runInContext(`thinkingIndicator(${JSON.stringify(worker)},false,1788310000000)`,context);
  assert.match(last,/>HIGH</); assert.match(last,/Last request/);
  assert.match(vm.runInContext(`thinkingIndicator(${JSON.stringify(worker)},true,1788310000000)`,context),/Historical snapshot/);
  assert.match(source,/thinkingIndicator\(w,stale,now\)/);
});
test('hardware cards stay compact, label unified memory honestly and preserve missing values',()=>{
  const source=fs.readFileSync(new URL('./ui/ui.js',import.meta.url),'utf8').replace(/^import .*;\n/,'').split('\npoll();')[0],context=vm.createContext({});vm.runInContext(source,context);
  const hardware={schema:1,configured:true,state:'connected',last_sample_at:100000,current:{time:100000,memory_used_bytes:75,memory_total_bytes:100,memory_scope:'host_unified',accelerator_activity_pct:42,accelerator_scope:'gpu_kernel_time',power_watts:88.5,power_scope:'compute_module',clock_mhz:1200,clock_scope:'sm'},series:[]};
  const html=vm.runInContext(`hardwareMarkup(${JSON.stringify(hardware)},100001)`,context);assert.match(html,/RAM/);assert.match(html,/75%/);assert.match(html,/GPU/);assert.match(html,/42%/);assert.match(html,/89 W/);assert.match(html,/1,200 MHz SM/);assert.match(html,/Unified host memory used; not dedicated GPU RAM/);assert.match(html,/Measured compute-module power/);
  hardware.current={time:100000,memory_used_bytes:75,memory_total_bytes:100,memory_scope:'host_unified'};const partial=vm.runInContext(`hardwareMarkup(${JSON.stringify(hardware)},100001)`,context);assert.match(partial,/class="hardware-reading accelerator[^"]*"[^>]*>[\s\S]*?<strong>—<\/strong>/);assert.match(partial,/Power unavailable; no TDP estimate is substituted/);
  assert.equal(vm.runInContext('hardwareMarkup({configured:false},100001)',context),'');
});
async function fixture(t, management = null) {
  const server = createDashboard(() => ({ version:1, read_only:true, devices:[] }), undefined, management);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { server, url:`http://127.0.0.1:${server.address().port}` };
}
// Minimal DOM contract for reconciliation tests; actual disclosure/keyboard
// behavior is also checked in the browser, not inferred from this test double.
function genieReportFixture() {
  class Element {
    constructor(tag) { this.tagName=tag; this.children=[]; this.dataset={}; this.open=false; this.parent=null; this.writes=0; }
    set innerHTML(_) { throw new Error('Report rendering must not rebuild or parse HTML'); }
    set textContent(value) { this.text=String(value); this.writes++; }
    get textContent() { return this.text || ''; }
    contains(node) { return this===node || this.children.some(child=>child.contains(node)); }
    append(...nodes) { for(const node of nodes)this.insertBefore(node,null); }
    insertBefore(node, reference) {
      if(node===reference)return;
      node.remove(); const index=reference===null?this.children.length:this.children.indexOf(reference);
      assert.ok(index>=0); this.children.splice(index,0,node); node.parent=this;
    }
    remove() { if(this.parent){this.parent.children.splice(this.parent.children.indexOf(this),1);this.parent=null;} }
  }
  const container=new Element('div'), document={activeElement:null,getElementById:id=>id==='genie-reports'?container:null,createElement:tag=>new Element(tag)};
  const source=fs.readFileSync(new URL('./ui/ui.js',import.meta.url),'utf8').replace(/^import .*;\n/,'').split('\npoll();')[0];
  const context=vm.createContext({document});vm.runInContext(source,context);
  const render=reports=>{context.reports=reports;vm.runInContext('renderGenieReports(reports)',context);};
  const report=id=>({id,time:1000,source:'primary',text:`Report ${id}`});
  return {container,document,render,report};
}
test('Genie polling preserves report nodes, open state, focus and untouched text',()=>{
  const {container,document,render,report}=genieReportFixture(), reports=['c','b','a'].map(report);
  render(reports);const nodes=[...container.children], summary=nodes[1].children[0], answer=nodes[1].children[1];
  nodes[1].open=true;document.activeElement=summary;
  for(let i=0;i<5;i++)render(structuredClone(reports));
  assert.deepEqual(container.children,nodes);assert.equal(nodes[1].open,true);assert.equal(nodes[0].open,false);
  assert.equal(document.activeElement,summary);assert.equal(nodes[1].children[1],answer);assert.equal(answer.writes,1);
  nodes[1].open=false;render(reports);assert.equal(nodes[1].open,false);
});
test('Genie progress formats future provider deadlines as remaining time',()=>{
  const source=fs.readFileSync(new URL('./ui/ui.js',import.meta.url),'utf8');
  assert.match(source,/deadline in \$\{remaining\(s\.provider_deadline_at,now\)\}/);
  assert.doesNotMatch(source,/deadline in \$\{age\(s\.provider_deadline_at,now\)\}/);
});
test('new Genie reports retain an open older report beyond the latest three and history rotation',()=>{
  const {container,document,render,report}=genieReportFixture();
  render(['c','b','a'].map(report));const oldest=container.children[2];oldest.open=true;
  render(['d','c','b','a'].map(report));
  assert.deepEqual(container.children.map(n=>n.dataset.reportId),['d','c','b','a']);assert.equal(container.children[3],oldest);assert.ok(oldest.open);
  render(['e','d','c'].map(report));assert.equal(container.children[3],oldest);assert.ok(oldest.open);
  oldest.open=false;document.activeElement=oldest.children[0];render(['e','d','c'].map(report));assert.equal(container.children[3],oldest);
  document.activeElement=null;render(['e','d','c'].map(report));assert.equal(container.children.length,3);assert.equal(oldest.parent,null);
});
test('Genie report bodies remain inert text and an empty refresh does not close a report being read',()=>{
  const {container,render,report}=genieReportFixture(), text='<img src=x onerror=alert(1)> & <script>bad()</script>';
  render([{...report('a'),source:'<b>primary</b>',text}]);const node=container.children[0];node.open=true;
  assert.equal(node.tagName,'details');assert.equal(node.children[0].tagName,'summary');
  assert.equal(node.children[1].textContent,text);assert.equal(node.children[1].children.length,0);
  render([]);assert.equal(container.children[0],node);assert.ok(node.open);
  node.open=false;render([]);assert.equal(container.children.length,0);
});
test('predictor session labels distinguish known identities from legacy grouping',()=>{
  const source=fs.readFileSync(new URL('./ui/ui.js',import.meta.url),'utf8').replace(/^import .*;\n/,'');
  const context=vm.createContext({});vm.runInContext(source.split('\npoll();')[0],context);
  assert.equal(vm.runInContext('predictionSessionLabel({sessions:3,known_sessions:2,unknown_identity_requests:2})',context),'2 known sessions · 2 requests without identity');
  assert.equal(vm.runInContext('predictionSessionLabel({sessions:3})',context),'3 recorded groups');
  assert.equal(vm.runInContext('predictionSessionLabel({known_sessions:0,unknown_identity_requests:0})',context),'0 known sessions');
  assert.equal(vm.runInContext('predictionSessionLabel({known_sessions:"<img>",sessions:3})',context),'3 recorded groups');
  assert.match(source,/predictionSessionLabel\(s\)/);assert.match(source,/esc\(predictionSessionLabel\(m.future\)\)/);
});

test('Genie action ledger is concise, newest-first and includes proven pool commandeering',()=>{
  const source=fs.readFileSync(new URL('./ui/ui.js',import.meta.url),'utf8').replace(/^import .*;\n/,'').split('\npoll();')[0];
  const context=vm.createContext({});vm.runInContext(source,context);
  const snapshot={gateway:{
    recovery:{operations:[
      {id:'operator',actor:'operator',worker_id:'private-worker',service_action:'restart',state:'recovered',updated_at:6000},
      {id:'recover',actor:'genie',worker_id:'spark1',service_action:'adopt_restart',state:'recovered',updated_at:4000,profile_adopted:true,proof:{samples:[]}}
    ]},
    predictor:{actions:[{id:'predict',actor:'genie',action:'train',status:'verified',reason:'Fresh evidence passed',time:2000}]}
  }};
  const genie={reports:[{id:'report',time:5000,served_by:'pool_fallback',served_on:'spark2'},{id:'ordinary',time:7000,served_by:'dedicated'}]};
  const analytics={handovers:{rows:[{actor:'genie',at:3000,source:'spark1',destination:'m3-studio',waiting_before_move_ms:91000,service_state:'complete',cached_fraction:.75},{actor:'operator',at:8000,source:'private-worker',destination:'spark2',waiting_before_move_ms:1,service_state:'complete'}]}};
  context.snapshot=snapshot;context.genie=genie;context.analytics=analytics;
  const rows=JSON.parse(vm.runInContext('JSON.stringify(genieActionRows(snapshot,genie,analytics))',context));
  assert.deepEqual(rows.map(row=>row.kind),['provider','recovery','routing','predictor']);
  assert.match(rows[0].title,/Pool commandeered · spark2/);assert.match(rows[1].detail,/verified profile hand-back/);assert.match(rows[2].detail,/75% prompt reused/);
  assert.equal(rows.find(row=>row.level==='attention'),undefined);assert.ok(!JSON.stringify(rows).includes('private-worker'));
  const html=fs.readFileSync(new URL('./ui/index.html',import.meta.url),'utf8'),css=fs.readFileSync(new URL('./ui/brand.css',import.meta.url),'utf8');
  assert.match(html,/id="genie-action-ledger"/);assert.match(html,/Pool commandeering/);assert.match(html,/Newest first|title="Proven executor receipts/);
  assert.match(css,/\.genie-action-items li\{display:grid/);assert.match(source,/textContent=row\.detail/);assert.doesNotMatch(source,/innerHTML=.*genieActionRows/);
});
test('Genie ledger renders all 30 available receipts, filters and preserves scroll on refresh',()=>{
  const source=fs.readFileSync(new URL('./ui/ui.js',import.meta.url),'utf8').replace(/^import .*;\n/,'').split('\npoll();')[0];
  const make=()=>({dataset:{},children:[],scrollTop:0,append(...items){this.children.push(...items);},replaceChildren(...items){this.children=items;this.scrollTop=0;}});
  const nodes={'genie-action-filter':{value:'all'},'genie-action-summary':make(),'genie-action-items':make()};
  const context=vm.createContext({document:{getElementById:id=>nodes[id],createElement:make}});vm.runInContext(source,context);
  context.receipts=Array.from({length:35},(_,i)=>({id:String(i),time:1000+i,served_by:'pool_fallback',served_on:'worker-a'}));
  vm.runInContext('wireSnapshot={};analyticsState={};genieState={provider_actions:receipts};renderGenieActionLedger()',context);
  const list=nodes['genie-action-items'];assert.equal(list.children.length,30);
  assert.equal(list.children[0].children[0].dateTime,new Date(1034).toISOString());
  assert.equal(list.children.at(-1).children[0].dateTime,new Date(1005).toISOString());
  assert.match(nodes['genie-action-summary'].textContent,/30 shown.*newest first/);
  list.scrollTop=180;const children=list.children;vm.runInContext('renderGenieActionLedger()',context);
  assert.equal(list.children,children);assert.equal(list.scrollTop,180);
  vm.runInContext("genieState.provider_action_storage={error:'PRIVATE_ERROR'};renderGenieActionLedger()",context);
  assert.match(nodes['genie-action-summary'].textContent,/pool history not saved/);assert.doesNotMatch(nodes['genie-action-summary'].title,/PRIVATE/);
  assert.equal(list.children,children);assert.equal(list.scrollTop,180);
  vm.runInContext("genieState.provider_actions.unshift({id:'new',time:2000,served_by:'pool_fallback'});renderGenieActionLedger()",context);
  assert.equal(list.children.length,30);assert.equal(list.scrollTop,180);
  nodes['genie-action-filter'].value='attention';vm.runInContext('renderGenieActionLedger()',context);
  assert.equal(list.children.length,1);assert.equal(list.children[0].textContent,'No actions match this filter.');
  const css=fs.readFileSync(new URL('./ui/brand.css',import.meta.url),'utf8'),html=fs.readFileSync(new URL('./ui/index.html',import.meta.url),'utf8');
  assert.match(css,/\.genie-action-items\{[^}]*max-height:320px;overflow-y:auto/);
  assert.match(html,/id="genie-action-items"[^>]*tabindex="0"[^>]*aria-label="Latest 30/);
});
test('health wire shows Genie-authored findings and recommendations, withholding stale or unavailable advice',()=>{
  const source=fs.readFileSync(new URL('./ui/ui.js',import.meta.url),'utf8').replace(/^import .*;\n/,'').split('\npoll();')[0];
  const context=vm.createContext({});vm.runInContext(source,context);
  const news=(s,t)=>vm.runInContext(`healthHeadlines(${JSON.stringify(s)},${JSON.stringify(t)})`,context);
  const time=Date.parse('2026-09-02T20:00:00Z');
  const s={time,gateway:{active:1,queued:9,workers:[]}},ticker={state:'ready',evidence_at:time-60000,entries:[
    {severity:'warning',text:'Server B is quarantined after an accelerator failure.',recommendation:'Inspect its backend logs before verified recovery.'},
    {severity:'info',text:'Nine requests were queued at the evidence time.',recommendation:null}]};
  const result=news(s,ticker);assert.equal(result.level,'warn');
  assert.equal(result.items[0].text,'Server B is quarantined after an accelerator failure. Recommendation: Inspect its backend logs before verified recovery.');
  assert.equal(result.items[0].severity,'warning');
  assert.equal(result.items[1].text,ticker.entries[1].text);assert.equal(result.evidence_at,time-60000);
  assert.match(result.label,/Genie assessment · evidence/);
  assert.equal(news(s,{...ticker,entries:[ticker.entries[1]]}).level,'info');
  assert.match(news(s,{...ticker,refreshing:true}).label,/updating/);
  assert.match(news(s,{...ticker,review_error:true}).label,/latest refresh failed/);
  for(const unavailable of [{...s,gateway_error:true},{time}]) {
    assert.equal(news(unavailable,ticker).level,'unknown');assert.doesNotMatch(news(unavailable,ticker).items.map(i=>i.text).join(' '),/Server B|Nine requests/);
  }
  for(const state of ['off','reviewing','pending','stale','changed','invalid','error','unavailable']) {
    const value=news(s,{...ticker,state});assert.equal(value.level,'unknown');assert.equal(value.items.length,1);
    assert.equal(value.items[0].severity,'info');assert.doesNotMatch(value.items[0].text,/Server B|Nine requests|Recommendation:/);
  }
  assert.match(news(s,{state:'off'}).items[0].text,/Enable him/);
  assert.match(news(s,{state:'stale'}).items[0].text,/10 minutes/);
  assert.match(news(s,{state:'changed'}).items[0].text,/changed since/);
  const failed=news(s,{state:'error',provider_attempts:[{provider:'pool_fallback',outcome:'failed',reason:'transport_error'},{provider:'dedicated',outcome:'failed',reason:'transport_error'}]});
  assert.match(failed.items[0].text,/both the dedicated provider and DSG pool fallback were tried/);assert.match(failed.items[0].text,/gateway is unaffected/);
});
test('health wire cannot hide live quarantine or wasted-capacity evidence behind a stalled Genie',()=>{
  const source=fs.readFileSync(new URL('./ui/ui.js',import.meta.url),'utf8').replace(/^import .*;\n/,'').split('\npoll();')[0];
  const context=vm.createContext({});vm.runInContext(source,context);
  const news=(s,t)=>vm.runInContext(`healthHeadlines(${JSON.stringify(s)},${JSON.stringify(t)})`,context);
  const quarantine={reason:'accelerator_checkpoint_failure',at:'2026-09-04T13:10:59Z',request_id:'PRIVATE-REQUEST-ID'};
  const gateway={available:2,total:3,workers:[
    {id:'spark2',is_healthy:false,drained:false,recovery_waiting:2,quarantine},
    {id:'m3-studio',is_healthy:false,drained:true,operator_paused:true,holds:[{owner:'agent'}],quarantine:null}],
    recovery:{workers:[{worker_id:'spark2',state:'quarantined',eligible:false,reason:'service_identity_or_profile_unverified'}]}};
  const stalled=news({gateway},{state:'reviewing'});
  assert.equal(stalled.level,'critical');assert.match(stalled.label,/DSG safety alert · live gateway evidence/);
  assert.equal(stalled.items.length,1);assert.match(stalled.items[0].text,/Spark 2 is quarantined after accelerator checkpoint failure/);
  assert.match(stalled.items[0].text,/2 of 3 DS4 servers are available/);assert.match(stalled.items[0].text,/2 requests are being held/);
  assert.match(stalled.items[0].text,/deliberately re-enroll the changed DS4 service profile/);
  for(const [reason,expected] of [['launchd_registration_absent',/registration is missing.*no bootstrap authority/],['launchd_gui_domain_unavailable',/GUI service domain is unavailable.*does not prove/],['launchd_state_unverified',/inspection could not establish.*absence is not proven/],['launchd_native_disabled',/macOS explicitly disables.*DSG will not enable/],['launchd_disable_state_unverified',/native disable setting could not be verified.*unknown policy is not permission/]]){
    const specific=news({gateway:{...gateway,recovery:{workers:[{worker_id:'spark2',eligible:false,reason}]}}},{state:'reviewing'});
    assert.equal(specific.level,'critical');assert.match(specific.items[0].text,expected);
    assert.doesNotMatch(specific.items[0].text,/deliberately re-enroll the changed/);
  }
  assert.doesNotMatch(JSON.stringify(stalled),/PRIVATE-REQUEST-ID|m3-studio/,'private evidence and intentional holds stay out of the alert');
  const ready=news({gateway},{state:'ready',evidence_at:1000,entries:[{severity:'info',text:'A separate Genie observation.',recommendation:'Keep watching.'}]});
  assert.equal(ready.level,'critical');assert.match(ready.label,/DSG safety alert \+ Genie assessment/);assert.equal(ready.items.length,2);
  assert.match(ready.items[1].text,/A separate Genie observation.*Recommendation: Keep watching/);
});
test('long occupied slots explain queue pressure without treating stale engine totals as progress',()=>{
  const source=fs.readFileSync(new URL('./ui/ui.js',import.meta.url),'utf8').replace(/^import .*;\n/,'').split('\npoll();')[0];
  const context=vm.createContext({});vm.runInContext(source,context);
  const snapshot={time:100000,gateway:{workers:[{id:'spark1',load:1,active_seconds:7200,queued:6,is_healthy:true}]},devices:[{id:'spark1',connected:true,decode:{time:99000,generated:118000,tps:14.4,thinking:true}}]};
  const alerts=()=>JSON.parse(vm.runInContext(`JSON.stringify(deterministicHealthAlerts(${JSON.stringify(snapshot)}))`,context));
  assert.match(alerts()[0].text,/120m; 6 waiting.*118,000 generated tokens.*thinking phase/);
  assert.match(alerts()[0].text,/does not prove a hang or authorize cancellation/);
  snapshot.devices[0].decode.time=1;
  assert.match(alerts()[0].text,/Fresh engine generation progress is unavailable/);
  assert.doesNotMatch(alerts()[0].text,/118,000/);
  snapshot.gateway.workers[0].queued=0;assert.equal(alerts().length,0);
  snapshot.gateway.workers[0].queued=6;snapshot.gateway.workers[0].load=0;assert.equal(alerts().length,0);
});
test('Agent Watch warns only when a live client reports waiting but no request reached DSG',()=>{
  const source=fs.readFileSync(new URL('./ui/ui.js',import.meta.url),'utf8').replace(/^import .*;\n/,'').split('\npoll();')[0];
  const context=vm.createContext({});vm.runInContext(source,context);
  const news=run=>vm.runInContext(`healthHeadlines(${JSON.stringify({gateway:{available:1,total:1,workers:[],client_watch:{schema:1,mode:'advisory',runs:[run]}}})},${JSON.stringify({state:'off'})})`,context);
  const base={watch_ref:'abc123def456',client:'pi',state:'waiting_for_model',process_alive:true,fresh:true,last_seen_at:new Date().toISOString(),last_seen_seconds:1,state_seconds:25,request:null};
  const missing=news({...base,diagnosis:'no_request_reached_dsg'});assert.equal(missing.level,'warn');assert.match(missing.items[0].text,/no matching request reached DSG/);assert.match(missing.items[0].text,/no DS4 fault or frozen process is proven/);
  const failed=news({...base,state:'needs_attention',diagnosis:'client_reported_error',request:{state:'complete',age_seconds:1}});assert.equal(failed.level,'warn');assert.match(failed.items[0].text,/failed turn with no automatic continuation/);assert.match(failed.items[0].text,/not proof that replay is safe/);
  assert.equal(news({...base,state:'needs_attention',diagnosis:'client_reported_error',fresh:false}).level,'unknown');
  for(const diagnosis of ['waiting_inside_dsg','model_response_active','heartbeat_stale_unknown','local_tool_active']){
    const quiet=news({...base,diagnosis,fresh:diagnosis!=='heartbeat_stale_unknown'});assert.equal(quiet.level,'unknown');assert.doesNotMatch(quiet.items[0].text,/no matching request/);
  }
  const html=fs.readFileSync(new URL('./ui/index.html',import.meta.url),'utf8'),css=fs.readFileSync(new URL('./ui/brand.css',import.meta.url),'utf8');assert.match(html,/id="agent-watch"/);assert.match(html,/No prompts, task text, tool names, arguments or output/);assert.match(css,/\.agent-watch/);
});
test('enabled unavailable capacity is deterministic, while deliberate pauses and holds are not faults',()=>{
  const source=fs.readFileSync(new URL('./ui/ui.js',import.meta.url),'utf8').replace(/^import .*;\n/,'').split('\npoll();')[0];
  const context=vm.createContext({});vm.runInContext(source,context);
  const news=gateway=>vm.runInContext(`healthHeadlines(${JSON.stringify({gateway})},${JSON.stringify({state:'off'})})`,context);
  const unavailable=news({available:1,total:2,workers:[{id:'worker-a',is_healthy:false,drained:false,recovery_waiting:0,quarantine:null}]});
  assert.equal(unavailable.level,'warn');assert.match(unavailable.items[0].text,/enabled but unavailable/);
  for(const worker of [{id:'worker-a',is_healthy:false,drained:true,operator_paused:true},{id:'worker-a',is_healthy:false,drained:false,holds:[{id:'hold'}]}]) {
    const deliberate=news({available:1,total:2,workers:[worker]});assert.equal(deliberate.level,'unknown');assert.match(deliberate.items[0].text,/Gate Genie is off/);
  }
  const overdue=news({available:1,total:2,workers:[{id:'worker-a',is_healthy:true,drained:true,maintenance_locks:[{name:'speed-test',review_at:1}]}]});
  assert.equal(overdue.level,'warn');assert.match(overdue.items[0].text,/overdue maintenance lock speed-test/);assert.match(overdue.items[0].text,/separate checked Resume/);
});
test('health wire is a compact keyboard-pausable ticker with no redundant controls or explainer',()=>{
  const html=fs.readFileSync(new URL('./ui/index.html',import.meta.url),'utf8'),css=fs.readFileSync(new URL('./ui/brand.css',import.meta.url),'utf8');
  assert.doesNotMatch(html,/health-wire-pause|Gate Genie <span>health wire|Genie-written observations and recommendations/);assert.match(html,/class="health-wire-window" tabindex="0"/);
  assert.match(html,/id="health-wire-copy"[^>]*aria-hidden="true"/);assert.match(html,/aria-label="Gate Genie fleet health headlines"/);
  assert.match(css,/prefers-reduced-motion:reduce/);assert.match(css,/animation-play-state:paused/);assert.match(css,/aria-hidden="true"\]\{display:none\}/);
  assert.match(css,/gap:6rem;padding-right:6rem/);
  const js=fs.readFileSync(new URL('./ui/ui.js',import.meta.url),'utf8');
  assert.match(js,/getBoundingClientRect\(\)\.width\/52/);assert.match(js,/text\.textContent=entry\.text/);
});
test('each headline keeps its own severity, inert text and label in both copies without disturbing reading',()=>{
  class Element {
    constructor(){this.children=[];this.dataset={};this.style={};this.hovered=false;}
    set innerHTML(_){throw new Error('No headline HTML parsing');}
    set textContent(v){this.text=String(v);}
    get textContent(){return (this.text||'')+this.children.map(c=>c.textContent).join('');}
    append(...children){this.children.push(...children);}
    replaceChildren(...children){this.children=children;}
    matches(){return this.hovered;}
    getBoundingClientRect(){return {width:1680};}
  }
  const elements=new Map(),get=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
  const document={getElementById:get,createElement:()=>new Element()};
  const source=fs.readFileSync(new URL('./ui/ui.js',import.meta.url),'utf8').replace(/^import .*;\n/,'').split('\npoll();')[0];
  const ctx=vm.createContext({document,snap:{gateway:{}},tick:{state:'ready',evidence_at:1000,entries:['good','info','warning','critical'].map(severity=>({severity,text:`${severity} <img onerror=bad()>`,recommendation:null}))}});
  vm.runInContext(source,ctx);const render=()=>vm.runInContext('wireState=tick;renderHealthWire(snap)',ctx);render();
  for(const id of ['health-wire-text','health-wire-copy']){
    const children=get(id).children;assert.deepEqual(children.map(c=>c.dataset.severity),['good','info','warning','critical']);
    assert.deepEqual(children.map(c=>c.children[0].textContent),['Good: ','Info: ','Warning: ','Critical: ']);
    assert.equal(children[3].children[1].textContent,'critical <img onerror=bad()>');
  }
  const first=get('health-wire-text').children[0];render();assert.equal(get('health-wire-text').children[0],first);
  get('health-wire').hovered=true;ctx.tick.entries=[{severity:'invented css-class',text:'New report'}];render();assert.equal(get('health-wire-text').children[0],first);
  get('health-wire').hovered=false;render();assert.equal(get('health-wire-text').children[0].dataset.severity,'info');
  assert.ok(Math.abs(parseFloat(get('health-wire-track').style.animationDuration)-1680/52)<.001);
});
test('headline shades retain readable contrast and are not overridden by aggregate wire severity',()=>{
  const css=fs.readFileSync(new URL('./ui/brand.css',import.meta.url),'utf8');
  const lum=hex=>[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)/255).map(c=>c<=.04045?c/12.92:((c+.055)/1.055)**2.4).reduce((n,c,i)=>n+c*[.2126,.7152,.0722][i],0);
  const bg=lum('#1a1c1d'),colors=[];
  for(const severity of ['good','info','warning','critical']){
    const match=css.match(new RegExp(`\\.health-wire-item\\[data-severity="${severity}"\\]\\{color:(#[a-f0-9]{6})\\}`));
    assert.ok(match,severity);assert.ok((lum(match[1])+.05)/(bg+.05)>=4.5,severity);colors.push(match[1]);
  }
  assert.equal(new Set(colors).size,4);assert.doesNotMatch(css,/\.health-wire\[data-level=.*?color:/);
});
test('dashboard serves local assets and a downloadable read-only snapshot', async t => {
  const { url } = await fixture(t);
  for (const route of ['/', '/ui.css', '/brand.css', '/logo.png', '/ui.js', '/api/status', '/api/diagnostics']) {
    const r = await fetch(url + route); assert.equal(r.status, 200); assert.match(r.headers.get('cache-control'), /no-store/);
    if (route === '/api/diagnostics') assert.match(r.headers.get('content-disposition'), /attachment/);
    await r.arrayBuffer();
  }
});
test('dashboard names DS4 servers and explains gateway-only concurrency and availability', async t => {
  const { url } = await fixture(t);
  const html = await (await fetch(url)).text();
  const js = await (await fetch(url+'/ui.js')).text();
  assert.match(html,/AVAILABLE DS4 SERVERS/);assert.match(html,/ACTIVE REQUESTS/);assert.match(html,/WAITING IN DSG/);assert.match(html,/Queues still inside Pi, Hermes or another client/);assert.match(js,/incompatible artifact/);
  assert.match(html,/Manage DS4 servers/);assert.match(html,/not necessarily one physical machine/);
  assert.match(html,/Direct clients are outside this limit/);
  assert.match(html,/Available means healthy and enabled, including busy servers/);
  assert.match(html,/Warm cache slots retain sessions/);
  assert.match(js,/one active gateway request per DS4 server/);
  assert.doesNotMatch(html+js,/AVAILABLE SPARKS|AVAILABLE WORKERS|active generation per Spark|active gateway request per worker/);
});
test('fleet overview is a dense status band and controls live in one settings tab',()=>{
  const html=fs.readFileSync(new URL('./ui/index.html',import.meta.url),'utf8'),js=fs.readFileSync(new URL('./ui/ui.js',import.meta.url),'utf8'),css=fs.readFileSync(new URL('./ui/brand.css',import.meta.url),'utf8');
  assert.match(html,/<section class="status-deck"/);assert.match(html,/id="health-wire"[\s\S]*class="workspace-tabs"[\s\S]*class="status-deck"[\s\S]*class="capacity-panel"[\s\S]*class="overview"/);
  assert.doesNotMatch(html,/Gateway request slots, not GPU utilization\. Warm cache slots are separate\./);
  assert.doesNotMatch(html,/id="server-settings"|\[ server controls \]/);assert.match(js,/openServerSettings/);
  assert.match(html,/id="tab-settings"[^>]*aria-controls="view-settings"[^>]*data-workspace-tab="settings"/);
  assert.match(html,/id="view-settings"[^>]*>[\s\S]*id="worker-management"[\s\S]*id="spark-profile"/);
  assert.match(js,/fmtWhole\(m\?\.tps\)/);assert.match(js,/class="remaining-estimate/);assert.match(js,/class="device-evidence"/);
  assert.match(css,/\.metric-block\{display:grid;grid-template-rows:/);assert.match(css,/\.status-deck\{display:grid;grid-template-columns:/);assert.match(css,/\.workspace-tabs \.settings-tab\{display:inline-flex;[^}]*margin-left:auto/);
  assert.match(html,/id="health-wire"[\s\S]*id="genie-hardening"[\s\S]*class="workspace-tabs"/);assert.match(html,/Private developer hypotheses distilled from bounded DSG failure evidence/);
  assert.match(js,/function renderHardeningNotes/);assert.match(js,/suggestion\.textContent=note\.suggestion/);assert.match(css,/\.genie-hardening\{/);
});
test('dashboard uses accessible persistent views instead of one overwhelming vertical page',()=>{
  const html=fs.readFileSync(new URL('./ui/index.html',import.meta.url),'utf8'),js=fs.readFileSync(new URL('./ui/ui.js',import.meta.url),'utf8'),css=fs.readFileSync(new URL('./ui/brand.css',import.meta.url),'utf8');
  assert.match(html,/class="workspace-tabs" role="tablist"/);
  for(const [name,label] of [['fleet','Fleet'],['genie','Gate Genie'],['analytics','Analytics'],['activity','Activity']]){
    assert.match(html,new RegExp(`id="tab-${name}"[^>]*role="tab"[^>]*aria-controls="view-${name}"[^>]*data-workspace-tab="${name}"[^>]*>${label}<`));
    assert.match(html,new RegExp(`id="view-${name}"[^>]*role="tabpanel"[^>]*aria-labelledby="tab-${name}"[^>]*data-workspace-view="${name}"`));
  }
  assert.match(html,/id="tab-settings"[^>]*role="tab"[^>]*aria-controls="view-settings"[^>]*data-workspace-tab="settings"[^>]*>[\s\S]*<span>Settings<\/span>/);
  assert.match(html,/id="view-settings"[^>]*role="tabpanel"[^>]*aria-labelledby="tab-settings"[^>]*data-workspace-view="settings"/);
  assert.match(html,/id="view-fleet"[^>]*>[\s\S]*id="devices"[\s\S]*<\/section>\s*<section id="view-genie"/);
  assert.match(html,/id="view-genie"[^>]*hidden>[\s\S]*id="genie-reports"[\s\S]*id="recovery-actions"[\s\S]*id="genie-memory"/);
  assert.match(html,/id="view-analytics"[^>]*hidden>[\s\S]*id="dataset-status"[\s\S]*id="analytics"/);
  assert.match(html,/id="view-activity"[^>]*hidden>[\s\S]*id="continuity-rejections"[\s\S]*id="requests"/);
  assert.match(html,/id="view-settings"[^>]*hidden>[\s\S]*id="worker-management"[\s\S]*id="worker-form"/);
  assert.match(js,/function activateWorkspaceTab/);assert.match(js,/ArrowRight/);assert.match(js,/history\?\.replaceState/);assert.match(js,/activateWorkspaceTab\('settings',\{updateHash:true\}\)/);
  assert.match(css,/\.workspace-tabs\{/);assert.match(css,/\.workspace-view\[hidden\]\{display:none\}/);assert.match(css,/\.workspace-tabs button\[aria-selected="true"\]/);
});
test('cache evidence health exposes epoch coverage and abstention without claiming a cache hit',async t=>{
  const {url}=await fixture(t),html=await (await fetch(url)).text(),js=await (await fetch(url+'/ui.js')).text();
  assert.match(html,/Cache evidence and cost · measured components/);assert.match(html,/id="cache-evidence-status"/);
  assert.match(js,/telemetry-enabled servers have an observed process epoch/);assert.match(js,/Corroborated is still a bounded candidate, not protocol proof or a cache-hit verdict/);
});
test('dashboard links the pinned Spark recommendation without implying live configuration or fixed disk slots', async t => {
  const { url } = await fixture(t);
  const html = await (await fetch(url)).text();
  const profile = fs.readFileSync(new URL('../docs/recommended-spark-profile.md',import.meta.url),'utf8');
  assert.match(html, /<details id="spark-profile"><summary>Recommended DGX Spark configuration/);
  assert.match(html, /href="https:\/\/github.com\/JordiPosthumus\/dwarf-star-gate\/blob\/main\/docs\/recommended-spark-profile\.md" target="_blank" rel="noopener noreferrer"/);
  assert.match(html, /262,144-token context, two hot sessions, one active request per Spark/);
  assert.match(html, /349,525 MiB/); assert.match(html, /not a fixed ten-slot guarantee/);
  assert.match(html, /guidance, not a reading of live settings/); assert.match(html, /does not change servers or apply to Macs/);
  assert.match(profile, /552f6b834ce0b5c53b25a89a8468df5fdd1804de/);
  for (const flag of ['--ctx 262144','--tokens 262144','--batched-session 2','--max-active-requests 1','--kv-disk-space-mb 349525','--prefill-chunk 2048']) assert.ok(profile.includes(flag),flag);
  assert.match(profile, /DS4_KV_REWIND_REUSE=0/); assert.match(profile, /NV_ERR_NO_MEMORY/);
});
test('every HTML-referenced asset is served, including a real PNG logo with bounded fallback dimensions', async t => {
  const { url } = await fixture(t);
  const html = await (await fetch(url)).text();
  const routes = [...new Set([...html.matchAll(/(?:src|href)="(\/[^"#]*)"/g)].map(m=>m[1]))];
  assert.ok(routes.includes('/logo.png')); assert.ok(routes.includes('/brand.css'));
  for (const route of routes) {
    const r = await fetch(url+route); assert.equal(r.status,200,route);
    const bytes = Buffer.from(await r.arrayBuffer()); assert.ok(bytes.length>0);
    if (route === '/logo.png') { assert.equal(r.headers.get('content-type'),'image/png'); assert.equal(bytes.subarray(1,4).toString(),'PNG'); }
  }
  assert.match(html, /class="gate-art"[^>]*width="148" height="111"/);
});
test('an active dashboard serves a frozen complete bundle and rejects missing assets at startup', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'dwarf-gate-assets-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  fs.cpSync(new URL('./ui/',import.meta.url),dir,{recursive:true});
  const server = createDashboard(()=>({read_only:true}),dir);
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  t.after(()=>{server.closeAllConnections();server.close();});
  const url = `http://127.0.0.1:${server.address().port}`;
  const original = await(await fetch(url+'/brand.css')).text();
  fs.writeFileSync(path.join(dir,'brand.css'),'temporary incomplete edit');
  assert.equal(await(await fetch(url+'/brand.css')).text(),original);
  fs.writeFileSync(path.join(dir,'index.html'),'<img src="/not-served.png">');
  assert.throws(()=>createDashboard(()=>({}),dir),/Unserved dashboard asset/);
});
test('logo-derived icons include a transparent monochrome Safari mask and correctly sized PNG/ICO assets',async t=>{
  const {url}=await fixture(t),html=await(await fetch(url)).text();
  assert.match(html,/rel="shortcut icon" href="\/favicon-v2\.ico"/);
  assert.match(html,/rel="mask-icon" href="\/dsg-pinned-v2\.svg" color="#[a-f0-9]{6}"/);
  assert.match(html,/rel="apple-touch-icon" sizes="180x180" href="\/apple-touch-icon-v2\.png"/);
  assert.match(html,/rel="icon" type="image\/svg\+xml" sizes="any"/);
  const r=await fetch(url+'/dsg-pinned-v2.svg'),mask=await r.text();assert.equal(r.headers.get('content-type'),'image/svg+xml');
  assert.match(mask,/viewBox="0 0 64 64"/);assert.match(mask,/<g fill="#000000">/);assert.equal((mask.match(/<path /g)||[]).length,3);
  assert.doesNotMatch(mask,/<(?:rect|image|script|foreignObject)|href=|style=/);
  for(const [file,size] of [['favicon-v2.png',32],['apple-touch-icon-v2.png',180]]) {
    const image=Buffer.from(await(await fetch(url+'/'+file)).arrayBuffer());assert.equal(image.subarray(1,4).toString(),'PNG');assert.equal(image.readUInt32BE(16),size);assert.equal(image.readUInt32BE(20),size);
  }
  const ico=Buffer.from(await(await fetch(url+'/favicon-v2.ico')).arrayBuffer());assert.equal(ico.readUInt16LE(2),1);assert.equal(ico.readUInt16LE(4),2);
  for(const [i,size] of [16,32].entries()) {
    const entry=6+i*16,offset=ico.readUInt32LE(entry+12),length=ico.readUInt32LE(entry+8);assert.equal(ico[entry],size);assert.equal(ico[entry+1],size);assert.ok(offset+length<=ico.length);assert.equal(ico.readUInt32BE(offset+16),size);
  }
});
test('dashboard rejects mutation, unknown paths, cross-origin and DNS-rebinding requests', async t => {
  const { url } = await fixture(t);
  for (const [route, options, code] of [
    ['/api/status', { method:'POST' }, 405], ['/../config.production.json', {}, 404],
    ['/api/status', { headers:{ origin:'https://evil.example' } }, 403],
    ['/api/status', { headers:{ 'sec-fetch-site':'cross-site' } }, 403],
    ['/api/status', { headers:{ host:'attacker.example' } }, 403],
  ]) {
    // Use raw HTTP: fetch implementations can override Host / Sec-Fetch-* headers.
    const status = await new Promise((resolve,reject) => {
      const req = http.request(url+route, options, res => { res.resume(); res.on('end',()=>resolve(res.statusCode)); });
      req.on('error',reject); req.end();
    });
    assert.equal(status, code, JSON.stringify(options));
  }
});
test('opt-in worker controls require same origin, JSON and a CSRF token; diagnostics never contain the token', async t => {
  const calls=[];
  const {url}=await fixture(t,{read:async()=>({workers:[]}),act:async(action,body)=>{calls.push({action,body});return {ok:true};}});
  const init=await(await fetch(url+'/api/workers')).json();assert.equal(init.enabled,true);assert.ok(init.csrf_token.length>30);
  const post=(route,body,headers={})=>fetch(url+route,{method:'POST',headers,body});
  const valid={origin:url,'content-type':'application/json','x-dsg-csrf':init.csrf_token};
  assert.equal((await post('/api/workers/add','{}',{'content-type':'application/json'})).status,403);
  assert.equal((await post('/api/workers/add','{}',{...valid,origin:'https://evil.example'})).status,403);
  assert.equal((await post('/api/workers/add','{}',{...valid,'x-dsg-csrf':'wrong'})).status,403);
  assert.equal((await post('/api/workers/add','{}',{...valid,'content-type':'text/plain'})).status,415);
  assert.equal((await post('/api/workers/add','{bad',valid)).status,400);
  assert.equal((await post('/api/workers/add','x'.repeat(9000),valid)).status,413);
  assert.equal(calls.length,0);
  assert.equal((await post('/api/workers/context','{}',{'content-type':'application/json'})).status,403);
  assert.equal((await post('/api/workers/queue-timeout','{}',{'content-type':'application/json'})).status,403);
  for(const action of ['add','drain','resume','lock','unlock','remove','fallbacks','context','queue-timeout','protection','relocate']) assert.equal((await post('/api/workers/'+action,JSON.stringify({id:'fake'}),valid)).status,200);
  assert.deepEqual(calls.map(x=>x.action),['add','drain','resume','lock','unlock','remove','fallbacks','context','queue-timeout','protection','relocate']);
  assert.ok(!(await(await fetch(url+'/api/diagnostics')).text()).includes(init.csrf_token));
  const plain=await fixture(t);assert.deepEqual(await(await fetch(plain.url+'/api/workers')).json(),{enabled:false});
});
test('worker UI only offers removal after draining and finishing admitted work', () => {
  const source=fs.readFileSync(new URL('./ui/ui.js',import.meta.url),'utf8').replace(/^import .*;\n/,'').split('\npoll();')[0];
  const context=vm.createContext({});vm.runInContext(source,context);
  const rows=w=>vm.runInContext(`workerRows(${JSON.stringify([w])})`,context);
  assert.match(rows({id:'m3',is_healthy:true,drained:false,load:0,queued:0}),/data-action="remove"[^>]+disabled/);
  assert.match(rows({id:'m3',is_healthy:true,drained:true,load:1,queued:0}),/data-action="remove"[^>]+disabled/);
  assert.doesNotMatch(rows({id:'m3',is_healthy:true,drained:true,load:0,queued:0}),/data-action="remove"[^>]+disabled/);
  assert.match(rows({id:'m3',is_healthy:true,drained:true,load:0,queued:0,context_length:300000}),/300,000/);
});
test('server verdicts expose backlog, oldest wait, pause, health and telemetry staleness without guessing speed',()=>{
  const source=fs.readFileSync(new URL('./ui/ui.js',import.meta.url),'utf8').replace(/^import .*;\n/,'').split('\npoll();')[0];
  const context=vm.createContext({});vm.runInContext(source,context);
  const verdict=(device,worker,stale=false)=>vm.runInContext(`serverVerdict(${JSON.stringify(device)},${JSON.stringify(worker)},100000,${stale})`,context);
  assert.equal(verdict({connected:true,last_event:99000},{is_healthy:true,drained:false,load:0,queued:0}).label,'Ready · idle');
  assert.deepEqual({...verdict({connected:true,last_event:99000},{is_healthy:true,drained:false,load:1,queued:4,oldest_queue_seconds:90})},{level:'warn',label:'Backed up · 4 waiting',detail:'4 requests are queued; oldest has waited 90 seconds.'});
  assert.equal(verdict({connected:true,last_event:99000},{is_healthy:true,drained:true,load:0,queued:0}).label,'Paused');
  assert.equal(verdict({connected:false,last_event:0},{is_healthy:true,drained:false,load:0,queued:0}).label,'Ready · telemetry stale');
  assert.equal(verdict({}, {is_healthy:false,drained:false,load:0,queued:0}).label,'Unavailable');
  assert.equal(verdict({}, {is_healthy:true,quarantine:{reason:'accelerator_checkpoint_failure'},load:0,queued:0}).label,'Quarantined');
  assert.equal(verdict({}, {},true).label,'Status stale');
});
test('headline waiting count includes Continuity Door holds without claiming Pi-local queues',()=>{
  const source=fs.readFileSync(new URL('./ui/ui.js',import.meta.url),'utf8').replace(/^import .*;\n/,'').split('\npoll();')[0];
  const ctx=vm.createContext({console,document:{getElementById:()=>({})},window:{},fetch:async()=>{throw new Error('unused')},setInterval:()=>{},setTimeout:()=>{},clearTimeout:()=>{},AbortSignal,URL,Date,Intl});
  vm.runInContext(source,ctx);
  assert.deepEqual({...vm.runInContext(`knownWaiting({queued:3},{holding:true,held:6})`,ctx)},{core:3,held:6,total:9});
  assert.deepEqual({...vm.runInContext(`knownWaiting({queued:3},{holding:false,held:99})`,ctx)},{core:3,held:0,total:3});
});
test('unavailable server verdicts explain the observed management layer and avoid a duplicate phase badge',()=>{
  const source = fs.readFileSync(new URL('./ui/ui.js',import.meta.url),'utf8').replace(/^import .*;\n/,'').split('\npoll();')[0];
  const context = vm.createContext({phase:()=> 'unavailable'});vm.runInContext(source,context);
  const worker={id:'spark1',is_healthy:false,drained:false,load:0,queued:0,management_path:{transport:'ssh_tunnel',state:'ssh_error',reason:'adapter_dns_failure',route_count:3}};
  const verdict=vm.runInContext(`serverVerdict({},${JSON.stringify(worker)},100000,false)`,context);
  assert.match(verdict.detail,/cannot resolve/);assert.match(verdict.detail,/cycling through 3 enrolled SSH routes/);assert.ok(!verdict.detail.includes('worker.example'));
  const html=vm.runInContext(`device({id:'spark1',cache:{},series:[]},${JSON.stringify(worker)},100000,false,1,{decode:1,prefill:1},true)`,context);
  assert.match(html,/server-verdict[^>]*>Unavailable</);assert.match(html,/class="badge bad"[^>]*hidden>unavailable</);
  assert.match(html,/class="device-name-text">Spark 1<\/span>/);
  const auth={...worker,management_path:{transport:'ssh_tunnel',state:'ssh_error',reason:'adapter_auth_failure'}};
  assert.match(vm.runInContext(`serverVerdict({},${JSON.stringify(auth)},100000,false).detail`,context),/authentication failed/);
});
test('request log filters problems and slow work while treating compatibility guidance as non-failure',async t=>{
  const {url}=await fixture(t),html=await(await fetch(url)).text(),js=await(await fetch(url+'/ui.js')).text();
  assert.match(html,/id="request-filter"/);assert.match(html,/Problems only/);assert.match(html,/Slow only/);
  assert.match(js,/\['complete','vision_guidance'\]/);assert.match(js,/elapsed_ms>=300000\|\|e\.queue_ms>=60000/);assert.match(js,/vision_guidance' \? 'protected'/);
});
test('fresh empty fleets get an explicit first-server setup path',async t=>{
  const {url}=await fixture(t),html=await(await fetch(url)).text(),js=await(await fetch(url+'/ui.js')).text();
  assert.match(html,/Manage DS4 servers/);assert.match(js,/Add your first DS4 server/);assert.match(js,/data-add-first/);assert.match(js,/function openServerSettings/);assert.match(js,/activateWorkspaceTab\('settings',\{updateHash:true\}\)/);
});
test('dashboard follows live membership and marks machines without engine logs explicitly', async t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dsg-membership-ui-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  let workers=[{id:'spark1',is_healthy:true,load:0,context_length:153600}];
  const backend=http.createServer((_req,res)=>res.end(JSON.stringify({version:1,model:'ds4',context_length:153600,workers,total:workers.length,healthy:workers.length})));
  backend.listen(0,'127.0.0.1');await once(backend,'listening');t.after(()=>{backend.closeAllConnections();backend.close();});
  const config=path.join(dir,'config.json');fs.writeFileSync(config,JSON.stringify({port:backend.address().port,api_key:'test',state_file:path.join(dir,'state.json'),nodes:[{id:'spark1'}]}));
  const app=await runDashboard(config,0);t.after(app.close);
  workers=[...workers,{id:'m3-studio',is_healthy:true,load:0,context_length:300000}];
  const wait=async fn=>{const end=Date.now()+3500;while(!fn()){if(Date.now()>end)throw new Error('Dashboard membership did not refresh');await delay(20);}};
  await wait(()=>app.snapshot().devices.length===2);
  assert.equal(app.snapshot().devices[1].telemetry_configured,false);
  assert.equal(app.snapshot().gateway.workers[1].context_length,300000);
  workers=workers.slice(1);await wait(()=>app.snapshot().devices.length===1);
  assert.equal(app.snapshot().devices[0].id,'m3-studio');
});
test('dashboard ingests a local engine log without inference calls or exporting the private path', async t => {
  const {dir,file}=logFixture(t), calls=[];
  const now=new Date(), pad=n=>String(n).padStart(2,'0');
  const prefix=`${pad(now.getMonth()+1)}${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())} ds4-server: `;
  fs.writeFileSync(file,prefix+'chat ctx=0..10:10 prompt start\n'+prefix+'chat ctx=10..60:50 gen=50 THINKING decoding chunk=36.2 t/s avg=35.7 t/s 1.40s\nprivate answer NEVER_EXPORT\n');
  const backend=http.createServer((req,res)=>{calls.push(req.url);res.end(JSON.stringify({version:1,model:'ds4',workers:[{id:'studio',is_healthy:true,load:1}]}));});
  backend.listen(0,'127.0.0.1');await once(backend,'listening');t.after(()=>{backend.closeAllConnections();backend.close();});
  const config=path.join(dir,'config.json');
  fs.writeFileSync(config,JSON.stringify({port:backend.address().port,api_key:'test',state_file:path.join(dir,'state.json'),nodes:[{id:'studio',telemetry_service:null}],telemetry_files:{studio:file}}));
  const app=await runDashboard(config,0);t.after(app.close);
  const d=app.snapshot().devices[0];assert.equal(d.telemetry_source,'file');assert.equal(d.connected,true);assert.equal(d.decode.tps,36.2);
  assert.equal(app.snapshot().attribution.mode,'shadow');assert.equal(app.snapshot().attribution.counts.abstained,1,'local log has no proven process epoch');
  const url=`http://127.0.0.1:${app.server.address().port}`;
  const exported=await(await fetch(url+'/api/diagnostics')).text();
  const persisted=fs.readdirSync(path.join(dir,'dashboard')).map(f=>fs.readFileSync(path.join(dir,'dashboard',f),'utf8')).join('');
  for(const text of [exported,persisted]) {assert.ok(!text.includes(file));assert.ok(!text.includes('NEVER_EXPORT'));assert.ok(!text.includes('ds4-server:'));}
  assert.deepEqual(calls,['/gateway/status']);
});
test('dashboard ingests opt-in hardware numbers without exporting the source path or raw fields',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dsg-hardware-ui-')),file=path.join(dir,'private-meter.jsonl'),calls=[];t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  fs.writeFileSync(file,JSON.stringify({time:Date.now(),memory_used_bytes:75,memory_total_bytes:100,memory_scope:'host_unified',power_watts:64,power_scope:'system',private_label:'NEVER_EXPORT'})+'\n');
  const backend=http.createServer((req,res)=>{calls.push(req.url);res.end(JSON.stringify({version:1,model:'ds4',workers:[{id:'studio',is_healthy:true,load:0}]}));});backend.listen(0,'127.0.0.1');await once(backend,'listening');t.after(()=>{backend.closeAllConnections();backend.close();});
  const config=path.join(dir,'config.json');fs.writeFileSync(config,JSON.stringify({port:backend.address().port,api_key:'test',state_file:path.join(dir,'state.json'),nodes:[{id:'studio',telemetry_service:null}],hardware_telemetry:{enabled:true,workers:{studio:{adapter:'jsonl-file',path:file}}}}));
  const app=await runDashboard(config,0);t.after(app.close);const hardware=app.snapshot().devices[0].hardware;assert.equal(hardware.state,'connected');assert.equal(hardware.current.power_watts,64);assert.equal(hardware.current.power_scope,'system');
  const exported=JSON.stringify(app.snapshot()),persisted=fs.readdirSync(path.join(dir,'dashboard')).map(name=>fs.readFileSync(path.join(dir,'dashboard',name),'utf8')).join('');for(const text of [exported,persisted]){assert.ok(!text.includes(file));assert.ok(!text.includes('NEVER_EXPORT'));assert.ok(!text.includes('private_label'));}assert.deepEqual(calls,['/gateway/status']);
});
test('opt-in local cache inventory exports header aggregates without reading or exposing prompt bytes and paths',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dsg-cache-ui-')),cache=path.join(dir,'cache');fs.mkdirSync(cache);t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const name='a'.repeat(40)+'.kv',header=Buffer.alloc(52),prompt=Buffer.from('PRIVATE PROMPT');header.write('KVC');header[3]=1;header[4]=2;header[5]=2;header[7]=2;header.writeUInt32LE(1024,8);header.writeUInt32LE(5,12);header.writeUInt32LE(262144,16);header[20]=2;header[21]=1;header.writeBigUInt64LE(100n,24);header.writeBigUInt64LE(200n,32);header.writeBigUInt64LE(16n,40);header.writeUInt32LE(prompt.length,48);fs.writeFileSync(path.join(cache,name),Buffer.concat([header,prompt,Buffer.alloc(16)]));
  const calls=[],backend=http.createServer((req,res)=>{calls.push(req.url);res.end(JSON.stringify({version:1,model:'ds4',workers:[{id:'studio',is_healthy:true,load:0}]}));});backend.listen(0,'127.0.0.1');await once(backend,'listening');t.after(()=>{backend.closeAllConnections();backend.close();});
  const config=path.join(dir,'config.json');fs.writeFileSync(config,JSON.stringify({port:backend.address().port,api_key:'test',state_file:path.join(dir,'state.json'),nodes:[{id:'studio',telemetry_service:null}],cache_directories:{studio:cache}}));
  const app=await runDashboard(config,0);t.after(app.close);const inventory=app.snapshot().devices[0].cache_inventory;
  assert.equal(inventory.status,'ready');assert.equal(inventory.accepted,1);assert.equal(inventory.cohorts[0].max_tokens,1024);assert.equal(fs.statSync(path.join(dir,'dashboard','cache-inventory.key')).mode&0o077,0);
  const exported=JSON.stringify(app.snapshot());for(const privateValue of [cache,name,'PRIVATE PROMPT'])assert.ok(!exported.includes(privateValue));assert.deepEqual(calls,['/gateway/status']);
  assert.throws(()=>cacheInventoryDirectories({studio:'relative'}));
});
test('six-worker monitoring only reads gateway status; credentials and addresses never enter snapshots', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dwarf-gate-ui-'));
  t.after(() => fs.rmSync(dir, { recursive:true, force:true }));
  const calls = [];
  const backend = http.createServer((req,res) => {
    calls.push(req.url); assert.equal(req.headers.authorization, 'Bearer SECRET_FOR_TEST');
    res.end(JSON.stringify({ version:1, model:'ds4', context_length:153600, total:6, healthy:6, available:6, active:2, queued:0,
      workers:Array.from({ length:6 }, (_,i) => ({ id:`spark${i+1}`, is_healthy:true, load:0, url:'http://private-address', probe_error:'secret',
        requested_thinking:{status:'specified',fields:{reasoning_effort:i===0?'xhigh':'none',prompt:'NEVER_EXPORT'}},
        last_requested_thinking:{status:'not_specified'},last_request_finished_at:'NEVER_EXPORT' })) }));
  });
  backend.listen(0, '127.0.0.1'); await once(backend, 'listening');
  t.after(() => { backend.closeAllConnections(); backend.close(); });
  const config = path.join(dir, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ port:backend.address().port, api_key:'SECRET_FOR_TEST', state_file:path.join(dir,'state.json'), nodes:Array.from({ length:6 },(_,i)=>({id:`spark${i+1}`})) }));
  fs.writeFileSync(path.join(dir,'gateway.log'), JSON.stringify({ event:'request_finished', node:'spark1', outcome:'complete', prompt:'NEVER_EXPORT' })+'\n');
  const app = await runDashboard(config, 0); t.after(app.close);
  const s = app.snapshot(); assert.equal(s.devices.length, 6); assert.equal(s.events.length, 1);
  assert.deepEqual(s.gateway.workers[0].requested_thinking,{status:'specified',fields:{reasoning_effort:'xhigh'}});
  assert.equal(s.gateway.workers[1].requested_thinking.fields.reasoning_effort,'none');
  assert.equal(s.gateway.workers[0].last_request_finished_at,null);
  assert.ok(!/SECRET_FOR_TEST|private-address|NEVER_EXPORT/.test(JSON.stringify(s)));
  assert.deepEqual(calls, ['/gateway/status']);
});
test('dashboard refuses a symlinked gateway event log and recovers when a regular log appears', async t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dsg-gateway-log-'));
  const outside=fs.mkdtempSync(path.join(os.tmpdir(),'dsg-gateway-private-'));
  t.after(()=>{fs.rmSync(dir,{recursive:true,force:true});fs.rmSync(outside,{recursive:true,force:true});});
  const event=JSON.stringify({event:'request_finished',node:'spark1',outcome:'complete',request_id:'fixture'});
  const target=path.join(outside,'private.jsonl');fs.writeFileSync(target,event+'\n');
  fs.symlinkSync(target,path.join(dir,'gateway.log'));
  const backend=http.createServer((_req,res)=>res.end(JSON.stringify({version:1,model:'ds4',workers:[{id:'spark1',is_healthy:true,load:0}]})));
  backend.listen(0,'127.0.0.1');await once(backend,'listening');t.after(()=>{backend.closeAllConnections();backend.close();});
  const config=path.join(dir,'config.json');fs.writeFileSync(config,JSON.stringify({port:backend.address().port,api_key:'test',state_file:path.join(dir,'state.json'),nodes:[{id:'spark1'}]}));
  const app=await runDashboard(config,0);t.after(app.close);assert.equal(app.snapshot().events.length,0);
  fs.unlinkSync(path.join(dir,'gateway.log'));fs.writeFileSync(path.join(dir,'gateway.log'),event+'\n');
  const end=Date.now()+3500;while(!app.snapshot().events.length){if(Date.now()>end)throw new Error('Dashboard did not resume a regular gateway log');await delay(20);}
  assert.equal(app.snapshot().events.length,1);assert.equal(fs.readFileSync(target,'utf8'),event+'\n');
});
