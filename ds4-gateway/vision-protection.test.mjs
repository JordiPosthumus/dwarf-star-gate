import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {GIF_GUIDANCE,IMAGE_LIMIT_GUIDANCE,JPEG_GUIDANCE,JPEG_REJECTION_INSPECTION_BYTES,VisionProtection,isRejectedJpeg,visionGuidance,visionRejectionKind} from './vision-protection.mjs';

const JPEG=Buffer.from('/9j/2Q==','base64');
const GIF=Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==','base64');
const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB','base64');
function fixture(t,config={}){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'dsg-vision-protection-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const store={data:{},save(next){this.data=next;}},seen=[];
  const protection=new VisionProtection(config,store,directory,{transcode:async value=>{seen.push(value);return PNG;}});
  return {protection,store,seen,directory};
}
const uri=`data:image/jpeg;base64,${JPEG.toString('base64')}`;
const gifUri=`data:image/gif;base64,${GIF.toString('base64')}`;

test('only the exact bounded DS4 JPEG validation rejection is rescue-eligible',()=>{
  assert.equal(isRejectedJpeg(400,Buffer.from('{"message":"invalid or unsupported JPEG image","type":"invalid_request_error"}')),true);
  assert.equal(isRejectedJpeg(400,Buffer.from('{"error":{"message":"invalid or unsupported JPEG image"}}')),true);
  assert.equal(isRejectedJpeg(500,Buffer.from('{"message":"invalid or unsupported JPEG image"}')),false);
  assert.equal(isRejectedJpeg(400,Buffer.from('{"message":"some other validation error"}')),false);
  assert.equal(isRejectedJpeg(400,Buffer.alloc(JPEG_REJECTION_INSPECTION_BYTES+1)),false);
  assert.equal(isRejectedJpeg(400,Buffer.from('not json')),false);
  assert.equal(visionRejectionKind(400,Buffer.from('{"error":{"message":"invalid JSON request","type":"invalid_request_error"}}')),'gif_candidate');
  assert.equal(visionRejectionKind(400,Buffer.from('{"message":"too many images; at most 16 are allowed","type":"invalid_request_error"}')),'image_limit');
  assert.equal(visionRejectionKind(400,Buffer.from('{"error":{"message":"invalid JSON request","type":"other"}}')),null);
});

test('operator toggle persists and normalization touches only typed Chat Completions image fields',async t=>{
  const {protection,store,seen}=fixture(t);
  assert.equal(protection.enabled,false);assert.equal(protection.captureLimit('/v1/chat/completions'),0);
  assert.equal(protection.set({id:'vision_jpeg',enabled:true}).vision_jpeg.enabled,true);
  const body=Buffer.from(JSON.stringify({model:'deepseek-v4-flash',stream:true,reasoning_effort:'xhigh',tools:[{type:'function',function:{name:'x'}}],note:uri,messages:[{role:'tool',content:[{type:'text',text:uri},{type:'image_url',image_url:{url:uri}}]}]}));
  const result=await protection.normalize(body,'/v1/chat/completions'),parsed=JSON.parse(result.body);
  assert.equal(result.converted,1);assert.equal(result.stream,true);assert.equal(seen.length,1);assert.deepEqual(seen[0],JPEG);
  assert.equal(parsed.note,uri);assert.equal(parsed.messages[0].content[0].text,uri);
  assert.match(parsed.messages[0].content[1].image_url.url,/^data:image\/png;base64,/);
  assert.equal(parsed.reasoning_effort,'xhigh');assert.deepEqual(parsed.tools,[{type:'function',function:{name:'x'}}]);
  assert.deepEqual(store.data.protections,{vision_jpeg:true});
  assert.deepEqual(protection.status().vision_jpeg.formats,['jpeg','gif-guidance']);
});

test('a valid typed GIF is proven without conversion so DSG can return fixed guidance',t=>{
  const {protection,seen}=fixture(t,{enabled:true});
  const body=Buffer.from(JSON.stringify({stream:true,reasoning_effort:'xhigh',max_tokens:153600,note:gifUri,messages:[{role:'user',content:[{type:'image_url',image_url:{url:gifUri}}]}]}));
  assert.deepEqual(protection.inspectGif(body,'/v1/chat/completions'),{images:1,stream:true});
  assert.deepEqual(seen,[]);
  assert.throws(()=>protection.inspectGif(Buffer.from(JSON.stringify({messages:[{content:[{type:'image_url',image_url:{url:'data:image/gif;base64,RkFLRQ=='}}]}]})),'/v1/chat/completions'),/gif_payload_invalid/);
  assert.throws(()=>protection.inspectGif(Buffer.from(JSON.stringify({messages:[{content:[{type:'image_url',image_url:{url:uri}}]}]})),'/v1/chat/completions'),/typed_gif_not_found/);
});

test('image-limit proof requires valid Chat Completions JSON with more than sixteen typed images',t=>{
  const {protection}=fixture(t,{enabled:true}),block={type:'image_url',image_url:{url:'data:image/png;base64,aQ=='}};
  const proven=protection.inspectImageLimit(Buffer.from(JSON.stringify({stream:true,messages:[{role:'user',content:Array.from({length:17},()=>block)}]})),'/v1/chat/completions');
  assert.deepEqual(proven,{images:17,stream:true});
  assert.throws(()=>protection.inspectImageLimit(Buffer.from(JSON.stringify({messages:[{content:Array.from({length:16},()=>block)}]})),'/v1/chat/completions'),/image_limit_not_proven/);
  assert.throws(()=>protection.inspectImageLimit(Buffer.from('{'),'/v1/chat/completions'),/request_json_invalid/);
  assert.throws(()=>protection.inspectImageLimit(Buffer.from(JSON.stringify({messages:[{content:Array.from({length:17},()=>block)}]})),'/v1/responses'),/image_limit_not_proven/);
});

test('unsupported routes, malformed payloads and bounds fail closed without retaining image data',async t=>{
  const {protection}=fixture(t,{enabled:true,max_request_bytes:1024,max_image_bytes:1024,max_normalized_bytes:4096});
  await assert.rejects(protection.normalize(Buffer.from(JSON.stringify({input:[{content:[{type:'input_image',image_url:uri}]}]})),'/v1/responses'),/typed_image_not_found/);
  await assert.rejects(protection.normalize(Buffer.from(JSON.stringify({messages:[{content:[{type:'image_url',image_url:{url:'data:image/jpeg;base64,%%%%'}}]}]})),'/v1/chat/completions'),/jpeg_payload_invalid/);
  await assert.rejects(protection.normalize(Buffer.from(JSON.stringify({messages:[{content:'none'}]})),'/v1/chat/completions'),/typed_image_not_found/);
  await assert.rejects(protection.normalize(Buffer.from(JSON.stringify({messages:[{content:[{type:'image_url',image_url:{url:gifUri}}]}]})),'/v1/chat/completions'),/gif_not_supported/);
  await assert.rejects(protection.normalize(Buffer.alloc(1025),'/v1/chat/completions'),/request_capture_unavailable/);
  protection.record('failed',{reason:'/private/path and raw tool stderr',image:uri});
  assert.equal(JSON.stringify(protection.status()).includes(uri),false);assert.equal(protection.status().vision_jpeg.last.reason,undefined);
  assert.throws(()=>protection.set({id:'other',enabled:true}),/vision_jpeg/);
});

test('streaming and non-streaming guidance are valid successful Chat Completions turns',()=>{
  const streamed=visionGuidance({stream:true,model:'deepseek-v4-flash',requestId:'one',now:1000});
  assert.equal(streamed.format,'sse');assert.match(streamed.body.toString(),/data: \[DONE\]/);assert.match(streamed.body.toString(),new RegExp(JPEG_GUIDANCE.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
  const chunks=streamed.body.toString().split('\n\n').filter(line=>line.startsWith('data: {')).map(line=>JSON.parse(line.slice(6)));
  assert.equal(chunks[0].choices[0].delta.role,'assistant');assert.equal(chunks.at(-1).choices[0].finish_reason,'stop');
  const plain=visionGuidance({stream:false,model:'deepseek-v4-flash',requestId:'two',now:1000}),body=JSON.parse(plain.body);
  assert.equal(plain.format,'json');assert.equal(body.choices[0].message.content,JPEG_GUIDANCE);assert.equal(body.choices[0].finish_reason,'stop');assert.equal(body.usage,undefined);
  const gif=visionGuidance({stream:false,model:'deepseek-v4-flash',requestId:'gif',kind:'gif',now:1000});
  assert.equal(JSON.parse(gif.body).choices[0].message.content,GIF_GUIDANCE);
  const limit=visionGuidance({stream:false,model:'deepseek-v4-flash',requestId:'limit',kind:'image_limit',now:1000});
  assert.equal(JSON.parse(limit.body).choices[0].message.content,IMAGE_LIMIT_GUIDANCE);assert.match(IMAGE_LIMIT_GUIDANCE,/\(This is a message from the DSG gateway\.\)$/);
});

test('transcoder output must be a bounded PNG and status exposes only allowlisted metadata',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'dsg-vision-output-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const store={data:{},save(next){this.data=next;}};
  const invalid=new VisionProtection({enabled:true},store,directory,{transcode:async()=>Buffer.from('not png')});
  await assert.rejects(invalid.normalize(Buffer.from(JSON.stringify({messages:[{content:[{type:'image_url',image_url:{url:uri}}]}]})),'/v1/chat/completions'),/transcoder_output_invalid/);
  invalid.record('guided',{reason:'transcoder_output_invalid',images:1,node:'spark1',secret:'never'});
  assert.deepEqual(invalid.status().vision_jpeg.last,{time:invalid.status().vision_jpeg.last.time,kind:'guided',images:1,node:'spark1',reason:'transcoder_output_invalid'});
});

test('no converter remains an enabled guidance-only protection instead of exposing the DS4 error',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'dsg-vision-guidance-only-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const store={data:{},save(next){this.data=next;}},protection=new VisionProtection({enabled:true,transcoder:'none'},store,directory);
  assert.equal(protection.available,false);assert.equal(protection.enabled,true);assert.ok(protection.captureLimit('/v1/chat/completions')>0);
  await assert.rejects(protection.normalize(Buffer.from(JSON.stringify({messages:[{content:[{type:'image_url',image_url:{url:uri}}]}]})),'/v1/chat/completions'),/transcoder_unavailable/);
  assert.equal(protection.set({id:'vision_jpeg',enabled:false}).vision_jpeg.enabled,false);
});

test('stock macOS sips performs a real JPEG-to-PNG compatibility conversion',{skip:process.platform!=='darwin'},async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'dsg-vision-sips-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const jpeg=path.join(directory,'fixture.jpg');
  execFileSync('/usr/bin/sips',['-s','format','jpeg',fileURLToPath(new URL('./ui/logo.png',import.meta.url)),'--out',jpeg],{stdio:'ignore'});
  const encoded=fs.readFileSync(jpeg),store={data:{},save(next){this.data=next;}},protection=new VisionProtection({enabled:true,transcoder:'sips'},store,directory);
  assert.equal(protection.available,true);assert.equal(protection.status().vision_jpeg.transcoder,'sips');
  const body=Buffer.from(JSON.stringify({messages:[{role:'user',content:[{type:'image_url',image_url:{url:`data:image/jpeg;base64,${encoded.toString('base64')}`}}]}]}));
  const normalized=await protection.normalize(body,'/v1/chat/completions'),url=JSON.parse(normalized.body).messages[0].content[0].image_url.url;
  assert.match(url,/^data:image\/png;base64,/);assert.equal(Buffer.from(url.split(',')[1],'base64').subarray(0,8).equals(PNG.subarray(0,8)),true);
});
