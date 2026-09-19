import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {requestAuthorized} from './request-auth.mjs';
import {createGateway} from './gateway.mjs';
import {createDoor} from './door.mjs';
test('LAN mode uses actual peer; bearer mode and external authentication remain available',()=>{
 const req=(ip,key)=>({socket:{remoteAddress:ip},headers:{...(key?{authorization:`Bearer ${key}`}:{ }),'x-forwarded-for':'127.0.0.1'}});
 const c={lan_auth:'none',lan_auth_prefix:'192.0.2.',api_key:'test'};
 for(const ip of ['127.0.0.1','::1','::ffff:192.0.2.7','192.0.2.8'])assert.equal(requestAuthorized(c,req(ip)),true);
 for(const ip of ['198.51.100.2','203.0.113.4','192.0.2.invalid',undefined]){assert.equal(requestAuthorized(c,req(ip)),false);assert.equal(requestAuthorized(c,req(ip,'test')),true);}
 assert.equal(requestAuthorized({...c,lan_auth:'bearer'},req('127.0.0.1')),false);
});
test('credential-free Door and core accept media/status and reject empty uploads clearly',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sg-lan-auth-'));
 const c={host:'127.0.0.1',port:0,lan_auth:'none',api_key:'test',model:'fixture',context_length:262144,nodes:[],state_file:path.join(dir,'state.json'),media_jobs:{enabled:true}};
 const core=createGateway(c),addr=await core.start();
 const door=createDoor({...c,continuity_door:{enabled:true,core_port:addr.port,control_socket:path.join(dir,'door.sock')}});await door.start();
 t.after(async()=>{await door.close();await core.close();fs.rmSync(dir,{recursive:true,force:true});});
 for(const port of [addr.port,door.server.address().port]){
  const base=`http://127.0.0.1:${port}`;
  for(const route of ['/v1/video/jobs','/v1/music/jobs','/gateway/status'])assert.equal((await fetch(base+route)).status,200,route);
  assert.equal((await fetch(base+'/v1/models')).status,503); // No backend in this fixture, not an auth rejection.
  const empty=await fetch(base+'/v1/video/inputs',{method:'POST'});assert.equal(empty.status,400);assert.match(JSON.stringify(await empty.json()),/empty body/i);
  const upload=await fetch(base+'/v1/video/inputs',{method:'POST',headers:{'content-type':'audio/wav'},body:Buffer.from('RIFF-test')});assert.equal(upload.status,201);const input=await upload.json();assert.equal(input.bytes,9);
 }
});
