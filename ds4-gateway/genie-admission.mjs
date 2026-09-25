// Conversational fleet admission (card 028): Genie inspects an endpoint, drafts
// an admission plan, and executes it in confirmed stages. The autonomy model is
// ask-first: this tool never approves itself — every mutating stage must be
// requested under the owner’s approval of that concrete change. Existing control routes
// stay the executors; this module only orchestrates and verifies.
import {createHash} from 'node:crypto';
import {execFile, spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {configPath, projectRoot} from './config.mjs';
import {createToolEndpoint} from './genie-tool-endpoint.mjs';
import {runServingCheck} from './serving-checks.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const LIFECYCLE = path.join(here, 'lifecycle.mjs');
const STAGE_ORDER = ['remove-dead', 'add-worker', 'route', 'restart', 'resume', 'verify'];
const INSPECT_TIMEOUT_MS = 6000;
const PARK_TIMEOUT_MS = 180000;

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stable(v)]));
  return value;
}
function fingerprintOf(value) {
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex').slice(0, 16);
}
function localEndpointUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error('Provide the endpoint base URL, e.g. http://127.0.0.1:8013/v1'); }
  if (u.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(u.hostname) || !u.port || u.username || u.password || u.search || u.hash) throw new Error('Admission inspects local loopback endpoints only (http://127.0.0.1:<port>/v1).');
  const pathname = u.pathname.replace(/\/$/, '');
  return {base:`http://127.0.0.1:${u.port}`, url:`${u.origin}${pathname.endsWith('/v1') ? pathname : pathname + '/v1'}`, port:Number(u.port)};
}
function slug(id) {
  return id.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'admitted-worker';
}
function contextFromModel(model) {
  for (const key of ['context_length', 'max_context_length', 'context_size', 'max_model_len']) {
    const value = model?.[key];
    if (Number.isSafeInteger(value) && value > 0) return value;
  }
  return null;
}

export function createAdmissionTools({config, control, read, readDoor = null, probe = null, spawnPark = null, spawnStart = null, isTesting = () => false, isEnabled = () => true, now = Date.now, checkRunner = runServingCheck, resolveNativeWorker = null} = {}) {
  if (typeof control !== 'function' || typeof read !== 'function') throw new Error('Admission tools need a control-socket caller and a gateway status reader.');
  if (readDoor !== null && typeof readDoor !== 'function') throw new Error('readDoor must be a function when provided');
  if (spawnPark !== null && typeof spawnPark !== 'function') throw new Error('spawnPark must be a function when provided');
  if (spawnStart !== null && typeof spawnStart !== 'function') throw new Error('spawnStart must be a function when provided');
  const probeModels = probe ?? (async (url, {authorization, timeoutMs = INSPECT_TIMEOUT_MS} = {}) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${url}/models`, {signal: controller.signal, headers: {...(authorization ? {authorization} : {})}});
      if (!response.ok) throw new Error(`Model list HTTP ${response.status}`);
      const body = await response.json();
      const models = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : null;
      if (!models) throw new Error('Model list did not contain a data array');
      return models.map(m => ({id: String(m?.id ?? ''), context_length: contextFromModel(m)}));
    } finally { clearTimeout(timer); }
  });
  const admissionFile=config.state_file?path.join(path.dirname(config.state_file),'genie','admission-session.json'):null;
  const initialState={proposal:null,fingerprint:null,completed:[],receipts:[],busy:false,inspected_at:null};
  const state=admissionFile&&fs.existsSync(admissionFile)?JSON.parse(fs.readFileSync(admissionFile,'utf8')):initialState;
  if(!Array.isArray(state.completed)||!Array.isArray(state.receipts)||typeof state.busy!=='boolean')throw Error('Stored admission session is invalid; preserve it for inspection.');
  if(state.busy){state.busy=false;state.interrupted=true;}
  const persist=()=>{
    if(!admissionFile)return;
    fs.mkdirSync(path.dirname(admissionFile),{recursive:true,mode:0o700});
    const temporary=admissionFile+'.tmp';fs.writeFileSync(temporary,JSON.stringify(state,null,2)+'\n',{mode:0o600});fs.renameSync(temporary,admissionFile);
  };
  const checks=new Map();
  const checkDirectory=config.state_file?path.join(path.dirname(config.state_file),'genie','serving-checks'):null;
  if(checkDirectory&&fs.existsSync(checkDirectory))for(const name of fs.readdirSync(checkDirectory).filter(n=>/^[a-f0-9-]{36}\.json$/.test(n)).slice(-64)){
    const row=JSON.parse(fs.readFileSync(path.join(checkDirectory,name),'utf8'));
    if(row.state==='running')Object.assign(row,{state:'unverified',error:'Dashboard restarted before completion was recorded; inspect serving state. This action will not replay.'});
    checks.set(row.action_id,row);
  }
  const saveCheck=row=>{
    if(!checkDirectory)return;
    fs.mkdirSync(checkDirectory,{recursive:true,mode:0o700});
    const file=path.join(checkDirectory,row.action_id+'.json'),tmp=file+'.tmp';
    fs.writeFileSync(tmp,JSON.stringify(row,null,2)+'\n',{mode:0o600});fs.renameSync(tmp,file);
  };
  const checksBusy=()=>[...checks.values()].some(row=>row.state==='running');
  async function verifyWorker(input){
    if(Object.keys(input).sort().join(',')!=='action,action_id,check,worker'||!/^[a-f0-9-]{36}$/.test(input.action_id??'')||!['gateway','cache','tools'].includes(input.check))throw Error('Specify one worker, check and action ID.');
    const prior=checks.get(input.action_id);
    if(prior){if(prior.worker!==input.worker||prior.check!==input.check)throw Error('Action ID belongs to a different serving check');return prior;}
    if(isTesting()||!isEnabled())throw Error('Serving checks are suspended or server_changes is switched off.');
    if(state.busy||[...checks.values()].some(row=>row.worker===input.worker&&row.state==='running'))throw Error('A serving check or admission stage is already running; read its status.');
    const registry=await read(),worker=registry.workers?.find(w=>w.id===input.worker);
    if(!worker||!worker.is_healthy||worker.drained!==false||worker.operator_paused||worker.direct_reserved||worker.holds?.length||worker.maintenance_locks?.length)throw Error('Use a healthy, routing-enabled worker without an operator pause, maintenance hold or direct reservation.');
    let servingWorker=worker;
    if(input.check!=='gateway'&&resolveNativeWorker){
      const native=await resolveNativeWorker(worker.id);
      if(native?.id!==worker.id||native.url!==worker.url)throw Error('Native endpoint identity changed; no diagnostic request was sent');
      servingWorker={...worker,api_key_file:native.api_key_file};
    }
    if(checks.has(input.action_id))return verifyWorker(input);
    if([...checks.values()].some(row=>row.worker===input.worker&&row.state==='running'))throw Error('Another serving check started on this worker; read its status.');
    const row={action_id:input.action_id,worker:worker.id,check:input.check,state:'running',started_at:new Date(now()).toISOString(),samples:[]};checks.set(input.action_id,row);saveCheck(row);
    void checkRunner({worker:servingWorker,check:input.check,config,registry,readDoor,now,onSample:sample=>{row.samples.push(sample);saveCheck(row);}}).then(result=>Object.assign(row,result)).catch(error=>Object.assign(row,{state:'failed',error:error.message})).finally(()=>{row.finished_at=new Date(now()).toISOString();try{saveCheck(row);}catch{row.persistence_error='Could not save the completed receipt; this dashboard still has the observation.';}});
    return row;
  }
  const sameEndpoint = (worker, endpoint) => {
    try {
      const w = new URL(worker.url);
      return ['127.0.0.1', 'localhost'].includes(w.hostname) && Number(w.port) === endpoint.port;
    } catch { return false; }
  };
  function note(receipt) {
    state.receipts.unshift({at: new Date(now()).toISOString(), ...receipt});
    state.receipts = state.receipts.slice(0, 12);
  }
  async function inspect(input) {
    const endpoint = localEndpointUrl(input?.url);
    let authorization = null;
    if (input?.api_key_file !== undefined) {
      if (typeof input.api_key_file !== 'string' || !path.isAbsolute(input.api_key_file)) throw new Error('api_key_file must be an absolute local path when provided');
      authorization = `Bearer ${fs.readFileSync(input.api_key_file, 'utf8').trim()}`;
    }
    const models = await probeModels(endpoint.url, {authorization});
    if (!models.length) throw new Error('Endpoint answered with an empty model list; nothing to admit.');
    const value = await read();
    if (value?.version !== 1 || !Array.isArray(value.workers)) throw new Error('Gateway worker registry is unavailable.');
    const conflicts = value.workers.filter(w => sameEndpoint(w, endpoint)).map(w => ({id: w.id, is_healthy: w.is_healthy === true, drained: w.drained === true, quarantined: !!w.quarantine, served_model: w.served_model ?? null}));
    const primary = models[0].id;
    let id = slug(primary);
    const taken = new Set(value.workers.map(w => w.id));
    if (taken.has(id)) id = `${id}-2`;
    const proposal = {
      endpoint: endpoint.base,
      served_model: primary,
      models: models.map(m => m.id),
      context_length: models[0].context_length,
      worker: {
        id,
        url: `http://127.0.0.1:${endpoint.port}`,
        backend: 'openai',
        ...(models[0].context_length ? {context_length: models[0].context_length} : {}),
        model_aliases: {[config.model ?? 'PoolModel']: primary, [primary]: primary},
        ...(input?.api_key_file ? {api_key_file: input.api_key_file} : {})
      },
      route: {name: primary, workers: [id]},
      conflicts,
      needs_removal: conflicts.filter(c => !c.is_healthy).map(c => c.id),
      steps: [
        ...(conflicts.some(c => !c.is_healthy) ? ['remove-dead: drain and remove the dead worker(s) on this endpoint'] : []),
        'add-worker: register the endpoint (admission starts it routing-paused)',
        'route: write the model route into the private config with a backup',
        'restart: park the core (door holds calls), then spawn ./start-dsg.sh to apply and release',
        'resume: enable the newly registered worker only if no newer operator or maintenance decision replaced its registration pause',
        'verify: door status + one small canary generation through the door + worker health'
      ],
      warnings: [
        'Adding a model changes which machines serve which names. Confirm machine occupancy with the fleet catalogue before approving remove-dead or restart.',
        ...(conflicts.some(c => c.is_healthy) ? ['A healthy worker already serves this endpoint; admission would duplicate it.'] : []),
        ...(models.length > 1 ? ['Endpoint serves several models; the proposal routes the first listed one only.'] : [])
      ]
    };
    const fingerprint = fingerprintOf({url: endpoint.base, models: models.map(m => m.id), conflicts: conflicts.map(c => [c.id, c.is_healthy])});
    state.proposal = proposal;
    state.fingerprint = fingerprint;
    state.completed = [];
    state.intent = null;
    state.inspected_at = new Date(now()).toISOString();
    return {schema: 1, fingerprint, proposal, observed_at: state.inspected_at,
      next_step: 'Present this proposal to the owner in chat. Use existing explicit approval if it covers this concrete proposal and stage; otherwise ask first. Call admission_admit one stage at a time with this fingerprint. Stages run in order: ' + STAGE_ORDER.join(' → ') + ' (remove-dead only when the proposal lists dead workers).'};
  }
  function requireStage(stage, fingerprint) {
    if(state.interrupted)throw Error('Dashboard stopped during an admission stage. Inspect its existing intent and live worker state; do not replay it.');
    if (state.busy||checksBusy()) throw new Error('Another admission stage or serving check is running; wait for its receipt.');
    if (!state.proposal || state.fingerprint !== fingerprint) throw new Error('Fingerprint does not match the last inspection; re-inspect the endpoint (fleet state may have changed).');
    if (!STAGE_ORDER.includes(stage)) throw new Error(`Unknown admission stage ${stage}; stages: ${STAGE_ORDER.join(', ')}.`);
    const removable = state.proposal.needs_removal.length > 0;
    const expected = STAGE_ORDER.filter(s => s !== 'remove-dead' || removable);
    const index = expected.indexOf(stage);
    if (index !== state.completed.length) throw new Error(`Stage order violated: next stage is ${expected[state.completed.length] ?? 'none (already complete)'}; completed: ${state.completed.join(', ') || 'none'}.`);
  }
  async function removeDead(action_id) {
    const value = await read();
    const receipts = [];
    for (const id of state.proposal.needs_removal) {
      const current = value.workers?.find(w => w.id === id);
      if (!current) { receipts.push({worker: id, result: 'already absent'}); continue; }
      if (current.is_healthy === true) throw new Error(`Worker ${id} is healthy now; refusing removal. Re-inspect instead.`);
      await control('/drain-workers', {workers: [id]});
      const removed = await control('/remove-worker', {id});
      receipts.push({worker: id, result: 'drained and removed', removed});
    }
    if (!receipts.length) receipts.push({result: 'no dead workers listed'});
    const receipt = {stage: 'remove-dead', action_id, receipts};
    note(receipt);
    return receipt;
  }
  async function addWorker(action_id) {
    const value = await read();
    const {worker} = state.proposal;
    if (value.workers?.some(w => w.id === worker.id)) throw new Error(`Worker id ${worker.id} already exists; remove the dead occupant first or re-inspect.`);
    const added = await control('/add-worker', {worker});
    const registered=added.workers?.find(w=>w.id===worker.id);
    const receipt = {stage: 'add-worker', action_id, worker_id: worker.id, added,
      registration:registered&&added.conditional_resume_version===1?{url:registered.url,operator_action:registered.last_operator_action?.id??null}:null,
      note: 'The core registers new workers routing-paused. The separate approved resume stage preserves newer operator and maintenance decisions.'};
    note(receipt);
    return receipt;
  }
  async function writeRoute(action_id, overwrite) {
    const file = configPath(undefined);
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new Error(`Cannot read the private config at ${file}: ${e.message}`); }
    const routes = parsed.model_routes ?? {};
    const {name, workers} = state.proposal.route;
    if (routes[name] && JSON.stringify(routes[name]) !== JSON.stringify(workers) && overwrite !== true) throw new Error(`Route ${name} already exists with different workers (${JSON.stringify(routes[name])}). Repeat with overwrite_route true after the owner approves replacing it.`);
    const backup = `${file}.bak-admission-${now()}-${action_id}`;
    fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);fs.chmodSync(backup,0o600);
    parsed.model_routes = {...routes, [name]: workers};
    const tmp = `${file}.tmp-admission-${action_id}`;
    fs.writeFileSync(tmp, JSON.stringify(parsed, null, 2) + '\n',{mode:0o600,flag:'wx'});
    fs.renameSync(tmp, file);
    const receipt = {stage: 'route', action_id, route: name, workers, backup, file};
    note(receipt);
    return receipt;
  }
  async function restart(action_id) {
    const file = configPath(undefined);
    const parkArgs = [LIFECYCLE, 'park', '--config', file, '--json'];
    const parked = await new Promise((resolve, reject) => {
      const child = (spawnPark ?? ((args, opts, done) => execFile(process.execPath, args, opts, done)))(parkArgs, {cwd: projectRoot, timeout: PARK_TIMEOUT_MS}, (error, stdout) => error ? reject(new Error(`Park failed: ${error.message}${stdout ? ` · ${String(stdout).slice(0, 400)}` : ''}`)) : resolve(stdout));
    });
    let startLog = null, spawned = false;
    try {
      const logFile = path.join(projectRoot, 'runtime', 'logs', `admission-start-${now()}.log`);
      fs.mkdirSync(path.dirname(logFile), {recursive: true});
      const fd = fs.openSync(logFile, 'a');
      const child = (spawnStart ?? ((args, opts) => spawn(process.execPath, args, {...opts, detached: true, stdio: ['ignore', fd, fd]})))([LIFECYCLE, 'start', '--config', file], {cwd: projectRoot});
      child.unref?.();
      fs.closeSync(fd);
      spawned = true;
      startLog = logFile;
    } catch (e) {
      throw new Error(`Core parked but start could not be spawned (${e.message}). Run ./start-dsg.sh manually; the door is holding calls.`);
    }
    const receipt = {stage: 'restart', action_id, parked: String(parked).slice(0, 1200), start_spawned: spawned, start_log: startLog,
      note: 'The door held calls during the park. ./start-dsg.sh (spawned) verifies the core and releases that exact hold. Model servers were not touched.'};
    note(receipt);
    return receipt;
  }
  async function verify(action_id) {
    const problems = [];
    let door = null;
    if (readDoor) {
      try {
        door = await readDoor();
        if (door.holding !== false) problems.push('door is still holding calls or its hold state is unknown');
        if (door.core_ready !== true) problems.push('door readiness is not confirmed');
      } catch (e) { problems.push(`door status unavailable: ${e.message}`); }
    } else problems.push('door status unavailable');
    const value = await read();
    const worker = value.workers?.find(w => w.id === state.proposal.worker.id);
    if (!worker) problems.push(`worker ${state.proposal.worker.id} is not registered`);
    else if (worker.is_healthy !== true) problems.push(`worker ${state.proposal.worker.id} is registered but not healthy yet`);
    let canary = null;
    try {
      if(!problems.length)canary=await checkRunner({worker,check:'gateway',config,registry:value,readDoor,now});
      if(canary&&canary.state!=='passed')problems.push('door generation was not verified');
    } catch (e) { problems.push(`door generation failed: ${e.message}`); }
    const receipt = {stage: 'verify', action_id, door, worker: worker ? {id: worker.id, is_healthy: worker.is_healthy === true, drained: worker.drained === true} : null, canary, problems,
      verdict: problems.length === 0 ? 'admitted and verified' : 'unverified — resolve the problems or inspect honestly'};
    note(receipt);
    return receipt;
  }
  async function resume(action_id) {
    const door=readDoor?await readDoor():null;
    if(door?.holding!==false||door?.core_ready!==true)throw Error('Wait for the released, ready Door before enabling the new worker.');
    const before=state.receipts.find(row=>row.stage==='add-worker')?.registration;
    if(!before)throw Error('The original registration lacks conditional-resume evidence; inspect the worker without changing its pause.');
    const value=await control('/workers'),id=state.proposal.worker.id,current=value.workers?.find(row=>row.id===id);
    if(value.conditional_resume_version!==1||!current||current.url!==before.url)throw Error('Registered endpoint or conditional-resume support changed; leave routing paused.');
    if((current.last_operator_action?.id??null)!==before.operator_action)throw Error('Operator decision changed after registration; leave it untouched.');
    if(!Array.isArray(current.holds)||!Array.isArray(current.maintenance_locks)||current.holds.length||current.maintenance_locks.length||current.direct_reserved||current.is_healthy!==true)throw Error('Worker is held, reserved, unhealthy or incompletely observed; leave it untouched.');
    const result=await control('/resume-workers',{workers:[id],expected_operator_actions:{[id]:before.operator_action},expected_maintenance_actions:{[id]:null}});
    const after=await control('/workers'),worker=after.workers?.find(row=>row.id===id);
    if(!worker||worker.drained||worker.operator_paused||worker.holds?.length||worker.maintenance_locks?.length||worker.is_healthy!==true)throw Error('Readmission was not confirmed; inspect current status before any further action.');
    const receipt={stage:'resume',action_id,worker_id:id,result,note:'Fresh readiness and conditional operator/maintenance fencing passed. A real Door generation remains a separate verify stage.'};
    note(receipt);return receipt;
  }
  async function tool(input) {
    if (input?.action === 'status') return {schema: 1, enabled: isEnabled(), busy: state.busy||checksBusy(), interrupted:state.interrupted===true, intent:state.intent??null, serving_checks:[...checks.values()], fingerprint: state.fingerprint, inspected_at: state.inspected_at, completed: [...state.completed], receipts: state.receipts, proposal: state.proposal};
    if(input?.action==='verify-worker')return verifyWorker(input);
    if (input?.action === 'inspect') {
      if(state.interrupted)throw Error('The previous admission stage needs reconciliation; preserve its proposal and intent.');
      if(state.busy||checksBusy())throw Error('An admission stage or check is running; wait before replacing its proposal.');
      state.busy=true;
      try{return await inspect(input);}finally{state.busy=false;persist();}
    }
    if (input?.action === 'admit') {
      if (isTesting()) throw new Error('Admission is suspended for testing.');
      if (!isEnabled()) throw new Error('Server changes are switched off; admission needs the server_changes capability.');
      const {stage, fingerprint, action_id} = input;
      if (!/^[a-f0-9-]{36}$/.test(action_id ?? '')) throw new Error('Provide one action ID for this admission stage.');
      const prior=state.fingerprint===fingerprint&&state.receipts.find(row=>row.stage===stage&&row.action_id===action_id);
      if(prior&&state.completed.includes(stage))return {...prior,fingerprint,completed:[...state.completed],deduplicated:true};
      requireStage(stage, fingerprint);
      state.busy = true;state.intent={stage,fingerprint,action_id,started_at:new Date(now()).toISOString()};persist();
      try {
        const receipt = stage === 'remove-dead' ? await removeDead(action_id)
          : stage === 'add-worker' ? await addWorker(action_id)
          : stage === 'route' ? await writeRoute(action_id, input.overwrite_route === true)
          : stage === 'restart' ? await restart(action_id)
          : stage === 'resume' ? await resume(action_id)
          : await verify(action_id);
        if (stage !== 'verify' || receipt.verdict === 'admitted and verified') state.completed.push(stage);
        return {...receipt, fingerprint, completed: [...state.completed],
          next_step: stage === 'verify' ? 'Report the verdict to the owner honestly.' : `Owner-approved next stage: ${STAGE_ORDER.filter(s => s !== 'remove-dead' || state.proposal.needs_removal.length)[state.completed.length] ?? 'none'}.`};
      } finally { state.busy = false;persist(); }
    }
    throw new Error('Specify action: status, inspect or admit.');
  }
  const endpoint = createToolEndpoint('/api/genie/admission-tools', 'x-sg-admission-tool', tool);
  return {...endpoint, tool};
}
