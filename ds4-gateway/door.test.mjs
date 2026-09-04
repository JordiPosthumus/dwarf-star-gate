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
test('core health probe settles false after response headers are truncated',{timeout:5000},async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dsg-door-probe-'));let broken=false;
  const core=http.createServer((req,res)=>{req.resume();if(!broken)return res.end('ok');res.writeHead(200,{'content-length':'20'});res.write('partial');setTimeout(()=>res.destroy(),20);});
  const corePort=await listen(core),door=createDoor({host:'127.0.0.1',port:0,api_key:'test',continuity_door:{enabled:true,core_port:corePort,control_socket:path.join(dir,'door.sock'),health_interval_ms:60000,health_timeout_ms:100}});
  await door.start();t.after(async()=>{core.closeAllConnections();await door.close();await new Promise(r=>core.close(r));fs.rmSync(dir,{recursive:true,force:true});});
  broken=true;let timer;
  const result=await Promise.race([door.checkCore(),new Promise(resolve=>{timer=setTimeout(()=>resolve('unsettled'),500);})]);clearTimeout(timer);
  assert.equal(result,false,'a broken probe must not leave startup/release waiting forever');
  assert.equal(door.status().core_ready,false);assert.equal(door.status().core_failures,1);
});
test('core health probe started before a connection failure cannot release its newer hold',{timeout:5000},async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dsg-door-stale-probe-'));let delayed=false,pending;
  const core=http.createServer((req,res)=>{req.resume();if(req.url==='/health'){if(delayed){pending=res;return;}return res.end('ok');}res.destroy();});
  const corePort=await listen(core),door=createDoor({host:'127.0.0.1',port:0,api_key:'test',continuity_door:{enabled:true,core_port:corePort,control_socket:path.join(dir,'door.sock'),health_interval_ms:60000,health_timeout_ms:2000}});
  await door.start();t.after(async()=>{core.closeAllConnections();await door.close();await new Promise(r=>core.close(r));fs.rmSync(dir,{recursive:true,force:true});});
  delayed=true;const old=door.checkCore();while(!pending)await new Promise(r=>setImmediate(r));
  assert.equal((await request(door.server.address().port,'{}')).status,503);assert.equal(door.status().holding,true);
  pending.end('old healthy observation');await old;
  assert.equal(door.status().holding,true,'pre-failure probe cannot release a newer automatic hold');
  assert.equal(door.status().reason,'core_connection_failed');
  delayed=false;assert.equal(await door.checkCore(),true);assert.equal(door.status().holding,false);
});
test('core health probes coalesce and manual holds invalidate pending observations',{timeout:5000},async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dsg-door-coalesce-'));let delayed=false,pending,calls=0;
  const core=http.createServer((req,res)=>{req.resume();calls++;if(delayed){pending=res;return;}res.end('ok');});
  const corePort=await listen(core),config={host:'127.0.0.1',port:0,api_key:'test',continuity_door:{enabled:true,core_port:corePort,control_socket:path.join(dir,'door.sock'),health_interval_ms:60000}};
  const door=createDoor(config);await door.start();t.after(async()=>{core.closeAllConnections();await door.close();await new Promise(r=>core.close(r));fs.rmSync(dir,{recursive:true,force:true});});
  delayed=true;const first=door.checkCore();for(let i=0;i<20;i++)assert.equal(door.checkCore(),first);
  while(!pending)await new Promise(r=>setImmediate(r));assert.equal(calls,2,'one startup probe and one shared in-flight probe');
  door.hold('operator research');assert.equal(await first,false);pending.end('obsolete');
  assert.equal(door.status().core_failures,0,'invalidated observation is not a failed probe');
  pending=null;
  const release=doorControl(config.continuity_door.control_socket,'/release');
  const rejected=assert.rejects(release,/remains holding/);
  while(!pending)await new Promise(r=>setImmediate(r));
  door.hold('new operator reservation');pending.end('obsolete release check');await rejected;
  assert.equal(door.status().reason,'new operator reservation');assert.equal(door.status().hold_kind,'manual');
  delayed=false;assert.equal(await door.checkCore(),true);assert.equal(door.status().holding,true,'health alone never releases a manual hold');
});
test('core health deadline bounds a dripping body and shutdown settles pending probes',{timeout:5000},async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dsg-door-deadline-'));let mode='healthy',pending=false;
  const core=http.createServer((req,res)=>{req.resume();if(mode==='healthy')return res.end('ok');if(mode==='pending'){pending=true;return;}
    res.writeHead(200);res.write('x');const ticker=setInterval(()=>res.write('x'),10);res.on('close',()=>clearInterval(ticker));});
  const corePort=await listen(core),door=createDoor({host:'127.0.0.1',port:0,api_key:'test',continuity_door:{enabled:true,core_port:corePort,control_socket:path.join(dir,'door.sock'),health_interval_ms:60000,health_timeout_ms:300}});
  await door.start();t.after(async()=>{core.closeAllConnections();await door.close();await new Promise(r=>core.close(r));fs.rmSync(dir,{recursive:true,force:true});});
  mode='drip';let timer;
  const result=await Promise.race([door.checkCore(),new Promise(resolve=>{timer=setTimeout(()=>resolve('unsettled'),1500);})]);clearTimeout(timer);
  assert.equal(result,false);assert.equal(door.status().core_failures,1);assert.equal(door.status().core_ready,false);
  mode='pending';const probe=door.checkCore();while(!pending)await new Promise(r=>setImmediate(r));
  const closing=door.close();assert.equal(await probe,false);await closing;
  assert.equal(door.status().core_failures,1,'shutdown is not another health failure');assert.equal(await door.checkCore(),false);
});
test('active client cancellation never marks a healthy core failed or starts an automatic hold',{timeout:5000},async t=>{
  for(const streaming of [false,true])await t.test(streaming?'after response headers':'before response headers',async t=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dsg-door-cancel-'));let calls=0;
    const core=http.createServer((req,res)=>{req.resume();if(req.url==='/health')return res.end('ok');calls++;if(calls>1)return res.end('next request');if(streaming){res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: partial\n\n');}});
    const corePort=await listen(core),door=createDoor({host:'127.0.0.1',port:0,api_key:'test',continuity_door:{enabled:true,core_port:corePort,control_socket:path.join(dir,'door.sock'),health_interval_ms:60000}});
    await door.start();t.after(async()=>{await door.close();core.closeAllConnections();await new Promise(r=>core.close(r));fs.rmSync(dir,{recursive:true,force:true});});
    const client=http.request({host:'127.0.0.1',port:door.server.address().port,path:'/v1/chat/completions',method:'POST'},res=>{res.on('error',()=>{});res.resume();});client.on('error',()=>{});client.end('{}');
    while(calls!==1||streaming&&door.status().forwarded!==1)await new Promise(r=>setImmediate(r));
    client.destroy();while(door.status().active!==0)await new Promise(r=>setImmediate(r));
    await new Promise(r=>setTimeout(r,30));
    assert.equal(door.status().failed,0,'client cancellation is not an upstream failure');
    assert.equal(door.status().holding,false,'client cancellation cannot fence unrelated requests');
    assert.equal(door.status().core_ready,true);
    assert.equal((await request(door.server.address().port,'{}')).body,'next request');assert.equal(calls,2);
  });
});
test('genuine core connection failures and partial responses are still counted once',{timeout:5000},async t=>{
  for(const streaming of [false,true])await t.test(streaming?'broken response':'broken connection',async t=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dsg-door-fault-'));let calls=0;
    const core=http.createServer((req,res)=>{req.resume();if(req.url==='/health')return res.end('ok');calls++;
      if(!streaming)return res.destroy();res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: partial\n\n');setTimeout(()=>res.destroy(),20);
    }),corePort=await listen(core);
    const door=createDoor({host:'127.0.0.1',port:0,api_key:'test',continuity_door:{enabled:true,core_port:corePort,control_socket:path.join(dir,'door.sock'),health_interval_ms:60000}});
    await door.start();t.after(async()=>{await door.close();core.closeAllConnections();await new Promise(r=>core.close(r));fs.rmSync(dir,{recursive:true,force:true});});
    const port=door.server.address().port;
    if(!streaming){const r=await request(port,'{}');assert.equal(r.status,503);assert.equal(door.status().holding,true);assert.equal(door.status().reason,'core_connection_failed');}
    else await new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port,path:'/v1/chat/completions',method:'POST'},res=>{
      res.resume();res.on('error',()=>{});res.on('aborted',resolve);res.on('end',()=>reject(new Error('Broken response became a clean completion')));
    });req.on('error',reject);req.end('{}');});
    await new Promise(r=>setTimeout(r,30));assert.equal(door.status().failed,1);assert.equal(door.status().active,0);assert.equal(calls,1,'ambiguous dispatched work is never replayed');
  });
});
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
test('conditional hold preserves an existing operator hold',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dsg-door-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const core=http.createServer((req,res)=>res.end('ok')),corePort=await listen(core);t.after(()=>core.close());
  const config={host:'127.0.0.1',port:0,api_key:'test',continuity_door:{enabled:true,core_port:corePort,control_socket:path.join(dir,'door.sock')}};
  const door=createDoor(config);await door.start();t.after(()=>door.close());await doorControl(config.continuity_door.control_socket,'/hold',{reason:'operator maintenance'});
  await assert.rejects(doorControl(config.continuity_door.control_socket,'/hold',{reason:'planned_gateway_core_park',if_unheld:true}),/already has a hold/);
  assert.equal(door.status().reason,'operator maintenance');assert.equal(door.status().hold_kind,'manual');
});
