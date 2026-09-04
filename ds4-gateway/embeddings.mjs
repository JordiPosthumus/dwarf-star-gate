// Optional observation, never an admission or forwarding dependency.
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
export const ENCODER_MODEL='sentence-transformers/all-MiniLM-L6-v2';
export const ENCODER_REVISION='1110a243fdf4706b3f48f1d95db1a4f5529b4d41';
export const EXTRACTION='visible-head-tail-v1';
const MAX_CHARS=8192;
const object=x=>x && typeof x==='object' && !Array.isArray(x);
const finite=x=>typeof x==='number'&&Number.isFinite(x)&&x>=0;
function contentShape(content) {
  if(typeof content==='string')return {characters:content.length,images:0};
  if(!Array.isArray(content))return {characters:0,images:0};
  let characters=0,images=0;
  for(const part of content.slice(-256))if(object(part)){
    if(['text','input_text','output_text'].includes(part.type)&&typeof part.text==='string')characters+=part.text.length;
    else if(['image','image_url','input_image'].includes(part.type))images++;
  }
  return {characters,images};
}
function visible(content) {
  if(typeof content==='string')return content.slice(-MAX_CHARS);
  if(!Array.isArray(content))return '';
  return content.slice(-64).filter(x=>object(x)&&['text','input_text','output_text'].includes(x.type)&&typeof x.text==='string')
    .map(x=>x.text.slice(-MAX_CHARS)).join('\n').slice(-MAX_CHARS);
}
export function extractRequest(body,route) {
  if(!object(body))return {status:'invalid_body'};
  let messages;
  if(['/v1/chat/completions','/v1/messages'].includes(route))messages=body.messages;
  else if(route==='/v1/responses')messages=typeof body.input==='string'?[{role:'user',content:body.input}]:body.input;
  else return {status:'unsupported_route'};
  if(!Array.isArray(messages))return {status:'unsupported_body'};
  // Bounded suffix only; system/developer/tool/hidden-thinking/image content is
  // never passed to the encoder. This is NOT a truncation of the forwarded body.
  const tail=messages.slice(-256),eligible=tail.filter(x=>object(x)&&['user','assistant'].includes(x.role)&&(!x.type||x.type==='message'));
  const roles={user:0,assistant:0,system:0,tool:0};let textCharacters=0,imageParts=0;
  for(const message of tail)if(object(message)){
    if(message.role in roles)roles[message.role]++;
    const shape=contentShape(message.content);textCharacters+=shape.characters;imageParts+=shape.images;
  }
  let last=-1;for(let i=eligible.length-1;i>=0;i--)if(eligible[i].role==='user'){last=i;break;}
  if(last<0)return {status:'no_recent_user_text'};
  const latest=visible(eligible[last].content),recent=eligible.slice(Math.max(0,last-8),last).map(x=>`${x.role}: ${visible(x.content)}`).join('\n').slice(-MAX_CHARS);
  if(!latest)return {status:'no_recent_user_text'};
  const maxOutput=[body.max_completion_tokens,body.max_tokens].find(finite)??null;
  return {status:'ready',texts:[latest,...(recent?[recent]:[])],scopes:['latest_user',...(recent?['recent_conversation']:[])],
    extraction:EXTRACTION,visible_messages_considered:eligible.length,latest_characters:latest.length,recent_characters:recent.length,
    message_count:messages.length,user_messages:roles.user,assistant_messages:roles.assistant,system_messages:roles.system,tool_messages:roles.tool,
    text_characters:textCharacters,image_parts:imageParts,tool_definitions:Array.isArray(body.tools)?body.tools.length:0,
    max_output_tokens:maxOutput,temperature:finite(body.temperature)?body.temperature:null,top_p:finite(body.top_p)?body.top_p:null,
    request_stream:typeof body.stream==='boolean'?body.stream:null,request_route:route,
    bounded_slice:true,history_scan_limited:messages.length>256};
}

export class EmbeddingCollector {
  constructor(config,record,{spawnImpl=spawn,workerFile=fileURLToPath(new URL('./encoder/worker.py',import.meta.url)),timeoutMs=20000,maxPending=16}={}) {
    this.config=config;this.record=record;this.spawnImpl=spawnImpl;this.workerFile=workerFile;this.timeoutMs=timeoutMs;this.maxPending=maxPending;
    this.queue=[];this.active=null;this.child=null;this.timer=null;this.closed=false;this.retryAfter=0;
    this.state={enabled:config?.enabled===true,ready:false,model:ENCODER_MODEL,revision:ENCODER_REVISION,dimensions:384,
      extraction:EXTRACTION,observed:0,completed:0,dropped:0,failed:0,missing:0,last_ready_at:null,last_duration_ms:null,error:null};
    if(this.state.enabled)this.start();
  }
  start() {
    if(this.closed||this.child||Date.now()<this.retryAfter)return;
    if(!path.isAbsolute(this.config.python||'')||!path.isAbsolute(this.config.model_dir||'')) {this.state.error='absolute_local_encoder_paths_required';return;}
    let child;
    try {child=this.spawnImpl(this.config.python,['-u',this.workerFile,this.config.model_dir],{stdio:['pipe','pipe','ignore'],env:{...process.env,TOKENIZERS_PARALLELISM:'false',OMP_NUM_THREADS:'1'}});}
    catch {this.fail('worker_unavailable');return;}
    this.child=child;let buffer='';
    this.timer=setTimeout(()=>this.fail('worker_timeout'),this.timeoutMs);this.timer.unref?.();
    child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{
      if(this.child!==child)return;
      buffer+=chunk;if(Buffer.byteLength(buffer)>65536){this.fail('invalid_worker_output');return;}
      let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);
        try{this.receive(JSON.parse(line));}catch{this.fail('invalid_worker_output');return;}}
    });
    child.stdin.on('error',()=>{if(this.child===child)this.fail('worker_unavailable');});
    child.on('error',()=>{if(this.child===child)this.fail('worker_unavailable');});
    child.on('exit',()=>{if(this.child===child)this.fail('worker_unavailable');});
  }
  observe(body,thinking,meta) {
    if(!this.state.enabled||this.closed||meta.traffic_class==='genie')return;
    this.state.observed++;
    const extracted=body?extractRequest(body,meta.route):{status:thinking?.reason||'incomplete_body'};
    const features={...meta,...extracted,requested_thinking:thinking,available_at:Date.now()};delete features.texts;delete features.scopes;
    this.record('request_features',features);
    if(extracted.status!=='ready'){this.state.missing++;return;}
    if(this.queue.length+(this.active?1:0)>=this.maxPending){this.state.dropped++;this.record('embedding',{...meta,status:'queue_full',extraction:EXTRACTION});return;}
    this.queue.push({meta,extracted,queued_at:Date.now()});this.start();
    if(!this.child){this.fail('worker_unavailable');return;}
    this.pump();
  }
  pump() {
    if(!this.state.ready||this.active||!this.child||!this.queue.length||this.closed)return;
    this.active=this.queue.shift();
    const wire=JSON.stringify({id:this.active.meta.request_id,texts:this.active.extracted.texts})+'\n';
    delete this.active.extracted.texts;
    this.timer=setTimeout(()=>this.fail('worker_timeout'),this.timeoutMs);this.timer.unref?.();
    this.child.stdin.write(wire);
  }
  receive(value) {
    if(value.ready===true){
      if(this.state.ready||value.model!==ENCODER_MODEL||value.revision!==ENCODER_REVISION||value.dimensions!==384)throw new Error('contract');
      clearTimeout(this.timer);this.state.ready=true;this.state.error=null;this.pump();return;
    }
    if(!this.active||value.error||value.id!==this.active.meta.request_id||!Array.isArray(value.results)||value.results.length!==this.active.extracted.scopes.length)throw new Error('response');
    const vectors={};
    for(let i=0;i<value.results.length;i++){
      const r=value.results[i];if(!Array.isArray(r.vector)||r.vector.length!==384||!r.vector.every(Number.isFinite)||!Number.isInteger(r.input_tokens)||r.input_tokens<1||r.used_tokens!==Math.min(r.input_tokens,256)||r.truncated!==(r.input_tokens>256))throw new Error('vector');
      const norm=Math.hypot(...r.vector);if(Math.abs(norm-1)>.001)throw new Error('normalization');
      vectors[this.active.extracted.scopes[i]]=r;
    }
    if(!Number.isFinite(value.elapsed_ms)||value.elapsed_ms<0)throw new Error('timing');
    clearTimeout(this.timer);const now=Date.now();
    this.record('embedding',{...this.active.meta,status:'ready',model:ENCODER_MODEL,revision:ENCODER_REVISION,extraction:EXTRACTION,dimensions:384,
      vectors,available_at:now,queued_at:this.active.queued_at,elapsed_ms:value.elapsed_ms});
    this.state.completed++;this.state.last_ready_at=now;this.state.last_duration_ms=value.elapsed_ms;this.active=null;this.pump();
  }
  fail(reason) {
    clearTimeout(this.timer);const child=this.child;this.child=null;this.state.ready=false;this.state.error=reason;this.retryAfter=Date.now()+60000;
    child?.kill('SIGTERM');
    for(const job of [...(this.active?[this.active]:[]),...this.queue]){this.state.failed++;this.record('embedding',{...job.meta,status:reason,extraction:EXTRACTION});}
    this.active=null;this.queue=[];
  }
  snapshot(){return {...this.state,pending:this.queue.length,active:!!this.active};}
  close(){this.closed=true;this.fail('collector_stopped');}
}
