import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';

// Endpoints own tokenization. The logical pool name resolves from their existing
// model discovery; explicit model names and the rest of each request stay intact.
export function endpointUrl(worker, route) {
  if (worker.backend !== 'openai') return new URL(route, worker.url);
  const base = worker.url.replace(/\/$/, '');
  return new URL(base + route.replace(/^\/v1(?=\/|$)/, ''));
}

export const endpointTransport = url => url.protocol === 'https:' ? https : http;

export function endpointHeaders(worker) {
  if (!worker.api_key_file) return {};
  let token;
  try {
    const stat = fs.statSync(worker.api_key_file);
    if (!stat.isFile() || stat.size > 8192 || (stat.mode & 0o077)) throw new Error();
    token = fs.readFileSync(worker.api_key_file, 'utf8').trim();
    if (!token || /[\r\n\x00-\x1f\x7f]/.test(token)) throw new Error();
  } catch { throw new Error('Endpoint credential unavailable; use a private token file (mode 600)'); }
  return { authorization: `Bearer ${token}` };
}

// Reuse /models from the normal health probe; no extra poll or per-call lookup.
// A valid explicit target wins on multi-model servers. A single-model server
// needs no manually maintained PoolModel alias, even after a model replacement.
export function endpointAliases(worker, data, {model, model_agnostic=false}={}) {
  const aliases={...worker.model_aliases};
  if(!model||!(model_agnostic||worker.backend==='openai'))return aliases;
  const ids=[...new Set((Array.isArray(data?.data)?data.data:[]).map(m=>m?.id).filter(id=>typeof id==='string'&&id.length))];
  const target=ids.includes(aliases[model])?aliases[model]:ids.includes(model)?model:ids.length===1?ids[0]:null;
  if(target)aliases[model]=target;
  else delete aliases[model]; // Never select an arbitrary model from a catalogue.
  return aliases;
}

const capacity = value => Number.isSafeInteger(value) && value > 0 ? value : null;
export function endpointMetadata(worker, data, { model, model_agnostic = false } = {}) {
  const models = Array.isArray(data?.data) ? data.data.filter(m => m && typeof m.id === 'string' && m.id.length) : [];
  const aliasIds=Object.values(worker.model_aliases??{});
  // Dormant aliases must not take a healthy model-agnostic pool worker offline.
  if(!model_agnostic&&worker.backend!=='openai'&&aliasIds.some(id=>!models.some(m=>m.id===id)))return {available:false,contextLength:null,probeModel:null};
  const aliases=endpointAliases(worker,data,{model,model_agnostic});
  const candidates = model_agnostic || worker.backend === 'openai' ? models : models.filter(m => m.id === model);
  const configured = capacity(worker.context_length);
  const limits = candidates.map(m => {
    const reported = capacity(m.context_length) ?? capacity(m.max_model_len) ?? capacity(m.top_provider?.context_length);
    return reported && configured ? Math.min(reported, configured) : reported ?? configured;
  });
  return {
    available: candidates.length > 0,
    contextLength: limits.length && limits.every(n => n !== null) ? Math.min(...limits) : null,
    aliases,
    probeModel: aliases[model] ?? candidates[0]?.id,
  };
}
