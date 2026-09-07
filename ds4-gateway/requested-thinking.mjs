// Observation only: never modify, gate or re-encode an inference request.
// This is a metadata capture budget, NOT an upload/context/output limit.
export const THINKING_CAPTURE_BYTES = 8 * 1024 * 1024;
const efforts = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const types = new Set(['enabled', 'disabled', 'adaptive']);
const statuses = new Set(['pending', 'specified', 'not_specified', 'unavailable']);
const reasons = new Set(['capture_limit', 'invalid_json', 'encoded_body', 'incomplete_body']);
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const own = (v, k) => Object.hasOwn(v, k);
function scalar(key, value) {
  if (value === null) return null;
  if (key === 'thinking' || key === 'think' || key === 'enable_thinking') return typeof value === 'boolean' ? value : 'unrecognized';
  if (key === 'thinking.budget_tokens') return Number.isSafeInteger(value) && value >= 0 ? value : 'unrecognized';
  return (key === 'thinking.type' ? types : efforts).has(value) ? value : 'unrecognized';
}
const keys = ['think', 'reasoning_effort', 'reasoning.effort', 'output_config.effort', 'thinking', 'thinking.type', 'thinking.budget_tokens', 'enable_thinking'];

// Re-allowlist at the dashboard boundary as well as during body observation.
export function safeRequestedThinking(raw) {
  if (!object(raw) || !statuses.has(raw.status)) return null;
  const result = { status: raw.status };
  if (reasons.has(raw.reason)) result.reason = raw.reason;
  if (raw.status === 'specified' && object(raw.fields)) {
    result.fields = {};
    for (const key of keys) if (own(raw.fields, key)) result.fields[key] = scalar(key, raw.fields[key]);
  }
  if (object(raw.served) && ['high','max','none'].includes(raw.served.mode) && raw.served.basis === 'ds4_request_rules') result.served = {mode:raw.served.mode,basis:'ds4_request_rules'};
  return result;
}

export function requestedThinking(body) {
  if (!object(body)) return { status: 'unavailable', reason: 'invalid_json' };
  const fields = {};
  for (const key of ['reasoning_effort', 'think', 'enable_thinking']) if (own(body, key)) fields[key] = scalar(key, body[key]);
  for (const parent of ['reasoning', 'output_config']) {
    if (object(body[parent]) && own(body[parent], 'effort')) fields[`${parent}.effort`] = scalar(`${parent}.effort`, body[parent].effort);
    else if (own(body, parent) && body[parent] !== null && !object(body[parent])) fields[`${parent}.effort`] = 'unrecognized';
  }
  if (object(body.thinking)) {
    for (const key of ['type', 'budget_tokens']) if (own(body.thinking, key)) fields[`thinking.${key}`] = scalar(`thinking.${key}`, body.thinking[key]);
    // Do not mistake an unfamiliar thinking object for an omitted setting.
    if (!own(body.thinking, 'type') && !own(body.thinking, 'budget_tokens')) fields.thinking = 'unrecognized';
  } else if (own(body, 'thinking')) fields.thinking = scalar('thinking', body.thinking);
  return Object.keys(fields).length ? { status: 'specified', fields } : { status: 'not_specified' };
}

// Derived mode for the verified DeepSeek DS4 parser, not engine telemetry.
// Unknown models/routes stay unknown; observation never changes forwarding.
export function servedThinking(body, {route, model, contextLength} = {}) {
  if (!object(body) || model !== 'deepseek-v4-flash' || !['/v1/chat/completions','/v1/completions','/v1/messages','/v1/responses'].includes(route)) return null;
  const name=body.model ?? model;
  if (!['deepseek-v4-flash','deepseek-chat','deepseek-reasoner'].includes(name)) return null;
  let enabled=true, explicit=false, effort='high';
  const controls=[], levels=[];
  for (const [key,value] of Object.entries(body)) {
    if (key === 'thinking' && route!=='/v1/responses') {
      explicit=true;
      if (typeof value==='boolean') controls.push(value);
      else if (object(value) && own(value,'type')) {
        if(typeof value.type!=='string') return null;
        if(value.type==='enabled') controls.push(true);
        if(value.type==='disabled') controls.push(false);
      }
    }
    if(key==='think' && ['/v1/chat/completions','/v1/completions'].includes(route)) {
      explicit=true;if(typeof value!=='boolean')return null;controls.push(value);
    }
    let candidate;
    if(key==='reasoning_effort' && route!=='/v1/responses') candidate=value;
    if(key==='reasoning' && route==='/v1/responses' && object(value)) {candidate=value.effort;if(candidate!=null)explicit=true;}
    if(key==='output_config' && route==='/v1/messages' && object(value)) candidate=value.effort;
    if(candidate!=null) {
      if(!efforts.has(candidate))return null;
      effort=candidate==='max'?'max':candidate==='none'?'none':'high';levels.push(effort);
    }
  }
  // Differing controls can depend on duplicate-key ordering lost by JSON.parse.
  if(new Set(controls).size>1||new Set(levels).size>1)return null;
  if(controls.length)enabled=controls[0];
  if(!explicit && name==='deepseek-chat')enabled=false;
  let mode=!enabled||effort==='none'?'none':effort;
  if(mode==='max') {
    if(!Number.isSafeInteger(contextLength)||contextLength<=0)return null;
    if(contextLength<393216)mode='high';
  }
  return {mode,basis:'ds4_request_rules'};
}

export class RequestedThinkingObserver {
  constructor(encoding, onBody = null, serving = null) {
    this.serving=serving;
    this.onBody=onBody;this.notified=false;
    this.result = encoding && encoding !== 'identity' ? { status: 'unavailable', reason: 'encoded_body' } : { status: 'pending' };
    this.chunks = []; this.bytes = 0;
  }
  accept(chunk) {
    if (this.result.status !== 'pending') return;
    this.bytes += chunk.length;
    if (this.bytes > THINKING_CAPTURE_BYTES) {
      this.chunks = []; this.result = { status: 'unavailable', reason: 'capture_limit' };
    } else this.chunks.push(chunk);
  }
  finish() {
    let body;
    if (this.result.status === 'pending') {
      try { body=JSON.parse(Buffer.concat(this.chunks, this.bytes).toString('utf8'));this.result = requestedThinking(body); }
      catch { this.result = { status: 'unavailable', reason: 'invalid_json' }; }
    }
    this.chunks = [];
    const served=this.serving && servedThinking(body,this.serving);
    if(served)this.result.served=served;
    if(!this.notified){this.notified=true;try{this.onBody?.(body,this.result);}catch{/* Optional evidence cannot break forwarding. */}}
    return this.result;
  }
  dispose() {
    this.chunks = [];
    if (this.result.status === 'pending') this.result = { status: 'unavailable', reason: 'incomplete_body' };
    if(!this.notified){this.notified=true;try{this.onBody?.(undefined,this.result);}catch{/* Observation only. */}}
  }
}
