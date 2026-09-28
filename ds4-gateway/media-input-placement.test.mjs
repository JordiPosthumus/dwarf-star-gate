import test from 'node:test';
import assert from 'node:assert/strict';
import {mediaInputRequirements,inspectMediaJobInputs} from './media-input-placement.mjs';

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
