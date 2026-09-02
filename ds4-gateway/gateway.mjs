import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { RequestedThinkingObserver } from './requested-thinking.mjs';
import { workerConfig, workerConfigs, assertUniqueWorker } from './worker-config.mjs';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

const digest = value => createHash('sha256').update(value).digest('hex');
const log = (event, fields = {}) => process.stdout.write(JSON.stringify({ time: new Date().toISOString(), event, ...fields }) + '\n');
const hopHeaders = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
function forwardHeaders(headers) {
  const excluded = new Set([...hopHeaders, ...(headers.connection || '').toLowerCase().split(',').map(s => s.trim())]);
  return Object.fromEntries(Object.entries(headers).filter(([k]) => !excluded.has(k.toLowerCase())));
}
function json(res, status, value) {
  if (res.destroyed || res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}
function error(res, status, code, message) { json(res, status, { error: { type: 'gateway_error', code, message } }); }

// Tiny durable metadata store. No prompts, model outputs, or KV data live here.
// Atomic replace + fsync; an unreadable/corrupt store fails startup, never resets.
export class AffinityStore {
  constructor(filename) {
    this.filename = filename;
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    this.lock = `${filename}.lock`;
    const acquire = () => fs.openSync(this.lock, 'wx', 0o600);
    let fd;
    try { fd = acquire(); } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const old = JSON.parse(fs.readFileSync(this.lock, 'utf8'));
      if (!Number.isInteger(old.pid) || old.pid <= 1) throw new Error('Invalid state lock; inspect manually');
      try { process.kill(old.pid, 0); throw new Error(`State already locked by PID ${old.pid}`); }
      catch (probe) { if (probe.code !== 'ESRCH') throw probe; }
      fs.unlinkSync(this.lock);
      fd = acquire();
    }
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid })); fs.fsyncSync(fd); fs.closeSync(fd);
    try {
      let data = { version: 1, sessions: {} };
      if (fs.existsSync(filename)) data = JSON.parse(fs.readFileSync(filename, 'utf8'));
      if (data.version !== 1 || !data.sessions || Array.isArray(data.sessions)) throw new Error('Invalid affinity store');
      for (const [key, item] of Object.entries(data.sessions)) {
        if (!/^[a-f0-9]{64}$/.test(key) || typeof item.node !== 'string') throw new Error('Invalid affinity entry');
      }
      this.data = data;
    } catch (e) { this.close(); throw e; }
  }
  get(key) { return this.data.sessions[key]; }
  count(node) { return Object.values(this.data.sessions).filter(s => s.node === node).length; }
  set(key, node) {
    this.save({ ...this.data, sessions: { ...this.data.sessions, [key]: { node, assigned_at: new Date().toISOString() } } });
  }
  setDrained(ids, drained) {
    const next = { ...this.data, drained: { ...this.data.drained } };
    for (const id of ids) next.drained[id] = drained;
    this.save(next);
  }
  setWorkers(workers, drained = this.data.drained ?? {}) {
    this.save({ ...this.data, workers, drained });
  }
  save(next) {
    const tmp = `${this.filename}.${randomUUID()}.tmp`;
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(next)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, this.filename);
    const dir = fs.openSync(path.dirname(this.filename), 'r');
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    this.data = next;
  }
  close() { if (this.lock) { fs.unlinkSync(this.lock); this.lock = null; } }
}

// Buffers at most one SSE line, solely to observe usage. Forwarded bytes are
// never decoded/re-encoded. No answer/reasoning text is logged.
class UsageObserver {
  pending = ''; usage = undefined; done = false;
  accept(chunk) {
    this.pending += chunk.toString('utf8');
    let pos;
    while ((pos = this.pending.indexOf('\n')) !== -1) {
      const line = this.pending.slice(0, pos).trim(); this.pending = this.pending.slice(pos + 1);
      if (line === 'data: [DONE]') this.done = true;
      if (line.startsWith('data: {')) {
        try {
          const u = JSON.parse(line.slice(6)).usage;
          if (u) this.usage = { prompt_tokens: u.prompt_tokens, completion_tokens: u.completion_tokens,
            cached_tokens: u.prompt_tokens_details?.cached_tokens };
        } catch { /* A telemetry failure must not affect inference. */ }
      }
    }
    if (this.pending.length > 1048576) this.pending = '';
  }
}

export function createGateway(config) {
  const initial = workerConfigs(config.nodes);
  const store = new AffinityStore(config.state_file);
  const makeNode = n => ({ ...n, drained: store.data.drained?.[n.id] === true, healthy: false, failures: 0, active: null, queue: [], completed: 0, failed: 0, probing: false });
  let definitions;
  try { definitions = store.data.workers === undefined ? initial : workerConfigs(store.data.workers); }
  catch (e) { store.close(); throw e; }
  const nodes = definitions.map(makeNode);
  let draining = false, shuttingDown = false, healthTimer;
  let mutation = Promise.resolve();
  const serialize = fn => { const next = mutation.then(fn); mutation = next.catch(() => {}); return next; };
  const definition = n => Object.fromEntries(['id','url','ssh','remote_port','telemetry_service'].filter(k => n[k] !== undefined).map(k => [k,n[k]]));
  const agent = new http.Agent({ keepAlive: true, maxSockets: 16 });
  const accepted = new Set(['POST /v1/chat/completions', 'POST /v1/completions', 'POST /v1/responses', 'POST /v1/messages', 'GET /v1/models']);
  const auth = Buffer.from(`Bearer ${config.api_key}`);
  const stats = () => ({ version: 1, model: config.model, context_length: config.context_length, draining,
    total: nodes.length, healthy: nodes.filter(n => n.healthy).length, available: nodes.filter(n => n.healthy && !n.drained).length,
    active: nodes.filter(n => n.active).length, queued: nodes.reduce((s, n) => s + n.queue.length, 0),
    workers: nodes.map(n => ({ id: n.id, url: n.url, is_healthy: n.healthy, drained: n.drained,
      gateway_drained: n.drained && !n.active && !n.queue.length, load: Number(!!n.active),
      queued: n.queue.length, assigned_sessions: store.count(n.id), completed: n.completed, failed: n.failed,
      active_seconds: n.active ? Math.round((Date.now() - n.active.dispatched) / 1000) : 0,
      requested_thinking: n.active?.thinking?.result ?? null,
      last_requested_thinking: n.lastThinking ?? null, last_request_finished_at: n.lastFinishedAt ?? null,
      context_length: n.contextLength ?? null,
      last_probe: n.lastProbe, probe_error: n.probeError })) });

  function pick(exclude) {
    return nodes.filter(n => n.healthy && !n.drained && n.id !== exclude).sort((a, b) =>
      (Number(!!a.active) + a.queue.length) - (Number(!!b.active) + b.queue.length) ||
      store.count(a.id) - store.count(b.id) || a.id.localeCompare(b.id))[0];
  }
  function schedule(node) {
    if (node.active) return;
    while (node.queue.length) {
      const job = node.queue.shift();
      if (job.cancelled) continue;
      clearTimeout(job.queueTimer);
      if (!node.healthy) { error(job.res, 503, 'home_unavailable', 'Assigned Spark became unavailable while queued; request was not dispatched.'); job.cleanup(); job.req.resume(); continue; }
      node.active = job;
      dispatch(node, job);
      return;
    }
  }
  function dispatch(node, job) {
    const { req, res } = job;
    job.dispatched = Date.now();
    const target = new URL(req.url, node.url);
    const headers = forwardHeaders(req.headers);
    headers.host = target.host;
    headers['x-request-id'] = job.id;
    delete headers.expect;
    const observer = new UsageObserver();
    job.thinking = new RequestedThinkingObserver(req.headers['content-encoding']);
    const observeBody = chunk => job.thinking.accept(chunk);
    const bodyEnded = () => job.thinking.finish();
    let settled = false, response;
    const finish = (outcome, detail) => {
      if (settled) return; settled = true;
      clearTimeout(job.deadline);
      req.off('data', observeBody); req.off('end', bodyEnded); job.thinking.dispose();
      node.lastThinking = job.thinking.result; node.lastFinishedAt = new Date().toISOString();
      if (outcome === 'complete') node.completed++; else node.failed++;
      log('request_finished', { request_id: job.id, node: node.id, session: job.key?.slice(0, 12), outcome,
        queue_ms: job.dispatched - job.created, elapsed_ms: Date.now() - job.dispatched,
        usage: observer.usage, sse_done: observer.done, requested_thinking: job.thinking.result, detail });
      job.cleanup();
      node.active = null;
      schedule(node);
    };
    const upstream = http.request(target, { method: req.method, headers, agent }, up => {
      response = up;
      const outHeaders = forwardHeaders(up.headers);
      outHeaders['x-ds4-node'] = node.id;
      outHeaders['x-request-id'] = job.id;
      outHeaders['x-ds4-affinity'] = job.affinity;
      outHeaders['x-accel-buffering'] = 'no';
      res.writeHead(up.statusCode, outHeaders);
      res.flushHeaders();
      const isSSE = String(up.headers['content-type']).includes('text/event-stream');
      if (isSSE) up.on('data', chunk => observer.accept(chunk));
      up.on('error', e => { res.destroy(); finish(job.cancelled ? 'client_cancelled' : 'upstream_stream_error', e.code); });
      up.on('aborted', () => { res.destroy(); finish(job.cancelled ? 'client_cancelled' : 'upstream_aborted'); });
      up.on('end', () => finish(up.statusCode >= 400 ? 'upstream_http_error' : isSSE && !observer.done ? 'incomplete_sse' : 'complete', up.statusCode));
      up.pipe(res);
    });
    job.upstream = upstream;
    upstream.on('socket', socket => {
      if (!socket.connecting) return;
      const timer = setTimeout(() => upstream.destroy(Object.assign(new Error('Connect timeout'), { code: 'CONNECT_TIMEOUT' })), config.connect_timeout_ms ?? 10000);
      socket.once('connect', () => clearTimeout(timer));
      socket.once('close', () => clearTimeout(timer));
    });
    upstream.on('error', e => {
      if (!res.headersSent) error(res, 502, 'upstream_error', 'Upstream connection failed. Execution may have started; gateway did not retry.');
      else res.destroy();
      finish(job.cancelled ? 'client_cancelled' : 'upstream_error', e.code);
    });
    // No automatic retries, including errors before response headers.
    upstream.on('close', () => {
      if (!settled && (job.cancelled || !response)) finish(job.cancelled ? 'client_cancelled' : 'connection_closed');
    });
    job.deadline = setTimeout(() => { upstream.destroy(Object.assign(new Error('100-hour request deadline'), { code: 'REQUEST_DEADLINE' })); }, config.request_timeout_ms ?? 360000000);
    log('request_dispatched', { request_id: job.id, node: node.id, session: job.key?.slice(0, 12), affinity: job.affinity, queue_ms: job.dispatched - job.created });
    // Passive observation only while dispatched; queued uploads remain untouched.
    // The original pipe retains streaming/backpressure and exact body bytes.
    req.on('data', observeBody); req.once('end', bodyEnded);
    req.pipe(upstream);
  }

  const server = http.createServer((req, res) => {
    const credential = Buffer.from(req.headers.authorization || '');
    if (credential.length !== auth.length || !timingSafeEqual(credential, auth)) { req.resume(); return error(res, 401, 'unauthorized', 'Bearer API key required'); }
    // Reject absolute URLs and encoded/normalized alternate routes; no admin forwarding.
    const route = `${req.method} ${req.url}`;
    if (route === 'GET /gateway/status' || route === 'GET /workers') return json(res, 200, stats());
    if (route === 'GET /health') return json(res, !draining && nodes.some(n => n.healthy && !n.drained) ? 200 : 503, stats());
    if (!accepted.has(route)) { req.resume(); return error(res, 404, 'unsupported_route', 'Endpoint is not on the inference allowlist'); }
    if (draining) { req.resume(); return error(res, 503, 'draining', 'Gateway is draining; no new requests admitted'); }
    const keyValue = req.headers['x-session-affinity'] || req.headers['x-ds4-conversation-id'] || req.headers['x-session-id'] || req.headers.session_id;
    const key = keyValue && req.method === 'POST' ? digest(String(keyValue)) : null;
    const home = key && store.get(key);
    let node = home && nodes.find(n => n.id === home.node);
    let affinity = key ? home ? 'existing' : 'new' : 'none';
    if (node && (!node.healthy || node.drained)) {
      // Do not split the session while its old Spark has any outstanding work.
      if (node.active || node.queue.length) { req.resume(); return error(res, 503, 'home_unavailable', 'Home Spark has unresolved work; gateway will not split or replay it'); }
      node = pick(node.id); affinity = 'reassigned';
    }
    if (!node) node = pick();
    if (!node) { req.resume(); return error(res, 503, 'no_healthy_workers', 'No worker is currently ready'); }
    if (req.method === 'GET') {
      // Model-list requests must not sit behind a multi-hour generation.
      const probe = http.get(new URL(req.url, node.url), { agent }, up => {
        let body = '';
        up.on('data', chunk => { body += chunk; if (body.length > 1048576) probe.destroy(new Error('Model metadata too large')); });
        up.on('error', () => error(res, 502, 'models_unavailable', 'Model metadata unavailable'));
        up.on('end', () => {
          try {
            if (up.statusCode !== 200) throw new Error();
            const data = JSON.parse(body); if (!Array.isArray(data.data)) throw new Error();
            // Publish the pool guarantee, never one larger worker's limit.
            // This only changes model-list metadata; generation bytes are untouched.
            for (const model of data.data) {
              model.context_length = config.context_length;
              if (model.top_provider) model.top_provider = { ...model.top_provider, context_length:config.context_length,
                max_completion_tokens: Math.min(model.top_provider.max_completion_tokens ?? config.context_length, config.context_length) };
            }
            json(res, 200, data);
          } catch { error(res, 502, 'models_unavailable', 'Model metadata unavailable'); }
        });
      });
      probe.setTimeout(config.health_timeout_ms ?? 5000, () => probe.destroy());
      probe.on('error', () => error(res, 502, 'models_unavailable', 'Model metadata unavailable'));
      res.on('close', () => probe.destroy());
      return;
    }
    if (node.queue.length >= (config.max_queued_per_node ?? 128)) { req.resume(); return error(res, 429, 'queue_full', 'Spark waiting queue is full; request was not dispatched'); }
    try { if (key && home?.node !== node.id) store.set(key, node.id); }
    catch (e) { log('state_write_error', { error: e.message }); req.resume(); return error(res, 503, 'state_unavailable', 'Cannot durably record affinity; request was not dispatched'); }
    const job = { req, res, key, affinity, id: randomUUID(), created: Date.now(), cancelled: false };
    const cancel = () => {
      if (res.writableFinished) return;
      job.cancelled = true;
      if (job.upstream) job.upstream.destroy();
      else {
        node.queue = node.queue.filter(j => j !== job);
        clearTimeout(job.queueTimer); job.cleanup();
        log('queued_request_cancelled', { request_id: job.id, node: node.id });
      }
    };
    job.cleanup = () => { req.off('aborted', cancel); res.off('close', cancel); req.off('error', cancel); };
    req.on('aborted', cancel); req.on('error', cancel); res.on('close', cancel);
    job.queueTimer = setTimeout(() => {
      node.queue = node.queue.filter(j => j !== job);
      error(res, 504, 'queue_timeout', 'One-hour queue deadline reached; request was not dispatched');
      job.cleanup(); req.resume();
    }, config.queue_timeout_ms ?? 3600000);
    node.queue.push(job); schedule(node);
  });
  server.requestTimeout = 0; // Covers upload + queue; no hidden five-minute Node default.
  server.timeout = 0; // Long prefill/decode streams are intentionally allowed to be idle.
  server.headersTimeout = 60000;
  server.keepAliveTimeout = 5000;
  server.on('clientError', (_e, socket) => socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'));

  async function probe(node) {
    if (node.probing) return;
    node.probing = true;
    await new Promise(resolve => {
      let settled = false, deadline;
      const finish = (ok, reason) => {
        if (settled) return; settled = true;
        clearTimeout(deadline); node.probeRequest = null;
        node.probing = false; node.lastProbe = new Date().toISOString(); node.probeError = reason;
        const was = node.healthy;
        if (ok) { node.failures = 0; node.healthy = true; }
        else if (++node.failures >= (config.health_failures ?? 3)) node.healthy = false;
        if (was !== node.healthy) log('worker_health', { node: node.id, healthy: node.healthy, reason });
        resolve();
      };
      const p = http.get(new URL('/v1/models', node.url), { agent }, res => {
        let body = '';
        res.on('data', chunk => { body += chunk; if (body.length > 1048576) p.destroy(); });
        res.on('error', e => finish(false, e.code));
        res.on('end', () => {
          try {
            const model = JSON.parse(body).data?.find(m => m.id === config.model);
            node.contextLength = Number.isSafeInteger(model?.context_length) ? model.context_length : null;
            const ok = res.statusCode === 200 && !!model && node.contextLength >= config.context_length;
            finish(ok, ok ? undefined : 'model_or_context_mismatch');
          } catch { finish(false, 'invalid_model_response'); }
        });
      });
      node.probeRequest = p;
      // Total health-check deadline, not an inference or idle-stream limit.
      deadline = setTimeout(() => { p.destroy(); finish(false, 'PROBE_TIMEOUT'); }, config.health_timeout_ms ?? 5000);
      p.setTimeout(config.health_timeout_ms ?? 5000, () => p.destroy(Object.assign(new Error('probe timeout'), { code: 'PROBE_TIMEOUT' })));
      p.on('error', e => finish(false, e.code));
    });
  }
  const startTunnel = node => {
    if (node.ssh) node.stopTunnel = superviseTunnel(node, () => shuttingDown || node.removed);
  };
  const registry = () => ({ model: config.model, minimum_context: config.context_length,
    workers: nodes.map(n => ({ ...definition(n), ...stats().workers.find(w => w.id === n.id) })) });
  async function addWorker(raw) {
    if (shuttingDown || draining) throw new Error('Gateway is draining');
    const settings = workerConfig(raw, { registration: true });
    assertUniqueWorker(nodes, settings);
    // Do not mistake another process's listener for our new SSH tunnel.
    if (settings.ssh) await new Promise((resolve, reject) => {
      const check = net.createServer(); check.once('error', () => reject(new Error('Local tunnel port is already in use')));
      check.listen(Number(new URL(settings.url).port), '127.0.0.1', () => check.close(resolve));
    });
    const node = makeNode(settings); node.drained = true;
    try {
      startTunnel(node);
      const until = Date.now() + (config.registration_timeout_ms ?? 15000);
      do {
        if (shuttingDown) throw new Error('Gateway is stopping');
        await probe(node);
        if (node.healthy) break;
        if (!node.ssh || node.probeError === 'model_or_context_mismatch' || node.probeError === 'invalid_model_response') break;
        await delay(250);
      } while (Date.now() < until);
      if (shuttingDown) throw new Error('Gateway is stopping');
      if (!node.healthy) throw new Error(`Compatibility check failed (${node.probeError || 'unavailable'}). Required model ${config.model}, context at least ${config.context_length}; observed context ${node.contextLength ?? 'unknown'}.`);
      store.setWorkers([...nodes.map(definition), settings], { ...store.data.drained, [node.id]: true });
      nodes.push(node);
      log('worker_registered', { node: node.id, context_length: node.contextLength, drained: true });
      return registry();
    } catch (e) { node.removed = true; node.probeRequest?.destroy(); node.stopTunnel?.(); throw e; }
  }
  function removeWorker(id) {
    if (shuttingDown) throw new Error('Gateway is stopping');
    const node = nodes.find(n => n.id === id);
    if (!node) throw new Error('Unknown worker');
    if (!node.drained || node.active || node.queue.length) throw new Error('Drain this worker and wait for its admitted work to finish before removing it');
    const next = nodes.filter(n => n !== node);
    const drained = { ...store.data.drained }; delete drained[id];
    store.setWorkers(next.map(definition), drained);
    nodes.splice(nodes.indexOf(node), 1);
    node.removed = true; node.probeRequest?.destroy(); node.stopTunnel?.();
    // Keep session homes. Their next request can be durably reassigned normally.
    log('worker_removed', { node: id });
    return registry();
  }
  function drainNodes(ids, drained) {
    if (!Array.isArray(ids) || !ids.length || ids.some(id => !nodes.some(n => n.id === id))) throw new Error('Specify known worker IDs');
    store.setDrained(ids, drained);
    for (const n of nodes) if (ids.includes(n.id)) n.drained = drained;
    log('workers_drain_changed', { ids, drained });
    return stats();
  }
  // Operator-only Unix socket: never expose lifecycle mutation on the LAN.
  const control = config.control_socket ? http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/workers') return json(res, 200, registry());
    if (req.method !== 'POST' || !['/drain-workers', '/resume-workers', '/add-worker', '/remove-worker'].includes(req.url)) return error(res, 404, 'not_found', 'Unknown control action');
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 4096) req.destroy(); });
    req.on('error', () => {});
    req.on('end', () => {
      void serialize(async () => {
        try {
          const input = JSON.parse(body);
          if (req.url === '/add-worker') return json(res, 201, await addWorker(input.worker));
          if (req.url === '/remove-worker') return json(res, 200, removeWorker(input.id));
          json(res, 200, drainNodes(input.workers, req.url === '/drain-workers'));
        } catch (e) { error(res, 400, 'invalid_control_request', e.message); }
      });
    });
  }) : null;
  return {
    server, nodes, stats, store, drainNodes, registry,
    async start() {
      nodes.forEach(startTunnel);
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.port, config.host, resolve); });
      if (control) {
        // Store ownership has already been acquired; only our stale socket may exist.
        if (fs.existsSync(config.control_socket)) {
          if (!fs.lstatSync(config.control_socket).isSocket()) throw new Error('Control path is not a socket');
          fs.unlinkSync(config.control_socket);
        }
        await new Promise((resolve, reject) => { control.once('error', reject); control.listen(config.control_socket, resolve); });
        fs.chmodSync(config.control_socket, 0o600);
      }
      await Promise.all(nodes.map(probe));
      healthTimer = setInterval(() => { for (const n of nodes) void probe(n); }, config.health_interval_ms ?? 5000);
      return server.address();
    },
    drain(value = true) { draining = value; log('drain_changed', { draining }); },
    async close() {
      if (shuttingDown) return;
      shuttingDown = true; draining = true;
      if (control) await new Promise(resolve => control.close(resolve));
      await new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); });
      clearInterval(healthTimer); agent.destroy(); store.close();
      nodes.forEach(n => { n.removed = true; n.stopTunnel?.(); });
    },
  };
}

function superviseTunnel(node, stopping) {
  let child, timer;
  const start = () => {
    if (stopping()) return;
    const port = new URL(node.url).port;
    child = spawn('/usr/bin/ssh', ['-N', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'ConnectTimeout=10',
      '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '-L', `127.0.0.1:${port}:127.0.0.1:${node.remote_port ?? 8000}`, node.ssh], { stdio: ['ignore', 'ignore', 'pipe'] });
    log('tunnel_started', { node: node.id, pid: child.pid });
    child.stderr.on('data', chunk => log('tunnel_message', { node: node.id, message: chunk.toString().trim() }));
    child.on('error', e => log('tunnel_error', { node: node.id, error: e.message }));
    child.on('exit', (code, signal) => {
      log('tunnel_exited', { node: node.id, code, signal });
      if (!stopping()) timer = setTimeout(start, 3000);
    });
  };
  start();
  return () => { clearTimeout(timer); child?.kill('SIGTERM'); };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  let stopping = false;
  const gateway = createGateway(config);
  const awake = config.prevent_sleep ? spawn('/usr/bin/caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' }) : null;
  awake?.on('error', e => log('caffeinate_error', { error: e.message }));
  const stop = async () => {
    if (stopping) return; stopping = true;
    log('shutdown_draining');
    await gateway.close();
    awake?.kill('SIGTERM');
    log('shutdown_complete'); process.exit(0);
  };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  process.on('SIGUSR1', () => gateway.drain());
  process.on('SIGUSR2', () => gateway.drain(false));
  try { const address = await gateway.start(); log('gateway_started', { address, model: config.model }); }
  catch (e) { log('startup_failed', { error: e.message }); stopping = true; gateway.nodes.forEach(n => n.stopTunnel?.()); awake?.kill('SIGTERM'); gateway.store.close(); process.exit(1); }
}
