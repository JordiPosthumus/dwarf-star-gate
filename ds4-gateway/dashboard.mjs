import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { safeGatewayEvent, DeviceTelemetry, JournalReader } from './telemetry.mjs';
import { safeRequestedThinking } from './requested-thinking.mjs';
import { workerControl } from './worker-client.mjs';
import { FileLogReader, telemetryFiles } from './file-telemetry.mjs';
import { Activity } from './ui/activity.js';
import { Genie } from './genie.mjs';
import { genieTunnel } from './genie-tunnel.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const assets = new Map([['/', ['index.html', 'text/html']], ['/ui.css', ['ui.css', 'text/css']], ['/brand.css', ['brand.css', 'text/css']], ['/ui.js', ['ui.js', 'text/javascript']], ['/logo.png', ['logo.png', 'image/png']]]);
assets.set('/activity.js',['activity.js','text/javascript']);
export function createDashboard(getSnapshot, assetsDirectory = path.join(here, 'ui'), management = null, genie = null) {
  const csrf = randomBytes(32).toString('base64url');
  // Freeze one complete release in memory: edits on disk cannot expose half an
  // update to a live browser. Only the dashboard needs a reload to promote it.
  const bundle = new Map([...assets].map(([route, [file, mime]]) => [route, { bytes:fs.readFileSync(path.join(assetsDirectory,file)), mime }]));
  for (const match of bundle.get('/').bytes.toString('utf8').matchAll(/(?:src|href)="(\/[^"#]*)"/g))
    if (!bundle.has(match[1]) && !['/api/status', '/api/diagnostics'].includes(match[1])) throw new Error(`Unserved dashboard asset: ${match[1]}`);
  return http.createServer((req, res) => {
    const port = res.socket.localPort;
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" };
    // Loopback binding alone doesn't fence a browser's cross-origin/DNS-rebinding access.
    if (!hosts.includes(req.headers.host) || (req.headers.origin && !hosts.some(h => req.headers.origin === `http://${h}`)) || req.headers['sec-fetch-site'] === 'cross-site') {
      res.writeHead(403, headers); return res.end('Local same-origin dashboard only');
    }
    const reply = (status, value) => { if (!res.destroyed && !res.headersSent) { res.writeHead(status,{...headers,'content-type':'application/json'}); res.end(JSON.stringify(value)); } };
    if(req.url==='/api/genie' && req.method==='GET')return reply(200,{...(genie?.status()||{configured:false}),csrf_token:csrf});
    if(req.url==='/api/genie' && req.method==='POST' && genie) {
      const token=Buffer.from(req.headers['x-dsg-csrf']||''), expected=Buffer.from(csrf);
      if(req.headers.origin!==`http://${req.headers.host}` || token.length!==expected.length || !timingSafeEqual(token,expected))return reply(403,{error:'Same-origin Genie control session required'});
      if(req.headers['content-type']!=='application/json')return reply(415,{error:'JSON required'});
      let body='',ended=false;
      const timer=setTimeout(()=>{ended=true;reply(408,{error:'Incomplete request'});req.destroy();},5000);
      const stop=()=>{ended=true;clearTimeout(timer);};req.on('error',stop);req.on('aborted',stop);
      req.on('data',chunk=>{body+=chunk;if(Buffer.byteLength(body)>8192){stop();reply(413,{error:'Question too large'});req.destroy();}});
      req.on('end',()=>{clearTimeout(timer);if(ended)return;
        try {const input=JSON.parse(body);
          if(input.action==='enable')return reply(200,genie.setEnabled(input.enabled));
          if(input.action==='source')return reply(200,genie.setSource(input.source));
          if(input.action!=='ask')return reply(400,{error:'Unknown Genie action'});
          if(!genie.enabled || genie.busy)return reply(409,{error:'Genie is off or busy'});
          if(input.question!==undefined && (typeof input.question!=='string'||input.question.length>2000))return reply(400,{error:'Question too long'});
          void genie.ask(input.question);return reply(202,{accepted:true});
        } catch {reply(400,{error:'Invalid Genie request'});}
      });return;
    }
    if (req.url === '/api/workers' && req.method === 'GET') {
      if (!management) return reply(200, { enabled:false });
      void management.read().then(registry => reply(200,{enabled:true,csrf_token:csrf,...registry})).catch(() => reply(503,{error:'Worker controls unavailable'}));
      return;
    }
    const actions = { '/api/workers/add':'add', '/api/workers/remove':'remove', '/api/workers/drain':'drain', '/api/workers/resume':'resume', '/api/workers/context':'context' };
    if (management && req.method === 'POST' && Object.hasOwn(actions,req.url)) {
      const token = Buffer.from(req.headers['x-dsg-csrf'] || ''), expected = Buffer.from(csrf);
      if (req.headers.origin !== `http://${req.headers.host}` || token.length !== expected.length || !timingSafeEqual(token,expected)) return reply(403,{error:'Same-origin worker-control session required; refresh and retry'});
      if (req.headers['content-type'] !== 'application/json') return reply(415,{error:'JSON required'});
      let body = '', ended = false;
      const timer = setTimeout(() => { ended=true; reply(408,{error:'Incomplete worker-control request'}); req.destroy(); },5000);
      req.on('data', chunk => { if (ended) return; body += chunk; if (Buffer.byteLength(body)>8192) { ended=true;clearTimeout(timer);reply(413,{error:'Worker configuration too large'}); } });
      req.on('error',()=>{ended=true;clearTimeout(timer);});
      req.on('aborted',()=>{ended=true;clearTimeout(timer);});
      req.on('end',()=>{
        clearTimeout(timer); if(ended)return; ended=true;
        let input; try { input=JSON.parse(body); } catch { return reply(400,{error:'Invalid JSON'}); }
        void management.act(actions[req.url],input).then(value=>reply(200,value)).catch(e=>reply(400,{error:e.message}));
      });
      return;
    }
    if (req.method !== 'GET') { res.writeHead(405, headers); return res.end('Read-only'); }
    if (req.url === '/api/status' || req.url === '/api/diagnostics') {
      if (req.url === '/api/diagnostics') headers['content-disposition'] = 'attachment; filename="spark-gateway-diagnostics.json"';
      res.writeHead(200, { ...headers, 'content-type': 'application/json' }); return res.end(JSON.stringify(getSnapshot()));
    }
    const asset = bundle.get(req.url);
    if (!asset) { res.writeHead(404, headers); return res.end('Not found'); }
    res.writeHead(200, { ...headers, 'content-type': asset.mime.startsWith('text/') ? `${asset.mime}; charset=utf-8` : asset.mime });
    res.end(asset.bytes);
  });
}

export async function runDashboard(configPath, port = 30010) {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const fileSources = telemetryFiles(config.telemetry_files);
  const devices = new Map(), readers = new Map();
  const activity=new Activity();
  for (const node of config.nodes) {
    if (node.ssh && (!/^[\w.@-]+$/.test(node.ssh) || node.ssh.startsWith('-'))) throw new Error('Unsupported SSH alias');
    if (node.telemetry_service !== null && !/^[\w@.-]+\.service$/.test(node.telemetry_service || 'ds4-vision-q2.service')) throw new Error('Unsupported journal unit');
  }
  const runtime = path.join(path.dirname(config.state_file), 'dashboard');
  fs.mkdirSync(runtime, { recursive: true, mode: 0o700 });
  let closed = false, gateway = null, gatewayAt = null, gatewayError = 'Waiting for gateway', writeError = null;
  let events = [], offset = null, inode = null, fragment = '', polling = false;
  const children = new Set(), timers = new Set();
  const save = entry => {
    try { fs.appendFileSync(path.join(runtime, `metrics-${new Date().toISOString().slice(0, 10)}.jsonl`), JSON.stringify(entry) + '\n', { mode: 0o600 }); }
    catch { writeError = 'Telemetry file could not be written; live monitoring continues'; }
  };
  function follow(node, device, reader, resetCursor = false) {
    if (closed || !node.ssh || readers.get(node.id)?.node !== node) return;
    if (!/^[\w.@-]+$/.test(node.ssh) || node.ssh.startsWith('-')) throw new Error('Unsupported SSH alias');
    const service = node.telemetry_service || 'ds4-vision-q2.service';
    if (!/^[\w@.-]+\.service$/.test(service)) throw new Error('Unsupported journal unit');
    const resume = reader.cursor && !resetCursor ? `--after-cursor='${reader.cursor}'` : reader.last_time ? `--since=@${Math.floor(reader.last_time / 1000)}` : '--since=-15min';
    const remote = `journalctl --user -u ${service} -f -n 2000 --no-pager -o json --output-fields=MESSAGE,__REALTIME_TIMESTAMP,__CURSOR ${resume}`;
    const child = spawn('/usr/bin/ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2', node.ssh, remote], { stdio: ['ignore', 'pipe', 'ignore'] });
    child.workerNode = node;
    children.add(child); let buffer = '', skipping = false;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', data => {
      device.connected = true;
      buffer += data;
      let i;
      while ((i = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
        if (skipping) { skipping = false; continue; }
        try {
          const j = JSON.parse(line);
          const e = reader.accept(j);
          if (e) save({ sample_id: createHash('sha256').update(`${node.id}:${j.__CURSOR}`).digest('hex'), observed_at: Date.now(), node: node.id, ...e });
        } catch { /* An unfamiliar journal record cannot affect the model or UI. */ }
      }
      if (buffer.length > 1048576) { buffer = ''; skipping = true; }
    });
    child.on('error', () => { device.connected = false; });
    child.on('close', code => {
      children.delete(child); device.connected = false;
      if (!closed && readers.get(node.id)?.node === node) {
        // A vacuumed cursor may be invalid: reconnect from now, without replaying counted history.
        const t = setTimeout(() => { timers.delete(t); follow(node, device, reader, code !== 0 && code !== 255); }, 10000);
        timers.add(t);
      }
    });
  }
  function syncDevices(workers) {
    let definitions = config.nodes;
    try { definitions = JSON.parse(fs.readFileSync(config.state_file,'utf8')).workers ?? definitions; }
    catch { /* Keep initial journal configuration; gateway status owns membership. */ }
    const ids = new Set(workers.map(w=>w.id));
    const signature = id => JSON.stringify({node:definitions.find(n=>n.id===id),file:fileSources.get(id)});
    for (const [id,entry] of readers) if (!ids.has(id) || signature(id)!==entry.signature) {
      readers.delete(id);
      devices.delete(id);
      for(const child of children) if(child.workerNode===entry.node) child.kill();
    }
    for (const id of devices.keys()) if(!ids.has(id)) devices.delete(id);
    for(const w of workers) {
      if(!devices.has(w.id)) devices.set(w.id,new DeviceTelemetry(w.id));
      const device=devices.get(w.id), node=definitions.find(n=>n.id===w.id);
      const file=fileSources.get(w.id);
      device.telemetry_configured=!!file || !!(node?.ssh && node.telemetry_service!==null);
      device.telemetry_source=file?'file':device.telemetry_configured?'journal':null;
      if(file) {
        if(!readers.has(w.id)) readers.set(w.id,{node,signature:signature(w.id),reader:new FileLogReader(device,file,save)});
        readers.get(w.id).reader.poll();
        continue;
      }
      if(device.telemetry_configured && !readers.has(w.id)) {
        // Validate before any dynamic journal-reader command is constructed.
        if(!/^[a-zA-Z0-9][\w.@-]{0,252}$/.test(node.ssh) || !/^[\w@.-]+\.service$/.test(node.telemetry_service || 'ds4-vision-q2.service')) {device.telemetry_configured=false;continue;}
        const reader=new JournalReader(device);
        readers.set(w.id,{node,signature:signature(w.id),reader}); follow(node,device,reader);
      }
    }
  }
  function readEvents() {
    const log = path.join(path.dirname(config.state_file), 'gateway.log');
    try {
      const s = fs.statSync(log);
      if (offset === null || inode !== s.ino || s.size < offset) {
        offset = Math.max(0, s.size - 262144); inode = s.ino; fragment = '';
        // Initial tail starts mid-line; skip that first fragment.
        if (offset) fragment = '!';
      }
      const length = Math.min(262144, s.size - offset);
      if (!length) return;
      const fd = fs.openSync(log, 'r'), buf = Buffer.alloc(length);
      let bytes; try { bytes = fs.readSync(fd, buf, 0, length, offset); } finally { fs.closeSync(fd); }
      offset += bytes;
      const lines = (fragment + buf.subarray(0, bytes).toString('utf8')).split('\n'); fragment = lines.pop();
      for (const line of lines) {
        try { const e = safeGatewayEvent(JSON.parse(line)); if (e) events.push(e); } catch { /* partial line */ }
      }
      events = events.slice(-100);
      if (fragment.length > 1048576) fragment = '!';
    } catch { /* Status works even before a local gateway log exists. */ }
  }
  async function poll() {
    if (polling) return;
    polling = true; readEvents();
    try {
      const r = await fetch(`http://127.0.0.1:${config.port}/gateway/status`, { headers: { authorization: `Bearer ${config.api_key}` }, signal: AbortSignal.timeout(3000) });
      if (!r.ok) throw new Error('Status unavailable');
      const s = await r.json();
      if (s.version !== 1 || !Array.isArray(s.workers)) throw new Error('Unsupported gateway');
      gateway = { model: s.model, context_length: s.context_length, total: s.total, healthy: s.healthy, available: s.available, active: s.active, queued: s.queued, draining: s.draining, dataset:s.dataset,
        workers: s.workers.map(w => ({ id: w.id, is_healthy: w.is_healthy, drained: w.drained, load: w.load, queued: w.queued, active_seconds: w.active_seconds, completed: w.completed, failed: w.failed, assigned_sessions: w.assigned_sessions,
          context_length:Number.isSafeInteger(w.context_length)?w.context_length:null, requested_thinking: safeRequestedThinking(w.requested_thinking), last_requested_thinking: safeRequestedThinking(w.last_requested_thinking),
          last_request_finished_at: typeof w.last_request_finished_at === 'string' && Number.isFinite(Date.parse(w.last_request_finished_at)) ? w.last_request_finished_at : null })) };
      gatewayAt = Date.now(); gatewayError = null;
      syncDevices(s.workers);
    } catch { gatewayError = 'Gateway status unavailable; last snapshot is stale'; }
    finally { activity.update([...devices.values()],gateway?.workers||[],Date.now(),!!gatewayError);polling = false; }
  }
  const started = Date.now();
  const managementEnabled = config.ui_worker_management === true && !!config.control_socket;
  const snapshot = () => ({ version: 1, time: Date.now(), started, read_only: !managementEnabled, worker_management:managementEnabled, gateway, gateway_at: gatewayAt, gateway_error: gatewayError, telemetry_error: writeError,
    devices: [...devices.values()].map(d => ({...d.snapshot(),activity:activity.get(d.id)})), events, notes: 'Rates are DS4 engine measurements. Cache counts cover observed prompt starts, not lifetime requests. Raw prompts and responses are excluded.' });
  const genie=new Genie(config.genie,snapshot);
  const stopGenieTunnel=genieTunnel(config.genie);
  const server = createDashboard(snapshot, path.join(here,'ui'), managementEnabled ? {
    read:()=>workerControl(config.control_socket,'/workers'),
    act:(action,input)=>workerControl(config.control_socket,({add:'/add-worker',remove:'/remove-worker',drain:'/drain-workers',resume:'/resume-workers',context:'/set-context-limit'})[action],input),
  } : null,genie);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  await poll(); const interval = setInterval(poll, 2000), genieTimer=setInterval(()=>genie.tick(),10000);
  const close = () => { closed = true; clearInterval(interval);clearInterval(genieTimer);genie.close();stopGenieTunnel(); for (const t of timers) clearTimeout(t); for (const child of children) child.kill(); server.closeAllConnections(); server.close(); process.removeListener('SIGTERM', close); process.removeListener('SIGINT', close); };
  process.once('SIGTERM', close); process.once('SIGINT', close);
  console.log(`Dwarf Star Gate: http://127.0.0.1:${server.address().port} (${managementEnabled ? 'local worker controls' : 'read-only'})`);
  return { server, snapshot, close };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  runDashboard(path.resolve(process.argv[2] || path.join(here, 'config.production.json')), Number(process.env.GATEWAY_UI_PORT || 30010)).catch(e => { console.error(e.message); process.exitCode = 1; });
