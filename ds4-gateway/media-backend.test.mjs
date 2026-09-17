import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {MediaBackend} from './media-backend.mjs';
const uuid='00112233-4455-6677-8899-aabbccddeeff';
test('native workflow rejection exposes model/file validation without claiming acceptance or replaying',async()=>{
 let calls=0;
 const api=new MediaBackend({kind:'comfyui',url:'http://127.0.0.1:1'},{fetchImpl:async()=>{calls++;return Response.json({error:{message:'Prompt outputs failed validation'},node_errors:{'1':{class_type:'UNETLoader',errors:[{message:'Value not in list',details:'unet_name: reference-model.safetensors is not installed'}]}}},{status:400});}});
 await assert.rejects(api.submit({prompt:{}},uuid),e=>e.uncertain===false&&/node 1 \(UNETLoader\).*reference-model.safetensors is not installed/.test(e.message));assert.equal(calls,1);
 const unavailable=new MediaBackend({kind:'comfyui',url:'http://127.0.0.1:1'},{fetchImpl:async()=>new Response('unreadable',{status:503})});
 await assert.rejects(unavailable.submit({prompt:{}},uuid),e=>e.uncertain===true&&e.message==='Native media HTTP 503');
 const invalid=new MediaBackend({kind:'comfyui',url:'http://127.0.0.1:1'},{fetchImpl:async()=>new Response('not JSON',{status:400})});
 await assert.rejects(invalid.submit({prompt:{}},uuid),e=>e.uncertain===false&&e.message==='Native media HTTP 400');
});
test('native input transfer uses only the enrolled endpoint and confirms the stable non-overwriting name',async t=>{
 let renamed=false,calls=0;
 const server=http.createServer(async(req,res)=>{
  calls++;assert.equal(req.url,'/upload/image');assert.equal(req.headers.authorization,'Bearer native-fixture');
  const chunks=[];for await(const c of req)chunks.push(c);
  const form=await new Request('http://localhost/upload/image',{method:'POST',headers:req.headers,body:Buffer.concat(chunks)}).formData();
  const file=form.get('image');assert.equal(file.name,uuid+'.wav');assert.deepEqual(Buffer.from(await file.arrayBuffer()),Buffer.from('wave-data'));
  assert.equal(form.get('subfolder'),'stargate');assert.equal(form.get('type'),'input');assert.equal(form.has('overwrite'),false);
  res.setHeader('content-type','application/json');res.end(JSON.stringify({name:renamed?'renamed.wav':file.name,type:'input',subfolder:'stargate'}));
 });server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});
 const api=new MediaBackend({kind:'comfyui',url:`http://127.0.0.1:${server.address().port}`,token:'native-fixture'}),blob=new Blob(['wave-data'],{type:'audio/wav'});
 assert.deepEqual(await api.uploadInput(blob,'stargate/'+uuid+'.wav'),{name:'stargate/'+uuid+'.wav'});
 renamed=true;await assert.rejects(api.uploadInput(blob,'stargate/'+uuid+'.wav'),/name was not confirmed/);
 await assert.rejects(api.uploadInput(blob,'../personal.wav'),/stored Star Gate/);assert.equal(calls,2);
});
async function endpoint(t,handler){
 const calls=[],server=http.createServer(async(req,res)=>{let text='';for await(const chunk of req)text+=chunk;const call={method:req.method,path:req.url,body:text?JSON.parse(text):null};calls.push(call);res.setHeader('content-type','application/json');handler(call,res);});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});return {url:`http://127.0.0.1:${server.address().port}`,calls};
}
test('ACE-Step submits native parameters once and observes that exact task through completion',async t=>{
 let finished=false;const e=await endpoint(t,(c,r)=>r.end(JSON.stringify(c.path==='/release_task'?{data:{task_id:'ace-task'}}:{data:[{task_id:'ace-task',status:finished?1:0,result:JSON.stringify([{file:'/v1/audio?path=example.wav'}])}]})));
 const api=new MediaBackend({kind:'ace-step',url:e.url}),payload={prompt:'Instrumental piano',audio_duration:30,inference_steps:60};
 const receipt=await api.submit(payload,uuid);assert.equal(receipt.native_id,'ace-task');assert.equal((await api.observe('ace-task')).state,'pending');finished=true;
 const done=await api.observe('ace-task');assert.equal(done.state,'completed');assert.equal(done.result[0].file,'/v1/audio?path=example.wav');assert.deepEqual(e.calls[0].body,payload);assert.equal(e.calls.filter(c=>c.path==='/release_task').length,1);
});
test('ComfyUI retains job identity and distinguishes pending, running and actual successful history',async t=>{
 let phase='pending';const e=await endpoint(t,(c,r)=>{let out;
 if(c.path==='/prompt')out={prompt_id:uuid};else if(c.path.startsWith('/history/'))out=phase==='completed'?{[uuid]:{status:{completed:true,status_str:'success'},outputs:{'9':{gifs:[{filename:'video.mp4',type:'output',subfolder:''}]}}}}:{};
 else out={queue_pending:phase==='pending'?[[0,uuid]]:[],queue_running:phase==='running'?[[0,uuid]]:[]};r.end(JSON.stringify(out));});
 const api=new MediaBackend({kind:'comfyui',url:e.url}),prompt={'1':{class_type:'Example',inputs:{}}};await api.submit({prompt},uuid);
 assert.equal((await api.observe(uuid)).state,'pending');phase='running';assert.equal((await api.observe(uuid)).state,'running');phase='completed';assert.equal((await api.observe(uuid)).result.outputs['9'].gifs[0].filename,'video.mp4');
 assert.deepEqual(e.calls[0].body,{prompt,client_id:uuid,prompt_id:uuid});assert.equal(e.calls.filter(c=>c.path==='/prompt').length,1);
});
test('lost submission acknowledgement remains uncertain and is never retried',async()=>{
 let calls=0;const api=new MediaBackend({kind:'ace-step',url:'http://127.0.0.1:1'},{fetchImpl:async()=>{calls++;throw new Error('socket lost');}});
 await assert.rejects(api.submit({prompt:'example'},uuid),e=>e.uncertain===true);assert.equal(calls,1);
});
test('missing or unfinished native history does not become a successful job',async t=>{
 let result={};const e=await endpoint(t,(_c,r)=>r.end(JSON.stringify(result)));const api=new MediaBackend({kind:'comfyui',url:e.url});assert.equal((await api.observe(uuid)).state,'unknown');
 result={[uuid]:{status:{completed:false,status_str:'success'},outputs:{}}};assert.equal((await api.observe(uuid)).state,'unknown');result={[uuid]:{status:{completed:false,status_str:'error'},outputs:{}}};assert.equal((await api.observe(uuid)).state,'failed');
});
test('native ACE failure and malformed result stay distinct',async t=>{
 let result='[{"error":"generation failed"}]';const e=await endpoint(t,(_c,r)=>r.end(JSON.stringify({data:[{task_id:'task',status:2,result}]})));const api=new MediaBackend({kind:'ace-step',url:e.url});assert.equal((await api.observe('task')).state,'failed');result='invalid';assert.equal((await api.observe('task')).state,'unknown');
});

test('native progress uses a real WebSocket, scopes events to one job, and never submits work',async t=>{
 const {watchMediaProgress}=await import('./media-progress.mjs'),{createHash}=await import('node:crypto');
 const server=http.createServer(),sockets=new Set();let target;
 server.on('upgrade',(request,socket)=>{sockets.add(socket);target=request.url;
   socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+createHash('sha1').update(request.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')+'\r\n\r\n');
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');t.after(async()=>{for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));});
 const watch=watchMediaProgress({kind:'comfyui',url:`http://127.0.0.1:${server.address().port}`},uuid,{'9':{class_type:'KSampler'},'10':{class_type:'VAEDecode'}});t.after(()=>watch.close());
 const until=async predicate=>{for(let i=0;i<100&&!predicate();i++)await new Promise(r=>setTimeout(r,10));assert.ok(predicate());};
 await until(()=>watch.snapshot().connected);assert.equal(target,'/ws?clientId='+uuid);
 const send=data=>{const b=Buffer.from(JSON.stringify(data)),header=b.length<126?Buffer.from([0x81,b.length]):Buffer.from([0x81,126,b.length>>8,b.length&255]);[...sockets][0].write(Buffer.concat([header,b]));};
 send({type:'progress',data:{prompt_id:'other',node:'9',value:18,max:20}});
 send({type:'progress',data:{prompt_id:uuid,node:'9',value:4,max:20,prompt:'PRIVATE'}});
 await until(()=>watch.snapshot().value===4);assert.equal(watch.snapshot().node_type,'KSampler');assert.doesNotMatch(JSON.stringify(watch.snapshot()),/PRIVATE/);
 send({type:'progress',data:{prompt_id:uuid,node:'9',value:21,max:20}});
 send({type:'executing',data:{prompt_id:uuid,node:'10'}});
 await until(()=>watch.snapshot().node==='10');assert.equal(watch.snapshot().value,null,'old sampler counts cannot label the decoder');
 [...sockets][0].destroy();await until(()=>!watch.snapshot().connected);assert.equal(watch.snapshot().node_type,'VAEDecode');
});
test('unavailable optional progress and token-protected endpoints do not change REST execution',async()=>{
 const {watchMediaProgress}=await import('./media-progress.mjs');let calls=0;
 for(const backend of [{kind:'ace-step',url:'http://localhost'},{kind:'comfyui',url:'https://localhost',token:'PRIVATE'}]){
   const observer=watchMediaProgress(backend,uuid,{}, {socketFactory:()=>{calls++;throw Error('not supported');}});assert.equal(observer.snapshot().connected,false);observer.close();
 }
 assert.equal(calls,0);
 const unavailable=watchMediaProgress({kind:'comfyui',url:'http://localhost'},uuid,{}, {socketFactory:()=>{throw Error('offline');}});assert.equal(unavailable.snapshot().connected,false);unavailable.close();
});
