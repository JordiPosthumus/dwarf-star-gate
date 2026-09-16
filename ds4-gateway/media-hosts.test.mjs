import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import http from 'node:http';
import {createMediaHosts} from './media-hosts.mjs';
import {createDashboard,proxyMediaFile} from './dashboard.mjs';

test('placement defaults preserve installed engines; choices persist without granting installation',t=>{
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'sg-media-hosts-'));t.after(()=>fs.rmSync(folder,{recursive:true,force:true}));
 const store={filename:path.join(folder,'state.json'),data:{unrelated:'keep'},save(value){fs.writeFileSync(this.filename,JSON.stringify(value));this.data=value;}};store.save(store.data);
 const config={media_jobs:{workers:{one:{engines:{music:{}}}}},recovery:{workers:[{id:'one',adapter:'docker',verification:'qwen_vllm'}]},genie_chat:{inspection:{workers:{one:{container:'llm'}}}}};
 const workers=()=>[{id:'one',is_healthy:true,load:1},{id:'two',is_healthy:true}];
 const policy=createMediaHosts(config,store,{workers,binding:()=>true});
 assert.equal(policy.allowed('one','music'),true);assert.equal(policy.allowed('two','music'),false);
 policy.change({worker_id:'one',kind:'music',allowed:false});policy.change({worker_id:'two',kind:'music',allowed:true});
 store.data=JSON.parse(fs.readFileSync(store.filename));const restored=createMediaHosts(config,store,{workers,binding:()=>true});
 assert.equal(restored.allowed('one','music'),false);const target=restored.status().hosts[1].engines.find(e=>e.kind==='music');assert.equal(target.allowed,true);assert.equal(target.enrolled,false);assert.equal(target.ready,false);assert.match(target.reason,/Setup/);assert.equal(store.data.unrelated,'keep');assert.ok(fs.readdirSync(folder).some(f=>f.includes('.media-')));
 assert.throws(()=>policy.change({worker_id:'unknown',kind:'music',allowed:true}),/registered/);
 policy.change({worker_id:'one',kind:'music',allowed:true});assert.match(policy.status().hosts[0].engines[0].reason,/drain/);
});

test('Media dashboard keeps placement writes behind existing same-origin controls',async t=>{
 const changes=[];const management={read:async()=>({workers:[]}),media:async()=>({configured:true,media_host_controls_version:1,hosts:[],jobs:[]}),act:async(action,input)=>{changes.push({action,input});return input;}};
 const server=createDashboard(()=>({gateway:{}}),undefined,management);await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close();});const base=`http://127.0.0.1:${server.address().port}`;
 const response=await fetch(base+'/api/media');assert.equal(response.status,200);const state=await response.json();assert.equal(state.controls_enabled,true);
 assert.equal((await fetch(base+'/api/media/eligibility',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,403);
 const input={worker_id:'one',kind:'music',allowed:false};assert.equal((await fetch(base+'/api/media/eligibility',{method:'POST',headers:{'content-type':'application/json',origin:base,'x-dsg-csrf':state.csrf_token},body:JSON.stringify(input)})).status,200);assert.deepEqual(changes,[{action:'media-eligibility',input}]);
 const html=await (await fetch(base+'/')).text();assert.match(html,/data-workspace-tab="media"/);assert.equal((await fetch(base+'/media.js')).status,200);
});

test('retained media downloads use server-side credentials and preserve byte ranges',async t=>{
 const backend=http.createServer((req,res)=>{assert.equal(req.headers.authorization,'Bearer fixture-key');assert.equal(req.headers.range,'bytes=0-3');assert.match(req.url,/^\/v1\/music\/jobs\//);res.writeHead(206,{'content-type':'audio/flac','content-range':'bytes 0-3/8','content-length':'4'});res.end('fLaC');});await new Promise(r=>backend.listen(0,'127.0.0.1',r));
 const server=createDashboard(()=>({}),undefined,{mediaFile:(req,res,route)=>proxyMediaFile({port:backend.address().port,api_key:'fixture-key'},req,res,route)});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close();backend.closeAllConnections();backend.close();});
 const base=`http://127.0.0.1:${server.address().port}`,route='/api/media/music/jobs/aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa/files/bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
 const r=await fetch(base+route,{headers:{range:'bytes=0-3'}});assert.equal(r.status,206);assert.equal(r.headers.get('content-range'),'bytes 0-3/8');assert.equal(r.headers.get('authorization'),null);assert.equal(await r.text(),'fLaC');
 assert.equal((await fetch(base+route,{headers:{origin:'https://untrusted.example'}})).status,403);
});
