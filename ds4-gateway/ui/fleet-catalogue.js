// Fleet catalogue: one explicit mapping from every enrolled model to its
// endpoint, physical machine(s), routes and scripts, with truthfully derived
// state. Pure functions so the dashboard UI and Genie consume identical facts.
// An offline LLM endpoint never proves the physical machine is down; state
// distinguishes the model/service from the machine whenever hardware telemetry
// can tell them apart. No registry service: existing records only.

export const CATALOGUE_RANK = {
  'serving-llm': 0,
  'serving-media': 1,
  'engine-up': 2,
  paused: 3,
  'engine-stopped': 4,
  'configured-stopped': 5,
  failed: 6,
  unknown: 7
};

const MEDIA_TERMINAL = new Set(['done', 'failed', 'cancelled', 'completed']);
const NATIVE_FRESH_MS = 20000;

function probeAge(lastProbe, now) {
  const t = typeof lastProbe === 'string' ? Date.parse(lastProbe) : NaN;
  return Number.isFinite(t) ? Math.max(0, now - t) : null;
}

export function catalogueEntry({ member, worker, device, mediaBusy, mediaDetail, routes = {}, now = Date.now() }) {
  const telemetry = device?.endpoint_metrics ?? null;
  const connected = telemetry?.connected === true;
  const hardwareUp = device?.hardware?.state === 'connected';
  const healthy = worker?.is_healthy === true;
  const drained = worker?.drained === true;
  const maintenance = (worker?.maintenance_locks?.length ?? 0) > 0;
  const held = (worker?.holds?.length ?? 0) > 0;
  const directReserved = worker?.direct_reserved === true;
  const operatorPaused = worker?.operator_paused === true;
  const routingBlocked = drained || maintenance || held || directReserved || operatorPaused;
  const quarantined = worker?.quarantine === true || worker?.quarantine === 'true';
  const running = telemetry?.running ?? 0;
  const routeNames = Object.entries(routes).filter(([, ids]) => Array.isArray(ids) && ids.includes(member.id)).map(([name]) => name);
  const age = probeAge(worker?.last_probe, now);
  const sources = {
    endpoint: telemetry?.at ?? null,
    probe: worker?.last_probe ?? null,
    hardware: device?.hardware?.state ?? null
  };
  const base = {
    id: member.id,
    machines: member.machine ?? [],
    scripts: member.scripts ?? [],
    routes: routeNames,
    served_model: worker?.served_model ?? null,
    observed_at: telemetry?.at ?? worker?.last_probe ?? null,
    sources
  };
  const gatewayWorker = !!worker;
  let state, detail;
  if (mediaBusy) {
    state = 'serving-media';
    detail = mediaDetail || 'media workload active';
    if (!gatewayWorker) detail = `media workload active despite no gateway worker · ${detail}`;
  } else if (quarantined) {
    state = 'failed';
    detail = `quarantined${worker.quarantine_reason ? `: ${worker.quarantine_reason}` : ''}`;
  } else if (healthy && !routingBlocked && connected) {
    state = 'serving-llm';
    const load = worker?.load ?? 0, queued = worker?.queued ?? 0;
    detail = load > 0 ? `${load} active request${load === 1 ? '' : 's'}${queued ? ` · ${queued} queued` : ''}` : running > 0 ? `engine reports ${running} active outside gateway accounting` : 'healthy, idle';
  } else if (healthy && routingBlocked) {
    state = 'paused';
    const reasons = [operatorPaused && 'paused by operator', maintenance && 'held for maintenance',
      held && 'held by a gateway operation', directReserved && 'reserved for direct work'].filter(Boolean);
    detail = `routing ${reasons.length ? reasons.join(' and ') : 'paused'}; ${connected ? 'endpoint answering' : 'last gateway readiness check passed; current endpoint telemetry unavailable'}`;
  } else if (connected) {
    state = 'engine-up';
    detail = `endpoint answers${running > 0 ? ` · ${running} active` : ''}; gateway health ${age === null ? 'never probed' : `last probed ${Math.round(age / 1000)}s ago`}${worker?.probe_error ? ` · ${worker.probe_error}` : ''} — may be loading or a probe mismatch`;
  } else if (!gatewayWorker) {
    state = 'configured-stopped';
    detail = 'enrolled scripts only; not a gateway worker, so DSG never routes to it until added';
  } else if (hardwareUp) {
    state = 'engine-stopped';
    detail = 'endpoint not answering; machine reachable through hardware agent — model process is down or still starting';
  } else {
    state = 'unknown';
    detail = 'endpoint not answering and machine state unknown — an offline endpoint does not prove the machine is down';
  }
  return { ...base, state, detail, gateway_worker: gatewayWorker };
}

export function buildCatalogue({ members = [], workers = [], devices = [], media = { workloads: [], native_engines: [] }, routes = {}, now = Date.now() } = {}) {
  const byId = new Map(workers.map(w => [w.id, w]));
  const deviceById = new Map(devices.map(d => [d.id, d]));
  const mediaByWorker = new Map((media.workloads ?? []).filter(row => row.worker_id && !MEDIA_TERMINAL.has(row.state)).map(row => [row.worker_id, row]));
  const nativeBusy = new Set((media.native_engines ?? []).filter(row => row.state === 'busy' && Number.isFinite(row.observed_at) && now >= row.observed_at && now - row.observed_at < NATIVE_FRESH_MS).map(row => row.worker_id));
  const entries = members.map(member => {
    const worker = byId.get(member.id) ?? null;
    const device = deviceById.get(member.id) ?? null;
    const workload = mediaByWorker.get(member.id) ?? null;
    const busy = !!workload || nativeBusy.has(member.id);
    const detail = workload ? `${workload.kind ?? 'media'} · ${workload.state}${workload.phase ? ` · ${workload.phase}` : ''}` : nativeBusy.has(member.id) ? 'native engine busy' : '';
    return catalogueEntry({ member, worker, device, mediaBusy: busy, mediaDetail: detail, routes, now });
  });
  entries.sort((a, b) => (CATALOGUE_RANK[a.state] ?? 99) - (CATALOGUE_RANK[b.state] ?? 99) || a.id.localeCompare(b.id));
  // Disagreement flags, honestly derived, never auto-repaired:
  const warnings = [];
  const enrolled = new Set(members.map(m => m.id));
  for (const [name, ids] of Object.entries(routes)) {
    for (const id of ids ?? []) {
      const w = byId.get(id);
      if (!enrolled.has(id)) warnings.push(`route ${name} targets ${id}, which has no enrolled scripts`);
      if (!w) warnings.push(`route ${name} targets ${id}, which is not a current gateway worker`);
      else {
        if (w.drained) warnings.push(`route ${name} targets ${id}, which is routing-paused`);
        if (w.is_healthy === false) warnings.push(`route ${name} targets ${id}, which is not healthy`);
      }
    }
  }
  for (const worker of workers) {
    if (!enrolled.has(worker.id)) warnings.push(`gateway worker ${worker.id} has no enrolled power scripts — it cannot be started or stopped from here`);
  }
  return { entries, warnings, built_at: now };
}
