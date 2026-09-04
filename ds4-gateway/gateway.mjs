import http from 'node:http';
import {HardwareSnapshot} from './hardware-snapshot.mjs';
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
import { workerConfig, workerConfigs, assertUniqueWorker, sshTargets, replaceSshFallbacks } from './worker-config.mjs';
import { Recovery } from './recovery.mjs';
import { classifySshFailure } from './recovery-transport.mjs';
import { loadConfig, isMain, gatewayPort, gatewayHost, continuityEnabled } from './config.mjs';
import { Predictor } from './predictor.mjs';
import { calibrationPreflight } from './calibration.mjs';
import { AgentControl } from './agent-control.mjs';
import {deadlineTimer,queueTimeout,queueTimeoutMessage} from './deadline.mjs';
import {CALL_ID_HEADER,DISPATCH_HEADER,validCallId,unavailableReason,sessionWork,rejectionReceipt} from './continuity.mjs';
import {JsonUsageObserver} from './json-usage.mjs';
import {dsgReport,invalidHttp} from './report.mjs';
import {ClientWatch,CLIENT_WATCH_HEADER,CLIENT_WATCH_ROUTE,validClientWatchId} from './client-watch.mjs';
import {JPEG_REJECTION_INSPECTION_BYTES,VisionProtection,visionGuidance,visionRejectionKind} from './vision-protection.mjs';
import {compareFallbackTieBreak,selectFallbackTieBreak} from './fallback-tiebreak.mjs';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

const digest = value => createHash('sha256').update(value).digest('hex');
const validContext = value => Number.isSafeInteger(value) && value > 0;
export const workerRegistrationTimeout=(config,node)=>config.registration_timeout_ms??Math.max(15000,sshTargets(node).length*15000);
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
function error(res, status, code, message) { json(res, status, { error: { type: 'gateway_error', code, message:dsgReport(message) } }); }

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
      if(data.protections!==undefined&&(!data.protections||typeof data.protections!=='object'||Array.isArray(data.protections)||Object.keys(data.protections).some(k=>k!=='vision_jpeg')||(data.protections.vision_jpeg!==undefined&&typeof data.protections.vision_jpeg!=='boolean')))throw new Error('Invalid saved protection state');
      if(data.operator_actions!==undefined&&(!Array.isArray(data.operator_actions)||data.operator_actions.length>256||data.operator_actions.some(action=>!action||typeof action!=='object'||!/^[a-f0-9-]{36}$/.test(action.id)||!['pause','resume'].includes(action.action)||!Array.isArray(action.workers)||!action.workers.length||action.workers.length>128||action.workers.some(id=>typeof id!=='string'||!/^[a-zA-Z0-9][\w-]{0,63}$/.test(id))||typeof action.control_channel!=='string'||!/^[a-z][a-z0-9_]{0,31}$/.test(action.control_channel)||typeof action.time!=='string'||!Number.isFinite(Date.parse(action.time)))))throw new Error('Invalid saved operator action history');
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
  eventBoundary = true; closed = false;
  constructor(route='/v1/chat/completions'){this.route=route;}
  accept(chunk) {
    if(this.closed)return;
    // Bound transient decoding even if accept receives one enormous chunk.
    // After overflow, discard through the actual newline, not just this chunk.
    for(let i=0;i<chunk.length;i+=4096) {
      const text=this.decoder.write(chunk.subarray(i,i+4096));
      for(const [j,part] of text.split('\n').entries()) {
        if(j) {
          if(!this.skipping){const blank=this.pending.trim().length===0;this.line();this.eventBoundary=blank;}
          else this.eventBoundary=false;
          this.pending='';this.skipping=false;
        }
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
  finishState() {
    if(!this.closed){
      const tail=this.decoder.end();this.closed=true;
      if(tail&&!this.skipping){
        if(this.pending.length+tail.length>1048576){this.pending='';this.skipping=true;this.limited=true;}
        else this.pending+=tail;
      }
    }
    if(this.failed)return 'engine_error';
    if(this.done)return 'terminal';
    if(this.limited)return 'observation_limited';
    if(this.skipping||this.pending.length>0||!this.eventBoundary)return 'partial_sse_event';
    return 'clean_eof_no_terminal';
  }
}

export function createGateway(config,{visionTranscode}={}) {
  if (!validContext(config.context_length)) throw new Error('Invalid configured pool context limit');
  const configuredQueueTimeout=queueTimeout(config.queue_timeout_ms);
  const initial = workerConfigs(config.nodes);
  const store = new AffinityStore(config.state_file);
  const queueTimeoutMs=()=>store.data.queue_timeout_ms??configuredQueueTimeout;
  // Like registered workers, an explicit UI setting survives process restarts.
  const contextLimit = () => store.data.pool_context_length ?? config.context_length;
  const makeNode = n => ({ ...n, drained: store.data.drained?.[n.id] === true, quarantine:store.data.quarantined?.[n.id] ?? null, inferenceFailures:0, healthy: false, failures: 0, active: null, queue: [], completed: 0, failed: 0, protected:0, observationLimited:0, probing: false, healthProbeDeferred:0,
    managementPath:n.ssh?{transport:'ssh_tunnel',state:'pending',reason:null,attempts:0,route_count:sshTargets(n).length,changed_at:new Date().toISOString(),last_verified_at:null}:{transport:'local',state:'local',reason:null,attempts:0,route_count:0,changed_at:new Date().toISOString(),last_verified_at:null} });
  let definitions;
  try { definitions = store.data.workers === undefined ? initial : workerConfigs(store.data.workers); }
  catch (e) { store.close(); throw e; }
  const nodes = definitions.map(makeNode);
  const dataset = new Dataset(path.join(path.dirname(config.state_file),'training'),{enabled:config.dataset_enabled===true});
  const hardwareSnapshot=config.hardware_telemetry?.enabled===true?new HardwareSnapshot(path.join(path.dirname(config.state_file),'dashboard','hardware-current.json')):null;
  const predictor=new Predictor(dataset.enabled?config.predictor:null,{directory:path.join(path.dirname(config.state_file),'predictor'),dataDirectory:dataset.directory,record:(kind,row)=>dataset.record(kind,row)});
  dataset.onRecord=row=>predictor.observe(row);
  const shadow = new RoutingShadow({enabled:config.routing_shadow_enabled===true && config.dataset_enabled===true});
  const observe = fn => {if(shadow.enabled)try{return fn();}catch{shadow.state.errors++;}};
  let draining = false, shuttingDown = false, healthTimer, recoveryTimer, predictorTimer, waitingTimer;
  const startup={barrier:continuityEnabled(config),complete:false,started_at:new Date().toISOString(),completed_at:null,unavailable:[]};
  // Undispatched HTTP requests only. Bodies remain on their original streams,
  // with backpressure; no prompt spool and no optimistic 200/SSE response.
  const waiting=[];
  let sequence=0;
  const relocation={completed:0,rejected:0,last:null};
  // This may influence only genuinely new/unaffined work, where no established
  // cache home exists. It still abstains unless every tied worker has fresh
  // forecasts from the deployed, independently validated models.
  const fallbackTieBreak={schema:1,mode:'active_with_abstention',policy:'validated_remaining_tiebreak',evaluations:0,comparable:0,would_change:0,applied:0,insufficient_evidence:0,errors:0,last:null};
  const queueBound=()=>config.max_queued_per_node??128;
  const waitingBound=()=>Math.max(1,nodes.length)*queueBound();
  // Long affinity-bound waits must not depend on the dashboard/Genie process.
  // The warm home gets first refusal, then the core may trade unknown cache
  // locality for a truly empty compatible server. `false` keeps strict affinity.
  const automaticAffinityWait=config.automatic_affinity_rebalance_min_wait_ms===false?null:(config.automatic_affinity_rebalance_min_wait_ms??300000);
  if(automaticAffinityWait!==null&&(!Number.isSafeInteger(automaticAffinityWait)||automaticAffinityWait<0))throw new Error('automatic_affinity_rebalance_min_wait_ms must be false or a non-negative whole millisecond count');
  const automaticRelocationScope=automaticAffinityWait===null?'first_dsg_request_or_unaffined':'first_unaffined_or_affinity_wait_expired';
  const parkedFor=n=>waiting.filter(j=>j.fixedHome===n);
  const rejections=[];
  const clientWatch=new ClientWatch();
  function reject(req,res,status,code,message,{id=randomUUID(),callId=validCallId(req.headers[CALL_ID_HEADER]),key=null,node=null,reason}={}){
    const receipt=rejectionReceipt({request_id:id,call_id:callId,session:key,node:node?.id??null,code,reason});
    const recorded={time:new Date().toISOString(),...receipt};
    rejections.unshift(recorded);rejections.length=Math.min(rejections.length,32);
    clientWatch.observeRequest(req.headers[CLIENT_WATCH_HEADER],id,'rejected');
    log('request_rejected',receipt);dataset.record('rejection',receipt);
    if(!res.headersSent&&!res.destroyed){res.setHeader(DISPATCH_HEADER,'not_dispatched');res.setHeader('x-request-id',id);res.setHeader('retry-after','5');}
    json(res,status,{error:{type:'gateway_error',code,message:dsgReport(message),request_id:id,continuity:receipt}});
    req.resume();
  }
  let mutation = Promise.resolve();
  const serialize = fn => { const next = mutation.then(fn); mutation = next.catch(() => {}); return next; };
  const definition = n => Object.fromEntries(['id','url','ssh','ssh_fallbacks','remote_port','telemetry_service'].filter(k => n[k] !== undefined).map(k => [k,n[k]]));
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
  try {agents=new AgentControl({store,nodes,log,onPause:ids=>recovery.operatorPause(ids),canHandback:async n=>recovery.profileHandbackOffer(n,{ignorePause:true}),onHandback:()=>void recovery.tick(),canResume:async n=>{
    if(shuttingDown||draining)throw new Error('Gateway is draining; hold retained');
    await freshProbe(n);
    if(shuttingDown||draining||n.recovering||n.quarantine||n.probeError||!n.modelMatches||!validContext(n.contextLength)||n.contextLength<contextLimit())throw new Error('Fresh compatible worker readiness required; hold retained');
  }});}catch(e){store.close();throw e;}
  const embeddings=new EmbeddingCollector(dataset.enabled?config.embeddings:null,(kind,row)=>dataset.record(kind,{...row,hardware:hardwareSnapshot?.get(row.node)??null}));
  const visionProtection=new VisionProtection(config.vision_compatibility,store,path.dirname(config.state_file),visionTranscode?{transcode:visionTranscode}:undefined);
  dataset.state.embeddings=embeddings.state.enabled;
  const agent = new http.Agent({ keepAlive: true, maxSockets: 16 });
  const accepted = new Set(['POST /v1/chat/completions', 'POST /v1/completions', 'POST /v1/responses', 'POST /v1/messages', 'GET /v1/models']);
  const auth = Buffer.from(`Bearer ${config.api_key}`);
  const lastOperatorAction=id=>[...(store.data.operator_actions??[])].reverse().find(action=>action.workers.includes(id))??null;
  const stats = () => ({ version: 1, agent_api_version:1, maintenance_lock_version:1,client_watch_version:1,client_watch:clientWatch.snapshot(), model: config.model, context_length: contextLimit(), queue_timeout_ms:queueTimeoutMs(), request_timeout_ms:config.request_timeout_ms??360000000, draining,startup:{...startup}, dataset:{...dataset.snapshot(),embedding_collection:embeddings.snapshot()}, routing_shadow:shadow.snapshot(),fallback_tiebreak_shadow:{...fallbackTieBreak},recovery:recovery.status(),predictor:predictor.status(),protections:visionProtection.status(),
    calibration:calibrationPreflight(nodes,{draining}),continuity:{schema:1,recent_rejections:rejections.slice(0,20),safe_retry_contract:true,queued_relocation:true,automatic_relocation:true,automatic_relocation_scope:automaticRelocationScope,automatic_affinity_rebalance_min_wait_ms:automaticAffinityWait,patient_wait:true,
      relocation:{completed:relocation.completed,rejected:relocation.rejected,offers:relocationOffers().length,genie_enabled:config.genie_load_balancing!==false,genie_offers:genieRelocationOffers(),diagnostics:relocationDiagnostics(),last:relocation.last},
      waiting:waiting.length,oldest_wait_seconds:waiting.length?Math.max(0,(performance.now()-waiting[0].createdMono)/1000):null,
      waiting_reasons:Object.fromEntries([...new Set(waiting.map(j=>j.waitReason))].map(reason=>[reason,waiting.filter(j=>j.waitReason===reason).length]))},
    total: nodes.length, healthy: nodes.filter(n => n.healthy).length, available: nodes.filter(n => n.healthy && !n.drained).length,
    active: nodes.filter(n => n.active).length, queued: waiting.length+nodes.reduce((s, n) => s + n.queue.length, 0),
    workers: nodes.map(n => ({ id: n.id, url: n.url, is_healthy: n.healthy, drained: n.drained, quarantine:n.quarantine, inference_failures:n.inferenceFailures,
      ...agents.pauseStatus(n.id),last_operator_action:lastOperatorAction(n.id),
      gateway_drained: n.drained && !n.active && !n.queue.length, load: Number(!!n.active),
      queued: n.queue.length, recovery_waiting:parkedFor(n).length, assigned_sessions: store.count(n.id), completed: n.completed, failed: n.failed, protected:n.protected, observation_limited:n.observationLimited,
      oldest_queue_seconds:n.queue.length?Math.max(0,(performance.now()-n.queue[0].createdMono)/1000):null,
      oldest_queue_remaining_seconds:n.queue.length?Math.max(0,(n.queue[0].queueTimeoutMs-(performance.now()-n.queue[0].createdMono))/1000):null,
      active_seconds: n.active ? Math.round((Date.now() - n.active.dispatched) / 1000) : 0,
      predictions:n.active?predictor.forecasts(n.active.id):null,
      requested_thinking: n.active?.thinking?.result ?? null,
      last_requested_thinking: n.lastThinking ?? null, last_request_finished_at: n.lastFinishedAt ?? null,
      context_length: n.contextLength ?? null,
      health_probe_deferred:n.healthProbeDeferred,
      health_state_source:n.probeError==='busy_probe_deferred'?'recent_upstream_progress':'model_probe',
      management_path:{...n.managementPath},
      last_probe: n.lastProbe, probe_error: n.probeError })) });

  const briefJob = j => ({key:j.key,route:j.req.url,trafficClass:j.trafficClass});
  function candidate(n,key) {
    return {node:n.id,healthy:n.healthy,paused:n.drained,active:Number(!!n.active),queued:n.queue.length,
      assigned_sessions:store.count(n.id),context_length:n.contextLength,hardware:hardwareSnapshot?.get(n.id)??null,
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

  const eligibleDestination=n=>n.healthy&&!n.drained&&!n.quarantine&&!n.recovering&&!n.removed&&!n.active&&n.queue.length===0;
  function conflictingSessionWork(job) {
    if(!job.key)return null;
    for(const node of nodes)if(node.active?.key===job.key)return {node,reason:'same_session_active'};
    for(const node of nodes)if(node.queue.some(other=>other!==job&&!other.cancelled&&other.key===job.key))return {node,reason:'same_session_queued'};
    if(waiting.some(other=>other!==job&&!other.cancelled&&other.key===job.key))return {node:null,reason:'same_session_waiting'};
    return null;
  }
  const relocationEvidence=(job,source,destination)=>digest(['queue-relocation-v1',job.id,source.id,destination.id,job.sequence,job.created].join('\0'));
  function relocationDecision(source,idle) {
    const job=source.queue.find(candidate=>!candidate.cancelled);
    if(!job)return null;
    let reason='offer_ready',conflict=null;
    if(!source.active)reason='source_not_active';
    else if(source.queue[0]!==job)reason='cancelled_queue_head';
    else if(job.upstream||job.dispatched)reason='already_dispatched';
    else if((conflict=conflictingSessionWork(job)))reason=conflict.reason;
    const destination=idle.find(node=>node!==source);
    if(reason==='offer_ready'&&!destination)reason='no_idle_destination';
    const home=job.key&&store.get(job.key);
    if(reason==='offer_ready'&&job.key&&home?.node!==source.id)reason='durable_home_mismatch';
    return {source,job,destination:reason==='offer_ready'?destination:null,reason,conflict};
  }
  function relocationDiagnostics() {
    const idle=nodes.filter(eligibleDestination).sort((a,b)=>store.count(a.id)-store.count(b.id)||a.id.localeCompare(b.id));
    const gateway_reason=shuttingDown?'gateway_stopping':draining?'gateway_draining':null;
    const sources=[];
    for(const source of nodes){
      const decision=relocationDecision(source,idle);if(!decision)continue;
      const {job,destination,reason,conflict}=decision,waiting_seconds=Math.max(0,(performance.now()-job.createdMono)/1000);
      const automatic_reason=gateway_reason??(reason!=='offer_ready'?reason:['new','none'].includes(job.affinity)?'automatic_ready':automaticAffinityWait===null?'affinity_automatic_disabled':waiting_seconds<automaticAffinityWait/1000?'automatic_wait_threshold':'automatic_ready');
      const minimum=(config.genie_rebalance_min_wait_ms??60000)/1000;
      const genie_reason=gateway_reason??(reason!=='offer_ready'?reason:config.genie_load_balancing===false?'genie_disabled':waiting_seconds<minimum?'genie_wait_threshold':'genie_offer_ready');
      sources.push({source:source.id,request_id:job.id,affinity:job.affinity,waiting_seconds,reason:gateway_reason??reason,
        destination:gateway_reason?null:destination?.id??null,conflicting_worker:conflict?.node?.id??null,automatic_reason,genie_reason});
      if(sources.length>=32)break;
    }
    return {schema:1,gateway_reason,idle_destinations:idle.map(node=>node.id).slice(0,32),sources,truncated:nodes.some(node=>node.queue.some(job=>!job.cancelled))&&sources.length>=32};
  }
  function relocationOffers() {
    if(shuttingDown||draining)return [];
    const idle=nodes.filter(eligibleDestination).sort((a,b)=>store.count(a.id)-store.count(b.id)||a.id.localeCompare(b.id));
    if(!idle.length)return [];
    const offers=[];
    for(const source of nodes) {
      const decision=relocationDecision(source,idle);if(!decision||decision.reason!=='offer_ready')continue;
      const {job,destination}=decision;
      offers.push({schema:1,evidence_id:relocationEvidence(job,source,destination),request_id:job.id,source:source.id,destination:destination.id,
        waiting_seconds:Math.max(0,(performance.now()-job.createdMono)/1000),source_active_seconds:source.active?Math.max(0,(performance.now()-source.active.dispatchedMono)/1000):null,
        source_remaining_prediction:source.active?predictor.forecasts(source.active.id)?.remaining??null:null,
        affinity:job.affinity,cache_locality:'unknown',destination_immediately_free:true,automatic:false});
    }
    return offers.slice(0,32);
  }
  function genieRelocationOffers(){
    if(config.genie_load_balancing===false)return [];
    const minimum=(config.genie_rebalance_min_wait_ms??60000)/1000;
    if(!Number.isFinite(minimum)||minimum<0)throw new Error('genie_rebalance_min_wait_ms must be non-negative');
    return relocationOffers().filter(offer=>offer.waiting_seconds>=minimum).slice(0,8);
  }
  function relocateQueued(input,actor='operator') {
    const keys=Object.keys(input??{}).sort().join(',');
    if(keys!=='destination,evidence_id,request_id,source'||!validCallId(input.request_id)||!/^[a-f0-9]{64}$/.test(input.evidence_id)||
      !/^[\w-]{1,64}$/.test(input.source)||!/^[\w-]{1,64}$/.test(input.destination))throw new Error('Specify one current queued-handover offer exactly');
    const source=nodes.find(n=>n.id===input.source),destination=nodes.find(n=>n.id===input.destination),job=source?.queue[0];
    const rejectMove=message=>{relocation.rejected++;throw new Error(message);};
    if(!source||!destination||source===destination||!job||job.id!==input.request_id)return rejectMove('Queued-handover offer is stale; refresh before retrying');
    if(job.cancelled||job.upstream||job.dispatched||!source.active||!eligibleDestination(destination))return rejectMove('Queued-handover state changed; request was left in place');
    if(relocationEvidence(job,source,destination)!==input.evidence_id)return rejectMove('Queued-handover evidence changed; request was left in place');
    if(conflictingSessionWork(job))return rejectMove('Same-session work prevents a safe handover; request was left in place');
    const home=job.key&&store.get(job.key);
    if(job.key&&home?.node!==source.id)return rejectMove('Durable session ownership changed; request was left in place');
    // Persist the new conversation owner before changing in-memory queue
    // ownership. A failed fsync leaves the original queue and client intact.
    try {if(job.key)store.set(job.key,destination.id);}catch{
      log('queue_relocation_persistence_failed',{request_id:job.id,source:source.id,destination:destination.id});
      return rejectMove('Durable handover failed; request remains queued on its original server');
    }
    source.queue.shift();job.node=destination;job.affinity='rebalanced';destination.queue.push(job);
    const receipt={schema:1,request_id:job.id,source:source.id,destination:destination.id,actor,waiting_ms:performance.now()-job.createdMono,
      dispatch_state:'not_dispatched',body_replayed:false,deadline_preserved:true,cache_locality:'unknown'};
    relocation.completed++;relocation.last={...receipt,time:new Date().toISOString()};
    log('queued_request_relocated',receipt);dataset.record('queue_relocation',{...receipt,node:destination.id});
    schedule(destination);evaluateWaiting();
    return {state:'relocated',...receipt};
  }
  function rebalanceUndispatched() {
    const offer=relocationOffers().filter(candidate=>{
      const job=nodes.find(node=>node.id===candidate.source)?.queue[0];
      return job&&(['new','none'].includes(job.affinity)||(automaticAffinityWait!==null&&candidate.waiting_seconds*1000>=automaticAffinityWait));
    }).sort((a,b)=>b.waiting_seconds-a.waiting_seconds||a.source.localeCompare(b.source))[0];
    if(!offer)return;
    try {relocateQueued({request_id:offer.request_id,source:offer.source,destination:offer.destination,evidence_id:offer.evidence_id},'scheduler');}
    catch{/* Exact-offer revalidation failed; the untouched request remains queued. */}
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
  function evaluateFallbackTieBreak(selected,requestId) {
    const eligible=nodes.filter(n=>n.healthy&&!n.drained&&!n.quarantine&&!n.recovering&&!n.removed);
    const result=compareFallbackTieBreak(eligible,selected,id=>predictor.forecasts(id));
    fallbackTieBreak.evaluations++;
    if(['would_keep','would_change'].includes(result.verdict))fallbackTieBreak.comparable++;
    if(result.verdict==='would_change')fallbackTieBreak.would_change++;
    if(result.verdict==='insufficient_evidence')fallbackTieBreak.insufficient_evidence++;
    fallbackTieBreak.last={...result,request_id:requestId,applied:false};
    return result;
  }
  function applyFallbackTieBreak(selected,requestId) {
    const result=evaluateFallbackTieBreak(selected,requestId);
    const alternative=selectFallbackTieBreak(nodes,selected,result);
    const applied=alternative!==selected;if(applied)fallbackTieBreak.applied++;
    fallbackTieBreak.last.applied=applied;
    dataset.record('routing_tiebreak_shadow',{request_id:requestId,node:selected.id,...result,applied});
    return alternative;
  }
  function detach(job) {
    if(job.node)job.node.queue=job.node.queue.filter(j=>j!==job);
    const i=waiting.indexOf(job);if(i>=0)waiting.splice(i,1);
  }
  function park(job,node,reason) {
    if(job.upstream)throw new Error('Cannot park dispatched work');
    detach(job);
    // Previously admitted work keeps its home. No cache migration or replay.
    if(node)job.fixedHome=node;
    job.node=null;job.waitReason=reason;
    if(shuttingDown){reject(job.req,job.res,503,'draining','Gateway is stopping; the recovery-waiting request was not dispatched.',{...job,node:job.fixedHome,reason:'gateway_draining'});job.cleanup();return;}
    waiting.push(job);waiting.sort((a,b)=>a.sequence-b.sequence);
    clientWatch.observeRequest(job.watchId,job.id,'queued');
    heartbeat(job);
    log('request_waiting',{request_id:job.id,node:job.fixedHome?.id??null,reason,dispatch_state:'not_dispatched'});
    dataset.record('waiting',{request_id:job.id,node:job.fixedHome?.id??null,reason,total_ms:performance.now()-job.createdMono});
  }
  function admit(job,node) {
    const home=job.key&&store.get(job.key);
    const wasAdmitted=job.recordedDecision===true;
    const candidates=job.recordedDecision?null:nodes.map(n=>candidate(n,job.key));
    try {if(job.key&&home?.node!==node.id)store.set(job.key,node.id);}
    catch(e){
      detach(job);log('state_write_error',{error:e.message});
      reject(job.req,job.res,503,'state_unavailable','Cannot durably record affinity; request was not dispatched',{...job,node,reason:'affinity_write_failed'});job.cleanup();return;
    }
    detach(job);job.node=node;
    if(!job.recordedDecision){
      dataset.record('decision',{request_id:job.id,call_id:job.callId,node:node.id,session:job.key,affinity:job.affinity,context_length:contextLimit(),candidates,
        traffic_class:job.trafficClass,client_metadata:job.admissionMetadata,admission_wait_ms:performance.now()-job.createdMono});
      job.recordedDecision=true;job.admissionMetadata=null;
    }
    if(job.waitReason)log('request_wait_resumed',{request_id:job.id,node:node.id,wait_ms:performance.now()-job.createdMono});
    job.waitReason=null;
    node.queue.push(job);node.queue.sort((a,b)=>a.sequence-b.sequence);
    clientWatch.observeRequest(job.watchId,job.id,'queued');
    evaluateShadow(node,job,wasAdmitted?'worker_free':'admission');schedule(node);
  }
  function pumpWaiting() {
    if(shuttingDown)return;
    for(const n of nodes)for(const job of n.queue)heartbeat(job);
    // Retain FIFO within each conversation; independent conversations can proceed.
    for(const job of [...waiting]){
      if(job.cancelled)continue;
      heartbeat(job);
      if(job.key&&waiting.some(j=>j!==job&&j.sequence<job.sequence&&j.key===job.key)){job.waitReason='same_session_queued';continue;}
      const home=job.key&&store.get(job.key),outstanding=sessionWork(nodes,job.key);
      let node=job.fixedHome??(home&&nodes.find(n=>n.id===home.node));
      if(job.fixedHome){
        if(node.removed||!node.healthy||node.drained||node.quarantine||node.recovering){job.waitReason=unavailableReason(node);continue;}
        if(outstanding&&outstanding.node!==node){job.waitReason=outstanding.reason;continue;}
      }else{
        if(node&&(!node.healthy||node.drained||node.quarantine||node.recovering)){
          if(outstanding){job.waitReason=outstanding.reason;continue;}
          node=pick(node.id);job.affinity='reassigned';
        }
        if(!node)node=pick();
        if(!node){job.waitReason='no_ready_worker';continue;}
        if(outstanding&&outstanding.node!==node){job.waitReason=outstanding.reason;continue;}
      }
      if(node.queue.length>=queueBound()){job.waitReason='queue_full';continue;}
      admit(job,node);
    }
    rebalanceUndispatched();
  }
  function heartbeat(job) {
    // A standard informational response, NOT final 200/SSE headers. This lets
    // TCP surface disconnects even when a large upload is backpressured and EOF
    // is behind unread bytes. Clients must still set their own HTTP deadlines.
    if(job.res.destroyed||job.res.headersSent||job.cancelled)return;
    const now=performance.now();
    if(job.lastHeartbeat!==undefined&&now-job.lastHeartbeat<5000)return;
    job.lastHeartbeat=now;
    try{job.res.writeProcessing();}catch{job.res.destroy();}
  }
  function schedule(node) {
    if (node.active) return;
    while (node.queue.length) {
      const job = node.queue.shift();
      if (job.cancelled) continue;
      if (!node.healthy || node.quarantine || node.recovering) { park(job,node,unavailableReason(node)); continue; }
      job.queueTimer?.cancel();
      node.active = job;
      dispatch(node, job);
      return;
    }
  }
  function dispatch(node, job) {
    const { req, res } = job;
    job.dispatched = Date.now();
    job.dispatchedMono=performance.now();
    clientWatch.observeRequest(job.watchId,job.id,'dispatched');
    observe(()=>shadow.started(node.id,job.key));
    let requestBytes=0, firstBodyByte=null;
    const captureLimit=visionProtection.captureLimit(req.url,req.headers['content-encoding']);
    let captureChunks=[],captureBytes=0,captureOverflow=false,captureResolved=false,resolveCapture;
    const bodyReady=new Promise(resolve=>{resolveCapture=resolve;});
    const finishCapture=value=>{if(captureResolved)return;captureResolved=true;resolveCapture(value);};
    const target = new URL(req.url, node.url);
    const headers = forwardHeaders(req.headers);
    // The bearer credential authenticates callers to DSG. Stock DS4 workers
    // are intentionally unauthenticated behind loopback or an SSH tunnel, so
    // the ingress secret must never cross the worker boundary.
    delete headers.authorization;
    delete headers[CLIENT_METADATA_HEADER]; // DSG hint only; never a DS4 setting.
    delete headers[CALL_ID_HEADER];
    delete headers[CLIENT_WATCH_HEADER]; // Ephemeral client liveness hint; never DS4 input.
    headers.host = target.host;
    headers['x-request-id'] = job.id;
    delete headers.expect;
    const observer = new UsageObserver(req.url);
    job.thinking = new RequestedThinkingObserver(req.headers['content-encoding'],(body,thinking)=>{
      job.requestStream=typeof body?.stream==='boolean'?body.stream:null;
      job.requestedUsage=typeof body?.stream_options?.include_usage==='boolean'?body.stream_options.include_usage:null;
      embeddings.observe(body,thinking,{request_id:job.id,node:node.id,route:req.url,traffic_class:job.trafficClass,request_bytes:requestBytes});
    });
    const observeBody = chunk => {
      requestBytes+=chunk.length;job.thinking.accept(chunk);
      if(captureLimit&&!captureOverflow){
        if(captureBytes+chunk.length<=captureLimit){captureChunks.push(chunk);captureBytes+=chunk.length;}
        else{captureOverflow=true;captureChunks=[];}
      }
    };
    const bodyEnded = () => {
      job.thinking.finish();
      const body=captureLimit&&!captureOverflow?Buffer.concat(captureChunks,captureBytes):null;
      captureChunks=[];finishCapture(body);
    };
    const bodyAborted=()=>{captureChunks=[];finishCapture(null);};
    let settled = false, response, faults,jsonUsage,responseFormat='no_response',clientStatus=null;
    const progress=()=>{if(dataset.enabled && !settled && job.trafficClass!=='genie')dataset.record('progress',{request_id:job.id,node:node.id,
      active_elapsed_ms:performance.now()-job.dispatchedMono,hardware:hardwareSnapshot?.get(node.id)??null,phase:observer.phase,semantic_characters:observer.semanticCharacters,
      thinking_characters:observer.thinkingCharacters,answer_characters:observer.answerCharacters,tool_characters:observer.toolCharacters,
      semantic_age_ms:observer.lastSemanticAt===null?null:performance.now()-observer.lastSemanticAt,requested_thinking:job.thinking.result});};
    const progressTimer=dataset.enabled?setInterval(progress,30000):null;progressTimer?.unref();
    const finish = (outcome, detail, observedStreamEnd=null) => {
      if (settled) return; settled = true;
      const streamEnd=responseFormat==='sse'?(observedStreamEnd??observer.finishState()):null;
      const jsonMetadata=jsonUsage?.finish();
      if(jsonMetadata){observer.usage=jsonMetadata.usage??undefined;observer.finish_reason=jsonMetadata.finish_reason??null;}
      const usageObservation=jsonMetadata?.status??(responseFormat!=='sse'?'unsupported_format':!observer.usage?'not_reported':observer.usage.prompt_tokens!=null&&observer.usage.completion_tokens!=null?'observed':'partial');
      const fault=faults?.finish();
      if(fault){quarantine(node,fault,job.id);if(outcome==='complete')outcome='upstream_engine_error';}
      else if(!job.cancelled && ((outcome==='upstream_http_error' && detail>=500) || ['incomplete_sse','upstream_engine_error','upstream_error','upstream_stream_error','upstream_aborted','connection_closed'].includes(outcome))) {
        if(++node.inferenceFailures>=3)quarantine(node,'repeated_inference_failures',job.id);
      } else if(outcome==='complete')node.inferenceFailures=0;
      clearTimeout(job.deadline);
      clearInterval(progressTimer);
      req.off('data', observeBody);req.off('end',bodyEnded);req.off('aborted',bodyAborted);req.off('error',bodyAborted);job.thinking.dispose();
      captureChunks=[];finishCapture(null);
      node.lastThinking = job.thinking.result; node.lastFinishedAt = new Date().toISOString();
      if (outcome === 'complete') node.completed++; else if(outcome==='vision_guidance')node.protected++;else if(outcome==='sse_observation_limited')node.observationLimited++;else node.failed++;
      clientWatch.observeRequest(job.watchId,job.id,['complete','vision_guidance'].includes(outcome)?'complete':outcome==='client_cancelled'?'cancelled':['incomplete_sse','sse_observation_limited'].includes(outcome)?'incomplete':'failed');
      if(job.visionNormalized){
        if(outcome==='complete'){
          visionProtection.record('rescued',{images:job.visionNormalized.images,formats:job.visionNormalized.formats,node:node.id});
          log('vision_image_rescued',{request_id:job.id,node:node.id,images:job.visionNormalized.images,formats:job.visionNormalized.formats});
        }
        else if(outcome!=='vision_guidance')visionProtection.record('failed',{reason:'normalized_retry_failed',node:node.id});
      }
      log('request_finished', { request_id: job.id, node: node.id, session: job.key?.slice(0, 12), outcome,
        queue_ms: job.dispatched - job.created, elapsed_ms: Date.now() - job.dispatched,
        usage: observer.usage, sse_done: observer.done, stream_end:streamEnd, requested_thinking: job.thinking.result, detail });
      dataset.record('finish',{request_id:job.id,node:node.id,outcome,queue_ms:job.dispatchedMono-job.createdMono,
        route:req.url,response_format:responseFormat,http_status:clientStatus??response?.statusCode,usage_observation:usageObservation,request_stream:job.requestStream,requested_usage:job.requestedUsage,traffic_class:job.trafficClass,
        service_ms:performance.now()-job.dispatchedMono,total_ms:performance.now()-job.createdMono,first_body_byte_ms:firstBodyByte,
        request_bytes:requestBytes,usage:observer.usage,finish_reason:observer.finish_reason,stream_end:streamEnd,requested_thinking:job.thinking.result,
        generation:jsonMetadata?.generation??(responseFormat==='sse'?{thinking_characters:observer.thinkingCharacters,answer_characters:observer.answerCharacters,tool_characters:observer.toolCharacters,first_semantic_ms:observer.firstSemanticAt===null?null:observer.firstSemanticAt-job.dispatchedMono}:null)});
      observe(()=>shadow.finished(node.id,job.key,{outcome,finish_reason:observer.finish_reason,
        service_ms:performance.now()-job.dispatchedMono,usage:observer.usage,route:req.url,traffic_class:job.trafficClass}));
      job.cleanup();
      job.upstream=null;job.upstreamResponse=null;
      node.active = null;
      schedule(node);
      pumpWaiting();
      if(shadow.enabled)setImmediate(evaluateWaiting);
    };
    const responseHeaders=up=>{
      const outHeaders = forwardHeaders(up.headers);
      outHeaders['x-ds4-node'] = node.id;
      outHeaders['x-request-id'] = job.id;
      outHeaders['x-ds4-affinity'] = job.affinity;
      // An upstream response can never attest that DSG did not dispatch it.
      outHeaders[DISPATCH_HEADER] = 'dispatched';
      outHeaders['x-accel-buffering'] = 'no';
      if(job.visionNormalized?.kind==='image_limit'){
        outHeaders['x-dsg-protection']='vision-image-limit-recovery';
        outHeaders['x-dsg-images-withheld']=String(job.visionNormalized.images);
      }else if(job.visionNormalized?.kind==='gif'){
        outHeaders['x-dsg-protection']='vision-gif-recovery';
        outHeaders['x-dsg-gifs-withheld']=String(job.visionNormalized.images);
      }
      return outHeaders;
    };
    const observeResponse=(up,isSSE)=>{
      response=up;clientStatus=up.statusCode;
      responseFormat=isSSE?'sse':String(up.headers['content-type']).includes('application/json')?'json':'other';
      if(responseFormat==='json'&&!up.headers['content-encoding'])jsonUsage=new JsonUsageObserver(req.url);
      faults=new GenerationFaultObserver(isSSE);
    };
    const acceptResponseChunk=(up,chunk,isSSE)=>{
      if(firstBodyByte===null)firstBodyByte=performance.now()-job.dispatchedMono;
      job.lastUpstreamByteMono=performance.now();
      if(jsonUsage)jsonUsage.accept(chunk);
      if(isSSE||up.statusCode>=400)faults?.accept(chunk);
      if(isSSE)observer.accept(chunk);
    };
    const sendBuffered=(up,body)=>{
      const isSSE=String(up.headers['content-type']).includes('text/event-stream');
      observeResponse(up,isSSE);if(body.length)acceptResponseChunk(up,body,isSSE);
      res.writeHead(up.statusCode,responseHeaders(up));res.end(body);
      const streamEnd=isSSE?observer.finishState():null;
      finish(up.statusCode>=400?'upstream_http_error':!isSSE?'complete':streamEnd==='engine_error'?'upstream_engine_error':streamEnd==='terminal'?'complete':streamEnd==='observation_limited'?'sse_observation_limited':'incomplete_sse',up.statusCode,streamEnd);
    };
    const sendGuidance=(reason,stream,kind='jpeg')=>{
      const guide=visionGuidance({stream,model:config.model,requestId:job.id,kind});
      response=undefined;clientStatus=200;responseFormat=guide.format;observer.done=true;observer.finish_reason='stop';
      const protectionKind=kind==='gif'?'vision-gif-guidance':kind==='image_limit'?'vision-image-limit-guidance':'vision-jpeg-guidance';
      const outHeaders={'content-type':guide.contentType,'content-length':guide.body.length,'cache-control':'no-store','x-ds4-node':node.id,'x-request-id':job.id,'x-ds4-affinity':job.affinity,[DISPATCH_HEADER]:'dispatched','x-accel-buffering':'no','x-dsg-protection':protectionKind};
      firstBodyByte=performance.now()-job.dispatchedMono;
      res.writeHead(200,outHeaders);res.end(guide.body);
      visionProtection.record('guided',{reason,formats:[kind],node:node.id});log('vision_image_guidance',{request_id:job.id,node:node.id,format:kind,reason});
      finish('vision_guidance',reason);
    };
    const bufferCandidate=(up,retry)=>{
      job.upstreamResponse=up;
      let chunks=[],bytes=0,passthrough=false,isSSE=false;
      const write=chunk=>{acceptResponseChunk(up,chunk,isSSE);if(!res.write(chunk)){up.pause();res.once('drain',()=>up.resume());}};
      const beginPassthrough=()=>{if(passthrough)return;passthrough=true;observeResponse(up,isSSE);res.writeHead(up.statusCode,responseHeaders(up));res.flushHeaders();for(const chunk of chunks)write(chunk);chunks=[];};
      up.on('data',chunk=>{
        if(passthrough)return write(chunk);
        if(bytes+chunk.length<=JPEG_REJECTION_INSPECTION_BYTES){chunks.push(chunk);bytes+=chunk.length;}
        else{beginPassthrough();write(chunk);}
      });
      up.on('error',e=>{res.destroy();finish(job.cancelled?'client_cancelled':'upstream_stream_error',e.code);});
      up.on('aborted',()=>{res.destroy();finish(job.cancelled?'client_cancelled':'upstream_aborted');});
      up.on('end',()=>void (async()=>{
        if(passthrough){res.end();finish('upstream_http_error',up.statusCode);return;}
        const rejected=Buffer.concat(chunks,bytes);
        const rejection=visionRejectionKind(up.statusCode,rejected);
        if(!rejection){sendBuffered(up,rejected);return;}
        if(rejection==='image_limit'&&!retry){
          const original=await bodyReady;
          if(job.cancelled){finish('client_cancelled','CLIENT_CLOSED');return;}
          try{
            const repaired=visionProtection.recoverImageLimit(original,req.url);
            job.visionNormalized={images:repaired.removed,formats:['image_limit'],totalImages:repaired.retained,kind:'image_limit',stream:repaired.stream};firstBodyByte=null;
            log('vision_image_limit_recovery',{request_id:job.id,node:node.id,withheld:repaired.removed,retained:repaired.retained});
            issue(repaired.body,true);
          }catch{sendBuffered(up,rejected);}
          return;
        }
        if(rejection==='image_limit'&&retry){
          if(job.visionNormalized?.kind==='image_limit')sendGuidance('image_limit_recovery_rejected',job.visionNormalized.stream,'image_limit');
          else if(job.visionNormalized?.totalImages>16)sendGuidance('image_limit_exceeded',job.visionNormalized.stream,'image_limit');
          else sendBuffered(up,rejected);
          return;
        }
        if(rejection==='gif_candidate'){
          const original=await bodyReady;
          if(job.cancelled){finish('client_cancelled','CLIENT_CLOSED');return;}
          try{
            if(retry){
              const inspected=visionProtection.inspectGif(original,req.url);
              sendGuidance('gif_recovery_rejected',job.visionNormalized?.stream??inspected.stream,'gif');
            }else{
              const repaired=visionProtection.recoverGif(original,req.url);
              job.visionNormalized={images:repaired.removed,formats:['gif'],totalImages:repaired.totalImages,kind:'gif',stream:repaired.stream};firstBodyByte=null;
              log('vision_gif_recovery',{request_id:job.id,node:node.id,withheld:repaired.removed});
              issue(repaired.body,true);
            }
          }catch{
            // A generic JSON response is not enough evidence. Preserve it
            // exactly unless the submitted Chat Completions body proves that a
            // valid typed GIF caused the pre-generation rejection.
            sendBuffered(up,rejected);
          }
          return;
        }
        const kind=job.visionNormalized?.kind??'jpeg';
        if(retry){sendGuidance('normalized_image_rejected',job.visionNormalized?.stream??job.requestStream===true,kind);return;}
        const original=await bodyReady;
        if(job.cancelled){finish('client_cancelled','CLIENT_CLOSED');return;}
        try{
          const normalized=await visionProtection.normalize(original,req.url);
          if(job.cancelled){finish('client_cancelled','CLIENT_CLOSED');return;}
          job.visionNormalized={images:normalized.converted,formats:normalized.formats,totalImages:normalized.totalImages,kind:'jpeg',stream:normalized.stream};firstBodyByte=null;
          issue(normalized.body,true);
        }catch(error){
          let stream=job.requestStream===true;
          if(Buffer.isBuffer(original))try{stream=JSON.parse(original.toString('utf8'))?.stream===true;}catch{}
          const guidanceKind=error.message==='gif_not_supported'?'gif':kind;
          sendGuidance(/^[a-z_]{1,64}$/.test(error.message)?error.message:'normalization_failed',stream,guidanceKind);
        }
      })());
    };
    const forwardResponse=up=>{
      job.upstreamResponse=up;
      const isSSE = String(up.headers['content-type']).includes('text/event-stream');
      observeResponse(up,isSSE);
      res.writeHead(up.statusCode,responseHeaders(up));res.flushHeaders();
      up.on('data',chunk=>acceptResponseChunk(up,chunk,isSSE));
      up.on('error',e=>{res.destroy();finish(job.cancelled?'client_cancelled':'upstream_stream_error',e.code);});
      up.on('aborted',()=>{res.destroy();finish(job.cancelled?'client_cancelled':'upstream_aborted');});
      up.on('end',()=>{const streamEnd=isSSE?observer.finishState():null;finish(up.statusCode>=400?'upstream_http_error':!isSSE?'complete':streamEnd==='engine_error'?'upstream_engine_error':streamEnd==='terminal'?'complete':streamEnd==='observation_limited'?'sse_observation_limited':'incomplete_sse',up.statusCode,streamEnd);});
      up.pipe(res);
    };
    const issue=(replacement,retry=false)=>{
      let gotResponse=false,freshConnectingSocket=false,connected=false;
      const attemptHeaders={...headers};
      if(replacement){delete attemptHeaders['transfer-encoding'];attemptHeaders['content-length']=replacement.length;}
      const upstream=http.request(target,{method:req.method,headers:attemptHeaders,agent},up=>{
        gotResponse=true;
        if(up.statusCode===400&&visionProtection.enabled&&(retry||captureLimit))bufferCandidate(up,retry);
        else forwardResponse(up);
      });
      job.upstream=upstream;
      upstream.on('socket',socket=>{
        if(!socket.connecting){connected=true;return;}
        freshConnectingSocket=true;
        const timer=setTimeout(()=>upstream.destroy(Object.assign(new Error('Connect timeout'),{code:'CONNECT_TIMEOUT'})),config.connect_timeout_ms??10000);
        socket.once('connect',()=>{connected=true;clearTimeout(timer);});socket.once('close',()=>clearTimeout(timer));
      });
      upstream.on('error',errorValue=>{
        // Only the original POST on a witnessed fresh, never-connected socket
        // can prove that no worker received it. Resets, timeouts, reused sockets
        // and normalized follow-up attempts remain ambiguous. Never replay here.
        if(!settled&&!job.cancelled&&!res.destroyed&&!res.headersSent&&req.method==='POST'&&!retry&&!replacement&&
          !gotResponse&&freshConnectingSocket&&!connected&&upstream.reusedSocket===false&&errorValue.code==='ECONNREFUSED'){
          req.unpipe(upstream);clientStatus=503;
          finish('upstream_error',errorValue.code);
          return reject(req,res,503,'home_unavailable','The DS4 connection was refused before it connected; this request did not reach the server. A compatible patient client can wait and retry the unchanged request.',{id:job.id,callId:job.callId,key:job.key,node,reason:'worker_connect_refused'});
        }
        const retryMessage=job.visionNormalized?.kind==='image_limit'?'Image-limit recovery turn could not reach DS4. Execution may have started; DSG did not retry again.':job.visionNormalized?.kind==='gif'?'GIF recovery turn could not reach DS4. Execution may have started; DSG did not retry again.':'Normalized image retry could not reach DS4. Execution may have started; DSG did not retry again.';
        if(!res.headersSent)error(res,502,'upstream_error',retry?retryMessage:'Upstream connection failed. Execution may have started; gateway did not retry.');
        else res.destroy();
        finish(job.cancelled?'client_cancelled':'upstream_error',errorValue.code);
      });
      upstream.on('close',()=>{if(!settled&&(job.cancelled||!gotResponse))finish(job.cancelled?'client_cancelled':'connection_closed');});
      if(replacement)upstream.end(replacement);
      return upstream;
    };
    const upstream=issue(null);
    job.deadline = setTimeout(() => { job.upstream?.destroy(Object.assign(new Error('100-hour request deadline'), { code: 'REQUEST_DEADLINE' })); }, config.request_timeout_ms ?? 360000000);
    log('request_dispatched', { request_id: job.id, node: node.id, session: job.key?.slice(0, 12), affinity: job.affinity, queue_ms: job.dispatched - job.created });
    dataset.record('dispatch',{request_id:job.id,node:node.id,queue_ms:job.dispatchedMono-job.createdMono});
    progress();
    // Passive observation only while dispatched; queued uploads remain untouched.
    // The original pipe retains streaming/backpressure and exact body bytes.
    req.on('data',observeBody);req.once('end',bodyEnded);req.once('aborted',bodyAborted);req.once('error',bodyAborted);
    req.pipe(upstream);
  }

  const server = http.createServer((req, res) => {
    const credential = Buffer.from(req.headers.authorization || '');
    if (credential.length !== auth.length || !timingSafeEqual(credential, auth)) { req.resume(); return error(res, 401, 'unauthorized', 'Bearer API key required'); }
    // Reject absolute URLs and encoded/normalized alternate routes; no admin forwarding.
    const route = `${req.method} ${req.url}`;
    if (route === 'GET /gateway/status' || route === 'GET /workers') return json(res, 200, stats());
    if (route === 'GET /health') {const ready=!draining&&nodes.some(n=>n.healthy&&!n.drained);return json(res,ready?200:503,{...stats(),...(!ready?{error:{type:'gateway_error',code:'not_ready',message:dsgReport('Gateway is draining or no DS4 server is ready.')}}:{})});}
    if(route===`POST ${CLIENT_WATCH_ROUTE}`){
      if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']??'')){req.resume();return error(res,415,'client_watch_media_type','Client Watch requires JSON');}
      const declared=Number(req.headers['content-length']);if(Number.isFinite(declared)&&declared>2048){req.resume();return error(res,413,'client_watch_too_large','Client Watch heartbeat exceeds 2 KiB');}
      let body='',bytes=0,finished=false;
      const timer=setTimeout(()=>{if(finished)return;finished=true;error(res,408,'client_watch_timeout','Client Watch heartbeat was incomplete');req.destroy();},5000);timer.unref();
      req.on('data',chunk=>{if(finished)return;bytes+=chunk.length;if(bytes>2048){finished=true;clearTimeout(timer);error(res,413,'client_watch_too_large','Client Watch heartbeat exceeds 2 KiB');req.resume();return;}body+=chunk;});
      req.on('error',()=>{finished=true;clearTimeout(timer);});req.on('aborted',()=>{finished=true;clearTimeout(timer);});
      req.on('end',()=>{if(finished)return;finished=true;clearTimeout(timer);try{return json(res,200,{schema:1,...clientWatch.heartbeat(JSON.parse(body))});}catch{return error(res,400,'invalid_client_watch','Invalid Client Watch heartbeat');}});
      return;
    }
    if (!accepted.has(route)) { req.resume(); return error(res, 404, 'unsupported_route', 'Endpoint is not on the inference allowlist'); }
    const admissionMetadata=clientMetadata(req.headers[CLIENT_METADATA_HEADER]);
    const keyValue = req.headers['x-session-affinity'] || req.headers['x-ds4-conversation-id'] || req.headers['x-session-id'] || req.headers.session_id;
    const key = keyValue && req.method === 'POST' ? digest(String(keyValue)) : null;
    const requestId=randomUUID(),callId=validCallId(req.headers[CALL_ID_HEADER]),watchId=validClientWatchId(req.headers[CLIENT_WATCH_HEADER]),trafficClass=req.headers['x-dsg-observer']==='gate-genie'?'genie':'unclassified';
    if(req.method==='POST')clientWatch.observeRequest(watchId,requestId,'received');
    if(draining)return reject(req,res,503,'draining','Gateway is draining; no new requests admitted',{id:requestId,callId,key,reason:'gateway_draining'});
    const home = key && store.get(key);
    let node = home && nodes.find(n => n.id === home.node);
    let affinity = key ? home ? 'existing' : 'new' : 'none';
    let waitReason=null;
    if (node && (!node.healthy || node.drained)) {
      // Ownership is conversation-scoped. Unrelated work must not block a safe
      // undispatched retry; same-session work, including cancelled active work,
      // retains ownership until its dispatch actually settles.
      const outstanding=sessionWork(nodes,key);
      if(outstanding){waitReason=outstanding.reason;node=null;}
      else {node = pick(node.id); affinity = 'reassigned';}
    }
    if (!node&&!waitReason) {
      node=pick();
      if(node&&!home&&req.method==='POST'&&trafficClass!=='genie')try{node=applyFallbackTieBreak(node,requestId);}catch{fallbackTieBreak.errors++;}
      // Existing homes and reassignment retain their established safety/cache
      // behavior. Only genuinely new conversations may use validated placement.
      if(node&&key&&!home&&req.method==='POST')node=predictor.choose(nodes.filter(n=>n.healthy&&!n.drained&&!n.quarantine),key,node,candidate);
    }
    if(key&&waiting.some(j=>j.key===key)){node=null;waitReason='same_session_queued';}
    if (req.method === 'GET') {
      if(!node)return reject(req,res,503,'no_healthy_workers','No DS4 server is currently ready; model metadata is unavailable',{id:requestId,callId,key,reason:'no_ready_worker'});
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
    if ((node&&node.queue.length+parkedFor(node).length>=queueBound())||(!node&&waiting.length>=waitingBound()))return reject(req,res,429,'queue_full','DSG waiting capacity is full; request was not dispatched. Wait for capacity or use the patient client adapter.',{id:requestId,callId,key,node,reason:'queue_full'});
    const job = { req, res, key, affinity, id:requestId,callId,watchId, sequence:sequence++,admissionMetadata,created: Date.now(), createdMono:performance.now(), cancelled: false,queueTimeoutMs:queueTimeoutMs(),
      trafficClass };
    const cancel = () => {
      if (res.writableFinished) return;
      job.cancelled = true;
      if (job.upstream) {
        // Once response headers exist, destroying ClientRequest alone does not
        // reliably close its IncomingMessage. Close both halves so DS4 sees the
        // cancelled consumer and the gateway cannot retain a ghost active slot.
        const outbound=job.upstream,inbound=job.upstreamResponse;
        inbound?.destroy();
        outbound.destroy();
      }
      else {
        detach(job);
        job.queueTimer?.cancel(); job.cleanup();
        clientWatch.observeRequest(job.watchId,job.id,'cancelled');
        log('queued_request_cancelled', { request_id: job.id, node: job.node?.id??job.fixedHome?.id??null });
        dataset.record('queued_cancel',{request_id:job.id,node:job.node?.id??job.fixedHome?.id??null,total_ms:performance.now()-job.createdMono});
        pumpWaiting();
      }
    };
    job.cleanup = () => { job.queueTimer?.cancel();req.off('aborted', cancel); res.off('close', cancel); req.off('error', cancel); };
    req.on('aborted', cancel); req.on('error', cancel); res.on('close', cancel);
    job.queueTimer = deadlineTimer(() => {
      detach(job);
      const owner=job.node??job.fixedHome;
      reject(req,res,504,'queue_timeout',queueTimeoutMessage(job.queueTimeoutMs),{...job,node:owner,reason:'queue_deadline'});
      dataset.record('queue_timeout',{request_id:job.id,node:owner?.id??null,total_ms:performance.now()-job.createdMono});
      job.cleanup(); req.resume();pumpWaiting();
    }, job.queueTimeoutMs);
    if(node)admit(job,node);else park(job,null,waitReason??'no_ready_worker');
  });
  server.requestTimeout = 0; // Covers upload + queue; no hidden five-minute Node default.
  server.timeout = 0; // Long prefill/decode streams are intentionally allowed to be idle.
  server.headersTimeout = 60000;
  server.keepAliveTimeout = 5000;
  server.on('clientError',invalidHttp);

  async function probe(node) {
    if (node.probing) return;
    node.probing = true;
    const activeAtStart=node.active;
    await new Promise(resolve => {
      let settled = false, deadline;
      const finish = (ok, reason) => {
        if (settled) return; settled = true;
        clearTimeout(deadline); node.probeRequest = null;
        node.probing = false; node.lastProbe = new Date().toISOString();
        // A model-list timeout alone cannot contradict contemporaneous bytes
        // from the live inference stream. Merely being active is NOT enough:
        // silent prefill, a stuck socket and real network loss still fail probes.
        const inference=node.active??activeAtStart;
        if(!ok&&reason==='PROBE_TIMEOUT'&&inference?.lastUpstreamByteMono!==undefined&&
          performance.now()-inference.lastUpstreamByteMono<(config.health_timeout_ms??5000)){
          node.healthProbeDeferred++;
          node.probeError='busy_probe_deferred';
          resolve();return;
        }
        node.probeError = reason;
        if (reason && reason !== 'model_or_context_mismatch') node.modelMatches=false;
        const was = node.healthy;
        if (ok) {
          node.failures = 0; node.healthy = !node.quarantine && !node.recovering;
          if(node.ssh)node.managementPath={...node.managementPath,state:'verified',reason:null,changed_at:new Date().toISOString(),last_verified_at:new Date().toISOString()};
        }
        else if (++node.failures >= (config.health_failures ?? 3)) node.healthy = false;
        if(!ok&&node.ssh&&node.managementPath.state==='verified')node.managementPath={...node.managementPath,state:'ssh_process_active',reason:null,changed_at:new Date().toISOString()};
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
    recovery:recovery.status(),protections:visionProtection.status(),queued_relocation:{schema:1,automatic:true,automatic_scope:automaticRelocationScope,automatic_affinity_rebalance_min_wait_ms:automaticAffinityWait,offers:relocationOffers(),diagnostics:relocationDiagnostics(),completed:relocation.completed,rejected:relocation.rejected},
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
      const until = Date.now() + workerRegistrationTimeout(config,node);
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
  function setSshFallbacks(input) {
    if(shuttingDown||draining)throw new Error('Gateway is draining');
    const next=replaceSshFallbacks(nodes.map(definition),input),updated=next.find(worker=>worker.id===input.id),node=nodes.find(worker=>worker.id===input.id);
    if(JSON.stringify(updated.ssh_fallbacks??[])===JSON.stringify(node.ssh_fallbacks??[]))return registry();
    if(fs.existsSync(store.filename)){const backup=`${store.filename}.routes-${Date.now()}-${randomUUID()}.bak`;fs.copyFileSync(store.filename,backup,fs.constants.COPYFILE_EXCL);fs.chmodSync(backup,0o600);}
    store.save({...store.data,workers:next});
    if(updated.ssh_fallbacks)node.ssh_fallbacks=[...updated.ssh_fallbacks];else delete node.ssh_fallbacks;
    node.managementPath={...node.managementPath,route_count:sshTargets(node).length,changed_at:new Date().toISOString()};
    log('worker_management_routes_changed',{node:node.id,route_count:sshTargets(node).length});
    return registry();
  }
  function removeWorker(id) {
    if (shuttingDown) throw new Error('Gateway is stopping');
    const node = nodes.find(n => n.id === id);
    if (!node) throw new Error('Unknown worker');
    if(parkedFor(node).length)throw new Error('Undispatched requests are waiting for this server to recover. Readmit it or cancel those requests before removing its registration.');
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
  function operatorAction(ids,drained,controlChannel='in_process'){
    const channel=typeof controlChannel==='string'&&/^[a-z][a-z0-9_]{0,31}$/.test(controlChannel)?controlChannel:'unidentified_local_client';
    return {id:randomUUID(),time:new Date().toISOString(),action:drained?'pause':'resume',workers:[...ids],control_channel:channel};
  }
  function drainNodes(ids, drained, controlChannel='in_process') {
    if (!Array.isArray(ids) || !ids.length || ids.some(id => !nodes.some(n => n.id === id))) throw new Error('Specify known worker IDs');
    const action=operatorAction(ids,drained,controlChannel);
    store.save({...store.data,...agents.manualUpdate(ids,drained),operator_actions:[...(store.data.operator_actions??[]),action].slice(-256)});
    if(drained)recovery.operatorPause(ids);
    for (const n of nodes) if (ids.includes(n.id)) n.drained = drained;
    log('workers_drain_changed', { ids, drained, operator_action_id:action.id, control_channel:action.control_channel });
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
    if (req.method !== 'POST' || !['/drain-workers', '/resume-workers', '/maintenance-lock','/release-maintenance-lock','/maintenance-receipt','/add-worker', '/remove-worker', '/set-ssh-fallbacks','/set-context-limit','/set-queue-timeout','/set-protection','/relocate-queued','/genie-relocate-queued','/recovery-policy','/recovery-handback-policy','/recover-worker','/genie-recover-worker','/recovery-canary','/recovery-recheck','/predictor','/genie-predictor','/grant-agent','/revoke-agent','/release-agent-hold','/agent/v1/drain','/agent/v1/resume','/agent/v1/receipt'].includes(req.url)) return error(res, 404, 'not_found', 'Unknown control action');
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
          if(req.url==='/maintenance-lock')return json(res,201,agents.maintenanceLock(input,req.headers['x-dsg-control-channel']));
          if(req.url==='/release-maintenance-lock')return json(res,200,agents.maintenanceRelease(input,req.headers['x-dsg-control-channel']));
          if(req.url==='/maintenance-receipt')return json(res,200,agents.maintenanceReceipt(input));
          if(['/predictor','/genie-predictor'].includes(req.url))return json(res,200,predictor.control(input,req.url==='/genie-predictor'?'genie':'operator'));
          if(req.url==='/recovery-recheck')return json(res,202,recovery.reconcile(input));
          if(req.url==='/recovery-policy') {
            if(Object.keys(input).length!==1 || !Object.hasOwn(input,'enabled'))throw new Error('Specify enabled only');
            return json(res,200,recovery.setAutomatic(input.enabled));
          }
          if(req.url==='/recovery-handback-policy') {
            if(Object.keys(input).length!==1 || !Object.hasOwn(input,'enabled'))throw new Error('Specify enabled only');
            return json(res,200,recovery.setProfileHandbackAutomatic(input.enabled));
          }
          if(['/recover-worker','/genie-recover-worker','/recovery-canary'].includes(req.url))return json(res,202,recovery.request(input,req.url==='/genie-recover-worker'?'genie':'operator',{canary:req.url==='/recovery-canary'}));
          if (req.url === '/set-context-limit') return json(res,200,await setContextLimit(input));
          if (req.url === '/set-queue-timeout') return json(res,200,setQueueTimeout(input));
          if (req.url === '/set-protection') return json(res,200,visionProtection.set(input));
          if (req.url === '/relocate-queued') return json(res,200,relocateQueued(input));
          if (req.url === '/genie-relocate-queued') {
            if(config.genie_load_balancing===false||!genieRelocationOffers().some(offer=>['request_id','source','destination','evidence_id'].every(key=>offer[key]===input?.[key])))throw new Error('Genie relocation evidence or policy changed; request was left in place');
            return json(res,200,relocateQueued(input,'genie'));
          }
          if (req.url === '/add-worker') return json(res, 201, await addWorker(input.worker));
          if (req.url === '/set-ssh-fallbacks') return json(res, 200, setSshFallbacks(input));
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
            const action=operatorAction(input.workers,false,req.headers['x-dsg-control-channel']??'unidentified_local_client');
            store.save({...store.data,quarantined,...agents.manualUpdate(input.workers,false),operator_actions:[...(store.data.operator_actions??[]),action].slice(-256)});
            for(const {node,proof} of recovered){node.quarantine=null;node.inferenceFailures=0;node.healthy=true;log('worker_recovery_verified',{node:node.id,...proof});}
            for(const n of selected)n.drained=false;
            log('workers_drain_changed',{ids:input.workers,drained:false,operator_action_id:action.id,control_channel:action.control_channel});
            return json(res,200,stats());
          }
          json(res, 200, drainNodes(input.workers, req.url === '/drain-workers',req.headers['x-dsg-control-channel']??'unidentified_local_client'));
        } catch (e) { error(res, e.status??400, e.code??'invalid_control_request', e.message); }
      });
    });
  }) : null;
  control?.on('clientError',invalidHttp);
  return {
    server, nodes, stats, store, drainNodes, registry,recovery,relocateQueued,visionProtection,
    async start() {
      nodes.forEach(startTunnel);
      if(startup.barrier){
        const allowance=config.continuity_door.startup_probe_ms??12000;
        if(!Number.isSafeInteger(allowance)||allowance<0||allowance>120000)throw new Error('continuity_door.startup_probe_ms must be 0–120000');
        const deadline=performance.now()+allowance;
        do {
          await Promise.all(nodes.map(freshProbe));
          startup.unavailable=nodes.filter(n=>!n.healthy&&!n.drained&&!n.quarantine).map(n=>n.id);
          if(!startup.unavailable.length||performance.now()>=deadline)break;
          await delay(Math.min(250,Math.max(0,deadline-performance.now())));
        } while(performance.now()<deadline);
        startup.complete=true;startup.completed_at=new Date().toISOString();
        log('startup_probe_barrier',{unavailable:startup.unavailable,allowance_ms:allowance});
      }
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(gatewayPort(config), gatewayHost(config), resolve); });
      if (control) {
        // Store ownership has already been acquired; only our stale socket may exist.
        if (fs.existsSync(config.control_socket)) {
          if (!fs.lstatSync(config.control_socket).isSocket()) throw new Error('Control path is not a socket');
          fs.unlinkSync(config.control_socket);
        }
        await new Promise((resolve, reject) => { control.once('error', reject); control.listen(config.control_socket, resolve); });
        fs.chmodSync(config.control_socket, 0o600);
      }
      if(!startup.barrier){await Promise.all(nodes.map(probe));startup.complete=true;startup.completed_at=new Date().toISOString();startup.unavailable=nodes.filter(n=>!n.healthy&&!n.drained&&!n.quarantine).map(n=>n.id);}
      healthTimer = setInterval(() => { for (const n of nodes) void probe(n); }, config.health_interval_ms ?? 5000);
      waitingTimer=setInterval(pumpWaiting,1000);waitingTimer.unref?.();
      void recovery.tick();recoveryTimer=setInterval(()=>void recovery.tick(),30000);
      predictorTimer=setInterval(()=>predictor.tick(),60000);predictorTimer.unref?.();
      return server.address();
    },
    drain(value = true) { draining = value; log('drain_changed', { draining }); },
    async close() {
      if (shuttingDown) return;
      shuttingDown = true; draining = true;
      clearInterval(waitingTimer);
      for(const job of [...waiting]){detach(job);reject(job.req,job.res,503,'draining','Gateway is stopping; the waiting request was not dispatched. A compatible patient client may retry after DSG returns.',{...job,node:job.fixedHome,reason:'gateway_draining'});job.cleanup();}
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
  let child, timer,targetIndex=0;
  const update=(state,reason=null)=>{node.managementPath={...node.managementPath,transport:'ssh_tunnel',state,reason,changed_at:new Date().toISOString()};};
  const start = () => {
    if (stopping()) return;
    const targets=sshTargets(node);targetIndex%=targets.length;
    node.managementPath={...node.managementPath,transport:'ssh_tunnel',state:'connecting',reason:null,attempts:(node.managementPath?.attempts??0)+1,changed_at:new Date().toISOString()};
    const port = new URL(node.url).port;
    child = spawn('/usr/bin/ssh', ['-N', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'ConnectTimeout=10',
      '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '-L', `127.0.0.1:${port}:127.0.0.1:${node.remote_port ?? 8000}`, targets[targetIndex]], { stdio: ['ignore', 'ignore', 'pipe'] });
    log('tunnel_started', { node: node.id, pid: child.pid });
    child.once('spawn',()=>update('ssh_process_active'));
    child.stderr.on('data', chunk => {const message=chunk.toString().trim(),reason=classifySshFailure(message);if(reason)update('ssh_error',reason);log('tunnel_message', { node: node.id, message });});
    child.on('error', e => {update('ssh_error',classifySshFailure('',e.code));log('tunnel_error', { node: node.id, error: e.message });});
    child.on('exit', (code, signal) => {
      update('retrying',node.managementPath?.reason??classifySshFailure('',null,code));
      log('tunnel_exited', { node: node.id, code, signal });
      targetIndex=(targetIndex+1)%sshTargets(node).length;
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
