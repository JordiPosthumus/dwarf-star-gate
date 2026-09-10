import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';

// Inference endpoints own model selection and tokenization. DSG only validates
// the advertised pool capacity and transports the original request bytes.
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

const capacity = value => Number.isSafeInteger(value) && value > 0 ? value : null;
export function endpointMetadata(worker, data, { model, model_agnostic = false } = {}) {
  const models = Array.isArray(data?.data) ? data.data.filter(m => m && typeof m.id === 'string' && m.id.length) : [];
  const aliasIds=Object.values(worker.model_aliases??{});
  if(aliasIds.some(id=>!models.some(m=>m.id===id)))return {available:false,contextLength:null,probeModel:null};
  const candidates = model_agnostic || worker.backend === 'openai' ? models : models.filter(m => m.id === model);
  const configured = capacity(worker.context_length);
  const limits = candidates.map(m => {
    const reported = capacity(m.context_length) ?? capacity(m.max_model_len) ?? capacity(m.top_provider?.context_length);
    return reported && configured ? Math.min(reported, configured) : reported ?? configured;
  });
  return {
    available: candidates.length > 0,
    contextLength: limits.length && limits.every(n => n !== null) ? Math.min(...limits) : null,
    // Used only for an explicit operator recovery canary, never for inference.
    probeModel: candidates[0]?.id,
  };
}
