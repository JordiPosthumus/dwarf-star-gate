import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {once,EventEmitter} from 'node:events';
import {spawn} from 'node:child_process';
import {createDoor} from './door.mjs';
import {doorControl} from './door-client.mjs';
import {coordinatedCoreRestart,releaseParkedCore,PARK_REASON} from './service-control.mjs';

test('lifecycle release cannot clear a newer hold, even with an identical reason',{timeout:5000},async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dsg-hold-owner-'));
  const core=http.createServer((req,res)=>res.end('ok')),corePort=await listen(core);
  const config={host:'127.0.0.1',port:0,api_key:'test',continuity_door:{enabled:true,core_port:corePort,control_socket:path.join(dir,'door.sock'),health_interval_ms:60000}};
  const door=createDoor(config);await door.start();
  t.after(async()=>{core.closeAllConnections();await door.close();await new Promise(r=>core.close(r));fs.rmSync(dir,{recursive:true,force:true});});
  const ready=()=>({active:0,queued:0,startup:{complete:true}});
  for(const reason of ['operator maintenance','planned_gateway_core_restart']){
    door.release();
    await assert.rejects(coordinatedCoreRestart(config,{doorStatus:async()=>door.status(),read:async()=>ready(),stop:async()=>{},start:async()=>door.hold(reason)}),/hold.*changed/i);
    assert.equal(door.status().holding,true);assert.equal(door.status().reason,reason);
  }
  door.hold(PARK_REASON);
  await assert.rejects(releaseParkedCore(config,{doorStatus:async()=>door.status(),coreStatus:async()=>{door.hold(PARK_REASON);return ready();}}),/hold.*changed/i);
  assert.equal(door.status().holding,true);assert.equal(door.status().reason,PARK_REASON);
});

const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(server.address().port)));
const request=(port,body)=>new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port,path:'/v1/chat/completions',method:'POST',headers:{authorization:'Bearer test','content-type':'application/json'}},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,body:Buffer.concat(chunks).toString(),headers:res.headers}));});req.on('error',reject);req.end(body);});
const get=(port,route)=>new Promise((resolve,reject)=>{http.get({host:'127.0.0.1',port,path:route,agent:false,headers:{authorization:'Bearer test'}},res=>{
  const chunks=[];res.on('data',c=>chunks.push(c));res.on('error',reject);res.on('end',()=>resolve({status:res.statusCode,body:Buffer.concat(chunks).toString()}));
}).on('error',reject);});
test('duplicate Door startup preserves the running control socket and maintenance hold',{timeout:5000},async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dsg-door-duplicate-'));
  const received=[];
  const core=http.createServer((req,res)=>{if(req.url==='/health'){req.resume();return res.end('ok');}let body='';req.on('data',c=>body+=c);req.on('end',()=>{received.push(body);res.end('ok');});}),corePort=await listen(core);
  const config={host:'127.0.0.1',port:0,api_key:'test',continuity_door:{enabled:true,core_port:corePort,control_socket:path.join(dir,'door.sock'),health_interval_ms:60000}};
  const door=createDoor(config);await door.start();
  t.after(async()=>{await door.close();core.closeAllConnections();await new Promise(r=>core.close(r));fs.rmSync(dir,{recursive:true,force:true});});
  const receipt=await doorControl(config.continuity_door.control_socket,'/hold',{reason:'operator maintenance'});
  const original=' {"unchanged":"held fixture"}\n',work=request(door.server.address().port,original);
  while(door.status().held!==1)await new Promise(r=>setImmediate(r));
  const before=fs.lstatSync(config.continuity_door.control_socket);
  const duplicate=createDoor({...config,port:door.server.address().port});
  await assert.rejects(duplicate.start());
  const after=fs.lstatSync(config.continuity_door.control_socket);
  assert.equal(after.ino,before.ino);assert.equal(after.dev,before.dev);
  const status=await doorControl(config.continuity_door.control_socket,'/status');
  assert.equal(status.hold_id,receipt.hold_id);assert.equal(status.reason,'operator maintenance');
  assert.equal(status.held,1);assert.deepEqual(received,[]);
  assert.equal((await get(door.server.address().port,'/continuity/status')).status,200);
  await doorControl(config.continuity_door.control_socket,'/release',{if_hold_id:receipt.hold_id});
  assert.equal((await work).body,'ok');assert.deepEqual(received,[original]);
});
async function staleSocket(socketPath,t){
  const child=spawn(process.execPath,['--input-type=module','-e',"import net from 'node:net';net.createServer().listen(process.argv[1],()=>process.send('ready'));",socketPath],{stdio:['ignore','ignore','inherit','ipc']});
  t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');});
  await once(child,'message');const exited=once(child,'exit');child.kill('SIGKILL');await exited;
  assert(fs.lstatSync(socketPath).isSocket(),'crash fixture must leave a real socket');
}
test('different public ports cannot steal one live control socket',{timeout:5000},async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dsg-door-socket-live-'));
  const core=http.createServer((req,res)=>res.end('ok')),corePort=await listen(core);
  const config={host:'127.0.0.1',port:0,api_key:'test',continuity_door:{enabled:true,core_port:corePort,control_socket:path.join(dir,'door.sock'),health_interval_ms:60000}};
  const door=createDoor(config);await door.start();
  t.after(async()=>{await door.close();await new Promise(r=>core.close(r));fs.rmSync(dir,{recursive:true,force:true});});
  const duplicate=createDoor(config);await assert.rejects(duplicate.start(),/already in use/);
  assert.equal(duplicate.server.listening,false);assert.equal(duplicate.control.listening,false);
  assert.equal((await doorControl(config.continuity_door.control_socket,'/status')).service,'dwarf-star-gate-continuity-door');
});
test('repeated start on the same Door instance cannot close its listeners',{timeout:5000},async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dsg-door-repeat-start-')),socketPath=path.join(dir,'door.sock');
  const core=http.createServer((req,res)=>res.end('ok')),corePort=await listen(core);
  const door=createDoor({host:'127.0.0.1',port:0,api_key:'test',continuity_door:{enabled:true,core_port:corePort,control_socket:socketPath,health_interval_ms:60000}});
  t.after(async()=>{await door.close();await new Promise(r=>core.close(r));fs.rmSync(dir,{recursive:true,force:true});});
  const results=await Promise.allSettled([door.start(),door.start()]);assert.equal(results[0].status,'fulfilled');assert.equal(results[1].status,'rejected');
  const receipt=await doorControl(socketPath,'/hold',{reason:'preserve me'});
  await assert.rejects(door.start(),/already started/);
  assert.equal((await doorControl(socketPath,'/status')).hold_id,receipt.hold_id);
  assert.equal((await get(door.server.address().port,'/continuity/status')).status,200);
});
test('shutdown during startup does not recreate listeners or a health monitor',{timeout:5000},async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dsg-door-start-close-')),socketPath=path.join(dir,'door.sock');let healthCalls=0;
  const core=http.createServer(()=>healthCalls++),corePort=await listen(core);
  const door=createDoor({host:'127.0.0.1',port:0,api_key:'test',continuity_door:{enabled:true,core_port:corePort,control_socket:socketPath,health_interval_ms:250}});
  t.after(async()=>{await door.close();core.closeAllConnections();await new Promise(r=>core.close(r));fs.rmSync(dir,{recursive:true,force:true});});
  const started=assert.rejects(door.start(),/closing during startup/);
  while(!healthCalls)await new Promise(r=>setImmediate(r));
  await door.close();await started;
  assert.equal(door.server.listening,false);assert.equal(door.control.listening,false);assert.equal(fs.existsSync(socketPath),false);
  await new Promise(r=>setTimeout(r,300));assert.equal(healthCalls,1);
  await assert.rejects(door.start(),/closing/);
});
test('a non-HTTP socket owner is preserved without sending a probe request',{timeout:5000},async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dsg-door-socket-peer-')),socketPath=path.join(dir,'door.sock');let bytes=0;
  const peer=net.createServer(socket=>socket.on('data',chunk=>bytes+=chunk.length));
  await new Promise(r=>peer.listen(socketPath,r));
  t.after(async()=>{await new Promise(r=>peer.close(r));fs.rmSync(dir,{recursive:true,force:true});});
  const before=fs.lstatSync(socketPath),door=createDoor({host:'127.0.0.1',port:0,api_key:'test',continuity_door:{enabled:true,core_port:1,control_socket:socketPath}});
  await assert.rejects(door.start(),/already in use/);
  assert.equal(fs.lstatSync(socketPath).ino,before.ino);assert.equal(bytes,0);assert.equal(door.server.listening,false);
});
test('concurrent Door starts have one owner for both fresh and crashed sockets',{timeout:10000},async t=>{
  for(const stale of [false,true]){
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dsg-door-socket-race-')),socketPath=path.join(dir,'door.sock');
    const core=http.createServer((req,res)=>res.end('ok')),corePort=await listen(core);
    if(stale)await staleSocket(socketPath,t);
    const config={host:'127.0.0.1',port:0,api_key:'test',continuity_door:{enabled:true,core_port:corePort,control_socket:socketPath,health_interval_ms:60000}};
    const doors=[createDoor(config),createDoor(config)];
    t.after(async()=>{for(const door of doors)await door.close();await new Promise(r=>core.close(r));fs.rmSync(dir,{recursive:true,force:true});});
    const results=await Promise.allSettled(doors.map(door=>door.start()));
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
    const owner=doors[results.findIndex(r=>r.status==='fulfilled')];
    assert.equal((fs.statSync(socketPath).mode&0o777),0o600);
    assert.equal((await doorControl(socketPath,'/status')).core_ready,true);
    assert.equal((await get(owner.server.address().port,'/v1/models')).body,'ok');
  }
});
test('a changed stale socket and non-socket paths are never removed',{timeout:5000},async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dsg-door-socket-changed-')),socketPath=path.join(dir,'door.sock');
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  await staleSocket(socketPath,t);
  const stat=fs.lstatSync;let reads=0;
  const mock=t.mock.method(fs,'lstatSync',(filename,...args)=>{
    if(filename===socketPath&&++reads===2){fs.unlinkSync(socketPath);fs.writeFileSync(socketPath,'replacement must survive');}
    return stat(filename,...args);
  });
  const config={host:'127.0.0.1',port:0,api_key:'test',continuity_door:{enabled:true,core_port:1,control_socket:socketPath}};
  await assert.rejects(createDoor(config).start(),/changed during startup/);mock.mock.restore();
  assert.equal(fs.readFileSync(socketPath,'utf8'),'replacement must survive');
  await assert.rejects(createDoor(config).start(),/not a socket/);
  const link=path.join(dir,'link.sock');fs.symlinkSync(socketPath,link);
  await assert.rejects(createDoor({...config,continuity_door:{...config.continuity_door,control_socket:link}}).start(),/not a socket/);
  assert(fs.lstatSync(link).isSymbolicLink());assert.equal(fs.readFileSync(socketPath,'utf8'),'replacement must survive');
});
test('public bind failure cleans up only its own socket and permits a later start',{timeout:5000},async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dsg-door-bind-fail-')),socketPath=path.join(dir,'door.sock');
  const core=http.createServer((req,res)=>res.end('ok')),corePort=await listen(core);
  const config={host:'127.0.0.1',port:corePort,api_key:'test',continuity_door:{enabled:true,core_port:1,control_socket:socketPath,health_interval_ms:60000}};
  const failed=createDoor(config);
  t.after(async()=>{await failed.close();core.closeAllConnections();await new Promise(r=>core.close(r));fs.rmSync(dir,{recursive:true,force:true});});
  await assert.rejects(failed.start(),{code:'EADDRINUSE'});
  assert.equal(fs.existsSync(socketPath),false);assert.equal(failed.control.listening,false);
  const next=createDoor({...config,port:0,continuity_door:{...config.continuity_door,core_port:corePort}});await next.start();
  assert.equal((await doorControl(socketPath,'/status')).core_ready,true);await next.close();
});
test('uncertain socket probes preserve the path and invalid intervals never bind',{timeout:5000},async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dsg-door-socket-unknown-')),socketPath=path.join(dir,'door.sock');
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));await staleSocket(socketPath,t);
  const before=fs.lstatSync(socketPath),config={host:'127.0.0.1',port:0,api_key:'test',continuity_door:{enabled:true,core_port:1,control_socket:socketPath}};
  for(const code of ['EACCES','ECONNRESET','ENOENT',null]){
    const mock=t.mock.method(net,'createConnection',()=>{const peer=new EventEmitter();peer.destroy=()=>{};if(code)queueMicrotask(()=>peer.emit('error',Object.assign(new Error(code),{code})));return peer;});
    await assert.rejects(createDoor(config).start(),code?{code}:/ownership is unknown/);mock.mock.restore();
    assert.equal(fs.lstatSync(socketPath).ino,before.ino);
  }
  for(const health_interval_ms of [0,249,60001,NaN])assert.throws(()=>createDoor({...config,continuity_door:{...config.continuity_door,health_interval_ms}}),/health_interval_ms/);
  assert.equal(fs.lstatSync(socketPath).ino,before.ino);
});
test('hold receipts fence before and during readiness, keeping held bytes undispatched',{timeout:5000},async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dsg-hold-cas-'));let delayed=false,pending,healthCalls=0;const bodies=[];
  const core=http.createServer((req,res)=>{
    if(req.url==='/health'){healthCalls++;if(delayed){pending=res;return;}return res.end('ok');}
    const chunks=[];req.on('data',c=>chunks.push(c));req.on('end',()=>{bodies.push(Buffer.concat(chunks).toString());res.end('done');});
  });
  const corePort=await listen(core),config={host:'127.0.0.1',port:0,api_key:'test',continuity_door:{enabled:true,core_port:corePort,control_socket:path.join(dir,'door.sock'),health_interval_ms:60000}};
  const door=createDoor(config);await door.start();
  t.after(async()=>{core.closeAllConnections();await door.close();await new Promise(r=>core.close(r));fs.rmSync(dir,{recursive:true,force:true});});
  const control=(route,body)=>doorControl(config.continuity_door.control_socket,route,body);
  const first=await control('/hold',{reason:'same reason'});
  const original=' {"model":"fixture","stream":true,"messages":[]}\n';
  const work=request(door.server.address().port,original);
  while(door.status().held!==1)await new Promise(r=>setImmediate(r));
  const second=await control('/hold',{reason:'same reason'});assert.notEqual(second.hold_id,first.hold_id);
  const before=healthCalls;
  await assert.rejects(control('/release',{if_hold_id:first.hold_id}),/hold changed/);
  assert.equal(healthCalls,before,'stale receipt must fail before probing');
  for(const invalid of [null,0,'',{}])await assert.rejects(control('/release',{if_hold_id:invalid}),/nonempty hold receipt/);
  assert.equal(door.status().held,1);assert.deepEqual(bodies,[]);
  delayed=true;
  const release=assert.rejects(control('/release',{if_hold_id:second.hold_id}),/hold changed/);
  while(!pending)await new Promise(r=>setImmediate(r));
  const third=await control('/hold',{reason:'same reason'});pending.end('obsolete');await release;
  assert.equal(door.status().hold_id,third.hold_id);assert.equal(door.status().held,1);assert.deepEqual(bodies,[]);
  delayed=false;const done=await control('/release',{if_hold_id:third.hold_id});
  assert.equal(done.hold_id,null);assert.equal((await work).body,'done');assert.deepEqual(bodies,[original]);
  await assert.rejects(control('/release',{if_hold_id:third.hold_id}),/hold changed/);
});
test('model discovery waits through planned core downtime while status reads remain available',{timeout:5000},async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dsg-door-discovery-')),calls=[];
  const body='{"data":[{"id":"fixture-model"}]}';
  const core=http.createServer((req,res)=>{req.resume();if(req.url==='/health')return res.end('ok');calls.push({url:req.url,auth:req.headers.authorization});res.setHeader('content-type','application/json');res.end(body);});
  const corePort=await listen(core),config={host:'127.0.0.1',port:0,api_key:'test',continuity_door:{enabled:true,core_port:corePort,control_socket:path.join(dir,'door.sock'),health_interval_ms:60000}};
  const door=createDoor(config);await door.start();
  t.after(async()=>{core.closeAllConnections();await door.close();await new Promise(r=>core.close(r));fs.rmSync(dir,{recursive:true,force:true});});
  door.hold('planned_gateway_core_restart');await new Promise(r=>core.close(r));
  let resolved=false;const pending=get(door.server.address().port,'/v1/models?fixture=kept').then(r=>{resolved=true;return r;});
  await new Promise(r=>setTimeout(r,40));assert.equal(resolved,false,'discovery must not escape a planned hold and return a transient 503');
  assert.equal(door.status().held,1);assert.equal(calls.length,0);assert.equal(door.status().model_discovery_hold,true);
  assert.equal((await get(door.server.address().port,'/gateway/status')).status,503);
  assert.equal(door.status().held,1,'a failed status poll does not discard held discovery');
  await new Promise(r=>core.listen(corePort,'127.0.0.1',r));
  await doorControl(config.continuity_door.control_socket,'/release');
  assert.deepEqual(await pending,{status:200,body});assert.deepEqual(calls,[{url:'/v1/models?fixture=kept',auth:'Bearer test'}]);
  assert.equal(door.status().held,0);assert.equal(door.status().replay,false);
});
test('model discovery waits behind an automatic hold until a fresh healthy probe releases it',{timeout:5000},async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dsg-door-discovery-auto-'));let ready=true,calls=0;
  const core=http.createServer((req,res)=>{req.resume();if(req.url==='/health'){res.statusCode=ready?200:503;return res.end('health');}calls++;res.end('models');});
  const corePort=await listen(core),door=createDoor({host:'127.0.0.1',port:0,api_key:'test',continuity_door:{enabled:true,core_port:corePort,control_socket:path.join(dir,'door.sock'),health_interval_ms:60000,health_failures:1}});
  await door.start();t.after(async()=>{core.closeAllConnections();await door.close();await new Promise(r=>core.close(r));fs.rmSync(dir,{recursive:true,force:true});});
  ready=false;assert.equal(await door.checkCore(),false);assert.equal(door.status().hold_kind,'automatic');
  let resolved=false;const pending=get(door.server.address().port,'/v1/models').then(r=>{resolved=true;return r;});
  await new Promise(r=>setTimeout(r,30));assert.equal(resolved,false);assert.equal(door.status().held,1);assert.equal(calls,0);
  assert.equal((await get(door.server.address().port,'/continuity/status')).status,200,'local Door status remains available while core is not ready');
  assert.equal(await door.checkCore(),false);assert.equal(door.status().held,1);
  ready=true;assert.equal(await door.checkCore(),true);assert.deepEqual(await pending,{status:200,body:'models'});
  assert.equal(calls,1);assert.equal(door.status().held,0);assert.equal(door.status().failed,0);
});
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
    assert.deepEqual(door.status().failure_evidence.recent,[]);
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
    const evidence=door.status().failure_evidence;
    assert.equal(evidence.by_request_class.inference,1);assert.equal(evidence.recent.length,1);
    assert.equal(evidence.recent[0].phase,streaming?'after_response_headers':'before_response_headers');
    assert.equal(evidence.recent[0].backend_dispatch,'unknown');
  });
});
test('failure evidence separates request types, stays bounded and exposes no paths or payloads',{timeout:5000},async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dsg-door-evidence-'));let mode='http_error',clock=1000;
  const core=http.createServer((req,res)=>{req.resume();if(req.url==='/health')return res.end('ok');
    if(mode==='http_error'){res.statusCode=400;return res.end('private backend message');}res.destroy();});
  const corePort=await listen(core),door=createDoor({host:'127.0.0.1',port:0,api_key:'test',continuity_door:{enabled:true,core_port:corePort,control_socket:path.join(dir,'door.sock'),health_interval_ms:60000}},{now:()=>clock++});
  await door.start();t.after(async()=>{core.closeAllConnections();await door.close();await new Promise(r=>core.close(r));fs.rmSync(dir,{recursive:true,force:true});});
  const port=door.server.address().port;
  assert.equal((await get(port,'/private?secret=yes')).status,400);
  assert.equal(door.status().failed,0,'HTTP rejection is not a proxy transport failure');
  mode='connection';
  assert.equal((await get(port,'/private?secret=yes')).status,503);door.release();
  assert.equal((await get(port,'/v1/models?secret=yes')).status,503);door.release();
  assert.equal((await request(port,'{"secret":"private body"}')).status,503);
  door.hold('private maintenance reason');
  assert.equal((await get(port,'/gateway/status?secret=yes')).status,503);
  let evidence=door.status().failure_evidence;
  assert.equal(evidence.scope,'door_process');assert.deepEqual(evidence.by_request_class,{inference:1,model_discovery:1,status:1,other:1});
  assert.equal(evidence.recent[0].holding,true);assert.equal(evidence.recent[0].hold_kind,'manual');
  for(let i=0;i<32;i++)assert.equal((await get(port,'/gateway/status')).status,503);
  evidence=door.status().failure_evidence;
  assert.equal(door.status().failed,36);assert.equal(evidence.by_request_class.status,33);assert.equal(evidence.recent.length,30);
  assert.equal(evidence.recent[0].sequence,36);assert.equal(evidence.recent.at(-1).sequence,7);
  assert.ok(evidence.recent.every(r=>r.backend_dispatch==='unknown'));
  for(const text of ['secret','private','/gateway','Bearer','body'])assert.equal(JSON.stringify(evidence).includes(text),false);
  evidence.by_request_class.status=999;evidence.recent[0].request_class='mutated';evidence.recent.length=0;
  assert.equal(door.status().failure_evidence.by_request_class.status,33);assert.equal(door.status().failure_evidence.recent[0].request_class,'status');
});
test('held model discovery shares capacity and cancellation cleanup without being forwarded',{timeout:5000},async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dsg-door-discovery-cancel-'));let calls=0;
  const core=http.createServer((req,res)=>{req.resume();if(req.url==='/health')return res.end('ok');calls++;res.end('models');});
  const corePort=await listen(core),door=createDoor({host:'127.0.0.1',port:0,api_key:'test',continuity_door:{enabled:true,core_port:corePort,control_socket:path.join(dir,'door.sock'),health_interval_ms:60000,max_held_requests:1}});
  await door.start();t.after(async()=>{core.closeAllConnections();await door.close();await new Promise(r=>core.close(r));fs.rmSync(dir,{recursive:true,force:true});});
  door.hold('planned');const port=door.server.address().port;
  const client=http.get({host:'127.0.0.1',port,path:'/v1/models',agent:false},res=>res.resume());client.on('error',()=>{});
  while(door.status().held!==1)await new Promise(r=>setImmediate(r));
  assert.equal((await request(port,'{}')).status,429);assert.equal(calls,0);
  client.destroy();while(door.status().held)await new Promise(r=>setImmediate(r));
  assert.equal(door.status().failed,0);assert.deepEqual(door.status().failure_evidence.recent,[]);
  door.release();assert.equal((await get(port,'/v1/models')).body,'models');assert.equal(calls,1);
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
