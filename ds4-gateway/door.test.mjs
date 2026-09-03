import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {createDoor} from './door.mjs';
import {doorControl} from './door-client.mjs';

const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(server.address().port)));
const request=(port,body)=>new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port,path:'/v1/chat/completions',method:'POST',headers:{authorization:'Bearer test','content-type':'application/json'}},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,body:Buffer.concat(chunks).toString(),headers:res.headers}));});req.on('error',reject);req.end(body);});
test('continuity door holds unread bodies, then forwards exact bytes once',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dsg-door-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const records=[],core=http.createServer((req,res)=>{if(req.url==='/health')return res.end('ok');const chunks=[];req.on('data',c=>chunks.push(c));req.on('end',()=>{records.push(Buffer.concat(chunks));res.end('ok');});}),corePort=await listen(core);t.after(()=>core.close());
  const config={host:'127.0.0.1',port:0,api_key:'test',nodes:[{}],continuity_door:{enabled:true,core_port:corePort,control_socket:path.join(dir,'door.sock')}};
  const door=createDoor(config);await door.start();t.after(()=>door.close());const port=door.server.address().port;
  await doorControl(config.continuity_door.control_socket,'/hold',{reason:'test replacement'});
  const body=JSON.stringify({private_fixture:'x'.repeat(200000)}),pending=request(port,body);
  await new Promise(resolve=>setTimeout(resolve,50));assert.equal(records.length,0);assert.equal(door.status().held,1);assert.equal(door.status().body_spooling,false);
  await doorControl(config.continuity_door.control_socket,'/release');const result=await pending;
  assert.equal(result.status,200);assert.equal(records.length,1);assert.equal(records[0].toString(),body);assert.equal(door.status().held,0);assert.equal(door.status().forwarded,1);
});
test('continuity door preserves an active stream while a later request waits',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dsg-door-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));let releaseFirst;
  const core=http.createServer((req,res)=>{if(req.url==='/health')return res.end('ok');const chunks=[];req.on('data',c=>chunks.push(c));req.on('end',()=>{const p=JSON.parse(Buffer.concat(chunks));if(p.first)new Promise(r=>releaseFirst=r).then(()=>res.end('first'));else res.end('second');});}),corePort=await listen(core);t.after(()=>core.close());
  const config={host:'127.0.0.1',port:0,api_key:'test',nodes:[{}],continuity_door:{enabled:true,core_port:corePort,control_socket:path.join(dir,'door.sock')}};
  const door=createDoor(config);await door.start();t.after(()=>door.close());const port=door.server.address().port;
  const first=request(port,'{"first":true}');while(door.status().active!==1)await new Promise(r=>setImmediate(r));
  door.hold('planned');const second=request(port,'{"second":true}');await new Promise(r=>setTimeout(r,20));assert.equal(door.status().held,1);assert.equal(door.status().active,1);
  releaseFirst();assert.equal((await first).body,'first');door.release();assert.equal((await second).body,'second');
});
test('held client cancellation is removed and never forwarded',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dsg-door-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));let calls=0;
  const core=http.createServer((req,res)=>{if(req.url==='/health')return res.end('ok');calls++;res.end('bad');}),corePort=await listen(core);t.after(()=>core.close());
  const config={host:'127.0.0.1',port:0,api_key:'test',continuity_door:{enabled:true,core_port:corePort,control_socket:path.join(dir,'door.sock')}};
  const door=createDoor(config);await door.start();t.after(()=>door.close());door.hold('planned');
  const req=http.request({host:'127.0.0.1',port:door.server.address().port,path:'/v1/chat/completions',method:'POST',headers:{authorization:'Bearer test'}});req.on('error',()=>{});req.end('{}');
  while(door.status().held!==1)await new Promise(r=>setImmediate(r));req.destroy();while(door.status().held)await new Promise(r=>setImmediate(r));door.release();await new Promise(r=>setTimeout(r,20));assert.equal(calls,0);
});
test('private control refuses release until the replacement core is healthy',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dsg-door-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  let healthy=true;const core=http.createServer((req,res)=>{if(req.url==='/health'){res.statusCode=healthy?200:503;return res.end();}res.end('ok');}),corePort=await listen(core);t.after(()=>core.close());
  const config={host:'127.0.0.1',port:0,api_key:'test',continuity_door:{enabled:true,core_port:corePort,control_socket:path.join(dir,'door.sock')}};
  const door=createDoor(config);await door.start();t.after(()=>door.close());await doorControl(config.continuity_door.control_socket,'/hold',{reason:'planned_gateway_core_restart'});
  healthy=false;await assert.rejects(doorControl(config.continuity_door.control_socket,'/release'),/remains holding/);assert.equal(door.status().holding,true);
  healthy=true;const released=await doorControl(config.continuity_door.control_socket,'/release');assert.equal(released.holding,false);assert.equal(released.core_ready,true);
});
