#!/usr/bin/env node
// Steam Engine film runner — dual-engine, 16 clips, one pair lifecycle.
// Phase 1: stop GLM pair (sanctioned scripts, exact-name checks).
// Phase 2: start BOTH H3 engines, tunnels, readiness.
// Phase 3: submit each clip job to an idle engine (direct /prompt, no DSG),
//          observe, collect outputs. Never resubmit a submitted job.
// Phase 4: stop engines (confirmed idle), restore pair, verify, resume.
// Usage: node film-runner.mjs <film-op-folder>
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {execFile, spawn} from 'node:child_process';
import {promisify} from 'node:util';

const execute = promisify(execFile);
const folder = path.resolve(process.argv[2]);
const P = JSON.parse(fs.readFileSync(path.join(folder, 'plan.json'), 'utf8'));
const MANIFEST = JSON.parse(fs.readFileSync(P.manifest, 'utf8'));
const CUTS = Object.keys(MANIFEST);

const save = (name, value) => {
  const t = path.join(folder, name), tmp = t + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', {mode: 0o600});
  fs.renameSync(tmp, t);
};
let phase = '', detail = '';
const progress = (p, m) => { if (p === phase && m === detail) return; phase = p; detail = m; save('progress.json', {phase, detail, at: new Date().toISOString()}); };
const ssh = async (host, cmd, timeout = 180000) =>
  (await execute('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', host, cmd], {timeout, maxBuffer: 8 * 1024 * 1024})).stdout;
const controlRequest = (route, body) => new Promise((resolve, reject) => {
  const data = body ? JSON.stringify(body) : null;
  const req = http.request({socketPath: P.control_socket, path: route, method: data ? 'POST' : 'GET',
    headers: data ? {'content-type': 'application/json', 'content-length': Buffer.byteLength(data)} : {}},
    res => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({status: res.statusCode, body: b})); });
  req.on('error', reject);
  if (data) req.write(data);
  req.end();
});
const glmServing = async () => {
  try { const r = await fetch(P.pair_url + '/v1/models', {signal: AbortSignal.timeout(8000)});
        return (await r.json()).data.map(m => m.id).includes(P.model_id); } catch { return false; }
};
const glmProbe = async () => {
  const r = await fetch(P.pair_url + '/v1/chat/completions', {method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({model: P.model_id, messages: [{role: 'user', content: 'Reply with the single word: ready'}], max_tokens: 64, temperature: 0}),
    signal: AbortSignal.timeout(90000)});
  const j = await r.json(); const m = j.choices?.[0]?.message ?? {};
  return {model: j.model, response: (m.content || m.reasoning || '').trim().slice(0, 80)};
};

class Engine {
  constructor(spec) {
    Object.assign(this, spec);           // host, container, port, localPort, name
    this.base = `http://127.0.0.1:${spec.localPort}`;
    this.tunnel = null; this.startedHere = false; this.busyJob = null;
    this.uploads = new Map();            // srcPath -> {name, subfolder, type}
  }
  async req(route, opts = {}) {
    return fetch(new URL(route, this.base), {...opts, signal: AbortSignal.timeout(opts.timeoutMs ?? 60000)});
  }
  async start() {
    const st = (await ssh(this.host, `docker inspect -f '{{.State.Running}}' ${this.container}`, 60000)).trim();
    if (st !== 'true') {
      await ssh(this.host, `docker start ${this.container}`, 300000);
      this.startedHere = true;
    }
    this.tunnel = spawn('ssh', ['-N', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes',
      '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
      '-L', `127.0.0.1:${this.localPort}:127.0.0.1:${this.port}`, this.host],
      {stdio: ['ignore', 'ignore', 'ignore']});
    await new Promise((res, rej) => { this.tunnel.once('spawn', res); this.tunnel.once('error', rej); });
    for (let i = 0; i < 200; i++) {
      try { await (await this.req('/system_stats')).json(); return; }
      catch (e) {
        const running = (await ssh(this.host, `docker inspect -f '{{.State.Running}}' ${this.container}`, 60000)).trim();
        if (running === 'false') throw new Error(`${this.name}: engine exited before readiness`);
        progress('starting_engines', `${this.name} not ready yet (${i})`);
        await new Promise(r => setTimeout(r, 3000));
      }
    }
    throw new Error(`${this.name}: readiness not established`);
  }
  async queueCount() { // throws if unreachable -> unknown
    const q = await (await this.req('/queue', {timeoutMs: 15000})).json();
    return (q.queue_running?.length ?? 0) + (q.queue_pending?.length ?? 0);
  }
  async upload(srcPath, name, magic) {
    if (this.uploads.has(srcPath)) return this.uploads.get(srcPath);
    const form = new FormData();
    const ct = name.endsWith('.png') ? 'image/png' : 'audio/wav';
    form.append('image', new Blob([fs.readFileSync(srcPath)], {type: ct}), name);
    const r = await this.req('/upload/image', {method: 'POST', body: form, timeoutMs: 120000});
    const text = await r.text();
    if (!r.ok) throw new Error(`${this.name} upload HTTP ${r.status}: ${text.slice(0, 200)}`);
    const j = JSON.parse(text);
    const q = new URLSearchParams({filename: j.name, subfolder: j.subfolder ?? '', type: j.type ?? 'input'});
    const v = await this.req('/view?' + q, {timeoutMs: 60000});
    const buf = Buffer.from(await v.arrayBuffer());
    if (!v.ok || buf.length === 0 || !buf.subarray(0, magic.length).equals(Buffer.from(magic)))
      throw new Error(`${this.name} /view verify failed for ${name}`);
    const rec = {name: j.name, subfolder: j.subfolder ?? '', type: j.type ?? 'input'};
    this.uploads.set(srcPath, rec);
    return rec;
  }
  async submit(promptId, graph) {
    const pr = await this.req('/prompt', {method: 'POST', headers: {'content-type': 'application/json'},
      body: JSON.stringify({prompt: graph, client_id: promptId}), timeoutMs: 60000});
    const body = await pr.json();
    save(`prompt-response-${promptId.slice(0, 8)}.json`, {engine: this.name, status: pr.status, body});
    if (!pr.ok || body?.error || (body?.node_errors && Object.keys(body.node_errors).length))
      throw new Error(`${this.name} /prompt rejected (HTTP ${pr.status}): ${JSON.stringify(body).slice(0, 1000)}`);
    this.busyJob = {promptId, nativeId: body.prompt_id, startedAt: Date.now()};
    return body.prompt_id;
  }
  async done() {
    if (!this.busyJob) return true;
    try {
      const h = await (await this.req(`/history/${this.busyJob.nativeId}`, {timeoutMs: 15000})).json();
      const row = h?.[this.busyJob.nativeId];
      if (row?.status?.status_str === 'error') throw new Error(`${this.name} native job failed: ${JSON.stringify(row.status).slice(0, 300)}`);
      if (row?.status?.completed === true && row?.status?.status_str === 'success') return row.outputs;
      return null;
    } catch (e) { if (/failed/.test(e.message)) throw e; return null; }
  }
  async collect(outputs, cut) {
    const outDir = path.join(P.results_directory, cut);
    fs.mkdirSync(outDir, {recursive: true, mode: 0o700});
    const files = [];
    for (const node of Object.values(outputs ?? {})) {
      for (const key of Object.keys(node ?? {})) {
        for (const item of Array.isArray(node[key]) ? node[key] : []) {
          if (typeof item?.filename !== 'string' || item.type !== 'output') continue;
          const q = new URLSearchParams({filename: item.filename, subfolder: item.subfolder ?? '', type: 'output'});
          const r = await this.req('/view?' + q, {timeoutMs: 600000});
          if (!r.ok) throw new Error(`output download failed HTTP ${r.status}`);
          const buf = Buffer.from(await r.arrayBuffer());
          const id = crypto.randomUUID();
          fs.writeFileSync(path.join(outDir, id), buf, {mode: 0o600});
          files.push({id, filename: item.filename, bytes: buf.length});
        }
      }
    }
    if (!files.length) throw new Error(`${cut}: completed with no output files`);
    return files;
  }
  async stop() {
    try { if (await this.queueCount() === 0) { await ssh(this.host, `docker stop -t 120 ${this.container}`, 300000); this.startedHere = false; return true; }
          save(`engine-left-running-${this.name}.json`, {at: new Date().toISOString()}); return false; }
    catch { save(`engine-left-running-${this.name}.json`, {reason: 'queue unreachable — unknown', at: new Date().toISOString()}); return false; }
  }
}

const runner = async () => {
  fs.writeFileSync(path.join(folder, 'runner-claim.json'), JSON.stringify({pid: process.pid, at: new Date().toISOString()}, null, 2), {mode: 0o600});
  const hb = setInterval(() => progress(phase, detail), 20000);
  const engines = P.engines.map(s => new Engine(s));
  const tunnels = () => engines.forEach(e => e.tunnel && e.tunnel.kill('SIGTERM'));
  let pairStopped = false, error = null;
  const submitted = {};
  try {
    // ---- Phase 0: no active gateway work on the pair.
    progress('checking_idle', 'Checking gateway for active work on the pair.');
    const cur = await controlRequest('/current-jobs');
    const active = JSON.parse(cur.body).jobs?.filter(j => j.machine === P.worker_id) ?? [];
    if (active.length) throw new Error(`Active work on ${P.worker_id}: ${active.map(j => j.request_id).join(',')}`);

    // ---- Phase 1: stop the whole GLM pair.
    progress('stopping_pair', `Running ${P.pair_stop}`);
    const stop = await execute('bash', [P.pair_stop], {timeout: 900000, maxBuffer: 1024 * 1024});
    save('pair-stop.json', {stdout: stop.stdout.slice(-4000), stderr: stop.stderr.slice(-2000)});
    pairStopped = true;
    const state = {};
    for (const host of P.pair_hosts) {
      const names = (await ssh(host, "docker ps --format '{{.Names}}'")).split('\n').map(s => s.trim()).filter(Boolean);
      state[host] = names;
      for (const c of (P.expected_down[host] ?? [])) if (names.includes(c)) throw new Error(`LLM container ${c} still running on ${host}`);
      const allowed = new Set([...(P.expected_down[host] ?? []), 'glm53-nfs', ...P.engines.filter(e => e.host === host).map(e => e.container)]);
      const conflicts = names.filter(n => !allowed.has(n));
      if (conflicts.length) throw new Error(`conflicting containers on ${host}: ${conflicts.join(', ')}`);
    }
    save('containers-after-stop.json', state);

    // ---- Phase 2: start both engines.
    progress('starting_engines', 'Booting both H3 engines.');
    for (const e of engines) { await e.start(); }
    save('engines-ready.json', {engines: engines.map(e => e.name), at: new Date().toISOString()});

    // ---- Phase 3: dispatch every cut; wait on idle engines.
    const resultsPath = path.join(folder, 'results.json');
    const results = fs.existsSync(resultsPath) ? JSON.parse(fs.readFileSync(resultsPath, 'utf8')) : {};
    const pending = [...CUTS];
    const inFlight = new Map(); // engineName -> cut
    while (pending.length || inFlight.size) {
      for (const e of engines) {
        if (inFlight.has(e.name) || !pending.length) continue;
        let idle = false;
        try { idle = (await e.queueCount()) === 0 && !e.busyJob; } catch { idle = false; }
        if (!idle) continue;
        const cut = pending.shift();
        if (results[cut]) { progress('generating', `${cut} already collected — skipping`); continue; }
        const m = MANIFEST[cut];
        const graph = JSON.parse(fs.readFileSync(path.join(folder, 'graphs', `${cut}.json`), 'utf8'));
        const facePath = m.face || P.files.face;
        const face = await e.upload(facePath, m.face ? `${cut}-face.png` : 'face.png', [0x89, 0x50, 0x4e, 0x47]);
        const audio = await e.upload(m.audio, `${cut}.wav`, Buffer.from('RIFF'));
        graph['5'].inputs.image = (face.subfolder ? face.subfolder + '/' : '') + face.name;
        graph['15'].inputs.audio = (audio.subfolder ? audio.subfolder + '/' : '') + audio.name;
        if (m.env && graph['16']) {
          const envSrc = P.envs[m.env];
          const env = await e.upload(envSrc, 'env.png', [0x89, 0x50, 0x4e, 0x47]);
          graph['16'].inputs.image = (env.subfolder ? env.subfolder + '/' : '') + env.name;
        }
        const promptId = cut + '-' + crypto.randomUUID().slice(0, 8);
        submitted[cut] = {engine: e.name, promptId};
        save('submissions.json', submitted);
        try {
          await e.submit(promptId, graph);
        } catch (err) { // one bad submission must not kill the film
          results[cut] = {error: err.message, engine: e.name};
          save('results.json', results);
          submitted[cut] = {engine: e.name, promptId, rejected: true};
          save('submissions.json', submitted);
          progress('generating', `${cut} rejected: ${err.message.slice(0, 120)}`);
          continue;
        }
        inFlight.set(e.name, cut);
        progress('generating', `${cut} -> ${e.name} (${inFlight.size} running, ${pending.length} queued)`);
      }
      for (const [name, cut] of [...inFlight]) {
        const e = engines.find(x => x.name === name);
        let outputs = null;
        try { outputs = await e.done(); }
        catch (err) { // native job failed on this engine — record, free engine, do not retry
          results[cut] = {error: err.message, engine: name};
          save('results.json', results);
          inFlight.delete(name); e.busyJob = null;
          progress('generating', `${cut} FAILED on ${name}`);
          continue;
        }
        if (outputs) {
          const files = await e.collect(outputs, cut);
          results[cut] = {engine: name, files, nativeId: e.busyJob.nativeId};
          save('results.json', results);
          inFlight.delete(name); e.busyJob = null;
          progress('generating', `${cut} collected (${Object.keys(results).length}/${CUTS.length})`);
        }
      }
      await new Promise(r => setTimeout(r, 5000));
    }
    save('results.json', results);
    const failed = Object.entries(results).filter(([, v]) => v.error);
    if (failed.length) throw new Error(`clips failed: ${failed.map(([k, v]) => `${k}(${v.error.slice(0, 80)})`).join('; ')}`);
  } catch (e) {
    error = e;
    save('failure.json', {error: e.message, at: new Date().toISOString()});
  }

  try {
    // ---- Phase 4: release engines only when confirmed idle; restore pair once.
    for (const e of engines) await e.stop();
    tunnels();
    if (pairStopped) {
      progress('restoring_pair', `Running ${P.pair_start}`);
      const start = await execute('bash', [P.pair_start], {timeout: 2400000, maxBuffer: 1024 * 1024});
      save('pair-start.json', {stdout: start.stdout.slice(-4000), stderr: start.stderr.slice(-2000)});
      let serving = false;
      for (let i = 0; i < 320; i++) {
        serving = await glmServing();
        if (serving) break;
        progress('restoring_pair', `GLM loading (${i * 15}s)...`);
        await new Promise(r => setTimeout(r, 15000));
      }
      if (!serving) throw new Error('GLM pair did not report serving within the wait window');
      const proof = await glmProbe();
      save('llm-proof.json', proof);
      if (!proof.response) throw new Error('GLM answered with an empty body');
      const res = await controlRequest('/resume-workers', {workers: [P.worker_id]});
      save('resume-routing.json', {status: res.status, body: res.body.slice(-500)});
      if (res.status !== 200) throw new Error(`resume-workers failed: HTTP ${res.status}`);
      progress(error ? 'failed_returned' : 'returned',
        error ? `Film run had failures: ${error.message}. GLM pair restored, verified and routing resumed.`
              : `All ${CUTS.length} clips collected; GLM pair restored, verified and routing resumed.`);
      save('completion.json', {clips_done: Object.values(submitted).length, llm_return_verified: true, at: new Date().toISOString()});
    }
  } catch (e) {
    save('restoration-needs-attention.json', {error: e.message});
    progress('needs_attention', `LLM return needs attention: ${e.message}`);
    process.exitCode = 1;
  } finally { clearInterval(hb); }
};

import crypto from 'node:crypto';
runner().catch(e => { console.error(e); process.exitCode = 1; });