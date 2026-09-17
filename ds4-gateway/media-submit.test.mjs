import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {createGateway} from './gateway.mjs';
import {createDashboard,submitVideoFromDashboard} from './dashboard.mjs';
import {workerControl} from './worker-client.mjs';

test('dashboard queues a text video through the authenticated core once, preserving retries across reloads',async t=>{
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'sg-video-submit-'));
  const config={host:'127.0.0.1',port:0,api_key:'private-fixture-key',model:'fixture',context_length:262144,nodes:[],state_file:path.join(folder,'state.json'),control_socket:path.join(folder,'control.sock'),media_jobs:{enabled:true}};
  const core=createGateway(config),address=await core.start();config.port=address.port;
  t.after(async()=>{await core.close();fs.rmSync(folder,{recursive:true,force:true});});
  const management={media:()=>workerControl(config.control_socket,'/media-jobs'),act:(action,input)=>{assert.equal(action,'media-video-submit');return submitVideoFromDashboard(config,input);}};
  const dashboard=createDashboard(()=>({gateway:{workers:[]}}),undefined,management);await new Promise(r=>dashboard.listen(0,'127.0.0.1',r));
  t.after(()=>{dashboard.closeAllConnections();dashboard.close();});const origin=`http://127.0.0.1:${dashboard.address().port}`;
  const status=await (await fetch(origin+'/api/media')).json();assert.equal(status.text_video_supported,true);assert.equal(status.enabled,false);
  const request={key:'same-browser-request',prompt:'A paper boat on a calm pond.'};
  const submit=(headers={})=>fetch(origin+'/api/media/video/jobs',{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(request)});
  assert.equal((await submit()).status,403);assert.equal(core.mediaJobs.list().length,0);
  const headers={origin,'x-dsg-csrf':status.csrf_token};
  const first=await submit(headers);assert.equal(first.status,200);const job=await first.json();assert.equal(job.state,'queued');assert.equal(job.generation.input_format,'text');
  // Simulate a lost acceptance followed by a fresh page/status read and the same request.
  const refreshed=await (await fetch(origin+'/api/media')).json();const again=await (await submit({origin,'x-dsg-csrf':refreshed.csrf_token})).json();
  assert.equal(again.id,job.id);assert.equal(core.mediaJobs.list().length,1);
  assert.equal(core.mediaJobs.get(job.id).payload.prompt['7'].inputs.prompt,request.prompt);
  assert.equal((await (await fetch(origin+'/api/media')).json()).jobs[0].id,job.id);
  assert.ok(!JSON.stringify(again).includes(request.prompt));assert.ok(!JSON.stringify(status).includes(config.api_key));
  assert.equal(core.stats().active,0,'Queueing does not start inference or bypass the media execution switch.');
});

test('dashboard refuses text submission to a core that does not advertise support',async t=>{
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'sg-video-old-core-')),socket=path.join(folder,'control.sock');let requests=0;
  const server=http.createServer((req,res)=>{requests++;assert.equal(req.url,'/media-jobs');res.end(JSON.stringify({configured:true}));});
  await new Promise(r=>server.listen(socket,r));t.after(()=>{server.close();fs.rmSync(folder,{recursive:true,force:true});});
  await assert.rejects(submitVideoFromDashboard({control_socket:socket,port:1,api_key:'unused'},{key:'request',prompt:'test'}),/not connected/);
  assert.equal(requests,1);
});

test('authenticated video API accepts uploaded reference IDs, exposes their receipt and protects queued inputs',async t=>{
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'sg-video-reference-api-'));
 const config={host:'127.0.0.1',port:0,api_key:'reference-fixture',model:'fixture',context_length:262144,nodes:[],state_file:path.join(folder,'state.json'),media_jobs:{enabled:true}};
 const core=createGateway(config),address=await core.start();t.after(async()=>{await core.close();fs.rmSync(folder,{recursive:true,force:true});});
 const origin=`http://127.0.0.1:${address.port}`,headers={authorization:'Bearer reference-fixture'};
 const image=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=','base64');
 const uploaded=await fetch(origin+'/v1/video/inputs',{method:'POST',headers:{...headers,'content-type':'image/png'},body:image});assert.equal(uploaded.status,201);const input=await uploaded.json();
 const body={prompt:'Animate <Picture 1>.',reference_image:input.id,seed:42};
 const submit=payload=>fetch(origin+'/v1/video/jobs',{method:'POST',headers:{...headers,'content-type':'application/json','idempotency-key':'reference-api'},body:JSON.stringify(payload)});
 const accepted=await submit(body);assert.equal(accepted.status,202);const job=await accepted.json();
 assert.deepEqual(job.generation.reference_inputs,[{kind:'image',id:input.id,sha256:input.sha256}]);assert.equal(job.payload,undefined);
 assert.equal(core.mediaJobs.get(job.id).payload.prompt['5'].inputs.image,input.name);
 assert.deepEqual(core.mediaJobs.get(job.id).payload.prompt['7'].inputs['ref_images.ref_image_0'],['5',0]);
 const retry=await submit(body);assert.equal(retry.status,200);assert.equal((await retry.json()).id,job.id);
 assert.equal((await fetch(origin+'/v1/video/inputs/'+input.id,{method:'DELETE',headers})).status,409);
 assert.equal(core.stats().active,0);assert.equal(core.mediaJobs.list().length,1);
});
