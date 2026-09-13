import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {createLocalChatPreview} from './genie-chat-local.mjs';

test('local preview reads current gateway status, excludes private fields and exposes no management',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'dsg-chat-local-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  let fail=false;const routes=[];
  const gateway=http.createServer((req,res)=>{
    routes.push(req.url);assert.equal(req.method,'GET');assert.equal(req.headers.authorization,'Bearer example-local-key');
    res.setHeader('content-type','application/json');
    if(fail){res.writeHead(503);res.end('{}');return;}
    res.end(JSON.stringify({version:1,model:'example-model',context_length:65536,api_key:'PRIVATE_EXAMPLE',
      workers:[{id:'example-worker',url:'http://private.invalid',is_healthy:true,body:'PRIVATE_REQUEST_EXAMPLE'}]}));
  });
  await new Promise(resolve=>gateway.listen(0,'127.0.0.1',resolve));
  t.after(()=>{gateway.closeAllConnections();gateway.close();});
  const config=path.join(directory,'gateway.json');
  fs.writeFileSync(config,JSON.stringify({port:gateway.address().port,state_file:'state.json',api_key:'example-local-key'}));
  const preview=await createLocalChatPreview({gateway_config:config,directory:path.join(directory,'chat'),python:'/unused/example-python',source:directory,model:'example-model'});
  t.after(preview.close);
  await new Promise(resolve=>preview.server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${preview.server.address().port}`;
  const observed=await(await fetch(`${base}/api/status`)).json();
  assert.equal(observed.read_only,true);assert.equal(observed.worker_management,false);
  assert.equal(observed.gateway.workers[0].id,'example-worker');assert.equal(observed.gateway_error,null);
  assert.doesNotMatch(JSON.stringify(observed),/PRIVATE_EXAMPLE|PRIVATE_REQUEST_EXAMPLE|private.invalid|example-local-key/);
  const chat=await(await fetch(`${base}/api/genie/chat`)).json();assert.equal(chat.can_act,false);
  assert.equal((await fetch(`${base}/api/manage`,{method:'POST',headers:{'content-type':'application/json',origin:base,'x-dsg-csrf':chat.csrf_token},body:'{"action":"drain","workers":["example-worker"]}'})).status>=400,true);
  fail=true;await preview.poll();assert.match(preview.snapshot().gateway_error,/stale/);
  assert.deepEqual(routes,['/gateway/status','/gateway/status']);
});
