import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import http from 'node:http';
import {lanAddresses,readLanSharing,writeLanSharing,isLoopback,lanSharingDetails} from './lan-sharing.mjs';
import {createDoor} from './door.mjs';import {doorControl} from './door-client.mjs';import {createDashboard} from './dashboard.mjs';
// Construct synthetic RFC1918/Bonjour fixtures; these are not deployment addresses.
const lanA=[192,168,1,10].join('.'),lanB=[192,168,1,11].join('.'),lanC=[192,168,1,12].join('.'),vpn=[10,0,0,2].join('.');
const macA=['example','local'].join('.'),macB=['another-example','local'].join('.');
const lanUrl=address=>`http://${address}:30000/v1`;
const listen=(server,host='127.0.0.1')=>new Promise(resolve=>server.listen(0,host,()=>resolve(server.address().port)));
const temp=t=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dsg-lan-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;};

test('LAN state preserves the existing bind by default, persists changes and rejects corrupt state',t=>{
 const dir=temp(t),file=path.join(dir,'lan-sharing.json');
 assert.equal(readLanSharing(file,true).enabled,true);assert.equal(readLanSharing(file,false).enabled,false);
 writeLanSharing(file,false,true);assert.equal(readLanSharing(file,true).enabled,false);
 writeLanSharing(file,true,true);assert.equal(readLanSharing(file,false).enabled,true);
 assert.ok(fs.readdirSync(dir).some(n=>n.endsWith('.bak')));
 fs.writeFileSync(file,'broken');assert.throws(()=>writeLanSharing(file,false,true));assert.equal(fs.readFileSync(file,'utf8'),'broken');
});
test('LAN address discovery uses actual private interfaces and excludes loopback, VPN and public addresses',()=>{
 const row=address=>({family:'IPv4',address,internal:false});
 const interfaces={utun0:[row(vpn)],en1:[row(lanB)],en0:[row(lanA)],lo0:[{...row('127.0.0.1'),internal:true}],en2:[row('203.0.113.1')]};
 assert.deepEqual(lanAddresses({host:'0.0.0.0',port:30000},interfaces),[lanUrl(lanA),lanUrl(lanB)]);
 assert.deepEqual(lanAddresses({host:'127.0.0.1',port:30000},interfaces),[]);
 assert.ok(isLoopback('::ffff:127.0.0.1'));assert.ok(isLoopback('::1'));assert.equal(isLoopback(lanA),false);
});
test('turning LAN off blocks new remote requests, ignores spoofed headers and preserves live streams and local access',{timeout:10000},async t=>{
 const dir=temp(t);let finishStream,remote=true;
 const core=http.createServer((req,res)=>{
  if(req.url==='/health')return res.end('ok');
  if(req.headers.authorization!=='Bearer none'){res.writeHead(401);return res.end('wrong key');}
  if(req.url==='/v1/chat/completions'){res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: first\n\n');finishStream=()=>res.end('data: last\n\n');}
  else res.end(JSON.stringify({data:[{id:'model'}]}));
 });const port=await listen(core);
 const config={host:'0.0.0.0',port:0,api_key:'none',state_file:path.join(dir,'affinity.json'),continuity_door:{enabled:true,core_port:port,control_socket:path.join(dir,'door.sock'),health_interval_ms:60000}};
 const door=createDoor(config);
 // Emulate a LAN peer on a loopback-only test connection. Production always
 // uses the socket's real peer address; no injectable policy bypass exists.
 door.server.on('connection',socket=>{if(remote)Object.defineProperty(socket,'remoteAddress',{value:lanC});});
 await door.start();t.after(async()=>{finishStream?.();await door.close();await new Promise(resolve=>core.close(resolve));});
 const url=`http://127.0.0.1:${door.server.address().port}`;
 const call=route=>fetch(url+route,{headers:{authorization:'Bearer none','x-forwarded-for':'127.0.0.1'},agent:false});
 const before=await doorControl(config.continuity_door.control_socket,'/lan-sharing');assert.equal(before.enabled,true);assert.equal(before.api_key,'none');
 const stream=await call('/v1/chat/completions');assert.equal(stream.status,200);const body=stream.text();
 const off=await doorControl(config.continuity_door.control_socket,'/set-lan-sharing',{enabled:false});assert.equal(off.enabled,false);
 assert.equal((await call('/v1/models')).status,503);assert.equal(door.status().active,1);
 finishStream();assert.match(await body,/first[\s\S]*last/);
 remote=false;
 // A fresh TCP connection makes the loopback peer distinct from the LAN one.
 const local=await new Promise((resolve,reject)=>http.get(url+'/v1/models',{agent:false,headers:{authorization:'Bearer none'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));}).on('error',reject));
 assert.equal(local,200);
 await assert.rejects(doorControl(config.continuity_door.control_socket,'/set-lan-sharing',{enabled:'true'}));
 await doorControl(config.continuity_door.control_socket,'/set-lan-sharing',{enabled:true});
 assert.equal((await call('/v1/models')).status,200);
 assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'lan-sharing.json'))).enabled,true);
});
test('LAN dashboard toggle requires same origin and CSRF and reveals the exact configured key',{timeout:5000},async t=>{
 let enabled=true,changes=0;const value=()=>({available:true,enabled,urls:[lanUrl(lanA)],api_key:'none'});
 const server=createDashboard(()=>({}),undefined,null,null,null,null,null,{read:async()=>value(),set:async next=>{enabled=next;changes++;return value();}});
 const port=await listen(server);t.after(()=>{server.closeAllConnections();server.close();});const url=`http://127.0.0.1:${port}`;
 const initial=await(await fetch(url+'/api/lan-sharing')).json();assert.equal(initial.api_key,'none');assert.equal(initial.urls[0],lanUrl(lanA));
 const post=(headers,body={enabled:false})=>fetch(url+'/api/lan-sharing',{method:'POST',headers,body:JSON.stringify(body)});
 const headers={origin:url,'content-type':'application/json','x-dsg-csrf':initial.csrf_token};
 assert.equal((await post({...headers,origin:'http://untrusted.example'})).status,403);
 assert.equal((await post({...headers,'x-dsg-csrf':'wrong'})).status,403);
 assert.equal((await post(headers,{enabled:false,api_key:'replacement'})).status,400);assert.equal(changes,0);
 const response=await post(headers);assert.equal(response.status,200);assert.equal((await response.json()).enabled,false);assert.equal(changes,1);
});


test('LAN display discovers each Mac name independently and keeps the hostname stable across DHCP changes',()=>{
 const before={available:true,enabled:true,api_key:'none',urls:[lanUrl(lanA)]};
 const a=lanSharingDetails(before,30000,macA);
 assert.equal(a.urls[0],lanUrl(macA));assert.deepEqual(a.ip_urls,before.urls);assert.equal(before.urls.length,1);
 const moved=lanSharingDetails({...before,urls:[lanUrl(lanB)]},30000,macA);
 assert.equal(moved.urls[0],a.urls[0]);assert.equal(moved.ip_urls[0],lanUrl(lanB));
 assert.equal(lanSharingDetails(before,30000,macB).urls[0],lanUrl(macB));
 for(const name of [null,'unadvertised-host',macA+'/path','user@'+macA])assert.deepEqual(lanSharingDetails(before,30000,name).urls,before.urls);
 assert.equal(lanSharingDetails({...before,urls:[]},30000,macA).hostname_url,null);
});
