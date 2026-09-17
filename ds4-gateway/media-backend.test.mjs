import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {MediaBackend} from './media-backend.mjs';
const uuid='00112233-4455-6677-8899-aabbccddeeff';
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
