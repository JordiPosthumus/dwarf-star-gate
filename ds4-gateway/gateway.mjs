import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { RequestedThinkingObserver } from './requested-thinking.mjs';
import { Dataset } from './dataset.mjs';
import { clientMetadata, CLIENT_METADATA_HEADER } from './client-metadata.mjs';
import { EmbeddingCollector } from './embeddings.mjs';
import { RoutingShadow } from './routing-shadow.mjs';
import { GenerationFaultObserver, verifyGeneration } from './generation-health.mjs';
import { workerConfig, workerConfigs, assertUniqueWorker } from './worker-config.mjs';
import { Recovery } from './recovery.mjs';
import { loadConfig, isMain } from './config.mjs';
import { Predictor } from './predictor.mjs';
import { calibrationPreflight } from './calibration.mjs';
import { AgentControl } from './agent-control.mjs';
import {deadlineTimer,queueTimeout} from './deadline.mjs';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

const digest = value => createHash('sha256').update(value).digest('hex');
const validContext = value => Number.isSafeInteger(value) && value > 0;
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
      if (data.pool_context_length !== undefined && !validContext(data.pool_context_length)) throw new Error('Invalid saved pool context limit');
      if(data.queue_timeout_ms!==undefined){if(typeof data.queue_timeout_ms!=='number')throw new Error('Invalid saved queue allowance');queueTimeout(data.queue_timeout_ms);}
      if(data.quarantined!==undefined && (!data.quarantined || typeof data.quarantined!=='object' || Array.isArray(data.quarantined)))throw new Error('Invalid saved quarantine state');
      for(const entry of Object.values(data.quarantined??{}))if(!entry || !['fatal_accelerator_error','accelerator_checkpoint_failure','repeated_inference_failures'].includes(entry.reason) || typeof entry.request_id!=='string' || !Number.isFinite(Date.parse(entry.at)))throw new Error('Invalid saved quarantine entry');
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

// Buffers at most one SSE line to observe usage and semantic progress. Forwarded bytes are
// never decoded/re-encoded. No answer/reasoning text is logged.
export class UsageObserver {
  phase='awaiting_content';semanticCharacters=0;lastSemanticAt=null;
  thinkingCharacters=0;answerCharacters=0;toolCharacters=0;firstSemanticAt=null;
  pending = ''; usage = undefined; done = false; finish_reason = null;
  skipping = false; limited = false; failed = false; decoder = new StringDecoder('utf8');
  constructor(route='/v1/chat/completions'){this.route=route;}
  accept(chunk) {
    // Bound transient decoding even if accept receives one enormous chunk.
    // After overflow, discard through the actual newline, not just this chunk.
    for(let i=0;i<chunk.length;i+=4096) {
      const text=this.decoder.write(chunk.subarray(i,i+4096));
      for(const [j,part] of text.split('\n').entries()) {
        if(j) {if(!this.skipping)this.line();this.pending='';this.skipping=false;}
        if(!this.skipping) {
          if(this.pending.length+part.length>1048576){this.pending='';this.skipping=true;this.limited=true;}
          else this.pending+=part;
        }
      }
    }
  }
  line() {
    const line=this.pending.trim();
    if(!line.startsWith('data:'))return;
    const payload=line.slice(5).trim();
    if(payload==='[DONE]'){
      if(['/v1/chat/completions','/v1/completions'].includes(this.route))this.done=true;
      return;
    }
    try {
      const parsed=JSON.parse(payload),u=parsed.usage,reason=parsed.choices?.[0]?.finish_reason;
      const delta=parsed.choices?.[0]?.delta;
      const progress=(text,phase)=>{if(typeof text==='string'&&text.length){this.semanticCharacters+=text.length;this.lastSemanticAt=performance.now();this.firstSemanticAt??=this.lastSemanticAt;this.phase=phase;if(phase==='thinking')this.thinkingCharacters+=text.length;else if(phase==='answering')this.answerCharacters+=text.length;else if(phase==='tool_output')this.toolCharacters+=text.length;}};
      if(delta) {
        progress(delta.reasoning_content||delta.reasoning,'thinking');
        progress(delta.content,'answering');
        if(Array.isArray(delta.tool_calls))for(const call of delta.tool_calls)progress(call?.function?.arguments,'tool_output');
      } else if(parsed.type==='content_block_delta') {
        const d=parsed.delta;if(d?.type==='thinking_delta')progress(d.thinking,'thinking');
        else if(d?.type==='text_delta')progress(d.text,'answering');
        else if(d?.type==='input_json_delta')progress(d.partial_json,'tool_output');
      } else if(['response.output_text.delta','response.reasoning_summary_text.delta','response.reasoning_text.delta','response.function_call_arguments.delta'].includes(parsed.type)) {
        progress(parsed.delta,parsed.type.includes('reasoning')?'thinking':parsed.type.includes('arguments')?'tool_output':'answering');
      }
      const count=x=>Number.isFinite(x)&&x>=0?x:undefined;
      if(parsed.type==='error' || parsed.error)this.failed=true;
      if(this.route==='/v1/messages') {
        if(parsed.type==='message_stop')this.done=true;
        if(parsed.type==='message_delta')this.finish_reason=({end_turn:'stop',stop_sequence:'stop',tool_use:'tool_calls',max_tokens:'length'})[parsed.delta?.stop_reason]??null;
        // Anthropic usage has different cache accounting; leave it unknown
        // until its full start/delta contract is explicitly instrumented.
        return;
      }
      if(this.route==='/v1/responses') {
        if(['response.completed','response.incomplete','response.failed'].includes(parsed.type)) {
          const r=parsed.response;
          if(!r || !['completed','incomplete','failed'].includes(r.status))return;
          this.done=true;
          if(parsed.type==='response.failed' || r.status==='failed' || r.error)this.failed=true;
          else if(parsed.type==='response.completed' && r.status==='completed')this.finish_reason='stop';
          else if(['max_tokens','max_output_tokens'].includes(r.incomplete_details?.reason))this.finish_reason='length';
          else this.finish_reason=null;
          if(r.usage)this.usage={prompt_tokens:count(r.usage.input_tokens),completion_tokens:count(r.usage.output_tokens),cached_tokens:count(r.usage.input_tokens_details?.cached_tokens)};
        }
        return;
      }
      if(['stop','length','tool_calls','function_call','content_filter'].includes(reason))this.finish_reason=reason;
      if(u)this.usage={prompt_tokens:count(u.prompt_tokens),completion_tokens:count(u.completion_tokens),cached_tokens:count(u.prompt_tokens_details?.cached_tokens)};
    } catch { /* A telemetry failure must not affect inference. */ }
  }
}

export function createGateway(config) {
  if (!validContext(config.context_length)) throw new Error('Invalid configured pool context limit');
  const configuredQueueTimeout=queueTimeout(config.queue_timeout_ms);
  const initial = workerConfigs(config.nodes);
  const store = new AffinityStore(config.state_file);
  const queueTimeoutMs=()=>store.data.queue_timeout_ms??configuredQueueTimeout;
  // Like registered workers, an explicit UI setting survives process restarts.
  const contextLimit = () => store.data.pool_context_length ?? config.context_length;
  const makeNode = n => ({ ...n, drained: store.data.drained?.[n.id] === true, quarantine:store.data.quarantined?.[n.id] ?? null, inferenceFailures:0, healthy: false, failures: 0, active: null, queue: [], completed: 0, failed: 0, observationLimited:0, probing: false });
  let definitions;
  try { definitions = store.data.workers === undefined ? initial : workerConfigs(store.data.workers); }
  catch (e) { store.close(); throw e; }
  const nodes = definitions.map(makeNode);
  const dataset = new Dataset(path.join(path.dirname(config.state_file),'training'),{enabled:config.dataset_enabled===true});
  const predictor=new Predictor(dataset.enabled?config.predictor:null,{directory:path.join(path.dirname(config.state_file),'predictor'),dataDirectory:dataset.directory,record:(kind,row)=>dataset.record(kind,row)});
  dataset.onRecord=row=>predictor.observe(row);
  const shadow = new RoutingShadow({enabled:config.routing_shadow_enabled===true && config.dataset_enabled===true});
  const observe = fn => {if(shadow.enabled)try{return fn();}catch{shadow.state.errors++;}};
  let draining = false, shuttingDown = false, healthTimer, recoveryTimer, predictorTimer;
  let mutation = Promise.resolve();
  const serialize = fn => { const next = mutation.then(fn); mutation = next.catch(() => {}); return next; };
  const definition = n => Object.fromEntries(['id','url','ssh','remote_port','telemetry_service'].filter(k => n[k] !== undefined).map(k => [k,n[k]]));
  let recovery;
  try { recovery=new Recovery(config.recovery,{store,nodes,model:config.model,stopping:()=>shuttingDown||draining,log,
    reinstate:(n,expected,recoveryState)=>{
      if(n.removed || n.drained || n.active || n.queue.length || JSON.stringify(n.quarantine)!==JSON.stringify(expected) || shuttingDown || draining)throw new Error('reinstatement_state_changed');
      const quarantined={...store.data.quarantined};delete quarantined[n.id];
      store.save({...store.data,quarantined,recovery:recoveryState});
      n.quarantine=null;n.inferenceFailures=0;n.healthy=true;n.failures=0;
      observe(()=>shadow.reset(n.id));
    }}); } catch(e){store.close();throw e;}
  let agents;
  try {agents=new AgentControl({store,nodes,log,onPause:ids=>recovery.operatorPause(ids),canResume:async n=>{
    if(shuttingDown||draining)throw new Error('Gateway is draining; hold retained');
    await freshProbe(n);
    if(shuttingDown||draining||n.recovering||n.quarantine||n.probeError||!n.modelMatches||!validContext(n.contextLength)||n.contextLength<contextLimit())throw new Error('Fresh compatible worker readiness required; hold retained');
  }});}catch(e){store.close();throw e;}
  const embeddings=new EmbeddingCollector(dataset.enabled?config.embeddings:null,(kind,row)=>dataset.record(kind,row));
  dataset.state.embeddings=embeddings.state.enabled;
  const agent = new http.Agent({ keepAlive: true, maxSockets: 16 });
  const accepted = new Set(['POST /v1/chat/completions', 'POST /v1/completions', 'POST /v1/responses', 'POST /v1/messages', 'GET /v1/models']);
  const auth = Buffer.from(`Bearer ${config.api_key}`);
  const stats = () => ({ version: 1, agent_api_version:1, model: config.model, context_length: contextLimit(), queue_timeout_ms:queueTimeoutMs(), request_timeout_ms:config.request_timeout_ms??360000000, draining, dataset:{...dataset.snapshot(),embedding_collection:embeddings.snapshot()}, routing_shadow:shadow.snapshot(),recovery:recovery.status(),predictor:predictor.status(),
    calibration:calibrationPreflight(nodes,{draining}),
    total: nodes.length, healthy: nodes.filter(n => n.healthy).length, available: nodes.filter(n => n.healthy && !n.drained).length,
    active: nodes.filter(n => n.active).length, queued: nodes.reduce((s, n) => s + n.queue.length, 0),
    workers: nodes.map(n => ({ id: n.id, url: n.url, is_healthy: n.healthy, drained: n.drained, quarantine:n.quarantine, inference_failures:n.inferenceFailures,
      ...agents.pauseStatus(n.id),
      gateway_drained: n.drained && !n.active && !n.queue.length, load: Number(!!n.active),
      queued: n.queue.length, assigned_sessions: store.count(n.id), completed: n.completed, failed: n.failed, observation_limited:n.observationLimited,
      oldest_queue_seconds:n.queue.length?Math.max(0,(performance.now()-n.queue[0].createdMono)/1000):null,
      oldest_queue_remaining_seconds:n.queue.length?Math.max(0,(n.queue[0].queueTimeoutMs-(performance.now()-n.queue[0].createdMono))/1000):null,
      active_seconds: n.active ? Math.round((Date.now() - n.active.dispatched) / 1000) : 0,
      predictions:n.active?predictor.forecasts(n.active.id):null,
      requested_thinking: n.active?.thinking?.result ?? null,
      last_requested_thinking: n.lastThinking ?? null, last_request_finished_at: n.lastFinishedAt ?? null,
      context_length: n.contextLength ?? null,
      last_probe: n.lastProbe, probe_error: n.probeError })) });

  const briefJob = j => ({key:j.key,route:j.req.url,trafficClass:j.trafficClass});
  function candidate(n,key) {
    return {node:n.id,healthy:n.healthy,paused:n.drained,active:Number(!!n.active),queued:n.queue.length,
      assigned_sessions:store.count(n.id),context_length:n.contextLength,
      profile:digest(JSON.stringify({id:n.id,url:n.url,model:config.model,context:n.contextLength})),
      ...(observe(()=>({...shadow.timing(n.id,key,n.active),active_request_id:n.active?.id??null}))??{})};
  }
  function evaluateShadow(node,job,reason) {
    observe(()=>{
      if(job.cancelled || job.upstream)return;
      const sessionBusy=!!job.key && nodes.some(n=>n.active?.key===job.key || n.queue.some(j=>j!==job && j.key===job.key && !j.cancelled));
      const candidates=nodes.slice(0,128).map(n=>({...candidate(n,job.key),active_job:n.active?briefJob(n.active):null,
        ahead_jobs:n===node?n.queue.slice(0,n.queue.indexOf(job)).filter(j=>!j.cancelled).map(briefJob):[]}));
      const result=shadow.assess({job:briefJob(job),home:node.id,candidates,reason,
        waiting_ms:performance.now()-job.createdMono,session_busy:sessionBusy});
      dataset.record('routing_shadow',{request_id:job.id,node:node.id,session:job.key,...result,candidates_truncated:nodes.length>128});
    });
  }
  function evaluateWaiting() {
    // At most one head-of-line request per worker, 32 workers per free event.
    // This callback never reads/consumes queued uploads or changes ownership.
    if(shuttingDown)return;
    let count=0;
    for(const n of nodes)if(n.queue.length){if(count++>=32){shadow.state.skipped++;continue;}evaluateShadow(n,n.queue[0],'worker_free');}
  }

  function quarantine(node, reason, requestId) {
    if(node.quarantine)return;
    node.quarantine={reason,request_id:requestId,at:new Date().toISOString()};
    observe(()=>shadow.reset(node.id));
    node.healthy=false;
    try {store.save({...store.data,quarantined:{...store.data.quarantined,[node.id]:node.quarantine}});}
    catch {draining=true;log('quarantine_persistence_failed',{node:node.id});}
    log('worker_quarantined',{node:node.id,...node.quarantine});
  }

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
      job.queueTimer?.cancel();
      if (!node.healthy) { dataset.record('unavailable_before_dispatch',{request_id:job.id,node:node.id,total_ms:performance.now()-job.createdMono}); error(job.res, 503, 'home_unavailable', 'Assigned Spark became unavailable while queued; request was not dispatched.'); job.cleanup(); job.req.resume(); continue; }
      node.active = job;
      dispatch(node, job);
      return;
    }
  }
  function dispatch(node, job) {
    const { req, res } = job;
    job.dispatched = Date.now();
    job.dispatchedMono=performance.now();
    observe(()=>shadow.started(node.id,job.key));
    let requestBytes=0, firstBodyByte=null;
    const target = new URL(req.url, node.url);
    const headers = forwardHeaders(req.headers);
    delete headers[CLIENT_METADATA_HEADER]; // DSG hint only; never a DS4 setting.
    headers.host = target.host;
    headers['x-request-id'] = job.id;
    delete headers.expect;
    const observer = new UsageObserver(req.url);
    job.thinking = new RequestedThinkingObserver(req.headers['content-encoding'],(body,thinking)=>embeddings.observe(body,thinking,{request_id:job.id,node:node.id,route:req.url,traffic_class:job.trafficClass}));
    const observeBody = chunk => {requestBytes+=chunk.length;job.thinking.accept(chunk);};
    const bodyEnded = () => job.thinking.finish();
    let settled = false, response, faults;
    const progress=()=>{if(dataset.enabled && !settled && job.trafficClass!=='genie')dataset.record('progress',{request_id:job.id,node:node.id,
      active_elapsed_ms:performance.now()-job.dispatchedMono,phase:observer.phase,semantic_characters:observer.semanticCharacters,
      thinking_characters:observer.thinkingCharacters,answer_characters:observer.answerCharacters,tool_characters:observer.toolCharacters,
      semantic_age_ms:observer.lastSemanticAt===null?null:performance.now()-observer.lastSemanticAt,requested_thinking:job.thinking.result});};
    const progressTimer=dataset.enabled?setInterval(progress,30000):null;progressTimer?.unref();
    const finish = (outcome, detail) => {
      if (settled) return; settled = true;
      const fault=faults?.finish();
      if(fault){quarantine(node,fault,job.id);if(outcome==='complete')outcome='upstream_engine_error';}
      else if(!job.cancelled && ((outcome==='upstream_http_error' && detail>=500) || ['incomplete_sse','upstream_engine_error','upstream_error','upstream_stream_error','upstream_aborted','connection_closed'].includes(outcome))) {
        if(++node.inferenceFailures>=3)quarantine(node,'repeated_inference_failures',job.id);
      } else if(outcome==='complete')node.inferenceFailures=0;
      clearTimeout(job.deadline);
      clearInterval(progressTimer);
      req.off('data', observeBody); req.off('end', bodyEnded); job.thinking.dispose();
      node.lastThinking = job.thinking.result; node.lastFinishedAt = new Date().toISOString();
      if (outcome === 'complete') node.completed++; else if(outcome==='sse_observation_limited')node.observationLimited++;else node.failed++;
      log('request_finished', { request_id: job.id, node: node.id, session: job.key?.slice(0, 12), outcome,
        queue_ms: job.dispatched - job.created, elapsed_ms: Date.now() - job.dispatched,
        usage: observer.usage, sse_done: observer.done, requested_thinking: job.thinking.result, detail });
      dataset.record('finish',{request_id:job.id,node:node.id,outcome,queue_ms:job.dispatchedMono-job.createdMono,
        service_ms:performance.now()-job.dispatchedMono,total_ms:performance.now()-job.createdMono,first_body_byte_ms:firstBodyByte,
        request_bytes:requestBytes,usage:observer.usage,finish_reason:observer.finish_reason,requested_thinking:job.thinking.result,
        generation:{thinking_characters:observer.thinkingCharacters,answer_characters:observer.answerCharacters,tool_characters:observer.toolCharacters,first_semantic_ms:observer.firstSemanticAt===null?null:observer.firstSemanticAt-job.dispatchedMono}});
      observe(()=>shadow.finished(node.id,job.key,{outcome,finish_reason:observer.finish_reason,
        service_ms:performance.now()-job.dispatchedMono,usage:observer.usage,route:req.url,traffic_class:job.trafficClass}));
      job.cleanup();
      node.active = null;
      schedule(node);
      if(shadow.enabled)setImmediate(evaluateWaiting);
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
      faults=new GenerationFaultObserver(isSSE);
      if(isSSE || up.statusCode>=400)up.on('data',chunk=>faults.accept(chunk));
      up.once('data',()=>{firstBodyByte=performance.now()-job.dispatchedMono;});
      if(shadow.enabled)up.on('data',()=>{job.lastUpstreamByteMono=performance.now();});
      if (isSSE) up.on('data', chunk => observer.accept(chunk));
      up.on('error', e => { res.destroy(); finish(job.cancelled ? 'client_cancelled' : 'upstream_stream_error', e.code); });
      up.on('aborted', () => { res.destroy(); finish(job.cancelled ? 'client_cancelled' : 'upstream_aborted'); });
      up.on('end', () => finish(up.statusCode >= 400 ? 'upstream_http_error' : isSSE && observer.failed ? 'upstream_engine_error' : isSSE && !observer.done ? observer.limited ? 'sse_observation_limited' : 'incomplete_sse' : 'complete', up.statusCode));
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
    dataset.record('dispatch',{request_id:job.id,node:node.id,queue_ms:job.dispatchedMono-job.createdMono});
    progress();
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
    const admissionMetadata=clientMetadata(req.headers[CLIENT_METADATA_HEADER]);
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
    if (!node) {
      node=pick();
      // Existing homes and reassignment retain their established safety/cache
      // behavior. Only genuinely new conversations may use validated placement.
      if(node&&key&&!home&&req.method==='POST')node=predictor.choose(nodes.filter(n=>n.healthy&&!n.drained&&!n.quarantine),key,node,candidate);
    }
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
              model.context_length = contextLimit();
              if (model.top_provider) model.top_provider = { ...model.top_provider, context_length:contextLimit(),
                max_completion_tokens: Math.min(model.top_provider.max_completion_tokens ?? contextLimit(), contextLimit()) };
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
    const candidates=nodes.map(n=>candidate(n,key));
    try { if (key && home?.node !== node.id) store.set(key, node.id); }
    catch (e) { log('state_write_error', { error: e.message }); req.resume(); return error(res, 503, 'state_unavailable', 'Cannot durably record affinity; request was not dispatched'); }
    const job = { req, res, key, affinity, id: randomUUID(), created: Date.now(), createdMono:performance.now(), cancelled: false,queueTimeoutMs:queueTimeoutMs(),
      trafficClass:req.headers['x-dsg-observer']==='gate-genie'?'genie':'unclassified' };
    dataset.record('decision',{request_id:job.id,node:node.id,session:key,affinity,context_length:contextLimit(),candidates,
      traffic_class:job.trafficClass,client_metadata:admissionMetadata});
    const cancel = () => {
      if (res.writableFinished) return;
      job.cancelled = true;
      if (job.upstream) job.upstream.destroy();
      else {
        node.queue = node.queue.filter(j => j !== job);
        job.queueTimer?.cancel(); job.cleanup();
        log('queued_request_cancelled', { request_id: job.id, node: node.id });
        dataset.record('queued_cancel',{request_id:job.id,node:node.id,total_ms:performance.now()-job.createdMono});
      }
    };
    job.cleanup = () => { job.queueTimer?.cancel();req.off('aborted', cancel); res.off('close', cancel); req.off('error', cancel); };
    req.on('aborted', cancel); req.on('error', cancel); res.on('close', cancel);
    job.queueTimer = deadlineTimer(() => {
      node.queue = node.queue.filter(j => j !== job);
      error(res, 504, 'queue_timeout', 'Configured queue deadline reached; request was not dispatched');
      dataset.record('queue_timeout',{request_id:job.id,node:node.id,total_ms:performance.now()-job.createdMono});
      job.cleanup(); req.resume();
    }, job.queueTimeoutMs);
    node.queue.push(job);evaluateShadow(node,job,'admission');schedule(node);
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
        if (reason && reason !== 'model_or_context_mismatch') node.modelMatches=false;
        const was = node.healthy;
        if (ok) { node.failures = 0; node.healthy = !node.quarantine && !node.recovering; }
        else if (++node.failures >= (config.health_failures ?? 3)) node.healthy = false;
        if(was && !node.healthy)observe(()=>shadow.reset(node.id));
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
            node.modelMatches = res.statusCode === 200 && !!model;
            const previousContext=node.contextLength;
            node.contextLength = Number.isSafeInteger(model?.context_length) ? model.context_length : null;
            if(previousContext!==undefined && previousContext!==node.contextLength)observe(()=>shadow.reset(node.id));
            const ok = res.statusCode === 200 && !!model && node.contextLength >= contextLimit();
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
  const registry = () => ({ model: config.model, minimum_context: contextLimit(), context_limit_control:true,
    context_limit_source:store.data.pool_context_length === undefined ? 'config' : 'saved',
    queue_timeout_ms:queueTimeoutMs(),queue_timeout_control:true,queue_timeout_source:store.data.queue_timeout_ms!==undefined?'saved':config.queue_timeout_ms!==undefined?'config':'default',
    recovery:recovery.status(),
    workers: nodes.map(n => ({ ...definition(n), ...stats().workers.find(w => w.id === n.id),...agents.pauseStatus(n.id,{includeReason:true}) })) });
  async function freshProbe(node) {
    while (node.probing) await delay(10);
    await probe(node);
  }
  function setQueueTimeout(input){
    if(shuttingDown||draining)throw new Error('Gateway is draining');
    if(!input||Array.isArray(input)||Object.keys(input).sort().join(',')!=='expected_queue_timeout_ms,queue_timeout_ms'||!Number.isSafeInteger(input.queue_timeout_ms)||input.queue_timeout_ms<1)throw new Error('Specify a positive whole queue timeout and expected current value');
    if(input.expected_queue_timeout_ms!==queueTimeoutMs())throw new Error('Queue allowance changed; refresh before applying');
    const before=queueTimeoutMs();
    if(before===input.queue_timeout_ms&&store.data.queue_timeout_ms!==undefined)return registry();
    if(fs.existsSync(store.filename)){const backup=`${store.filename}.queue-${Date.now()}-${randomUUID()}.bak`;fs.copyFileSync(store.filename,backup,fs.constants.COPYFILE_EXCL);fs.chmodSync(backup,0o600);}
    store.save({...store.data,queue_timeout_ms:input.queue_timeout_ms});
    log('queue_allowance_changed',{before_ms:before,after_ms:queueTimeoutMs(),applies_to:'new_admissions'});
    return registry();
  }
  async function setContextLimit(input) {
    if (shuttingDown || draining) throw new Error('Gateway is draining');
    if (!input || Object.keys(input).some(k=>!['context_length','expected_context_length'].includes(k)) || !validContext(input.context_length)) throw new Error('Context limit must be a positive whole token count');
    if (input.expected_context_length !== contextLimit()) throw new Error('Pool context changed; refresh before applying');
    const enabled=nodes.filter(n=>!n.drained);
    if (!enabled.length) throw new Error('Enable at least one DS4 server before changing the pool context');
    await Promise.all(enabled.map(freshProbe));
    if (shuttingDown || draining) throw new Error('Gateway is draining');
    const incompatible=enabled.filter(n=>!n.modelMatches || !validContext(n.contextLength) || n.contextLength<input.context_length);
    if (incompatible.length) throw new Error(`Enabled servers unavailable or below requested context: ${incompatible.map(n=>n.id).join(', ')}`);
    const before=contextLimit();
    if (before === input.context_length && store.data.pool_context_length !== undefined) return registry();
    // Backup before the existing atomic, fsynced store commit. Never overwrite
    // worker registration or newer affinity assignments with a stale snapshot.
    if (fs.existsSync(store.filename)) {
      const backup=`${store.filename}.context-${Date.now()}-${randomUUID()}.bak`;
      fs.copyFileSync(store.filename,backup,fs.constants.COPYFILE_EXCL);fs.chmodSync(backup,0o600);
    }
    store.save({...store.data,pool_context_length:input.context_length});
    for (const n of enabled) {n.healthy=!n.quarantine&&!n.recovering;n.failures=0;n.probeError=undefined;}
    for (const n of nodes) if (!n.modelMatches || !validContext(n.contextLength) || n.contextLength<contextLimit()) {
      n.healthy=false;n.failures=config.health_failures ?? 3;
      n.probeError=n.probeError || 'model_or_context_mismatch';
    }
    log('pool_context_changed',{previous:before,context_length:contextLimit()});
    return registry();
  }
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
    // Registration proves compatibility, not recovery. A retained quarantine
    // must survive removal/re-add, but cannot make the recovery CLI unreachable.
    const compatible=()=>node.modelMatches && validContext(node.contextLength) && node.contextLength>=contextLimit() && !node.probeError;
    try {
      startTunnel(node);
      const until = Date.now() + (config.registration_timeout_ms ?? 15000);
      do {
        if (shuttingDown) throw new Error('Gateway is stopping');
        await probe(node);
        if (compatible()) break;
        if (!node.ssh || node.probeError === 'model_or_context_mismatch' || node.probeError === 'invalid_model_response') break;
        await delay(250);
      } while (Date.now() < until);
      if (shuttingDown) throw new Error('Gateway is stopping');
      if (!compatible()) throw new Error(`Compatibility check failed (${node.probeError || 'unavailable'}). Required model ${config.model}, context at least ${contextLimit()}; observed context ${node.contextLength ?? 'unknown'}.`);
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
    const agentControl=agents.forgetWorker(id);
    const next = nodes.filter(n => n !== node);
    const drained = { ...store.data.drained }; delete drained[id];
    store.save({...store.data,workers:next.map(definition),drained,agent_control:agentControl});
    nodes.splice(nodes.indexOf(node), 1);
    observe(()=>shadow.remove(id));
    node.removed = true; node.probeRequest?.destroy(); node.stopTunnel?.();
    // Keep session homes. Their next request can be durably reassigned normally.
    log('worker_removed', { node: id });
    return registry();
  }
  function drainNodes(ids, drained) {
    if (!Array.isArray(ids) || !ids.length || ids.some(id => !nodes.some(n => n.id === id))) throw new Error('Specify known worker IDs');
    store.save({...store.data,...agents.manualUpdate(ids,drained)});
    if(drained)recovery.operatorPause(ids);
    for (const n of nodes) if (ids.includes(n.id)) n.drained = drained;
    log('workers_drain_changed', { ids, drained });
    return stats();
  }
  // Operator-only Unix socket: never expose lifecycle mutation on the LAN.
  const control = config.control_socket ? http.createServer((req, res) => {
    const agentRoute=req.url?.startsWith('/agent/v1/');
    const actor=agentRoute?agents.authenticate(req.headers.authorization):null;
    if(agentRoute&&!actor)return error(res,401,'unauthorized','Valid agent credential required');
    if(!agentRoute&&req.headers.authorization)return error(res,403,'wrong_ingress','Agent credentials are accepted only on the versioned agent API');
    if(req.method==='GET'&&req.url==='/agent/v1/status')return json(res,200,agents.status(actor));
    if(req.method==='GET'&&req.url==='/agents')return json(res,200,agents.adminStatus());
    if (req.method === 'GET' && req.url === '/workers') return json(res, 200, registry());
    if (req.method !== 'POST' || !['/drain-workers', '/resume-workers', '/add-worker', '/remove-worker', '/set-context-limit','/set-queue-timeout','/recovery-policy','/recover-worker','/genie-recover-worker','/recovery-canary','/recovery-recheck','/predictor','/genie-predictor','/grant-agent','/revoke-agent','/release-agent-hold','/agent/v1/drain','/agent/v1/resume','/agent/v1/receipt'].includes(req.url)) return error(res, 404, 'not_found', 'Unknown control action');
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 4096) req.destroy(); });
    req.on('error', () => {});
    req.on('end', () => {
      void serialize(async () => {
        try {
          const input = JSON.parse(body);
          // Actor is revalidated after waiting for the shared mutation queue.
          if(agentRoute){agents.agent(actor);if(req.url==='/agent/v1/receipt')return json(res,200,agents.receipt(actor,input));return json(res,200,await agents.act(actor,req.url.endsWith('/drain')?'drain':'resume',input));}
          if(req.url==='/grant-agent')return json(res,201,agents.grant(input));
          if(req.url==='/revoke-agent')return json(res,200,agents.revoke(input));
          if(req.url==='/release-agent-hold')return json(res,200,agents.clearHold(input));
          if(['/predictor','/genie-predictor'].includes(req.url))return json(res,200,predictor.control(input,req.url==='/genie-predictor'?'genie':'operator'));
          if(req.url==='/recovery-recheck')return json(res,202,recovery.reconcile(input));
          if(req.url==='/recovery-policy') {
            if(Object.keys(input).length!==1 || !Object.hasOwn(input,'enabled'))throw new Error('Specify enabled only');
            return json(res,200,recovery.setAutomatic(input.enabled));
          }
          if(['/recover-worker','/genie-recover-worker','/recovery-canary'].includes(req.url))return json(res,202,recovery.request(input,req.url==='/genie-recover-worker'?'genie':'operator',{canary:req.url==='/recovery-canary'}));
          if (req.url === '/set-context-limit') return json(res,200,await setContextLimit(input));
          if (req.url === '/set-queue-timeout') return json(res,200,setQueueTimeout(input));
          if (req.url === '/add-worker') return json(res, 201, await addWorker(input.worker));
          if (req.url === '/remove-worker') return json(res, 200, removeWorker(input.id));
          if (req.url === '/resume-workers') {
            if (!Array.isArray(input.workers) || !input.workers.length || input.workers.some(id=>!nodes.some(n=>n.id===id))) throw new Error('Specify known worker IDs');
            const selected=nodes.filter(n=>input.workers.includes(n.id));
            agents.manualUpdate(input.workers,false); // Reject owned holds before probes.
            if(selected.some(n=>n.recovering))throw new Error('Recovery owns this worker; pause is allowed but wait before enabling');
            await Promise.all(selected.map(freshProbe));
            if (selected.some(n=>n.probeError || !validContext(n.contextLength) || n.contextLength<contextLimit())) throw new Error('Cannot enable a server without a fresh compatible model/context probe');
            const recovered=[];
            for(const n of selected.filter(n=>n.quarantine)) {
              if(n.active || n.queue.length)throw new Error('Wait for this worker to become idle before recovery verification');
              const proof=await verifyGeneration(n.url,config.model);
              if(shuttingDown || draining)throw new Error('Gateway is draining');
              recovered.push({node:n,proof});
            }
            const quarantined={...store.data.quarantined};
            for(const {node} of recovered)delete quarantined[node.id];
            // Commit a multi-worker resume once, after every requested check
            // passes. Partial verification must not partially enable a fleet.
            store.save({...store.data,quarantined,...agents.manualUpdate(input.workers,false)});
            for(const {node,proof} of recovered){node.quarantine=null;node.inferenceFailures=0;node.healthy=true;log('worker_recovery_verified',{node:node.id,...proof});}
            for(const n of selected)n.drained=false;
            log('workers_drain_changed',{ids:input.workers,drained:false});
            return json(res,200,stats());
          }
          json(res, 200, drainNodes(input.workers, req.url === '/drain-workers'));
        } catch (e) { error(res, e.status??400, e.code??'invalid_control_request', e.message); }
      });
    });
  }) : null;
  return {
    server, nodes, stats, store, drainNodes, registry,recovery,
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
      void recovery.tick();recoveryTimer=setInterval(()=>void recovery.tick(),30000);
      predictorTimer=setInterval(()=>predictor.tick(),60000);predictorTimer.unref?.();
      return server.address();
    },
    drain(value = true) { draining = value; log('drain_changed', { draining }); },
    async close() {
      if (shuttingDown) return;
      shuttingDown = true; draining = true;
      clearInterval(predictorTimer);predictor.close();
      clearInterval(recoveryTimer);await recovery.close();
      if (control) await new Promise(resolve => control.close(resolve));
      await new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); });
      clearInterval(healthTimer); agent.destroy(); store.close();embeddings.close(); await dataset.close();
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

if (isMain(import.meta.url)) {
  const {config} = loadConfig(process.argv[2]);
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
