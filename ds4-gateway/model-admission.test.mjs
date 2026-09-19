import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createGateway} from './gateway.mjs';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let n=0;n<200;n++){if(fn())return;await pause(10);}throw Error('fixture timed out');}
test('distinct model routes preserve context, stream tools, queue at two slots and never spill into default pool',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sg-model-admission-')),backends=[];
 for(const [id,ctx] of [['qwen',800000],['m3-ds41',262144],['mia-ds41',600000]]){
  const b={id,ctx,calls:[],pending:[]};
  b.server=http.createServer((req,res)=>{
   if(req.method==='GET'){res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{id,context_length:ctx}]}));return;}
   let body='';req.on('data',x=>body+=x);req.on('end',()=>{b.calls.push(JSON.parse(body));res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: '+JSON.stringify({choices:[{delta:{tool_calls:[{index:0,id:'call-fixture',type:'function',function:{name:'report_result',arguments:'{"value":323}'}}]}}]})+'\n\n');b.pending.push(()=>res.end('data: [DONE]\n\n'));});
  });await new Promise(r=>b.server.listen(0,'127.0.0.1',r));backends.push(b);
 }
 const [qwen,m3,mia]=backends;
 const c={host:'127.0.0.1',port:0,api_key:'fixture',model:'qwen',context_length:800000,state_file:path.join(dir,'state.json'),health_interval_ms:60000,model_routes:{'qwen':['qwen'],'m3-ds41':['m3-ds41'],'mia-ds41':['mia-ds41']},nodes:backends.map(b=>({id:b.id,backend:'openai',url:`http://127.0.0.1:${b.server.address().port}/v1`,context_length:b.ctx,route_only:b!==qwen,max_concurrent_requests:b===mia?2:1,model_aliases:{[b.id]:b.id}}))};
 const gateway=createGateway(c),addr=await gateway.start();t.after(async()=>{for(const b of backends)for(const finish of b.pending)finish();await gateway.close();for(const b of backends)await new Promise(r=>b.server.close(r));fs.rmSync(dir,{recursive:true,force:true});});
 await until(()=>gateway.nodes.every(n=>n.healthy));
 const base=`http://127.0.0.1:${addr.port}`;
 const headers=route=>({authorization:'Bearer fixture',...(route?{'x-dsg-model':route}:{})});
 for(const [route,context] of [[undefined,800000],['qwen',800000],['m3-ds41',262144],['mia-ds41',600000]]){
  const r=await fetch(base+'/v1/models',{headers:headers(route)});assert.equal(r.status,200);const d=await r.json();assert.equal(d.data[0].context_length,context);
 }
 const submit=(route,id,signal)=>fetch(base+'/v1/chat/completions',{method:'POST',headers:{...headers(route),'content-type':'application/json','x-session-id':id},body:JSON.stringify({model:route??'qwen',messages:[{role:'user',content:id}],stream:true}),signal});
 const a=await submit('mia-ds41','a'),b=await submit('mia-ds41','b');const third=submit('mia-ds41','c');await until(()=>mia.calls.length===2);await pause(80);assert.equal(mia.calls.length,2);assert.equal(qwen.calls.length,0);assert.equal(m3.calls.length,0);
 mia.pending[0]();const streamed=await a.text();assert.match(streamed,/report_result/);assert.match(streamed,/DONE/);const cr=await third;assert.equal(mia.calls.length,3);mia.pending[1]();mia.pending[2]();await b.text();await cr.text();
 const normal=await submit(undefined,'default');assert.equal(qwen.calls.length,1);qwen.pending[0]();await normal.text();
 gateway.nodes.find(n=>n.id==='mia-ds41').healthy=false;const controller=new AbortController();const waiting=submit('mia-ds41','unavailable',controller.signal).catch(()=>null);await pause(80);assert.equal(qwen.calls.length,1);assert.equal(m3.calls.length,0);controller.abort();await waiting;
});

test('shared pool members retain larger explicit-route context metadata',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sg-shared-context-'));
 const backend=http.createServer((_req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{id:'native',context_length:600000}]}));});
 await new Promise(r=>backend.listen(0,'127.0.0.1',r));
 const gateway=createGateway({host:'127.0.0.1',port:0,api_key:'fixture',model:'native',context_length:262144,state_file:path.join(dir,'state.json'),health_interval_ms:60000,model_routes:{large:['large']},nodes:[{id:'large',backend:'openai',url:`http://127.0.0.1:${backend.address().port}/v1`,context_length:600000,route_only:false,max_concurrent_requests:2}]});
 const address=await gateway.start();t.after(async()=>{await gateway.close();await new Promise(r=>backend.close(r));fs.rmSync(dir,{recursive:true,force:true});});await until(()=>gateway.nodes[0].healthy);
 for(const [route,expected] of [[null,262144],['large',600000]]){
  const response=await fetch(`http://127.0.0.1:${address.port}/v1/models`,{headers:{authorization:'Bearer fixture',...(route?{'x-dsg-model':route}:{})}});
  assert.equal(response.status,200);assert.equal((await response.json()).data[0].context_length,expected);
 }
});
