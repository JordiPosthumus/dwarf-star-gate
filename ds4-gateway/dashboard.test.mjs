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
import { FileLogReader, parseLocalTiming, telemetryFiles } from './file-telemetry.mjs';
const parse = (s, t = 1000) => parseTiming(`0902 14:00:00 ds4-server: ${s}`, t);

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
  assert.ok(state(q,{recovering:true}).blocked);
  assert.equal(state({...q,quarantine:null,drained:true,operator_paused:true}).button,'Resume routing');
  assert.equal(state({...q,quarantine:null,drained:true,operator_paused:true}).blocked,false,'fresh probe may restore a previously unavailable paused server');
  const ready={...q,quarantine:null,is_healthy:true};assert.equal(state(ready).button,'Pause routing');assert.equal(state(ready).excluded,false);
  const compact=markup(ready);assert.match(compact,/class="worker-routing"/);assert.match(compact,/data-action="drain"/);assert.match(compact,/<svg/);
  assert.match(compact,/data-tooltip="ROUTING ENABLED[^\"]*New requests may use this server[^\"]*admitted requests finish/);
  assert.match(compact,/aria-label="ROUTING ENABLED/);assert.doesNotMatch(compact,/<p(?:\s|>)|<strong|Pause routing<\/button>/);
  const paused=markup({...ready,drained:true,operator_paused:true});assert.match(paused,/data-action="resume"/);assert.match(paused,/operator paused gateway routing/);
  assert.equal(state(ready,{stale:true}).action,null);assert.ok(!markup(ready,{controls:false}).includes('<button'));
  assert.ok(!markup({...q,holds:[{owner_id:'<script>evil</script>'}]}).includes('<script>'));
  assert.match(markup({...q,holds:[{owner_id:'<script>evil</script>'}]}),/&lt;script&gt;/);
  const html=fs.readFileSync(new URL('./ui/index.html',import.meta.url),'utf8');
  assert.ok(html.includes('id="routing-summary"'));assert.ok(html.indexOf('id="routing-message"')>html.indexOf('</details>'));
  assert.match(source,/\$\('devices'\)\.addEventListener\('click',handleWorkerClick\)/);
  assert.match(source,/Verify and readmit.*small test response/);
  const css=fs.readFileSync(new URL('./ui/brand.css',import.meta.url),'utf8');
  assert.match(css,/\.device-status\{display:flex/);assert.match(css,/\.routing-toggle\{[^}]*width:29px;height:29px/);
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
});
test('health wire markup offers pause and keyboard access, with a nonduplicated reduced-motion view',()=>{
  const html=fs.readFileSync(new URL('./ui/index.html',import.meta.url),'utf8'),css=fs.readFileSync(new URL('./ui/brand.css',import.meta.url),'utf8');
  assert.match(html,/id="health-wire-pause"[^>]*aria-pressed="false"/);assert.match(html,/class="health-wire-window" tabindex="0"/);
  assert.match(html,/id="health-wire-copy"[^>]*aria-hidden="true"/);assert.match(html,/Genie-written observations/);
  assert.match(css,/prefers-reduced-motion:reduce/);assert.match(css,/animation-play-state:paused/);assert.match(css,/aria-hidden="true"\]\{display:none\}/);
  assert.match(css,/gap:8rem;padding-right:8rem/);
  const js=fs.readFileSync(new URL('./ui/ui.js',import.meta.url),'utf8');
  assert.match(js,/getBoundingClientRect\(\)\.width\/42/);assert.match(js,/text\.textContent=entry\.text/);
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
  get('health-wire').hovered=false;vm.runInContext('wirePaused=true',ctx);render();assert.equal(get('health-wire-text').children[0],first);
  vm.runInContext('wirePaused=false',ctx);render();assert.equal(get('health-wire-text').children[0].dataset.severity,'info');
  assert.equal(get('health-wire-track').style.animationDuration,'40s');
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
  assert.match(html,/AVAILABLE DS4 SERVERS/);assert.match(html,/ACTIVE REQUESTS/);
  assert.match(html,/Manage DS4 servers/);assert.match(html,/not necessarily one physical machine/);
  assert.match(html,/Direct clients are outside this limit/);
  assert.match(html,/Available means healthy and enabled, including busy servers/);
  assert.match(html,/Warm cache slots retain sessions/);
  assert.match(js,/one active gateway request per DS4 server/);
  assert.doesNotMatch(html+js,/AVAILABLE SPARKS|AVAILABLE WORKERS|active generation per Spark|active gateway request per worker/);
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
  assert.match(html,/rel="mask-icon" href="\/dsg-pinned-v1\.svg" color="#[a-f0-9]{6}"/);
  assert.match(html,/rel="apple-touch-icon" sizes="180x180" href="\/apple-touch-icon\.png"/);
  assert.match(html,/rel="icon" type="image\/svg\+xml" sizes="any"/);
  const r=await fetch(url+'/dsg-pinned-v1.svg'),mask=await r.text();assert.equal(r.headers.get('content-type'),'image/svg+xml');
  assert.match(mask,/viewBox="0 0 64 64"/);assert.match(mask,/<g fill="#000000">/);assert.equal((mask.match(/<path /g)||[]).length,3);
  assert.doesNotMatch(mask,/<(?:rect|image|script|foreignObject)|href=|style=/);
  for(const [file,size] of [['favicon-v1.png',32],['apple-touch-icon.png',180]]) {
    const image=Buffer.from(await(await fetch(url+'/'+file)).arrayBuffer());assert.equal(image.subarray(1,4).toString(),'PNG');assert.equal(image.readUInt32BE(16),size);assert.equal(image.readUInt32BE(20),size);
  }
  const ico=Buffer.from(await(await fetch(url+'/favicon.ico')).arrayBuffer());assert.equal(ico.readUInt16LE(2),1);assert.equal(ico.readUInt16LE(4),2);
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
  for(const action of ['add','drain','resume','remove','context','queue-timeout','relocate']) assert.equal((await post('/api/workers/'+action,JSON.stringify({id:'fake'}),valid)).status,200);
  assert.deepEqual(calls.map(x=>x.action),['add','drain','resume','remove','context','queue-timeout','relocate']);
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
