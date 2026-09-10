import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createGateway} from './gateway.mjs';
import {createDoor} from './door.mjs';
import {workerControl} from './worker-client.mjs';
const listen=s=>new Promise(r=>s.listen(0,'127.0.0.1',()=>r(s.address().port)));
async function setup(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hg-forward-')),records=[[],[]],received=[0,0];
 const key=path.join(dir,'backend.key');fs.writeFileSync(key,'backend-secret',{mode:0o600});
 const servers=[0,1].map(i=>http.createServer((req,res)=>{
  if(req.url==='/v1/models')return res.end(JSON.stringify({data:[{id:'native',context_length:262144}]}));
  const chunks=[];req.on('data',c=>{received[i]+=c.length;chunks.push(c)});req.on('end',()=>{
   const body=Buffer.concat(chunks);records[i].push({body,headers:req.headers});
   const p=JSON.parse(body);if(p.fixture==='disconnect'){res.destroy();return;}
   const error=p.fixture==='error',sse=p.stream===true;
   res.writeHead(error?422:200,{'content-type':sse?'text/event-stream':'application/json','x-backend-proof':'unchanged','retry-after':'7'});
   const reply=error?' {"error":{"message":"Unsupported parameter: seed","type":"invalid_request_error"}}\n':sse?'data: {"choices":[{"delta":{"reasoning_content":"test reasoning","tool_calls":[{"index":0,"id":"t","type":"function","function":{"name":"check","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n':' {"choices":[{"message":{"content":"synthetic"},"finish_reason":"stop"}]}\n';
   res.end(reply);
  });
 }));
 const ports=await Promise.all(servers.map(listen));
 const config={host:'127.0.0.1',port:0,api_key:'ingress-secret',model:'native',context_length:262144,state_file:path.join(dir,'state.json'),control_socket:path.join(dir,'core.sock'),health_interval_ms:100000,model_routes:{spark:['spark'],m3:['m3']},nodes:ports.map((port,i)=>({id:i?'m3':'spark',backend:'openai',url:`http://127.0.0.1:${port}/v1`,api_key_file:key,model_aliases:{reviewed:'native'}}))};
 const core=createGateway(config);const addr=await core.start();
 const door=createDoor({host:'127.0.0.1',port:0,api_key:'ingress-secret',continuity_door:{enabled:true,core_port:addr.port,control_socket:path.join(dir,'door.sock'),health_interval_ms:60000}});await door.start();
 t.after(async()=>{await door.close();await core.close();for(const s of servers){s.closeAllConnections();await new Promise(r=>s.close(r))}fs.rmSync(dir,{recursive:true,force:true})});
 const send=(body,route='m3',partial=false,testing=false)=>new Promise((resolve,reject)=>{
  const q=http.request({host:'127.0.0.1',port:door.server.address().port,path:(testing?'/testing':'')+'/v1/chat/completions',method:'POST',headers:{authorization:'Bearer ingress-secret','content-type':'application/json','x-dsg-model':route,'x-session-affinity':'same-hourglass-run'}},r=>{const chunks=[];r.on('data',c=>chunks.push(c));r.on('error',reject);r.on('end',()=>resolve({status:r.statusCode,headers:r.headers,body:Buffer.concat(chunks).toString()}))});q.on('error',reject);
  if(!partial)return q.end(body);
  q.write(body.slice(0,20));const selected=route==='spark'?0:1;const before=received[selected];const deadline=Date.now()+3000;
  void(async()=>{while(received[selected]===before&&Date.now()<deadline)await delay(5);try{assert.ok(received[selected]>before,'upload must reach backend before client finishes');q.end(body.slice(20))}catch(e){q.destroy();reject(e)}})();
 });
 return {send,records,config,door,core};
}
const payload={model:'reviewed',messages:[{role:'user',content:'Synthetic héllo; nested model must remain reviewed.'}],temperature:0,top_p:0.95,top_k:20,min_p:0,presence_penalty:0,frequency_penalty:0,repetition_penalty:1,seed:0,stop:['STOP'],max_tokens:262144,tool_choice:'auto',tools:[{type:'function',function:{name:'check',parameters:{type:'object',properties:{}}}}],chat_template_kwargs:{enable_thinking:true,preserve_thinking:false,reasoning_effort:'xhigh'},stream:false};
test('Hourglass via Door and core preserves bytes except model alias, credentials, JSON and SSE',async t=>{
 const r=await setup(t);
 for(const stream of [false,true]){
  const body=JSON.stringify({...payload,stream},null,2)+'\n',reply=await r.send(body,'m3',true),got=r.records[1].at(-1);
  assert.equal(reply.status,200);assert.equal(reply.headers['x-ds4-node'],'m3');assert.equal(reply.headers['x-backend-proof'],'unchanged');
  assert.equal(got.body.toString(),body.replace('"model": "reviewed"','"model": "native"'));assert.equal(got.headers.authorization,'Bearer backend-secret');assert.equal(got.headers['x-dsg-model'],undefined);
  const expected=stream?'data: {"choices":[{"delta":{"reasoning_content":"test reasoning","tool_calls":[{"index":0,"id":"t","type":"function","function":{"name":"check","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n':' {"choices":[{"message":{"content":"synthetic"},"finish_reason":"stop"}]}\n';assert.equal(reply.body,expected);
 }
 const continuation={model:'reviewed',messages:[...payload.messages,{role:'assistant',content:null,reasoning_content:'test reasoning',tool_calls:[{id:'t',type:'function',function:{name:'check',arguments:'{}'}}]},{role:'tool',tool_call_id:'t',content:'ok'}]};
 const body=JSON.stringify(continuation);await r.send(body);assert.equal(r.records[1].at(-1).body.toString(),body.replace('"model":"reviewed"','"model":"native"'));assert.equal(r.records[1].length,3);assert.equal(r.records[0].length,0);
});
test('Hourglass pinned route survives pause and shared session history; errors are not retried',async t=>{
 const r=await setup(t);await r.send(JSON.stringify(payload),'spark');
 await workerControl(r.config.control_socket,'/drain-workers',{workers:['m3']});const waiting=r.send(JSON.stringify(payload));await delay(50);assert.equal(r.records[0].length,1);assert.equal(r.records[1].length,0);
 await workerControl(r.config.control_socket,'/resume-workers',{workers:['m3']});assert.equal((await waiting).headers['x-ds4-node'],'m3');
 const error=await r.send(JSON.stringify({...payload,fixture:'error'}));assert.equal(error.status,422);assert.equal(error.body,' {"error":{"message":"Unsupported parameter: seed","type":"invalid_request_error"}}\n');assert.equal(error.headers['retry-after'],'7');assert.equal(r.records[1].length,2);
 const bad=await r.send(JSON.stringify(payload),'unknown');assert.equal(bad.status,400);assert.equal(r.records[1].length,2);
 const disconnect=await r.send(JSON.stringify({...payload,fixture:'disconnect'}));assert.equal(disconnect.status,502);assert.equal(r.records[1].length,3);assert.equal(r.records[0].length,1);
});

 test('Testing endpoint uses the same gateway routes, aliases, errors and body bytes',async t=>{
 const r=await setup(t);r.door.setTesting(true);assert.deepEqual(r.core.stats().model_routes,{spark:['spark'],m3:['m3']});
 const normal=r.send(JSON.stringify(payload),'spark');while(r.door.status().testing.held===0)await delay(5);
 const body=JSON.stringify({...payload,stream:true},null,2);const testReply=await r.send(body,'spark',true,true);
 assert.equal(testReply.status,200);assert.equal(testReply.headers['x-ds4-node'],'spark');assert.equal(r.records[0].length,1);assert.equal(r.records[1].length,0);
 assert.equal(r.records[0][0].body.toString(),body.replace('"model": "reviewed"','"model": "native"'));
 const failure=await r.send(JSON.stringify({...payload,fixture:'error'}),'m3',false,true);assert.equal(failure.status,422);assert.equal(failure.headers['x-ds4-node'],'m3');
 assert.equal(r.records[1].length,1);r.door.setTesting(false);assert.equal((await normal).headers['x-ds4-node'],'spark');
 });
