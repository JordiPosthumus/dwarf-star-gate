// Pair-lifecycle DIRECT runner (engineer protocol, attempt 4 — recorded separately).
// Bypasses DSG rendering code (no validateVideoCatalog, no MediaJobs) for this
// smoke test. Talks to the enrolled ComfyUI engine directly:
//   /upload/image + /upload/audio (root, no subfolder) -> /view decode-verify
//   -> native /prompt POST (raw response saved) -> observe /history -> /view collect.
// Pair lifecycle + restoration precautions preserved from media-pair-runner.
// On /prompt rejection: KEEP H3 UP (plan.keep_engine_on_failure) and save the
// exact node_errors for diagnosis — no GLM pair cycling per file check.
// Usage: node media-pair-direct.mjs <operation-folder>
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {execFile, spawn} from 'node:child_process';
import {promisify} from 'node:util';

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
    return (await r.json()).data.map(m => m.id).includes(p.model_id);
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

const BASE = `http://127.0.0.1:${p.engine.local_port}`;
const engineRequest = async (route, options = {}) => {
  const r = await fetch(new URL(route, BASE), {...options, signal: AbortSignal.timeout(options.timeoutMs ?? 60000)});
  return r;
};
const uploadFile = async (fieldName, filePath, contentType, endpoint, name) => {
  const form = new FormData();
  form.append(fieldName, new Blob([fs.readFileSync(filePath)], {type: contentType}), name ?? path.basename(filePath));
  const r = await engineRequest(endpoint, {method: 'POST', body: form, timeoutMs: 120000});
  const text = await r.text();
  if (!r.ok) throw new Error(`${endpoint} HTTP ${r.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text); // {name, subfolder, type}
};
const viewOk = async (name, subfolder, type, magic) => {
  const q = new URLSearchParams({filename: name, subfolder: subfolder ?? '', type});
  const r = await engineRequest('/view?' + q, {timeoutMs: 60000});
  if (!r.ok) return {ok: false, status: r.status};
  const buf = Buffer.from(await r.arrayBuffer());
  return {ok: buf.length > 0 && buf.subarray(0, magic.length).equals(Buffer.from(magic)), bytes: buf.length,
          head: buf.subarray(0, 8).toString('hex')};
};

const runner = async () => {
  fs.writeFileSync(path.join(folder, 'runner-claim.json'),
    JSON.stringify({pid: process.pid, at: new Date().toISOString()}, null, 2), {mode: 0o600});
  const hb = setInterval(() => progress(phase, detail), 15000);
  let tunnel = null, pairStopped = false, mediaStarted = false, error = null, promptAccepted = false;
  try {
    // ---- Phase 0: gateway must show no active work on the pair.
    progress('checking_idle', 'Checking gateway for active work on the pair.');
    const cur = await controlRequest('/current-jobs');
    const active = JSON.parse(cur.body).jobs?.filter(j => j.machine === p.worker_id) ?? [];
    if (active.length) throw new Error(`Active work on ${p.worker_id}: ${active.map(j => j.request_id).join(',')}`);

    // ---- Phase 1: stop the whole GLM pair with the sanctioned control.
    progress('stopping_pair', `Running ${p.pair_stop}`);
    const stop = await execute('bash', [p.pair_stop], {timeout: 900000, maxBuffer: 1024 * 1024});
    save('pair-stop.json', {stdout: stop.stdout.slice(-4000), stderr: stop.stderr.slice(-2000)});
    pairStopped = true;
    const expectedDown = {Spark: ['glm53-exl3-head'], Spark2: ['glm53-exl3-worker']};
    const state = {};
    for (const host of p.pair_hosts) {
      const names = (await ssh(host, "docker ps --format '{{.Names}}'")).split('\n').map(s => s.trim()).filter(Boolean);
      state[host] = names;
      for (const c of expectedDown[host] ?? []) if (names.includes(c)) throw new Error(`LLM container ${c} still running on ${host}`);
      const allowed = new Set([...(expectedDown[host] ?? []), 'glm53-nfs']);
      if (host === p.engine.host) allowed.add(p.engine.container_name); // engine may be up (reuse)
      const conflicts = names.filter(n => !allowed.has(n));
      if (conflicts.length) throw new Error(`conflicting containers on ${host}: ${conflicts.join(', ')}`);
      const mem = await ssh(host, "free -m | awk 'NR==2{print $3\"/\"$2\" MB used\"}'", 30000);
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
    let ready = false, lastErr = null;
    for (let i = 0; i < 200; i++) {
      try { await (await engineRequest('/system_stats')).json(); ready = true; break; }
      catch (e) {
        lastErr = e.message;
        const running = (await ssh(p.engine.host,
          `docker inspect -f '{{.State.Running}}' ${p.engine.container_name}`, 60000)).trim();
        if (running === 'false') throw new Error('media container exited before readiness');
        progress('starting_media', `engine not ready yet (${i}): ${lastErr}`);
        await new Promise(r => setTimeout(r, 3000));
      }
    }
    if (!ready) throw new Error(`media readiness not established: ${lastErr}`);

    // ---- Phase 3 (DIRECT): upload refs to the running engine, verify /view.
    // NOTE: this engine build has NO /upload/audio — all files go through the
    // generic /upload/image handler (server.py image_upload, content-agnostic).
    progress('uploading_refs', 'Direct upload of face + env + audio to the running engine.');
    const faceUp = await uploadFile('image', p.files.face, 'image/png', '/upload/image', 'face.png');
    const audioUp = await uploadFile('image', p.files.audio, 'audio/wav', '/upload/image', 'voice.wav');
    const envUp = await uploadFile('image', p.files.env, 'image/png', '/upload/image', 'env.png');
    save('upload-receipts.json', {face: faceUp, audio: audioUp, env: envUp});
    const faceView = await viewOk(faceUp.name, faceUp.subfolder, faceUp.type, [0x89, 0x50, 0x4e, 0x47]);
    const audioView = await viewOk(audioUp.name, audioUp.subfolder, audioUp.type, Buffer.from('RIFF'));
    const envView = await viewOk(envUp.name, envUp.subfolder, envUp.type, [0x89, 0x50, 0x4e, 0x47]);
    save('view-verify.json', {face: faceView, audio: audioView, env: envView});
    if (!faceView.ok) throw new Error('face /view verification failed — engine cannot read back its own upload');
    if (!audioView.ok) throw new Error('audio /view verification failed — engine cannot read back its own upload');
    if (!envView.ok) throw new Error('env /view verification failed — engine cannot read back its own upload');

    // ---- Phase 4 (DIRECT): native /prompt, raw response saved, no DSG validator.
    const graph = JSON.parse(fs.readFileSync(p.graph_file, 'utf8'));
    const faceValue = (faceUp.subfolder ? faceUp.subfolder + '/' : '') + faceUp.name;
    const audioValue = (audioUp.subfolder ? audioUp.subfolder + '/' : '') + audioUp.name;
    const envValue = (envUp.subfolder ? envUp.subfolder + '/' : '') + envUp.name;
    graph['5'].inputs.image = faceValue;
    graph['15'].inputs.audio = audioValue; // LoadAudio lives at node 15 (reference recipe)
    graph['16'].inputs.image = envValue;   // environment ref -> ref_images.ref_image_1
    save('graph-final.json', graph);
    progress('generating', `Submitting native /prompt once (${p.job_id}).`);
    const pr = await engineRequest('/prompt', {method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({prompt: graph, client_id: p.job_id}), timeoutMs: 60000});
    const prBody = await pr.json();
    save('prompt-response.json', {status: pr.status, body: prBody});
    if (!pr.ok || prBody?.error || prBody?.node_errors && Object.keys(prBody.node_errors).length) {
      throw new Error(`ComfyUI /prompt rejected (HTTP ${pr.status}): ${JSON.stringify(prBody).slice(0, 1200)}`);
    }
    promptAccepted = true;
    const nativeId = prBody.prompt_id;
    save('submit-receipt.json', {job_id: p.job_id, native_id: nativeId});

    // ---- Phase 5: observe that job; no duplicate submissions.
    for (;;) {
      const h = await (await engineRequest(`/history/${nativeId}`, {timeoutMs: 60000})).json();
      const row = h?.[nativeId];
      if (row) {
        if (row.status?.status_str === 'error') throw new Error('native generation failed: ' + JSON.stringify(row.status).slice(0, 500));
        if (row.status?.completed === true && row.status?.status_str === 'success') {
          save('native-result.json', {outputs: row.outputs});
          break;
        }
      } else {
        const q = await (await engineRequest('/queue', {timeoutMs: 60000})).json();
        const known = [...(q.queue_running ?? []), ...(q.queue_pending ?? [])].some(item => item[1] === nativeId);
        if (!known) { save('queue-absence.json', {note: 'absent from queue+history; observing, not resubmitting'}); }
      }
      progress('generating', `Native job ${nativeId} running...`);
      await new Promise(r => setTimeout(r, 5000));
    }

    // ---- Phase 6: retain outputs via /view.
    progress('retaining_results', 'Saving generated files.');
    const h = await (await engineRequest(`/history/${nativeId}`)).json();
    const row = h[nativeId];
    const outDir = path.join(p.results_directory, p.job_id);
    fs.mkdirSync(outDir, {recursive: true, mode: 0o700});
    const files = [];
    for (const node of Object.values(row.outputs ?? {})) {
      for (const key of Object.keys(node ?? {})) {
        for (const item of Array.isArray(node[key]) ? node[key] : []) {
          if (typeof item?.filename !== 'string' || item.type !== 'output') continue;
          const q = new URLSearchParams({filename: item.filename, subfolder: item.subfolder ?? '', type: 'output'});
          const r = await engineRequest('/view?' + q, {timeoutMs: 300000});
          if (!r.ok) throw new Error(`output download failed HTTP ${r.status}`);
          const buf = Buffer.from(await r.arrayBuffer());
          const id = crypto.randomUUID();
          fs.writeFileSync(path.join(outDir, id), buf, {mode: 0o600});
          files.push({id, filename: item.filename, bytes: buf.length});
        }
      }
    }
    if (!files.length) throw new Error('native job completed with no output files');
    save('collect-receipt.json', {files, at: new Date().toISOString()});
  } catch (e) {
    error = e;
    save('failure.json', {error: e.message, promptAccepted, at: new Date().toISOString()});
  }

  try {
    const diagnose = error && !promptAccepted && p.keep_engine_on_failure === true;
    if (diagnose) {
      // Engineer protocol: keep H3 up for input-path diagnosis; pair stays down.
      if (tunnel) tunnel.kill('SIGTERM');
      progress('diagnosing', `ComfyUI rejected the workflow; engine left UP on ${p.engine.host} for diagnosis. Pair remains stopped. Error: ${error.message}`);
      save('diagnosing.json', {engine_up: true, pair_stopped: true, at: new Date().toISOString()});
      process.exitCode = 2;
    } else {
      // Cleanup law: confirm idle BEFORE stopping the engine; an unreachable
      // queue is unknown, not idle — leave the engine up and say so.
      let busy = null;
      if (mediaStarted) {
        try {
          const q = await (await engineRequest('/queue')).json();
          busy = (q.queue_running?.length ?? 0) + (q.queue_pending?.length ?? 0);
        } catch { busy = null; }
        if (busy === 0) {
          await ssh(p.engine.host, `docker stop -t 120 ${p.engine.container_name}`, 300000);
          mediaStarted = false;
        } else {
          save('engine-left-running.json', {reason: busy === null ? 'queue unreachable — unknown state' : `${busy} native jobs still queued`, at: new Date().toISOString()});
          progress('needs_attention', `Engine left UP (queue ${busy === null ? 'unreachable' : `busy: ${busy}`}). Pair restore deferred.`);
          process.exitCode = 1;
        }
      }
      if (tunnel) tunnel.kill('SIGTERM');
      if (mediaStarted === false && pairStopped) {
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
        progress('resuming_routing', 'POST /resume-workers');
        const res = await controlRequest('/resume-workers', {workers: [p.worker_id]});
        save('resume-routing.json', {status: res.status, body: res.body.slice(-500)});
        if (res.status !== 200) throw new Error(`resume-workers failed: HTTP ${res.status}`);
        progress(error ? 'failed_returned' : 'returned',
          error ? `Media failed: ${error.message}. GLM pair restored, verified and routing resumed.`
                : 'Generated files retained; GLM pair restored, verified and routing resumed.');
        save('completion.json', {native_generation_verified: !error && promptAccepted, llm_return_verified: true, at: new Date().toISOString()});
      }
    }
  } catch (e) {
    save('restoration-needs-attention.json', {error: e.message});
    progress('needs_attention', `LLM return needs attention: ${e.message}`);
    process.exitCode = 1;
  } finally { clearInterval(hb); }
};

import crypto from 'node:crypto';
runner().catch(e => { console.error(e); process.exitCode = 1; });