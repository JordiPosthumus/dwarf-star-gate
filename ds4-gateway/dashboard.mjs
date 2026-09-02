import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { safeGatewayEvent, DeviceTelemetry, JournalReader } from './telemetry.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const assets = new Map([['/', ['index.html', 'text/html']], ['/ui.css', ['ui.css', 'text/css']], ['/ui.js', ['ui.js', 'text/javascript']]]);
export function createDashboard(getSnapshot) {
  return http.createServer((req, res) => {
    const port = res.socket.localPort;
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" };
    // Loopback binding alone doesn't fence a browser's cross-origin/DNS-rebinding access.
    if (!hosts.includes(req.headers.host) || (req.headers.origin && !hosts.some(h => req.headers.origin === `http://${h}`)) || req.headers['sec-fetch-site'] === 'cross-site') {
      res.writeHead(403, headers); return res.end('Local same-origin dashboard only');
    }
    if (req.method !== 'GET') { res.writeHead(405, headers); return res.end('Read-only'); }
    if (req.url === '/api/status' || req.url === '/api/diagnostics') {
      if (req.url === '/api/diagnostics') headers['content-disposition'] = 'attachment; filename="spark-gateway-diagnostics.json"';
      res.writeHead(200, { ...headers, 'content-type': 'application/json' }); return res.end(JSON.stringify(getSnapshot()));
    }
    const asset = assets.get(req.url);
    if (!asset) { res.writeHead(404, headers); return res.end('Not found'); }
    res.writeHead(200, { ...headers, 'content-type': `${asset[1]}; charset=utf-8` });
    fs.createReadStream(path.join(here, 'ui', asset[0])).on('error', () => res.destroy()).pipe(res);
  });
}

export async function runDashboard(configPath, port = 30010) {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const devices = config.nodes.map(n => new DeviceTelemetry(n.id));
  for (const node of config.nodes) {
    if (node.ssh && (!/^[\w.@-]+$/.test(node.ssh) || node.ssh.startsWith('-'))) throw new Error('Unsupported SSH alias');
    if (!/^[\w@.-]+\.service$/.test(node.telemetry_service || 'ds4-vision-q2.service')) throw new Error('Unsupported journal unit');
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
    if (closed || !node.ssh) return;
    if (!/^[\w.@-]+$/.test(node.ssh) || node.ssh.startsWith('-')) throw new Error('Unsupported SSH alias');
    const service = node.telemetry_service || 'ds4-vision-q2.service';
    if (!/^[\w@.-]+\.service$/.test(service)) throw new Error('Unsupported journal unit');
    const resume = reader.cursor && !resetCursor ? `--after-cursor='${reader.cursor}'` : reader.last_time ? `--since=@${Math.floor(reader.last_time / 1000)}` : '--since=-15min';
    const remote = `journalctl --user -u ${service} -f -n 2000 --no-pager -o json --output-fields=MESSAGE,__REALTIME_TIMESTAMP,__CURSOR ${resume}`;
    const child = spawn('/usr/bin/ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2', node.ssh, remote], { stdio: ['ignore', 'pipe', 'ignore'] });
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
      if (!closed) {
        // A vacuumed cursor may be invalid: reconnect from now, without replaying counted history.
        const t = setTimeout(() => { timers.delete(t); follow(node, device, reader, code !== 0 && code !== 255); }, 10000);
        timers.add(t);
      }
    });
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
      gateway = { model: s.model, context_length: s.context_length, total: s.total, healthy: s.healthy, available: s.available, active: s.active, queued: s.queued, draining: s.draining,
        workers: s.workers.map(w => ({ id: w.id, is_healthy: w.is_healthy, drained: w.drained, load: w.load, queued: w.queued, active_seconds: w.active_seconds, completed: w.completed, failed: w.failed, assigned_sessions: w.assigned_sessions })) };
      gatewayAt = Date.now(); gatewayError = null;
    } catch { gatewayError = 'Gateway status unavailable; last snapshot is stale'; }
    finally { polling = false; }
  }
  const started = Date.now();
  const snapshot = () => ({ version: 1, time: Date.now(), started, read_only: true, gateway, gateway_at: gatewayAt, gateway_error: gatewayError, telemetry_error: writeError,
    devices: devices.map(d => d.snapshot()), events, notes: 'Rates are DS4 engine measurements. Cache counts cover observed prompt starts, not lifetime requests. Raw prompts and responses are excluded.' });
  const server = createDashboard(snapshot);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  config.nodes.forEach((n, i) => follow(n, devices[i], new JournalReader(devices[i])));
  await poll(); const interval = setInterval(poll, 2000);
  const close = () => { closed = true; clearInterval(interval); for (const t of timers) clearTimeout(t); for (const child of children) child.kill(); server.closeAllConnections(); server.close(); process.removeListener('SIGTERM', close); process.removeListener('SIGINT', close); };
  process.once('SIGTERM', close); process.once('SIGINT', close);
  console.log(`Dwarf Star Gate: http://127.0.0.1:${server.address().port} (read-only)`);
  return { server, snapshot, close };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  runDashboard(path.resolve(process.argv[2] || path.join(here, 'config.production.json')), Number(process.env.GATEWAY_UI_PORT || 30010)).catch(e => { console.error(e.message); process.exitCode = 1; });
