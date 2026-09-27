// Pair-lifecycle media runner (narrow integration, additive).
// Executes ONE saved H3 job using the whole-pair GLM controls from
// ~/startScripts (stop-sparks12 / start-glm53f-sparks12) instead of the legacy
// single-container qwen lifecycle. The qwen_vllm path and its checks are NOT
// touched or removed. Receipts mirror media-runner conventions.
// Usage: node media-pair-runner.mjs <operation-folder>
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {execFile, spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {openAsBlob} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {MediaJobs} from './media-jobs.mjs';
import {MediaBackend} from './media-backend.mjs';
import {validateVideoCatalog} from './media-validation.mjs';

const execute = promisify(execFile);
const folder = path.resolve(process.argv[2]);
const p = JSON.parse(fs.readFileSync(path.join(folder, 'plan.json'), 'utf8'));
if (path.basename(folder) !== p.operation_id) throw new Error('operation identity mismatch');

const save = (name, value) => {
  const target = path.join(folder, name), tmp = target + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', {mode: 0o600});
  fs.renameSync(tmp, target);
};
let phase = '', detail = '';
const progress = (next, message) => {
  if (next === phase && message === detail) return;
  phase = next; detail = message;
  save('progress.json', {phase, detail, at: new Date().toISOString()});
};
const ssh = async (host, cmd, timeout = 180000) =>
  (await execute('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', host, cmd], {timeout, maxBuffer: 8 * 1024 * 1024})).stdout;
const controlRequest = (route, body) => new Promise((resolve, reject) => {
  const data = body ? JSON.stringify(body) : null;
  const req = http.request({socketPath: p.control_socket, path: route, method: data ? 'POST' : 'GET',
    headers: data ? {'content-type': 'application/json', 'content-length': Buffer.byteLength(data)} : {}},
    res => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({status: res.statusCode, body: b})); });
  req.on('error', reject);
  if (data) req.write(data);
  req.end();
});
const glmServing = async () => {
  try {
    const r = await fetch(p.pair_url + '/v1/models', {signal: AbortSignal.timeout(8000)});
    const ids = (await r.json()).data.map(m => m.id);
    return ids.includes(p.model_id);
  } catch { return false; }
};
const glmProbe = async () => {
  const r = await fetch(p.pair_url + '/v1/chat/completions', {method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({model: p.model_id, messages: [{role: 'user', content: 'Reply with the single word: ready'}], max_tokens: 64, temperature: 0}),
    signal: AbortSignal.timeout(90000)});
  const j = await r.json();
  const m = j.choices?.[0]?.message ?? {};
  return {model: j.model, response: (m.content || m.reasoning || '').trim().slice(0, 80)};
};
const mediaIdle = async backend => {
  const q = await backend.request('/queue');
  return q.queue_running.length + q.queue_pending.length === 0;
};

const runner = async () => {
  fs.writeFileSync(path.join(folder, 'runner-claim.json'),
    JSON.stringify({pid: process.pid, at: new Date().toISOString()}, null, 2), {mode: 0o600});
  const jobs = new MediaJobs(path.join(folder, 'media-jobs.json'),
    {resultsDirectory: p.results_directory, inputsDirectory: p.inputs_directory});
  const jobIds = p.job_ids ?? [p.operation_id];
  const hb = setInterval(() => progress(phase, detail), 15000);
  let backend = null, tunnel = null, pairStopped = false, mediaStarted = false, error = null;
  try {
    // ---- Phase 0: confirm nothing is running on the pair through the gateway.
    progress('checking_idle', 'Checking gateway for active work on the pair.');
    const cur = await controlRequest('/current-jobs');
    const active = JSON.parse(cur.body).jobs?.filter(j => j.machine === p.worker_id) ?? [];
    if (active.length) throw new Error(`Active work on ${p.worker_id}: ${active.map(j => j.request_id).join(',')}`);
    save('pair-idle-check.json', {active: 0, at: new Date().toISOString()});

    // ---- Phase 1: stop the whole GLM pair with the sanctioned control.
    progress('stopping_pair', `Running ${p.pair_stop}`);
    const stop = await execute('bash', [p.pair_stop], {timeout: 900000, maxBuffer: 1024 * 1024});
    save('pair-stop.json', {stdout: stop.stdout.slice(-4000), stderr: stop.stderr.slice(-2000)});
    pairStopped = true;
    for (const host of p.pair_hosts) {
      const left = await ssh(host, "docker ps --format '{{.Names}}' | grep -E '^(glm53-exl3|dsv41-exl3)' || true");
      if (left.trim()) throw new Error(`pair containers still running on ${host}: ${left.trim()}`);
    }
    // Engineer ruling: exact-name check. Only the two GLM inference containers
    // must be down; the glm53-nfs exporter is tolerated by exact name. Any
    // OTHER running container is a conflict; record memory before H3 starts.
    const expectedDown = { Spark: ['glm53-exl3-head'], Spark2: ['glm53-exl3-worker'] };
    const state = {};
    for (const host of p.pair_hosts) {
      const names = (await ssh(host, "docker ps --format '{{.Names}}'")).split('\n').map(s => s.trim()).filter(Boolean);
      state[host] = names;
      for (const c of expectedDown[host] ?? []) {
        if (names.includes(c)) throw new Error(`LLM container ${c} still running on ${host}`);
      }
      const allowed = new Set([...(expectedDown[host] ?? []), 'glm53-nfs']);
      const conflicts = names.filter(n => !allowed.has(n));
      if (conflicts.length) throw new Error(`conflicting containers on ${host}: ${conflicts.join(', ')}`);
      const mem = await ssh(host, "free -m | awk 'NR==2{print $3\"/\"$2\" MB used\"}'; nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader 2>/dev/null || true", 30000);
      state[host + '_mem'] = mem.trim();
    }
    save('containers-after-stop.json', state);

    // ---- Phase 2: start the enrolled H3 engine, tunnel, wait for readiness.
    progress('starting_media', `docker start ${p.engine.container_name} on ${p.engine.host}`);
    await ssh(p.engine.host, `docker start ${p.engine.container_name}`, 300000);
    mediaStarted = true;
    tunnel = spawn('ssh', ['-N', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes',
      '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
      '-L', `127.0.0.1:${p.engine.local_port}:127.0.0.1:${p.engine.port}`, p.engine.host],
      {stdio: ['ignore', 'ignore', 'ignore']});
    await new Promise((res, rej) => { tunnel.once('spawn', res); tunnel.once('error', rej); });
    backend = new MediaBackend({kind: 'comfyui', url: `http://127.0.0.1:${p.engine.local_port}`});
    let ready = false, lastErr = null;
    for (let i = 0; i < 200; i++) {
      try { await backend.request('/system_stats'); ready = true; break; }
      catch (e) {
        lastErr = e.message;
        const running = (await ssh(p.engine.host,
          `docker inspect -f '{{.State.Running}}' ${p.engine.container_name}`, 60000)).trim();
        if (running === 'false') throw new Error('media container exited before readiness; no generation submitted');
        progress('starting_media', `engine not ready yet (${i}): ${lastErr}`);
        await new Promise(r => setTimeout(r, 3000));
      }
    }
    if (!ready) throw new Error(`media readiness not established: ${lastErr}`);

    // ---- Phase 3: run each saved job exactly once.
    for (const jid of jobIds) {
      const job = jobs.get(jid);
      if (!job || job.state !== 'queued') throw new Error(`saved job ${jid} missing or not queued in the snapshot`);
      const preStaged = p.inputs_pre_staged === true;
      for (const input of preStaged ? [] : job.payload.input_files === undefined ? [] : jobs.inputs.forJob(job.payload.input_files)) {
        progress('transferring_inputs', `Sending reference file ${input.name} to the engine.`);
        await backend.uploadInput(await openAsBlob(jobs.inputs.file(input.id), {type: input.content_type}), input.name);
        await new Promise(r => setTimeout(r, 2000)); // ComfyUI 0.30: catalog list refresh lags the upload receipt
      }
      const catalog = await backend.request('/object_info');
      if (preStaged) {
        const vals = catalog?.LoadImage?.input?.required?.image?.[0] ?? [];
        save('catalog-check.json', {loadimage_count: vals.length, face_listed: vals.includes('stargate/91ca756c-7cdf-4270-9195-c4756b66eaf4.png')});
      }
      validateVideoCatalog(job.payload, catalog);
      if (!await mediaIdle(backend)) throw new Error('media engine already has native work');
      progress('generating', `Submitting the saved media job once (${jid}).`);
      await jobs.dispatch(jid, backend, p.worker_id);
      for (;;) {
        let obs;
        try { obs = await jobs.observe(jid, backend); }
        catch { progress('generating', 'native progress temporarily unavailable; observing without repeating'); await new Promise(r => setTimeout(r, 5000)); continue; }
        progress('generating', `Native job: ${obs.state}.`);
        if (obs.state === 'completed' || obs.state === 'failed') {
          if (obs.state === 'failed') throw new Error(obs.detail ?? 'native media generation failed');
          break;
        }
        await new Promise(r => setTimeout(r, 5000));
      }
      progress('retaining_results', 'Saving generated files before releasing the media engine.');
      await jobs.collect(jid, backend);
    }

    // ---- Phase 4: release the media engine once idle.
    for (let i = 0; i < 600 && !await mediaIdle(backend); i++) {
      progress('waiting_media_idle', 'Waiting for direct media work before restoring the GLM pair.');
      await new Promise(r => setTimeout(r, 5000));
    }
    await ssh(p.engine.host, `docker stop -t 120 ${p.engine.container_name}`, 300000);
    mediaStarted = false;
  } catch (e) {
    error = e; save('failure.json', {error: e.message});
    // Failure path: never leak a running engine. Keep it up only when the plan
    // explicitly asks for diagnosis; otherwise stop it before pair restore.
    if (mediaStarted && !p.keep_engine_on_failure) {
      try { await ssh(p.engine.host, `docker stop -t 120 ${p.engine.container_name}`, 300000); mediaStarted = false; }
      catch (stopErr) { save('engine-stop-needs-attention.json', {error: stopErr.message}); }
    }
  }

  try {
    if (backend) { try { backend.request('/queue').catch(() => {}); } catch {} }
    if (tunnel) tunnel.kill('SIGTERM');
    // ---- Phase 5: restore the GLM pair, verify a real response.
    if (pairStopped) {
      progress('restoring_pair', `Running ${p.pair_start}`);
      const start = await execute('bash', [p.pair_start], {timeout: 2400000, maxBuffer: 1024 * 1024});
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
      // ---- Phase 6: resume DSG routing for the pair.
      progress('resuming_routing', 'POST /resume-workers');
      const res = await controlRequest('/resume-workers', {workers: [p.worker_id]});
      save('resume-routing.json', {status: res.status, body: res.body.slice(-500)});
      if (res.status !== 200) throw new Error(`resume-workers failed: HTTP ${res.status}`);
      progress(error ? 'failed_returned' : 'returned',
        error ? `Media failed: ${error.message}. GLM pair restored, verified and routing resumed.`
              : 'Generated files retained; GLM pair restored, verified and routing resumed.');
      save('completion.json', {native_generation_verified: !error, llm_return_verified: true, at: new Date().toISOString()});
    } else {
      progress('failed_unchanged', error?.message ?? 'nothing to do');
    }
  } catch (e) {
    save('restoration-needs-attention.json', {error: e.message});
    progress('needs_attention', `LLM return needs attention: ${e.message}`);
    process.exitCode = 1;
  } finally { clearInterval(hb); }
  if (error && !fs.existsSync(path.join(folder, 'completion.json'))) { console.error(error.message); process.exitCode = 1; }
};

runner().catch(e => { console.error(e); process.exitCode = 1; });