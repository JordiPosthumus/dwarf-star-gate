import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import vm from 'node:vm';
import { setTimeout as delay } from 'node:timers/promises';
import { parseTiming, safeGatewayEvent, DeviceTelemetry, JournalReader } from './telemetry.mjs';
import { createDashboard, runDashboard } from './dashboard.mjs';
const parse = (s, t = 1000) => parseTiming(`0902 14:00:00 ds4-server: ${s}`, t);

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
  const record = { __CURSOR:'s=abc;i=123;t=def', __REALTIME_TIMESTAMP:'1000000', MESSAGE:'ds4-server: chat ctx=0..10:10 prompt start' };
  assert.ok(r.accept(record)); assert.equal(r.accept(record), null); assert.equal(d.cache.starts, 1);
  assert.equal(r.accept({ ...record, __CURSOR:"';echo private;'" }), null);
  assert.equal(r.accept({ ...record, __CURSOR:'s=abc;i=124', __REALTIME_TIMESTAMP:'invalid' }), null);
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
  const source = fs.readFileSync(new URL('./ui/ui.js',import.meta.url),'utf8').replace(/\npoll\(\);\s*$/,'');
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
  assert.match(html, /153,600-token context, two hot sessions, one active request per Spark/);
  assert.match(html, /349,525 MiB/); assert.match(html, /not a fixed ten-slot guarantee/);
  assert.match(html, /guidance, not a reading of live settings/); assert.match(html, /does not change servers or apply to Macs/);
  assert.match(profile, /552f6b834ce0b5c53b25a89a8468df5fdd1804de/);
  for (const flag of ['--ctx 153600','--tokens 153600','--batched-session 2','--max-active-requests 1','--kv-disk-space-mb 349525','--prefill-chunk 4096']) assert.ok(profile.includes(flag),flag);
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
  assert.match(html, /class="gate-art"[^>]*width="148" height="105"/);
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
  for(const action of ['add','drain','resume','remove']) assert.equal((await post('/api/workers/'+action,JSON.stringify({id:'fake'}),valid)).status,200);
  assert.deepEqual(calls.map(x=>x.action),['add','drain','resume','remove']);
  assert.ok(!(await(await fetch(url+'/api/diagnostics')).text()).includes(init.csrf_token));
  const plain=await fixture(t);assert.deepEqual(await(await fetch(plain.url+'/api/workers')).json(),{enabled:false});
});
test('worker UI only offers removal after draining and finishing admitted work', () => {
  const source=fs.readFileSync(new URL('./ui/ui.js',import.meta.url),'utf8').replace(/\npoll\(\);\s*$/,'');
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
