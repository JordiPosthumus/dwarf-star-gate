import test from 'node:test';
import assert from 'node:assert/strict';
import {mediaInputRequirements,inspectMediaJobInputs} from './media-input-placement.mjs';
import {createMediaTools} from './genie-media.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createGateway} from './gateway.mjs';
import {workerControl} from './worker-client.mjs';

test('gateway input inspection crosses the private control socket and honors the inspection switch',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sg-input-probe-'));
  const config={host:'127.0.0.1',port:0,api_key:'fixture',model:'fixture',context_length:262144,nodes:[],state_file:path.join(dir,'state.json'),control_socket:path.join(dir,'control.sock'),media_jobs:{enabled:true,workers:{one:{engines:{video:{kind:'comfyui'}}}}},genie_chat:{inspection:{workers:{one:{ssh:['fixture']}}}}};
  const gateway=createGateway(config);t.after(async()=>{await gateway.close();fs.rmSync(dir,{recursive:true,force:true});});
  const address=await gateway.start();
  const response=await fetch(`http://127.0.0.1:${address.port}/v1/video/jobs`,{method:'POST',headers:{authorization:'Bearer fixture','content-type':'application/json','idempotency-key':'probe'},body:JSON.stringify({prompt:{}})});
  assert.equal(response.status,202);const job=await response.json();
  const result=await workerControl(config.control_socket,'/genie-media-inputs',{job_id:job.id,worker_id:'one'});
  assert.deepEqual(result.files,[]);assert.equal(result.job_id,job.id);
  const status=await workerControl(config.control_socket,'/media-jobs');assert.equal(status.jobs[0].state,'queued');assert.equal(status.jobs[0].execution,undefined);
  await workerControl(config.control_socket,'/genie-capability',{key:'inspection',enabled:false});
  await assert.rejects(workerControl(config.control_socket,'/genie-media-inputs',{job_id:job.id,worker_id:'one'}),/inspection is switched off/);
});

test('known local loaders are distinguished from portable uploads without classifying custom nodes',()=>{
  const job={kind:'video',payload:{input_files:['upload'],prompt:{
    a:{class_type:'LoadImage',inputs:{image:'portrait.png'}},
    b:{class_type:'LoadAudio',inputs:{audio:'stargate/upload.wav'}},
    c:{class_type:'CustomLoader',inputs:{image:'custom.png'}},
  }}};
  const r=mediaInputRequirements(job);assert.equal(r.uploaded_inputs,1);
  assert.deepEqual(r.engine_local_files,[{node_id:'a',node_type:'LoadImage',field:'image',name:'portrait.png'}]);
  assert.deepEqual(mediaInputRequirements({kind:'music',payload:{}}).engine_local_files,[]);
});
test('private tool uses the enrolled engine and saved job; uploaded-only jobs need no SSH',async()=>{
  const connection={ssh:['enrolled']},engine={kind:'comfyui',container:'a'.repeat(64)};
  const config={media_jobs:{workers:{one:{engines:{video:engine}}}},genie_chat:{inspection:{workers:{one:connection}}}};
  const job={id:'saved',kind:'video',payload:{prompt:{five:{class_type:'LoadImage',inputs:{image:'portrait.png'}}}}};
  const jobs={get:id=>{assert.equal(id,'saved');return job;}};let calls=0;
  const inspect=async(c,e,files)=>{calls++;assert.equal(c,connection);assert.equal(e,engine);assert.equal(files[0].name,'portrait.png');return {files:[{...files[0],state:'missing'}]};};
  const tools=createMediaTools({inspectInputs:input=>inspectMediaJobInputs(config,jobs,input,{inspect})});
  const r=await tools.tool({action:'inputs',job_id:'saved',worker_id:'one'});
  assert.equal(r.files[0].state,'missing');assert.equal(r.worker_id,'one');assert.match(r.interpretation,/No job was started/);
  await assert.rejects(tools.tool({action:'inputs',job_id:'saved',worker_id:'unknown'}),/enrolled/);
  job.payload.prompt.five.inputs.image='stargate/upload.png';job.payload.input_files=['upload'];
  const portable=await tools.tool({action:'inputs',job_id:'saved',worker_id:'one'});
  assert.equal(calls,1);assert.deepEqual(portable.files,[]);assert.equal(portable.uploaded_inputs,1);
  await assert.rejects(tools.tool({action:'inputs',job_id:'saved',worker_id:'one',filename:'arbitrary'}));
});
