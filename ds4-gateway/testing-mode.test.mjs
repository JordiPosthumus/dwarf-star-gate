import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createDoor} from './door.mjs';
import {doorControl} from './door-client.mjs';
import {readTestingMode,writeTestingMode,testingModeFile,testingSuspended} from './testing-mode.mjs';
import {Genie} from './genie.mjs';
import {createDashboard} from './dashboard.mjs';
const listen=s=>new Promise(r=>s.listen(0,'127.0.0.1',()=>r(s.address().port)));
async function until(fn){const end=Date.now()+3000;while(!fn()){if(Date.now()>end)throw Error('Condition timed out');await delay(5);}}
async function rig(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dsg-testing-')),seen=[],waiting=new Map();
 const core=http.createServer((req,res)=>{
  if(req.url==='/gateway/status'||req.url==='/health')return res.end(JSON.stringify({startup:{complete:true}}));
  const parts=[];req.on('data',c=>parts.push(c));req.on('end',()=>{const body=Buffer.concat(parts).toString();seen.push({url:req.url,body,headers:req.headers});if(body.startsWith('hold:'))waiting.set(body,()=>res.end(body));else res.end(body||'models');});
 });
 const corePort=await listen(core),config={host:'127.0.0.1',port:0,api_key:'key',state_file:path.join(dir,'state.json'),continuity_door:{enabled:true,core_port:corePort,control_socket:path.join(dir,'door.sock'),health_interval_ms:60000}};
 let door=createDoor(config);await door.start();
 t.after(async()=>{for(const end of waiting.values())end();door.server.closeAllConnections();await door.close();core.closeAllConnections();await new Promise(r=>core.close(r));fs.rmSync(dir,{recursive:true,force:true});});
 const send=(body='',test=false,route='/v1/chat/completions',auth='key')=>{
  let request;const result=new Promise((resolve,reject)=>{request=http.request({host:'127.0.0.1',port:door.server.address().port,path:(test?'/testing':'')+route,method:route.endsWith('/models')?'GET':'POST',headers:{authorization:`Bearer ${auth}`,'content-type':'application/json','x-dsg-model':'chosen-config'}},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('error',reject);res.on('end',()=>resolve({status:res.statusCode,body:Buffer.concat(chunks).toString()}));});request.on('error',reject);request.end(body)});return {request,result};
 };
 return {get door(){return door},config,seen,waiting,send,async restart(){await door.close();door=createDoor(config);await door.start();}};
}
test('Testing holds new normal jobs, preserves active work and forwards test requests unchanged',async t=>{
 const r=await rig(t),active=r.send('hold:normal');await until(()=>r.waiting.has('hold:normal'));
 await doorControl(r.config.continuity_door.control_socket,'/testing',{enabled:true});
 const held=r.send('normal-next');await until(()=>r.door.status().testing.held===1);
 assert.equal(r.door.status().testing.normal_active,1);assert.equal(r.seen.length,1);
 const body=' {"model":"any-config","temperature":0,"chat_template_kwargs":{"preserve_thinking":false}}\n';
 assert.equal((await r.send(body,true).result).body,body);assert.equal(r.seen.at(-1).url,'/v1/chat/completions');assert.equal(r.seen.at(-1).headers['x-dsg-model'],'chosen-config');
 r.waiting.get('hold:normal')();assert.equal((await active.result).body,'hold:normal');assert.equal(r.door.status().testing.normal_active,0);
 const testActive=r.send('hold:test',true);await until(()=>r.waiting.has('hold:test'));
 await doorControl(r.config.continuity_door.control_socket,'/testing',{enabled:false});assert.equal((await held.result).body,'normal-next');
 assert.equal((await r.send('closed',true).result).status,409);assert.ok(!r.seen.some(v=>v.body==='closed'));
 r.waiting.get('hold:test')();assert.equal((await testActive.result).body,'hold:test');
});
test('Testing cancellation, discovery, authentication and maintenance holds stay independent',async t=>{
 const r=await rig(t);r.door.setTesting(true);
 const cancelled=r.send('cancelled');const caught=cancelled.result.catch(()=>{});await until(()=>r.door.status().testing.held===1);cancelled.request.destroy();await caught;await until(()=>r.door.status().testing.held===0);
 assert.equal((await r.send('',false,'/v1/models').result).body,'models');assert.equal((await r.send('',true,'/v1/models').result).body,'models');
 assert.equal((await r.send('no',true,'/v1/chat/completions','wrong').result).status,401);
 assert.equal((await r.send('no',false,'/v1/chat/completions','wrong').result).status,401);
 r.door.hold('maintenance');const normal=r.send('normal'),testRequest=r.send('test',true);await until(()=>r.door.status().held===2);
 r.door.release();assert.equal((await testRequest.result).body,'test');assert.equal(r.door.status().testing.held,1);
 r.door.hold('maintenance');r.door.setTesting(false);assert.equal(r.door.status().held,1);assert.equal(r.door.status().holding,true);
 r.door.release();assert.equal((await normal.result).body,'normal');assert.ok(!r.seen.some(v=>v.body==='cancelled'||v.body==='no'));
});
test('Testing persists across Door restart and invalid state fails closed',async t=>{
 const r=await rig(t);r.door.setTesting(true);const since=r.door.status().testing.since;r.door.setTesting(true);assert.equal(r.door.status().testing.since,since);
 await r.restart();assert.equal(r.door.status().testing.enabled,true);assert.equal((await r.send('test',true).result).body,'test');
 const filename=testingModeFile(r.config);assert.equal(fs.statSync(filename).mode&0o777,0o600);
 fs.writeFileSync(filename,'bad state');assert.throws(()=>readTestingMode(filename));assert.equal(testingSuspended(filename),true);assert.throws(()=>createDoor(r.config));assert.throws(()=>writeTestingMode(filename,false));
});
const snapshot=()=>({time:Date.now(),gateway:{workers:[],active:0,queued:0},devices:[],events:[]});
test('Genie suspension prevents scheduled/manual calls and preserves the enabled preference',async()=>{
 let testing=true,calls=0;const g=new Genie({url:'http://127.0.0.1:9001/v1'},snapshot,{isTesting:()=>testing,fetchImpl:async()=>{calls++;throw Error('mock failure')}});
 g.tick();assert.throws(()=>g.submit('test'),/testing/);await assert.rejects(g.ask('test'),/testing/);assert.throws(()=>g.setEnabled(false),/testing/);assert.equal(calls,0);assert.equal(g.status().enabled,true);assert.equal(g.status().suspended_for_testing,true);
 testing=false;await g.ask('test');assert.equal(calls,1);g.setEnabled(false);testing=true;g.tick();testing=false;g.tick();assert.equal(calls,1);assert.equal(g.enabled,false);g.close();
});
test('An in-flight Genie request finishes without abort but cannot start another action during Testing',async()=>{
 let testing=false,finish,calls=0,signal;const g=new Genie({url:'http://127.0.0.1:9001/v1'},snapshot,{isTesting:()=>testing,fetchImpl:async(_url,opts)=>{calls++;signal=opts.signal;return await new Promise(r=>{finish=r})}});
 const pending=g.ask('test');await until(()=>!!finish);testing=true;assert.equal(signal.aborted,false);
 finish(Response.json({choices:[{finish_reason:'stop',message:{content:'The active request finished.'}}]}));await pending;
 assert.equal(calls,1);assert.equal(g.busy,false);assert.equal(g.reports.length,0);g.tick();assert.equal(calls,1);g.close();
});
test('Dashboard testing control requires same-origin CSRF and exposes no mutation on GET',async t=>{
 let enabled=false,changes=0;const state=()=>({testing:{enabled,held:0,normal_active:0,test_active:0},endpoint:'http://127.0.0.1:30000/testing/v1'});
 const server=createDashboard(()=>({}),undefined,null,null,null,null,{read:async()=>state(),set:async value=>{enabled=value;changes++;return state()}});const port=await listen(server);t.after(()=>{server.closeAllConnections();server.close()});
 const base=`http://127.0.0.1:${port}`,first=await (await fetch(base+'/api/testing')).json();assert.equal(changes,0);
 assert.equal((await fetch(base+'/api/testing',{method:'POST',headers:{'content-type':'application/json'},body:'{"enabled":true}'})).status,403);
 const headers={origin:base,'content-type':'application/json','x-dsg-csrf':first.csrf_token};
 assert.equal((await fetch(base+'/api/testing',{method:'POST',headers,body:'{"enabled":"yes"}'})).status,400);
 assert.equal((await fetch(base+'/api/testing',{method:'POST',headers,body:'{"enabled":true}'})).status,200);assert.equal(enabled,true);assert.equal(changes,1);
});
