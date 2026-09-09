import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {endpointUrl, endpointMetadata, endpointHeaders} from './endpoint.mjs';
import {workerConfig} from './worker-config.mjs';
import {createGateway} from './gateway.mjs';

test('generic endpoints accept LAN/HTTPS API bases; SSH still requires a loopback tunnel', () => {
  const worker=workerConfig({id:'mac',backend:'openai',url:'https://mac.example:9443/service/v1/'});
  assert.equal(endpointUrl(worker,'/v1/chat/completions').href,'https://mac.example:9443/service/v1/chat/completions');
  assert.equal(endpointUrl(workerConfig({id:'spark',backend:'openai',url:'http://192.0.2.2:8000'}),'/v1/models').href,'http://192.0.2.2:8000/v1/models');
  assert.throws(()=>workerConfig({...worker,ssh:'Spark'}));
  const credentialUrl=new URL('https://example.com/v1');
  credentialUrl.username='fixture-user';credentialUrl.password='fixture-password';
  assert.throws(()=>workerConfig({...worker,url:credentialUrl.href}));
  assert.throws(()=>workerConfig({...worker,url:'https://example.com/v1?api_key=secret'}));
});

test('context checks use the smallest reported capacity and never raise it with an override', () => {
  const worker={backend:'openai',context_length:262144};
  const data={data:[{id:'qwen',max_model_len:262144},{id:'other',context_length:32768}]};
  assert.equal(endpointMetadata(worker,data).contextLength,32768);
  assert.equal(endpointMetadata({backend:'openai'},{data:[{id:'unknown'}]}).contextLength,null);
  assert.equal(endpointMetadata(worker,{data:[{id:'unknown'}]}).contextLength,262144);
  assert.equal(endpointMetadata(worker,{data:[]}).available,false);
  assert.equal(endpointMetadata({},data,{model:'deepseek'}).available,false);
  assert.equal(endpointMetadata({},data,{model:'deepseek',model_agnostic:true}).available,true);
});

test('private credentials, model-opaque request bytes, SSE and context metadata work through the gateway',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'dsg-openai-'));
  const keyFile=path.join(directory,'token');fs.writeFileSync(keyFile,'backend-only-secret\n',{mode:0o600});
  assert.throws(()=>endpointHeaders({api_key_file:path.join(directory,'missing')}),/credential unavailable/);
  const records=[];
  const backend=http.createServer((req,res)=>{
    records.push({url:req.url,headers:req.headers});
    if(req.headers.authorization!=='Bearer backend-only-secret'){res.writeHead(401);res.end();return;}
    if(req.url==='/api/v1/models'){res.end(JSON.stringify({data:[{id:'different-backend-model',max_model_len:65536}]}));return;}
    let body='';req.on('data',c=>body+=c);req.on('end',()=>{
      records.at(-1).body=body;
      if(body.includes('unsupported-model')){res.writeHead(400,{'content-type':'application/json'});res.end('{"error":{"message":"model unavailable"}}');return;}
      res.writeHead(200,{'content-type':'text/event-stream'});
      res.end('data: {"choices":[{"delta":{"tool_calls":[{"function":{"name":"test","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise(r=>backend.listen(0,'127.0.0.1',r));
  t.after(async()=>{backend.closeAllConnections();await new Promise(r=>backend.close(r));});
  const gateway=createGateway({host:'127.0.0.1',port:0,api_key:'ingress-only-secret',model:'legacy-label',model_agnostic:true,context_length:32768,state_file:path.join(directory,'state.json'),nodes:[{id:'generic',backend:'openai',url:`http://127.0.0.1:${backend.address().port}/api/v1`,api_key_file:keyFile}],health_interval_ms:60000});
  const address=await gateway.start();t.after(async()=>{await gateway.close();fs.rmSync(directory,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${address.port}`;
  const headers={authorization:'Bearer ingress-only-secret','content-type':'application/json','x-api-key':'must-not-leak'};
  const metadata=await (await fetch(base+'/v1/models',{headers})).json();
  assert.equal(metadata.data[0].id,'different-backend-model');assert.equal(metadata.data[0].context_length,32768);
  for(const body of ['{ "model": "requested-unchanged", "messages": [], "stream": true }','{"messages":[],"stream":true}']){
    const res=await fetch(base+'/v1/chat/completions',{method:'POST',headers,body});
    assert.equal(res.status,200);assert.match(await res.text(),/tool_calls/);assert.equal(records.at(-1).body,body);
  }
  const failed=await fetch(base+'/v1/chat/completions',{method:'POST',headers,body:'{"model":"unsupported-model"}'});
  assert.equal(failed.status,400);assert.equal(await failed.text(),'{"error":{"message":"model unavailable"}}');
  assert.ok(records.every(r=>r.headers.authorization==='Bearer backend-only-secret'&&!r.headers['x-api-key']));
  const status=await (await fetch(base+'/gateway/status',{headers})).text();
  assert.ok(!status.includes('backend-only-secret')&&!status.includes(keyFile));
});
