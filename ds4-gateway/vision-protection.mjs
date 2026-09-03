import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';

const JPEG_PREFIXES=['data:image/jpeg;base64,','data:image/jpg;base64,'];
const PNG_MAGIC=Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]);
const DEFAULT_MAX_REQUEST=64*1024*1024;
const DEFAULT_MAX_IMAGE=48*1024*1024;
const DEFAULT_MAX_NORMALIZED=192*1024*1024;
export const JPEG_REJECTION_INSPECTION_BYTES=64*1024;
export const JPEG_GUIDANCE='DSG: DS4 could not use this JPEG file. Please resend it as PNG or WebP, or export it again as a standard RGB JPEG. Nothing was generated from the rejected file, and your session remains active.';

function boundedInteger(value,fallback,min,max,name){
  const n=value??fallback;
  if(!Number.isSafeInteger(n)||n<min||n>max)throw new Error(`${name} is outside its supported range`);
  return n;
}

function commandFor(config={}){
  if(config.transcoder==='none')return null;
  const allowed={
    sips:['/usr/bin/sips'],
    magick:['/opt/homebrew/bin/magick','/usr/local/bin/magick','/usr/bin/magick'],
    convert:['/usr/local/bin/convert','/usr/bin/convert'],
  };
  const choice=config.transcoder??'auto';
  if(choice!=='auto'&&!Object.hasOwn(allowed,choice))throw new Error('vision_compatibility.transcoder must be auto, sips, magick, convert or none');
  // Decoding untrusted images is a security boundary. The stock macOS decoder is
  // safe to auto-discover on macOS; ImageMagick must be selected explicitly.
  const groups=choice==='auto'?(process.platform==='darwin'?['sips']:[]):[choice];
  for(const kind of groups)for(const executable of allowed[kind])if(fs.existsSync(executable))return {kind,executable};
  return null;
}

function strictBase64(value){
  if(typeof value!=='string'||value.length===0||value.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(value))return null;
  const decoded=Buffer.from(value,'base64');
  return decoded.toString('base64')===value?decoded:null;
}

function dataUriRef(owner,key){
  const value=owner?.[key];
  if(typeof value!=='string')return null;
  const prefix=JPEG_PREFIXES.find(candidate=>value.startsWith(candidate));
  return prefix?{get:()=>value.slice(prefix.length),set:data=>{owner[key]=`data:image/png;base64,${data}`;}}:null;
}

function collectOpenAIContent(content,refs){
  if(!Array.isArray(content))return;
  for(const block of content){
    if(!block||typeof block!=='object')continue;
    if(block.type==='image_url'){
      const ref=typeof block.image_url==='string'?dataUriRef(block,'image_url'):dataUriRef(block.image_url,'url');
      if(ref)refs.push(ref);
    }
  }
}

function imageRefs(payload,route){
  const refs=[];
  // The first release deliberately supports the Pi/OpenAI Chat Completions path
  // only. Returning a synthetic success in a mismatched streaming protocol would
  // be worse than forwarding the original engine error.
  if(route==='/v1/chat/completions')for(const message of Array.isArray(payload.messages)?payload.messages:[])collectOpenAIContent(message?.content,refs);
  return refs;
}

function run(executable,args,timeoutMs,tmpdir){
  return new Promise((resolve,reject)=>{
    const child=spawn(executable,args,{stdio:['ignore','ignore','ignore'],env:{PATH:'/usr/bin:/bin:/usr/sbin:/sbin',TMPDIR:tmpdir}});
    let settled=false,timedOut=false;
    const finish=error=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve();};
    child.once('error',()=>finish(new Error('transcoder_start_failed')));
    child.once('close',code=>finish(code===0?null:new Error(timedOut?'transcoder_timeout':'transcoder_failed')));
    const timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL');},timeoutMs);timer.unref?.();
  });
}

export function isRejectedJpeg(status,body){
  if(status!==400||!Buffer.isBuffer(body)||body.length>JPEG_REJECTION_INSPECTION_BYTES)return false;
  try{
    const parsed=JSON.parse(body.toString('utf8')),message=parsed?.error?.message??parsed?.message;
    return message==='invalid or unsupported JPEG image';
  }catch{return false;}
}

export function visionGuidance({stream,model,requestId,now=Date.now()}){
  const created=Math.floor(now/1000),id=`chatcmpl-dsg-${requestId}`;
  if(stream===true){
    const first={id,object:'chat.completion.chunk',created,model,choices:[{index:0,delta:{role:'assistant',content:JPEG_GUIDANCE},finish_reason:null}]};
    const last={id,object:'chat.completion.chunk',created,model,choices:[{index:0,delta:{},finish_reason:'stop'}]};
    return {contentType:'text/event-stream; charset=utf-8',format:'sse',body:Buffer.from(`data: ${JSON.stringify(first)}\n\ndata: ${JSON.stringify(last)}\n\ndata: [DONE]\n\n`)};
  }
  const body={id,object:'chat.completion',created,model,choices:[{index:0,message:{role:'assistant',content:JPEG_GUIDANCE},finish_reason:'stop'}]};
  return {contentType:'application/json; charset=utf-8',format:'json',body:Buffer.from(JSON.stringify(body))};
}

export class VisionProtection{
  constructor(config,store,runtime,{transcode}={}){
    this.config=config??{};this.store=store;this.runtime=runtime;
    this.maxRequest=boundedInteger(this.config.max_request_bytes,DEFAULT_MAX_REQUEST,1024,256*1024*1024,'vision_compatibility.max_request_bytes');
    this.maxImage=boundedInteger(this.config.max_image_bytes,DEFAULT_MAX_IMAGE,1024,128*1024*1024,'vision_compatibility.max_image_bytes');
    this.maxNormalized=boundedInteger(this.config.max_normalized_bytes,DEFAULT_MAX_NORMALIZED,1024,512*1024*1024,'vision_compatibility.max_normalized_bytes');
    this.timeoutMs=boundedInteger(this.config.timeout_ms,30000,1000,120000,'vision_compatibility.timeout_ms');
    this.command=transcode?{kind:'test',executable:null}:commandFor(this.config);this.transcodeOverride=transcode;
    this.rescued=0;this.guided=0;this.failed=0;this.last=null;
  }
  get available(){return !!(this.transcodeOverride||this.command);}
  // Guidance-only protection remains useful when no local converter is
  // available: the exact pre-generation rejection still becomes a normal,
  // actionable assistant turn instead of killing the client session.
  get enabled(){return (this.store.data.protections?.vision_jpeg??this.config.enabled)===true;}
  status(){return {schema:1,vision_jpeg:{available:this.available,enabled:this.enabled,transcoder:this.command?.kind??null,max_request_bytes:this.maxRequest,max_image_bytes:this.maxImage,max_normalized_bytes:this.maxNormalized,rescued:this.rescued,guided:this.guided,failed:this.failed,last:this.last}};}
  set(input){
    if(!input||Array.isArray(input)||Object.keys(input).sort().join(',')!=='enabled,id'||input.id!=='vision_jpeg'||typeof input.enabled!=='boolean')throw new Error('Specify protection id vision_jpeg and enabled true or false');
    const protections={...this.store.data.protections,vision_jpeg:input.enabled};
    this.store.save({...this.store.data,protections});
    return this.status();
  }
  captureLimit(route,encoding){return this.enabled&&route==='/v1/chat/completions'&&!encoding?this.maxRequest:0;}
  async transcode(encoded){
    if(this.transcodeOverride){
      const result=await this.transcodeOverride(encoded);
      if(!Buffer.isBuffer(result)||result.length<PNG_MAGIC.length||!result.subarray(0,PNG_MAGIC.length).equals(PNG_MAGIC))throw new Error('transcoder_output_invalid');
      return result;
    }
    if(!this.command)throw new Error('transcoder_unavailable');
    const root=path.join(this.runtime,'vision-compat');
    await fs.promises.mkdir(root,{recursive:true,mode:0o700});await fs.promises.chmod(root,0o700);
    const directory=await fs.promises.mkdtemp(path.join(root,'attempt-'));await fs.promises.chmod(directory,0o700);
    const input=path.join(directory,'input.jpg'),output=path.join(directory,'output.png');
    try{
      await fs.promises.writeFile(input,encoded,{mode:0o600,flag:'wx'});
      const args=this.command.kind==='sips'?['-s','format','png',input,'--out',output]:[input,'-auto-orient','-strip',`PNG24:${output}`];
      await run(this.command.executable,args,this.timeoutMs,directory);
      const stat=await fs.promises.stat(output);if(!stat.isFile()||stat.size>this.maxNormalized)throw new Error('transcoder_output_too_large');
      const result=await fs.promises.readFile(output);
      if(result.length<PNG_MAGIC.length||!result.subarray(0,PNG_MAGIC.length).equals(PNG_MAGIC))throw new Error('transcoder_output_invalid');
      return result;
    }finally{await fs.promises.rm(directory,{recursive:true,force:true});}
  }
  async normalize(body,route){
    if(!this.enabled)throw new Error('protection_disabled');
    if(!Buffer.isBuffer(body)||body.length===0||body.length>this.maxRequest)throw new Error('request_capture_unavailable');
    let payload;try{payload=JSON.parse(body.toString('utf8'));}catch{throw new Error('request_json_invalid');}
    const refs=imageRefs(payload,route);if(!refs.length)throw new Error('typed_jpeg_not_found');
    let converted=0;
    for(const ref of refs){
      const encoded=strictBase64(ref.get());
      if(!encoded||encoded.length>this.maxImage||encoded[0]!==0xff||encoded[1]!==0xd8)throw new Error('jpeg_payload_invalid');
      const png=await this.transcode(encoded);if(png.length>this.maxNormalized)throw new Error('transcoder_output_too_large');
      ref.set(png.toString('base64'));converted++;
    }
    const normalized=Buffer.from(JSON.stringify(payload));if(normalized.length>this.maxNormalized)throw new Error('normalized_request_too_large');
    return {body:normalized,converted,stream:payload.stream===true};
  }
  record(kind,fields={}){
    if(kind==='rescued')this.rescued++;else if(kind==='guided')this.guided++;else this.failed++;
    const reason=typeof fields.reason==='string'&&/^[a-z_]{1,64}$/.test(fields.reason)?fields.reason:null;
    this.last={time:new Date().toISOString(),kind,...(Number.isSafeInteger(fields.images)?{images:fields.images}:{}),...(typeof fields.node==='string'?{node:fields.node}:{}),...(reason?{reason}:{})};
  }
}
