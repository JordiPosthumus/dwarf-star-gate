import http from 'node:http';
import { StringDecoder } from 'node:string_decoder';

export function safeQuarantine(raw) {
  if(!raw || !['fatal_accelerator_error','accelerator_checkpoint_failure','repeated_inference_failures'].includes(raw.reason))return null;
  return {reason:raw.reason,...(typeof raw.at==='string' && Number.isFinite(Date.parse(raw.at))?{at:raw.at}:{}),
    ...(typeof raw.request_id==='string' && /^[a-f0-9-]{36}$/.test(raw.request_id)?{request_id:raw.request_id}:{})};
}

// Inspect error envelopes only, never quoted text in a normal model answer.
// Retain only a bounded transient line/body, and persist only an enum reason.
export class GenerationFaultObserver {
  constructor(sse = false) { this.sse=sse;this.pending='';this.decoder=new StringDecoder('utf8');this.overflow=false;this.fault=null; }
  inspect(text) {
    try {
      const data=JSON.parse(text), message=data?.error?.message ??
        (data?.type==='response.failed' && data.response?.status==='failed'?data.response.error?.message:null) ??
        (['invalid_request_error','server_error','api_error'].includes(data?.type)?data.message:null);
      if(typeof message!=='string')return;
      if(/(?:illegal memory access|device-side assert)/i.test(message))this.fault='fatal_accelerator_error';
      else if(/^(?:cuda|metal) (?:prefill state reset failed|resumed prefill failed while extending checkpoint|decode failed while extending checkpoint)/i.test(message))this.fault='accelerator_checkpoint_failure';
    } catch { /* Unsupported evidence is unknown, not proof of a healthy engine. */ }
  }
  accept(chunk) {
    // Split before accumulating: one enormous upstream chunk cannot grow state.
    for(let i=0;i<chunk.length;i+=4096) {
      const text=this.decoder.write(chunk.subarray(i,i+4096));
      if(!this.sse) {if(!this.overflow){this.pending+=text;if(this.pending.length>65536){this.pending='';this.overflow=true;}}continue;}
      for(const [j,part] of text.split('\n').entries()) {
        if(j){this.line();this.pending='';this.overflow=false;}
        if(!this.overflow){this.pending+=part;if(this.pending.length>65536){this.pending='';this.overflow=true;}}
      }
    }
  }
  line() {if(!this.overflow && this.pending.startsWith('data:'))this.inspect(this.pending.slice(5).trim());}
  finish() {
    if(this.sse)this.line();else if(!this.overflow)this.inspect(this.pending);
    this.pending='';return this.fault;
  }
}

// Explicit operator recovery only, on an isolated idle endpoint. No model-server
// settings change. The synthetic request has its own small output/time budget.
export function verifyGeneration(url, model) {
  return new Promise((resolve,reject)=>{
    const req=http.request(new URL('/v1/chat/completions',url),{method:'POST',agent:false,headers:{'content-type':'application/json'}},res=>{
      let body='';
      res.on('data',chunk=>{body+=chunk.toString('utf8');if(body.length>65536)req.destroy(new Error('Recovery response too large'));});
      res.on('error',reject);
      res.on('end',()=>{
        try {
          const data=JSON.parse(body),choice=data.choices?.[0];
          if(res.statusCode!==200 || data.error || choice?.finish_reason!=='stop' || choice?.message?.content?.trim()!=='DSG_RECOVERY_OK')throw new Error('Recovery generation did not pass');
          resolve({verified_at:new Date().toISOString(),check:'generation_exact_marker'});
        } catch {reject(new Error('Recovery generation did not pass; worker remains quarantined'));}
      });
    });
    const timer=setTimeout(()=>req.destroy(new Error('Recovery generation timed out; worker remains quarantined')),20000);
    req.once('close',()=>clearTimeout(timer));req.on('error',reject);
    req.end(JSON.stringify({model,stream:false,max_tokens:32,temperature:0,thinking:{type:'disabled'},reasoning_effort:'none',messages:[{role:'user',content:'Reply with exactly DSG_RECOVERY_OK and nothing else.'}]}));
  });
}
