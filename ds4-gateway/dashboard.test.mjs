import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
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
async function fixture(t) {
  const server = createDashboard(() => ({ version:1, read_only:true, devices:[] }));
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
test('six-worker monitoring only reads gateway status; credentials and addresses never enter snapshots', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dwarf-gate-ui-'));
  t.after(() => fs.rmSync(dir, { recursive:true, force:true }));
  const calls = [];
  const backend = http.createServer((req,res) => {
    calls.push(req.url); assert.equal(req.headers.authorization, 'Bearer SECRET_FOR_TEST');
    res.end(JSON.stringify({ version:1, model:'ds4', context_length:153600, total:6, healthy:6, available:6, active:2, queued:0,
      workers:Array.from({ length:6 }, (_,i) => ({ id:`spark${i+1}`, is_healthy:true, load:0, url:'http://private-address', probe_error:'secret' })) }));
  });
  backend.listen(0, '127.0.0.1'); await once(backend, 'listening');
  t.after(() => { backend.closeAllConnections(); backend.close(); });
  const config = path.join(dir, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ port:backend.address().port, api_key:'SECRET_FOR_TEST', state_file:path.join(dir,'state.json'), nodes:Array.from({ length:6 },(_,i)=>({id:`spark${i+1}`})) }));
  fs.writeFileSync(path.join(dir,'gateway.log'), JSON.stringify({ event:'request_finished', node:'spark1', outcome:'complete', prompt:'NEVER_EXPORT' })+'\n');
  const app = await runDashboard(config, 0); t.after(app.close);
  const s = app.snapshot(); assert.equal(s.devices.length, 6); assert.equal(s.events.length, 1);
  assert.ok(!/SECRET_FOR_TEST|private-address|NEVER_EXPORT/.test(JSON.stringify(s)));
  assert.deepEqual(calls, ['/gateway/status']);
});
