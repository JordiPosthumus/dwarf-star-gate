import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AffinityStore, createGateway } from './gateway.mjs';

async function until(fn, timeout = 3000) {
  const end = Date.now() + timeout;
  while (!fn()) { if (Date.now() > end) throw new Error('Condition timed out'); await delay(10); }
}
async function backend(id) {
  const b = { id, records: [], active: 0, peak: 0, aborts: 0, health: true };
  b.server = http.createServer((req, res) => {
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: b.health ? 'deepseek-v4-flash' : 'wrong-model', context_length: 153600 }] }));
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks); const p = JSON.parse(body.toString());
      b.records.push({ body, headers: req.headers, payload: p }); b.active++; b.peak = Math.max(b.peak, b.active);
      let ended = false;
      res.on('close', () => { b.active--; if (!ended) b.aborts++; });
      if (p.http_error) { ended = true; res.writeHead(503); res.end('backend-error'); return; }
      if (p.disconnect) { res.destroy(); return; }
      if (p.large_stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        let remaining = 128;
        const send = () => {
          while (remaining > 0) { remaining--; if (!res.write('data: ' + 'x'.repeat(32768) + '\n\n')) { res.once('drain', send); return; } }
          ended = true; res.end('data: [DONE]\n\n');
        }; send(); return;
      }
      if (p.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"reasoning_content":"thinking"}}]}\n\n');
        const timer = setTimeout(() => {
          if (res.destroyed) return;
          ended = true;
          res.end('data: {"choices":[{"delta":{"content":"OK"}}],"usage":{"prompt_tokens":9000,"completion_tokens":2,"prompt_tokens_details":{"cached_tokens":8192}}}\n\ndata: [DONE]\n\n');
        }, p.delay ?? 10);
        res.on('close', () => clearTimeout(timer));
      } else {
        setTimeout(() => { if (!res.destroyed) { ended = true; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ node: id, body: body.toString() })); } }, p.delay ?? 0);
      }
    });
  });
  await new Promise(r => b.server.listen(0, '127.0.0.1', r));
  b.url = `http://127.0.0.1:${b.server.address().port}`;
  b.close = async () => { b.server.closeAllConnections(); await new Promise(r => b.server.close(r)); };
  return b;
}
async function rig(t, count = 2, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds4-gateway-test-'));
  const backends = await Promise.all(Array.from({ length: count }, (_, i) => backend(`spark${i + 1}`)));
  const config = { host: '127.0.0.1', port: 0, api_key: 'none', model: 'deepseek-v4-flash', context_length: 153600,
    state_file: path.join(dir, 'affinity.json'), health_interval_ms: 100000, nodes: backends.map(b => ({ id: b.id, url: b.url })), ...overrides };
  if (config.control_socket === true) config.control_socket = path.join(dir, 'control.sock');
  const r = { config, backends, gateway: createGateway(config) };
  r.address = await r.gateway.start();
  r.request = (body = '{}', key, options = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: r.address.port, path: options.path ?? '/v1/chat/completions', method: options.method ?? 'POST', agent: false,
      headers: { authorization: 'Bearer none', 'content-type': 'application/json', ...(key ? { 'x-session-affinity': key } : {}), ...options.headers } }, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('error', reject); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject); req.end(body);
  });
  r.restart = async (extraNodes = []) => {
    await r.gateway.close(); r.config.nodes.push(...extraNodes);
    r.gateway = createGateway(r.config); r.address = await r.gateway.start();
  };
  t.after(async () => { await r.gateway.close(); await Promise.all(backends.map(b => b.close())); });
  return r;
}

test('new sessions spread; existing sessions stay; restart keeps assignments', async t => {
  const r = await rig(t);
  const a = await r.request('{}', 'a'), b = await r.request('{}', 'b');
  assert.notEqual(a.headers['x-ds4-node'], b.headers['x-ds4-node']);
  assert.equal((await r.request('{}', 'a')).headers['x-ds4-node'], a.headers['x-ds4-node']);
  await r.restart();
  assert.equal((await r.request('{}', 'a')).headers['x-ds4-node'], a.headers['x-ds4-node']);
  assert.equal((await r.request('{}', 'b')).headers['x-ds4-node'], b.headers['x-ds4-node']);
});
test('six workers configurable: all used, adding workers does not remap sessions', async t => {
  const r = await rig(t, 6);
  const mappings = [];
  for (let i = 0; i < 6; i++) mappings.push((await r.request('{}', `s${i}`)).headers['x-ds4-node']);
  assert.equal(new Set(mappings).size, 6);
  await r.restart();
  for (let i = 0; i < 6; i++) assert.equal((await r.request('{}', `s${i}`)).headers['x-ds4-node'], mappings[i]);
});
test('N-worker pools (1, 3, 12, 20) distribute new sessions and retain every home', async t => {
  for (const count of [1, 3, 12, 20]) {
    const r = await rig(t, count);
    const results = await Promise.all(Array.from({length:count},(_,i)=>r.request('{"delay":30}',`fleet-${count}-${i}`)));
    assert.equal(r.gateway.stats().total,count); assert.equal(r.gateway.stats().healthy,count);
    assert.equal(new Set(results.map(x=>x.headers['x-ds4-node'])).size,count);
    for (let i=0;i<count;i++) assert.equal((await r.request('{}',`fleet-${count}-${i}`)).headers['x-ds4-node'],results[i].headers['x-ds4-node']);
    assert.ok(r.backends.every(b=>b.peak===1));
  }
});
test('expand from two to six without moving established sessions', async t => {
  const r = await rig(t);
  const original = (await r.request('{}', 'old')).headers['x-ds4-node'];
  const extra = await Promise.all([3, 4, 5, 6].map(i => backend(`spark${i}`)));
  r.backends.push(...extra);
  await r.restart(extra.map(b => ({ id: b.id, url: b.url })));
  assert.equal((await r.request('{}', 'old')).headers['x-ds4-node'], original);
  const used = new Set();
  for (let i = 0; i < 5; i++) used.add((await r.request('{}', `new${i}`)).headers['x-ds4-node']);
  assert.equal(used.size, 5);
});
test('body bytes and arbitrary DS4 fields survive exactly (vision, tools, xhigh, 153600)', async t => {
  const r = await rig(t);
  const body = '{ "model":"deepseek-v4-flash", "thinking":{"type":"disabled"}, "reasoning_effort":"xhigh", "max_tokens":153600, "unknown_future_field":{"a":1}, "messages":[{"role":"user","content":[{"type":"image_url","image_url":{"url":"data:image/png;base64,abcd"}}]}], "tools":[{"type":"function","function":{"name":"test","parameters":{}}}], "tool_choice":"auto", "stop":["END"] }';
  assert.equal((await r.request(body, 'raw')).status, 200);
  assert.equal(r.backends[0].records[0].body.toString(), body);
});
test('two simultaneous sessions execute one on each node', async t => {
  const r = await rig(t);
  await Promise.all([r.request('{"delay":100}', 'a'), r.request('{"delay":100}', 'b')]);
  assert.equal(r.backends[0].peak, 1); assert.equal(r.backends[1].peak, 1);
});
test('busy home queues FIFO, never spills to idle Spark', async t => {
  const r = await rig(t);
  const first = r.request('{"delay":150,"tag":1}', 'a');
  await until(() => r.gateway.stats().active === 1);
  const second = r.request('{"tag":2}', 'a');
  await until(() => r.gateway.stats().queued === 1);
  await Promise.all([first, second]);
  assert.deepEqual(r.backends[0].records.map(v => v.payload.tag), [1, 2]);
  assert.equal(r.backends[0].peak, 1); assert.equal(r.backends[1].records.length, 0);
});
test('cancel active SSE propagates; next queued request proceeds', async t => {
  const r = await rig(t);
  await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: r.address.port, path: '/v1/chat/completions', method: 'POST', headers: { authorization: 'Bearer none', 'x-session-affinity': 'a' } }, res => {
      res.once('data', () => { res.destroy(); req.destroy(); resolve(); });
    }); req.on('error', reject); req.end('{"stream":true,"delay":10000}');
  });
  await until(() => r.backends[0].aborts === 1 && r.gateway.stats().active === 0);
  assert.equal((await r.request('{}', 'a')).status, 200);
});
test('cancel queued request never executes upstream', async t => {
  const r = await rig(t);
  const first = r.request('{"delay":180}', 'a');
  await until(() => r.gateway.stats().active === 1);
  const queued = http.request({ host: '127.0.0.1', port: r.address.port, path: '/v1/chat/completions', method: 'POST', headers: { authorization: 'Bearer none', 'x-session-affinity': 'a' } });
  queued.on('error', () => {}); queued.end('{}');
  await until(() => r.gateway.stats().queued === 1); queued.destroy();
  await first; await delay(30);
  assert.equal(r.backends[0].records.length, 1); assert.equal(r.gateway.stats().queued, 0);
});
test('no retry on upstream 503 or ambiguous disconnect', async t => {
  const r = await rig(t);
  assert.equal((await r.request('{"http_error":true}', 'a')).status, 503);
  assert.equal((await r.request('{"disconnect":true}', 'a')).status, 502);
  assert.equal(r.backends[0].records.length, 2); assert.equal(r.backends[1].records.length, 0);
});
test('unhealthy idle home reassigns durably; recovery does not bounce session back', async t => {
  const r = await rig(t);
  await r.request('{}', 'a'); r.gateway.nodes[0].healthy = false;
  assert.equal((await r.request('{}', 'a')).headers['x-ds4-node'], 'spark2');
  r.gateway.nodes[0].healthy = true;
  assert.equal((await r.request('{}', 'a')).headers['x-ds4-node'], 'spark2');
  await r.restart(); assert.equal((await r.request('{}', 'a')).headers['x-ds4-node'], 'spark2');
});
test('no failover when old home has unresolved work', async t => {
  const r = await rig(t);
  const first = r.request('{"delay":180}', 'a'); await until(() => r.gateway.stats().active === 1);
  r.gateway.nodes[0].healthy = false;
  assert.equal((await r.request('{}', 'a')).status, 503); await first;
  assert.equal(r.backends[1].records.length, 0);
});
test('queue bound rejects without dispatch, queue timeout does not cap generation', async t => {
  const r = await rig(t, 2, { max_queued_per_node: 1, queue_timeout_ms: 50 });
  const first = r.request('{"delay":170}', 'a'); await until(() => r.gateway.stats().active === 1);
  const second = r.request('{}', 'a'); await until(() => r.gateway.stats().queued === 1);
  assert.equal((await r.request('{}', 'a')).status, 429);
  assert.equal((await second).status, 504); assert.equal((await first).status, 200);
  assert.equal(r.backends[0].records.length, 1);
});
test('SSE forwarded with usage and DONE; no Node five-minute or idle request timeout', async t => {
  const r = await rig(t);
  const result = await r.request('{"stream":true}', 'a');
  assert.match(result.body, /reasoning_content/); assert.match(result.body, /8192/); assert.match(result.body, /\[DONE\]/);
  assert.equal(r.gateway.server.requestTimeout, 0); assert.equal(r.gateway.server.timeout, 0);
});
test('health verifies model identity/context, routes and authentication fail closed', async t => {
  const r = await rig(t, 2, { health_interval_ms: 25, health_failures: 1 });
  r.backends[0].health = false; await until(() => !r.gateway.nodes[0].healthy);
  assert.equal((await r.request('{}', 'a')).headers['x-ds4-node'], 'spark2');
  for (const bad of ['/ha/shutdown', '/workers/abc', '/v1/../ha/shutdown', '/v1/%63hat/completions']) assert.equal((await r.request('{}', 'a', { path: bad })).status, 404);
  assert.equal((await r.request('{}', 'a', { headers: { authorization: 'Bearer wrong' } })).status, 401);
  r.gateway.drain(); assert.equal((await r.request('{}', 'a')).status, 503);
  assert.equal((await r.request('', null, { path: '/gateway/status', method: 'GET' })).status, 200);
});
test('model metadata bypasses generation queue; no-header clients still work', async t => {
  const r = await rig(t);
  const first = r.request('{"delay":170}', 'a'); await until(() => r.gateway.stats().active === 1);
  assert.equal((await r.request('', null, { path: '/v1/models', method: 'GET' })).status, 200);
  assert.equal(r.gateway.stats().active, 1); await first;
  assert.equal((await r.request('{}')).headers['x-ds4-affinity'], 'none');
});
test('state lock prevents double ownership; corrupt store never silently resets', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds4-gateway-state-test-'));
  const filename = path.join(dir, 'affinity.json'); const store = new AffinityStore(filename);
  assert.throws(() => new AffinityStore(filename), /locked/); store.close();
  fs.writeFileSync(filename, '{bad'); assert.throws(() => new AffinityStore(filename));
  assert.equal(fs.readFileSync(filename, 'utf8'), '{bad');
});
test('worker drain persists, drains admitted work, reassigns idle sessions and resumes without bouncing', async t => {
  const r = await rig(t);
  const first = r.request('{"delay":140}', 'a'); await until(() => r.gateway.stats().active === 1);
  r.gateway.drainNodes(['spark1'], true);
  assert.equal(r.gateway.stats().workers[0].gateway_drained, false);
  assert.equal((await r.request('{}', 'a')).status, 503);
  assert.equal((await r.request('{}', 'new')).headers['x-ds4-node'], 'spark2');
  await first; assert.equal(r.gateway.stats().workers[0].gateway_drained, true);
  assert.equal((await r.request('{}', 'a')).headers['x-ds4-node'], 'spark2');
  await r.restart(); assert.equal(r.gateway.stats().workers[0].drained, true);
  r.gateway.drainNodes(['spark1'], false);
  assert.equal((await r.request('{}', 'a')).headers['x-ds4-node'], 'spark2');
  r.gateway.drainNodes(['spark1', 'spark2'], true);
  assert.equal((await r.request('{}', 'next')).status, 503);
  assert.throws(() => r.gateway.drainNodes(['spark999'], true), /known worker/);
});
test('six-node fleet can drain four nodes and keep routing on the two remaining', async t => {
  const r = await rig(t, 6);
  for (let i = 0; i < 6; i++) await r.request('{}', `s${i}`);
  r.gateway.drainNodes(['spark1', 'spark2', 'spark3', 'spark4'], true);
  assert.equal(r.gateway.stats().available, 2);
  for (let i = 0; i < 6; i++) assert.ok(['spark5', 'spark6'].includes((await r.request('{}', `s${i}`)).headers['x-ds4-node']));
});
test('operator socket is private and worker control is not available over public HTTP', async t => {
  const r = await rig(t, 2, { control_socket: true });
  assert.equal(fs.statSync(r.config.control_socket).mode & 0o777, 0o600);
  const result = await new Promise((resolve, reject) => {
    const req = http.request({ socketPath: r.config.control_socket, method: 'POST', path: '/drain-workers' }, res => {
      let body = ''; res.on('data', b => { body += b; }); res.on('end', () => resolve(JSON.parse(body)));
    }); req.on('error', reject); req.end('{"workers":["spark1"]}');
  });
  assert.equal(result.workers[0].gateway_drained, true);
  assert.equal((await r.request('{"workers":["spark2"]}', null, { path: '/drain-workers' })).status, 404);
});
test('slow consumer receives the exact multi-megabyte stream without truncation', async t => {
  const r = await rig(t);
  const bytes = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: r.address.port, path: '/v1/chat/completions', method: 'POST', headers: { authorization: 'Bearer none' } }, res => {
      let size = 0; res.pause(); setTimeout(() => res.resume(), 100);
      res.on('data', b => { size += b.length; }); res.on('error', reject); res.on('end', () => resolve(size));
    }); req.on('error', reject); req.end('{"large_stream":true}');
  });
  assert.equal(bytes, 128 * (32768 + 8) + 'data: [DONE]\n\n'.length);
});
