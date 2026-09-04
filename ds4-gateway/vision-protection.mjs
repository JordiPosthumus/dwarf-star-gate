import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';

const JPEG_PREFIXES=['data:image/jpeg;base64,','data:image/jpg;base64,'];
const GIF_PREFIXES=['data:image/gif;base64,'];
const PNG_MAGIC=Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]);
const GIF87_MAGIC=Buffer.from('GIF87a','ascii');
const GIF89_MAGIC=Buffer.from('GIF89a','ascii');
const DEFAULT_MAX_REQUEST=64*1024*1024;
const DEFAULT_MAX_IMAGE=48*1024*1024;
const DEFAULT_MAX_NORMALIZED=192*1024*1024;
export const JPEG_REJECTION_INSPECTION_BYTES=64*1024;
export const JPEG_GUIDANCE='DSG: DS4 could not use this JPEG file. Please resend it as PNG or WebP, or export it again as a standard RGB JPEG. Nothing was generated from the rejected file, and your session remains active. (This is a message from the DSG gateway.)';
export const GIF_GUIDANCE='DSG: DS4 could not safely use this GIF. Please resend a representative frame as PNG or WebP; if motion matters, send a contact sheet or several frames. Nothing was generated from the rejected file, and your session remains active. (This is a message from the DSG gateway.)';
export const IMAGE_LIMIT_GUIDANCE="DSG: This request contains more than DS4's limit of 16 images across the submitted conversation. Send 16 or fewer images—choose representative frames, combine them into a contact sheet, or compact/start a fresh visual turn—and try again. Nothing was generated, and your session remains active. (This is a message from the DSG gateway.)";

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
  const jpeg=JPEG_PREFIXES.find(candidate=>value.startsWith(candidate));
  const gif=GIF_PREFIXES.find(candidate=>value.startsWith(candidate));
  const prefix=jpeg??gif;
  return prefix?{kind:jpeg?'jpeg':'gif',get:()=>value.slice(prefix.length),set:data=>{owner[key]=`data:image/png;base64,${data}`;}}:null;
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

function typedImageCount(payload,route){
  if(route!=='/v1/chat/completions')return 0;
  let count=0;
  for(const message of Array.isArray(payload.messages)?payload.messages:[])for(const block of Array.isArray(message?.content)?message.content:[]){
    if(!block||block.type!=='image_url')continue;
    const value=typeof block.image_url==='string'?block.image_url:block.image_url?.url;
    if(typeof value==='string'&&value.length)count++;
  }
  return count;
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
  return visionRejectionKind(status,body)==='jpeg';
}

export function visionRejectionKind(status,body){
  if(status!==400||!Buffer.isBuffer(body)||body.length>JPEG_REJECTION_INSPECTION_BYTES)return null;
  try{
    const parsed=JSON.parse(body.toString('utf8')),error=parsed?.error??parsed,message=error?.message,type=error?.type;
    if(message==='too many images; at most 16 are allowed'&&type==='invalid_request_error')return 'image_limit';
    if(message==='invalid or unsupported JPEG image')return 'jpeg';
    // DS4 currently reports a typed GIF image_url as a generic JSON error even
    // though the surrounding OpenAI request is valid. This classification is
    // only a candidate: the captured request must independently prove a valid
    // GIF data URI before DSG is allowed to intercept it.
    if(message==='invalid JSON request'&&type==='invalid_request_error')return 'gif_candidate';
    return null;
  }catch{return null;}
}

export function visionGuidance({stream,model,requestId,kind='jpeg',now=Date.now()}){
  const guidance=kind==='gif'?GIF_GUIDANCE:kind==='image_limit'?IMAGE_LIMIT_GUIDANCE:JPEG_GUIDANCE;
  const created=Math.floor(now/1000),id=`chatcmpl-dsg-${requestId}`;
  if(stream===true){
    const first={id,object:'chat.completion.chunk',created,model,choices:[{index:0,delta:{role:'assistant',content:guidance},finish_reason:null}]};
    const last={id,object:'chat.completion.chunk',created,model,choices:[{index:0,delta:{},finish_reason:'stop'}]};
    return {contentType:'text/event-stream; charset=utf-8',format:'sse',body:Buffer.from(`data: ${JSON.stringify(first)}\n\ndata: ${JSON.stringify(last)}\n\ndata: [DONE]\n\n`)};
  }
  const body={id,object:'chat.completion',created,model,choices:[{index:0,message:{role:'assistant',content:guidance},finish_reason:'stop'}]};
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
  status(){return {schema:1,vision_jpeg:{available:this.available,enabled:this.enabled,transcoder:this.command?.kind??null,formats:['jpeg','gif-first-frame'],max_request_bytes:this.maxRequest,max_image_bytes:this.maxImage,max_normalized_bytes:this.maxNormalized,rescued:this.rescued,guided:this.guided,failed:this.failed,last:this.last}};}
  set(input){
    if(!input||Array.isArray(input)||Object.keys(input).sort().join(',')!=='enabled,id'||input.id!=='vision_jpeg'||typeof input.enabled!=='boolean')throw new Error('Specify protection id vision_jpeg and enabled true or false');
    const protections={...this.store.data.protections,vision_jpeg:input.enabled};
    this.store.save({...this.store.data,protections});
    return this.status();
  }
  captureLimit(route,encoding){return this.enabled&&route==='/v1/chat/completions'&&!encoding?this.maxRequest:0;}
  inspectImageLimit(body,route){
    if(!this.enabled)throw new Error('protection_disabled');
    if(!Buffer.isBuffer(body)||body.length===0||body.length>this.maxRequest)throw new Error('request_capture_unavailable');
    let payload;try{payload=JSON.parse(body.toString('utf8'));}catch{throw new Error('request_json_invalid');}
    if(!payload||typeof payload!=='object'||Array.isArray(payload))throw new Error('request_json_invalid');
    const images=typedImageCount(payload,route);if(images<=16)throw new Error('image_limit_not_proven');
    return {images,stream:payload.stream===true};
  }
  async transcode(encoded,kind='jpeg'){
    if(this.transcodeOverride){
      const result=await this.transcodeOverride(encoded,kind);
      if(!Buffer.isBuffer(result)||result.length<PNG_MAGIC.length||!result.subarray(0,PNG_MAGIC.length).equals(PNG_MAGIC))throw new Error('transcoder_output_invalid');
      return result;
    }
    if(!this.command)throw new Error('transcoder_unavailable');
    const root=path.join(this.runtime,'vision-compat');
    await fs.promises.mkdir(root,{recursive:true,mode:0o700});await fs.promises.chmod(root,0o700);
    const directory=await fs.promises.mkdtemp(path.join(root,'attempt-'));await fs.promises.chmod(directory,0o700);
    const input=path.join(directory,kind==='gif'?'input.gif':'input.jpg'),output=path.join(directory,'output.png');
    try{
      await fs.promises.writeFile(input,encoded,{mode:0o600,flag:'wx'});
      const source=kind==='gif'?`${input}[0]`:input;
      const args=this.command.kind==='sips'?['-s','format','png',input,'--out',output]:[source,'-auto-orient','-strip',`PNG24:${output}`];
      await run(this.command.executable,args,this.timeoutMs,directory);
      const stat=await fs.promises.stat(output);if(!stat.isFile()||stat.size>this.maxNormalized)throw new Error('transcoder_output_too_large');
      const result=await fs.promises.readFile(output);
      if(result.length<PNG_MAGIC.length||!result.subarray(0,PNG_MAGIC.length).equals(PNG_MAGIC))throw new Error('transcoder_output_invalid');
      return result;
    }finally{await fs.promises.rm(directory,{recursive:true,force:true});}
  }
  async normalize(body,route,{requiredKind=null}={}){
    if(!this.enabled)throw new Error('protection_disabled');
    if(!Buffer.isBuffer(body)||body.length===0||body.length>this.maxRequest)throw new Error('request_capture_unavailable');
    let payload;try{payload=JSON.parse(body.toString('utf8'));}catch{throw new Error('request_json_invalid');}
    if(!payload||typeof payload!=='object'||Array.isArray(payload))throw new Error('request_json_invalid');
    const refs=imageRefs(payload,route);if(!refs.length)throw new Error('typed_image_not_found');
    const decodedRefs=[];
    for(const ref of refs){
      const encoded=strictBase64(ref.get());
      const jpeg=ref.kind==='jpeg'&&encoded?.[0]===0xff&&encoded?.[1]===0xd8;
      const gif=ref.kind==='gif'&&encoded?.length>=6&&(encoded.subarray(0,6).equals(GIF87_MAGIC)||encoded.subarray(0,6).equals(GIF89_MAGIC));
      if(!encoded||encoded.length>this.maxImage||(!jpeg&&!gif))throw new Error(`${ref.kind}_payload_invalid`);
      decodedRefs.push({ref,encoded});
    }
    if(requiredKind&&!decodedRefs.some(({ref})=>ref.kind===requiredKind))throw new Error(`typed_${requiredKind}_not_found`);
    let converted=0;
    for(const {ref,encoded} of decodedRefs){
      const png=await this.transcode(encoded,ref.kind);if(png.length>this.maxNormalized)throw new Error('transcoder_output_too_large');
      ref.set(png.toString('base64'));converted++;
    }
    const normalized=Buffer.from(JSON.stringify(payload));if(normalized.length>this.maxNormalized)throw new Error('normalized_request_too_large');
    return {body:normalized,converted,formats:[...new Set(refs.map(ref=>ref.kind))],totalImages:typedImageCount(payload,route),stream:payload.stream===true};
  }
  record(kind,fields={}){
    if(kind==='rescued')this.rescued++;else if(kind==='guided')this.guided++;else this.failed++;
    const reason=typeof fields.reason==='string'&&/^[a-z_]{1,64}$/.test(fields.reason)?fields.reason:null;
    const formats=Array.isArray(fields.formats)?[...new Set(fields.formats.filter(value=>value==='jpeg'||value==='gif'))]:[];
    this.last={time:new Date().toISOString(),kind,...(Number.isSafeInteger(fields.images)?{images:fields.images}:{}),...(formats.length?{formats}:{}),...(typeof fields.node==='string'?{node:fields.node}:{}),...(reason?{reason}:{})};
  }
}
