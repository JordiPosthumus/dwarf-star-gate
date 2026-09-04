import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { safeGatewayEvent, DeviceTelemetry, JournalReader } from './telemetry.mjs';
import { safeRequestedThinking } from './requested-thinking.mjs';
import { workerControl } from './worker-client.mjs';
import { FileLogReader, telemetryFiles } from './file-telemetry.mjs';
import { Activity } from './ui/activity.js';
import { Genie } from './genie.mjs';
import {GenieMemory} from './genie-memory.mjs';
import { genieTunnel } from './genie-tunnel.mjs';
import { safeQuarantine } from './generation-health.mjs';
import { AnalyticsReader } from './analytics.mjs';
import {FleetSpeedReader} from './fleet-speed.mjs';
import {HardwareTelemetry} from './hardware-telemetry.mjs';
import { estimateCacheCost } from './cache-cost.mjs';
import {CacheInventoryReader,cacheInventoryDirectories,loadCacheInventoryKey} from './cache-inventory.mjs';
import { loadConfig, dashboardPort, isMain, continuityEnabled } from './config.mjs';
import {continuityForDisplay,continuityDoorForDisplay,fallbackTieBreakForDisplay} from './continuity.mjs';
import {dsgReport,invalidHttp} from './report.mjs';
import {EngineAttribution} from './attribution.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const managementStates=new Set(['local','pending','connecting','ssh_process_active','verified','ssh_error','retrying']);
const managementReasons=new Set(['adapter_timeout','adapter_output_limit','adapter_spawn_failed','adapter_dns_failure','adapter_host_key_failure','adapter_auth_failure','adapter_connect_timeout','adapter_connection_refused','adapter_route_unreachable','adapter_connection_reset','adapter_unreachable','adapter_check_failed']);
function safeManagementPath(raw){
  if(!raw||!['local','ssh_tunnel'].includes(raw.transport)||!managementStates.has(raw.state))return null;
  return {transport:raw.transport,state:raw.state,reason:managementReasons.has(raw.reason)?raw.reason:null,
    attempts:Number.isSafeInteger(raw.attempts)&&raw.attempts>=0?raw.attempts:0,
    route_count:Number.isSafeInteger(raw.route_count)&&raw.route_count>=0&&raw.route_count<=5?raw.route_count:0,
    changed_at:typeof raw.changed_at==='string'&&Number.isFinite(Date.parse(raw.changed_at))?raw.changed_at:null,
    last_verified_at:typeof raw.last_verified_at==='string'&&Number.isFinite(Date.parse(raw.last_verified_at))?raw.last_verified_at:null};
}
const assets = new Map([['/', ['index.html', 'text/html']], ['/ui.css', ['ui.css', 'text/css']], ['/brand.css', ['brand.css', 'text/css']], ['/ui.js', ['ui.js', 'text/javascript']], ['/logo.png', ['logo.png', 'image/png']]]);
assets.set('/activity.js',['activity.js','text/javascript']);
for(const [route,file,mime] of [
  ['favicon.ico','favicon.ico','image/x-icon'],['favicon-v2.ico','favicon.ico','image/x-icon'],
  ['favicon-v1.svg','favicon-v1.svg','image/svg+xml'],['favicon-v2.svg','favicon-v1.svg','image/svg+xml'],
  ['dsg-pinned-v1.svg','dsg-pinned-v1.svg','image/svg+xml'],['dsg-pinned-v2.svg','dsg-pinned-v1.svg','image/svg+xml'],
  ['favicon-v1.png','favicon-v1.png','image/png'],['favicon-v2.png','favicon-v1.png','image/png'],
  ['apple-touch-icon.png','apple-touch-icon.png','image/png'],['apple-touch-icon-v2.png','apple-touch-icon.png','image/png'],
])assets.set('/'+route,[file,mime]);
export function genieRuntimeConfig(config){
  if(config.genie===false)return null;
  const pool={url:`http://127.0.0.1:${config.port}/v1`,model:config.model,api_key:config.api_key};
  if(config.genie?.url)return {...config.genie,enabled:config.genie.enabled!==false,fallback:config.genie.fallback??pool};
  return {...pool,enabled:config.genie?.enabled!==false,fallback:pool,default_source:'pool'};
}
export function createDashboard(getSnapshot, assetsDirectory = path.join(here, 'ui'), management = null, genie = null, analytics = null) {
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
      res.writeHead(403, headers); return res.end(dsgReport('Local same-origin dashboard only'));
    }
    const reply = (status, value) => { if (!res.destroyed && !res.headersSent) { res.writeHead(status,{...headers,'content-type':'application/json'}); res.end(JSON.stringify(status>=400&&typeof value.error==='string'?{...value,error:dsgReport(value.error)}:value)); } };
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
          if(input.action==='memory'&&genie.memory){genie.memory.setEnabled(input.enabled);return reply(200,genie.status());}
          if(input.action==='memory-note'&&genie.memory){const receipt=genie.memory.saveOperatorNote(input.note,getSnapshot());return reply(200,{...genie.status(),memory_receipt:receipt});}
          if(input.action!=='ask')return reply(400,{error:'Unknown Genie action'});
          if(!genie.enabled)return reply(409,{error:'Gate Genie is off. Enable him before asking; the question was not queued.'});
          if(input.question!==undefined && (typeof input.question!=='string'||input.question.length>2000))return reply(400,{error:'Question too long'});
          try{return reply(202,{accepted:true,question:genie.submit(input.question)});}
          catch(e){return reply(409,{error:e.message});}
        } catch {reply(400,{error:'Invalid Genie request'});}
      });return;
    }
    if (req.url === '/api/workers' && req.method === 'GET') {
      if (!management) return reply(200, { enabled:false });
      void management.read().then(registry => reply(200,{enabled:true,csrf_token:csrf,...registry})).catch(() => reply(503,{error:'Worker controls unavailable'}));
      return;
    }
    const actions = { '/api/workers/add':'add', '/api/workers/remove':'remove', '/api/workers/drain':'drain', '/api/workers/resume':'resume','/api/workers/fallbacks':'fallbacks', '/api/workers/context':'context','/api/workers/queue-timeout':'queue-timeout','/api/workers/protection':'protection','/api/workers/relocate':'relocate', '/api/workers/recover':'recover', '/api/workers/recovery-policy':'recovery-policy','/api/workers/recovery-handback-policy':'recovery-handback-policy','/api/workers/recovery-recheck':'recovery-recheck','/api/workers/predictor':'predictor' };
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
    if (req.method !== 'GET') { res.writeHead(405, headers); return res.end(dsgReport('Read-only')); }
    if(req.url?.split('?')[0]==='/api/cache-cost') {
      try {
        const p=new URL(req.url,'http://localhost').searchParams;
        if([...p.keys()].some(k=>!['worker','tier','cached_tokens','prompt_tokens'].includes(k))||[...p.keys()].length!==4)throw new Error();
        if(!/^\d+$/.test(p.get('cached_tokens'))||!/^\d+$/.test(p.get('prompt_tokens')))throw new Error();
        const s=getSnapshot(),worker=s.gateway?.workers.find(w=>w.id===p.get('worker')),device=s.devices?.find(d=>d.id===p.get('worker'));
        if(!worker||!device)return reply(404,{error:'Unknown worker'});
        if(s.gateway_error||!worker.is_healthy||!device.connected)return reply(503,{error:'Fresh healthy-worker telemetry required'});
        if(Number.isSafeInteger(worker.context_length)&&Number(p.get('prompt_tokens'))>worker.context_length)return reply(400,{error:'Scenario exceeds the worker context capacity'});
        return reply(200,estimateCacheCost(device.cache_cost,{tier:p.get('tier'),cached_tokens:Number(p.get('cached_tokens')),prompt_tokens:Number(p.get('prompt_tokens'))}));
      }catch{return reply(400,{error:'Specify worker, tier, integer cached_tokens and prompt_tokens'});}
    }
    if (req.url === '/api/analytics') return reply(200,analytics?analytics():{enabled:false,status:'disabled',rows:[]});
    if (req.url === '/api/status' || req.url === '/api/diagnostics') {
      if (req.url === '/api/diagnostics') headers['content-disposition'] = 'attachment; filename="spark-gateway-diagnostics.json"';
      res.writeHead(200, { ...headers, 'content-type': 'application/json' }); return res.end(JSON.stringify(getSnapshot()));
    }
    const asset = bundle.get(req.url);
    if (!asset) { res.writeHead(404, headers); return res.end(dsgReport('Not found')); }
    res.writeHead(200, { ...headers, 'content-type': asset.mime.startsWith('text/') ? `${asset.mime}; charset=utf-8` : asset.mime });
    res.end(asset.bytes);
  }).on('clientError',invalidHttp);
}

export async function runDashboard(configPath, port) {
  const {config} = loadConfig(configPath);
  port ??= dashboardPort(config);
  const fileSources = telemetryFiles(config.telemetry_files);
  const cacheSources=cacheInventoryDirectories(config.cache_directories);
  const devices = new Map(), readers = new Map(),cacheReaders=new Map();
  const activity=new Activity();
  for (const node of config.nodes) {
    if (node.ssh && (!/^[\w.@-]+$/.test(node.ssh) || node.ssh.startsWith('-'))) throw new Error('Unsupported SSH alias');
    if (node.telemetry_service !== null && !/^[\w@.-]+\.service$/.test(node.telemetry_service || 'ds4-vision-q2.service')) throw new Error('Unsupported journal unit');
  }
  const runtime = path.join(path.dirname(config.state_file), 'dashboard');
  const analytics=new AnalyticsReader(path.join(path.dirname(config.state_file),'training'),{enabled:config.dataset_enabled===true});
  fs.mkdirSync(runtime, { recursive: true, mode: 0o700 });
  const fleetSpeed=new FleetSpeedReader(runtime);
  let cacheInventoryKey=null,cacheInventoryError=null;
  if(cacheSources.size)try{cacheInventoryKey=loadCacheInventoryKey(runtime);}catch{cacheInventoryError='Cache inventory key unavailable';}
  let closed = false, gateway = null, gatewayAt = null, gatewayError = 'Waiting for gateway', writeError = null;
  let continuityDoor = null, continuityDoorError = continuityEnabled(config)?'Waiting for continuity door':null;
  let events = [], offset = null, inode = null, fragment = '', polling = false;
  const children = new Set(), timers = new Set();
  const appendMetric = entry => {
    try { fs.appendFileSync(path.join(runtime, `metrics-${new Date().toISOString().slice(0, 10)}.jsonl`), JSON.stringify(entry) + '\n', { mode: 0o600 }); }
    catch { writeError = 'Telemetry file could not be written; live monitoring continues'; }
  };
  const hardware=new HardwareTelemetry(config.hardware_telemetry,appendMetric);
  const attribution=new EngineAttribution(appendMetric);
  const save = entry => {appendMetric(entry);attribution.acceptEngine(entry);};
  function follow(node, device, reader, resetCursor = false) {
    if (closed || !node.ssh || readers.get(node.id)?.node !== node) return;
    if (!/^[\w.@-]+$/.test(node.ssh) || node.ssh.startsWith('-')) throw new Error('Unsupported SSH alias');
    const service = node.telemetry_service || 'ds4-vision-q2.service';
    if (!/^[\w@.-]+\.service$/.test(service)) throw new Error('Unsupported journal unit');
    const resume = reader.cursor && !resetCursor ? `--after-cursor='${reader.cursor}'` : reader.last_time ? `--since=@${Math.floor(reader.last_time / 1000)}` : '--since=-15min';
    const remote = `journalctl --user -u ${service} -f -n 2000 --no-pager -o json --output-fields=MESSAGE,__REALTIME_TIMESTAMP,__CURSOR,_SYSTEMD_INVOCATION_ID,_BOOT_ID,_PID ${resume}`;
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
    hardware.sync(definitions,workers);
    const signature = id => JSON.stringify({node:definitions.find(n=>n.id===id),file:fileSources.get(id)});
    for (const [id,entry] of readers) if (!ids.has(id) || signature(id)!==entry.signature) {
      readers.delete(id);
      devices.delete(id);
      for(const child of children) if(child.workerNode===entry.node) child.kill();
    }
    for (const id of devices.keys()) if(!ids.has(id)) devices.delete(id);
    for(const [id,reader] of cacheReaders)if(!ids.has(id)||reader.directory!==cacheSources.get(id))cacheReaders.delete(id);
    for(const w of workers) {
      if(!devices.has(w.id)) devices.set(w.id,new DeviceTelemetry(w.id));
      const device=devices.get(w.id), node=definitions.find(n=>n.id===w.id);
      const file=fileSources.get(w.id);
      const cacheDirectory=cacheSources.get(w.id);
      device.cache_inventory_configured=!!cacheDirectory;
      if(cacheDirectory&&cacheInventoryKey){
        if(!cacheReaders.has(w.id))cacheReaders.set(w.id,new CacheInventoryReader(w.id,cacheDirectory,cacheInventoryKey));
        device.cache_inventory=cacheReaders.get(w.id).poll();
      }else device.cache_inventory={schema:1,worker:w.id,status:cacheDirectory?'unavailable':'not_configured',accepted:0,cohorts:[],...(cacheDirectory&&cacheInventoryError?{error:'key_unavailable'}:{})};
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
    let fd;
    try {
      fd = fs.openSync(log, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      const s = fs.fstatSync(fd);
      if (!s.isFile()) throw new Error('Gateway event source is not a regular file');
      if (offset === null || inode !== s.ino || s.size < offset) {
        offset = Math.max(0, s.size - 262144); inode = s.ino; fragment = '';
        // Initial tail starts mid-line; skip that first fragment.
        if (offset) fragment = '!';
      }
      const length = Math.min(262144, s.size - offset);
      if (!length) return;
      const buf = Buffer.alloc(length);
      const bytes = fs.readSync(fd, buf, 0, length, offset);
      offset += bytes;
      const lines = (fragment + buf.subarray(0, bytes).toString('utf8')).split('\n'); fragment = lines.pop();
      for (const line of lines) {
        try { const e = safeGatewayEvent(JSON.parse(line)); if (e) {events.push(e);attribution.acceptGateway(e);} } catch { /* partial line */ }
      }
      events = events.slice(-100);
      if (fragment.length > 1048576) fragment = '!';
    } catch { /* Status works even before a safe local gateway log exists. */ }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  async function poll() {
    if (polling) return;
    polling = true; readEvents();analytics.poll();fleetSpeed.poll();
    if(continuityEnabled(config))try{
      const response=await fetch(`http://127.0.0.1:${config.port}/continuity/status`,{headers:{authorization:`Bearer ${config.api_key}`},signal:AbortSignal.timeout(3000)});
      if(!response.ok)throw new Error();continuityDoor=continuityDoorForDisplay(await response.json());continuityDoorError=continuityDoor?null:'Unsupported continuity door';
    }catch{continuityDoorError='Continuity door status unavailable';}
    try {
      const r = await fetch(`http://127.0.0.1:${config.port}/gateway/status`, { headers: { authorization: `Bearer ${config.api_key}` }, signal: AbortSignal.timeout(3000) });
      if (!r.ok) throw new Error('Status unavailable');
      const s = await r.json();
      if (s.version !== 1 || !Array.isArray(s.workers)) throw new Error('Unsupported gateway');
      gateway = { model: s.model, context_length: s.context_length,queue_timeout_ms:s.queue_timeout_ms,request_timeout_ms:s.request_timeout_ms, total: s.total, healthy: s.healthy, available: s.available, active: s.active, queued: s.queued, draining: s.draining, dataset:s.dataset,recovery:s.recovery,predictor:s.predictor,calibration:s.calibration,protections:s.protections,agent_api_version:s.agent_api_version,fallback_tiebreak_shadow:fallbackTieBreakForDisplay(s.fallback_tiebreak_shadow),
        continuity:continuityForDisplay(s.continuity),
        workers: s.workers.map(w => ({ id: w.id, is_healthy: w.is_healthy, drained: w.drained, quarantine:safeQuarantine(w.quarantine), load: w.load, queued: w.queued, active_seconds: w.active_seconds, completed: w.completed, failed: w.failed, assigned_sessions: w.assigned_sessions,
          gateway_drained:w.gateway_drained,recovery_waiting:Number.isSafeInteger(w.recovery_waiting)?w.recovery_waiting:0,operator_paused:w.operator_paused,holds:Array.isArray(w.holds)?w.holds.slice(0,1024).map(h=>({id:h.id,owner_id:h.owner_id,created_at:h.created_at})):[],
          last_operator_action:w.last_operator_action&&['pause','resume'].includes(w.last_operator_action.action)&&typeof w.last_operator_action.time==='string'&&Number.isFinite(Date.parse(w.last_operator_action.time))&&typeof w.last_operator_action.control_channel==='string'&&/^[a-z][a-z0-9_]{0,31}$/.test(w.last_operator_action.control_channel)?{action:w.last_operator_action.action,time:w.last_operator_action.time,control_channel:w.last_operator_action.control_channel}:null,
          oldest_queue_seconds:w.oldest_queue_seconds??null,oldest_queue_remaining_seconds:w.oldest_queue_remaining_seconds??null,
          context_length:Number.isSafeInteger(w.context_length)?w.context_length:null, requested_thinking: safeRequestedThinking(w.requested_thinking), last_requested_thinking: safeRequestedThinking(w.last_requested_thinking),predictions:w.predictions,
          health_probe_deferred:Number.isSafeInteger(w.health_probe_deferred)?w.health_probe_deferred:0,
          health_state_source:['model_probe','recent_upstream_progress'].includes(w.health_state_source)?w.health_state_source:null,
          management_path:safeManagementPath(w.management_path),
          probe_error:['PROBE_TIMEOUT','busy_probe_deferred','ECONNREFUSED','ECONNRESET','EHOSTUNREACH','ENETUNREACH','model_or_context_mismatch','invalid_model_response'].includes(w.probe_error)?w.probe_error:null,
          last_probe:typeof w.last_probe==='string'&&Number.isFinite(Date.parse(w.last_probe))?w.last_probe:null,
          last_request_finished_at: typeof w.last_request_finished_at === 'string' && Number.isFinite(Date.parse(w.last_request_finished_at)) ? w.last_request_finished_at : null })) };
      gatewayAt = Date.now(); gatewayError = null;
      syncDevices(s.workers);
      hardware.poll();
    } catch { gatewayError = 'Gateway status unavailable; last snapshot is stale'; }
    finally { activity.update([...devices.values()],gateway?.workers||[],Date.now(),!!gatewayError);try{memory.observe(snapshot());}catch{/* A notebook fault cannot stop fleet polling. */}polling = false; }
  }
  const started = Date.now();
  const managementEnabled = config.ui_worker_management === true && !!config.control_socket;
  const snapshot = () => ({ service:'dwarf-star-gate-dashboard', version: 1, time: Date.now(), started, read_only: !managementEnabled, worker_management:managementEnabled, gateway, gateway_at: gatewayAt, gateway_error: gatewayError, telemetry_error: writeError,
    continuity_door:continuityDoor,continuity_door_error:continuityDoorError,
    devices: [...devices.values()].map(d => ({...d.snapshot(),activity:activity.get(d.id),hardware:hardware.snapshot(d.id)})), events, attribution:attribution.snapshot(), notes: 'Rates are DS4 engine measurements. Cache counts cover observed prompt starts, not lifetime requests. Raw prompts and responses are excluded.' });
  const memory=new GenieMemory(path.join(path.dirname(config.state_file),'genie','memory'));
  const runtimeGenie=genieRuntimeConfig(config);
  const genie=new Genie(runtimeGenie,snapshot,{memory,recover:managementEnabled?input=>workerControl(config.control_socket,'/genie-recover-worker',input,{channel:'gate_genie'}):null,predict:managementEnabled?input=>workerControl(config.control_socket,'/genie-predictor',input,{channel:'gate_genie'}):null,rebalance:managementEnabled?input=>workerControl(config.control_socket,'/genie-relocate-queued',input,{channel:'gate_genie'}):null});
  const stopGenieTunnel=genieTunnel(config.genie);
  const server = createDashboard(snapshot, path.join(here,'ui'), managementEnabled ? {
    read:()=>workerControl(config.control_socket,'/workers',undefined,{channel:'dashboard'}),
    act:(action,input)=>workerControl(config.control_socket,({add:'/add-worker',remove:'/remove-worker',drain:'/drain-workers',resume:'/resume-workers',fallbacks:'/set-ssh-fallbacks',context:'/set-context-limit','queue-timeout':'/set-queue-timeout',protection:'/set-protection',relocate:'/relocate-queued',recover:'/recover-worker','recovery-policy':'/recovery-policy','recovery-handback-policy':'/recovery-handback-policy','recovery-recheck':'/recovery-recheck',predictor:'/predictor'})[action],input,{channel:'dashboard'}),
  } : null,genie,()=>({...analytics.snapshot(),fleet_speed:fleetSpeed.snapshot(Date.now(),gateway?.workers?.map(worker=>worker.id)??[])}));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  await poll(); const interval = setInterval(poll, 2000), genieTimer=setInterval(()=>genie.tick(),10000);
  const close = () => { closed = true; clearInterval(interval);clearInterval(genieTimer);genie.close();hardware.close();stopGenieTunnel(); for (const t of timers) clearTimeout(t); for (const child of children) child.kill(); server.closeAllConnections(); server.close(); process.removeListener('SIGTERM', close); process.removeListener('SIGINT', close); };
  process.once('SIGTERM', close); process.once('SIGINT', close);
  console.log(`Dwarf Star Gate: http://127.0.0.1:${server.address().port} (${managementEnabled ? 'local worker controls' : 'read-only'})`);
  return { server, snapshot, close };
}
if (isMain(import.meta.url))
  runDashboard(process.argv[2]).catch(e => { console.error(e.message); process.exitCode = 1; });
