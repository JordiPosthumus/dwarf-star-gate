// Passive, private evidence. No request/response bodies or arbitrary log fields.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { safeRequestedThinking } from './requested-thinking.mjs';

const number = x => Number.isFinite(x) && x >= 0 ? x : null;
const id = x => typeof x === 'string' && /^[\w-]{1,64}$/.test(x) ? x : null;
const kinds = new Set(['decision','dispatch','finish','queued_cancel','queue_timeout','unavailable_before_dispatch']);
export function evidence(kind, raw) {
  if (!kinds.has(kind)) return null;
  const row = { kind, request_id:id(raw.request_id), node:id(raw.node) };
  if (!row.request_id) return null;
  for (const k of ['queue_ms','service_ms','total_ms','first_body_byte_ms','request_bytes','context_length']) if (k in raw) row[k]=number(raw[k]);
  if (['new','existing','none','reassigned'].includes(raw.affinity)) row.affinity=raw.affinity;
  if (['genie','unclassified'].includes(raw.traffic_class)) row.traffic_class=raw.traffic_class;
  if (typeof raw.session==='string' && /^[a-f0-9]{64}$/.test(raw.session)) row.session=raw.session;
  if (['complete','client_cancelled','upstream_error','upstream_stream_error','upstream_aborted','upstream_http_error','incomplete_sse','connection_closed','timeout'].includes(raw.outcome)) row.outcome=raw.outcome;
  if (raw.usage) row.usage=Object.fromEntries(['prompt_tokens','completion_tokens','cached_tokens'].map(k=>[k,number(raw.usage[k])]));
  if(kind==='finish')row.finish_reason=['stop','length','tool_calls','function_call','content_filter'].includes(raw.finish_reason)?raw.finish_reason:null;
  if (raw.requested_thinking) row.requested_thinking=safeRequestedThinking(raw.requested_thinking);
  if (Array.isArray(raw.candidates)) {
    row.candidates=raw.candidates.slice(0,128).map(w=>({node:id(w.node), healthy:w.healthy===true, paused:w.paused===true,
      active:number(w.active), queued:number(w.queued), assigned_sessions:number(w.assigned_sessions), context_length:number(w.context_length),
      profile:/^[a-f0-9]{64}$/.test(w.profile)?w.profile:null}));
    row.candidates_truncated=raw.candidates.length>128;
  }
  return row;
}

export class Dataset {
  constructor(directory, {enabled=false, maxBytes=1024**3, maxPending=512}={}) {
    this.directory=directory; this.enabled=enabled; this.maxBytes=maxBytes; this.maxPending=maxPending;
    this.run=randomUUID(); this.queue=[]; this.writing=null; this.closed=false;
    this.state={enabled,run_id:this.run,written:0,dropped:0,bytes:0,last_write:null,error:null,
      schema:1,raw_text:false,embeddings:false,retention:'No automatic deletion',finished:0,missing_usage:0,truncated:0,failed_or_cancelled:0};
    this.ready=enabled ? this.initialize() : Promise.resolve();
  }
  async initialize() {
    try {
      await fs.mkdir(this.directory,{recursive:true,mode:0o700});
      for (const file of await fs.readdir(this.directory)) if (/^routing-\d{4}-\d{2}-\d{2}\.jsonl$/.test(file)) this.state.bytes+=(await fs.stat(path.join(this.directory,file))).size;
    } catch {this.state.error='Dataset directory unavailable';}
  }
  record(kind, raw) {
    if (!this.enabled || this.closed) return;
    try {
      const row=evidence(kind,raw); if(!row)return;
      const line=JSON.stringify({schema:1,run_id:this.run,event_id:randomUUID(),time:new Date().toISOString(),...row})+'\n';
      if(Buffer.byteLength(line)>65536 || this.queue.length>=this.maxPending) {this.state.dropped++;return;}
      this.queue.push(line); this.flush();
    } catch {this.state.dropped++;this.state.error='Evidence serialization failed';}
  }
  flush() {
    if(this.writing)return;
    this.writing=(async()=>{
      await this.ready;
      while(this.queue.length) {
        const lines=this.queue.splice(0,32), body=lines.join(''), bytes=Buffer.byteLength(body);
        if(this.state.error || this.state.bytes+bytes>this.maxBytes) {
          this.state.error ||= 'Dataset storage budget reached; collection paused, inference unchanged'; this.state.dropped+=lines.length; continue;
        }
        let handle;
        try {
          handle=await fs.open(path.join(this.directory,`routing-${new Date().toISOString().slice(0,10)}.jsonl`),'a',0o600);
          await handle.writeFile(body); await handle.sync();
          this.state.bytes+=bytes;this.state.written+=lines.length;this.state.last_write=Date.now();
          for(const line of lines){const row=JSON.parse(line);if(row.kind==='finish'){
            this.state.finished++;if(row.usage?.prompt_tokens==null||row.usage?.completion_tokens==null)this.state.missing_usage++;
            if(row.finish_reason==='length')this.state.truncated++;if(row.outcome!=='complete')this.state.failed_or_cancelled++;
          }}
        } catch {this.state.error='Dataset write failed; inference unchanged';this.state.dropped+=lines.length;}
        finally {await handle?.close().catch(()=>{});}
      }
    })().catch(()=>{this.state.error='Dataset writer failed';}).finally(()=>{this.writing=null;if(this.queue.length)this.flush();});
  }
  snapshot() {return {...this.state,pending:this.queue.length};}
  async close() {this.closed=true;await this.ready;while(this.writing)await this.writing;}
}
