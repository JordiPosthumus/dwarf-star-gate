// Explicit integration test: downloads real dependencies into a clean exported checkout.
// The HTTP provider is scripted; this proves installation/wiring, not model intelligence.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {spawn,execFile,execFileSync} from 'node:child_process';
import {promisify} from 'node:util';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {projectRoot} from '../ds4-gateway/config.mjs';
const exec=promisify(execFile);
async function until(fn){const end=Date.now()+120000;while(Date.now()<end){const result=await fn();if(result)return result;await delay(100);}throw new Error('Integration observation deadline exceeded.');}
test('fresh setup installs Hermes, loads its soul, chats and preserves history and personal Hermes',{timeout:900000},async t=>{
  // macOS's normal temp path exceeds the Unix socket limit for a full checkout.
  // Resolve its /tmp alias too: setup records canonical installation paths.
  const temp=fs.realpathSync(fs.mkdtempSync(path.join(process.platform==='darwin'?'/tmp':os.tmpdir(),'star-gate-install-'))),root=path.join(temp,'checkout with spaces'),home=path.join(temp,'empty-home');fs.mkdirSync(root);fs.mkdirSync(home);
  execFileSync('git',['checkout-index','--all',`--prefix=${root}/`],{cwd:projectRoot});
  const env={PATH:path.dirname(process.execPath)+':/usr/bin:/bin',HOME:home,LANG:'en_US.UTF-8'};
  assert.equal(fs.existsSync(path.join(root,'config.local.json')),false);assert.equal(fs.existsSync(path.join(root,'runtime')),false);assert.deepEqual(fs.readdirSync(home),[]);
  const requests=[],provider=http.createServer((req,res)=>{
    if(req.method==='GET'){res.setHeader('content-type','application/json');return res.end(JSON.stringify({data:[{id:'example-model'}]}));}
    let body='';req.on('data',c=>body+=c);req.on('end',()=>{const p=JSON.parse(body);if(!Array.isArray(p.messages)){console.log('Provider capability probe: '+req.url+' '+Object.keys(p).join(','));res.writeHead(404);res.end();return;}requests.push(p);const users=p.messages.filter(m=>m.role==='user');const answer=users.length>1?'Your name is Ada.':'I am Gate Genie. Hello Ada.';
      if(p.stream){res.setHeader('content-type','text/event-stream');res.end(`data: ${JSON.stringify({id:'fixture',object:'chat.completion.chunk',model:'example-model',choices:[{index:0,delta:{content:answer},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`);}
      else{res.setHeader('content-type','application/json');res.end(JSON.stringify({id:'fixture',model:'example-model',choices:[{index:0,message:{role:'assistant',content:answer},finish_reason:'stop'}]}));}
    });
  });provider.listen(0,'127.0.0.1');await once(provider,'listening');
  let dashboard; const services=[];
  const stop=async()=>{if(dashboard&&dashboard.exitCode===null){const exited=once(dashboard,'exit');dashboard.kill('SIGTERM');await exited;}};
  t.after(async()=>{await stop();for(const child of services){if(child.exitCode===null){const ended=once(child,'exit');child.kill('SIGTERM');await ended;}}provider.closeAllConnections();await new Promise(r=>provider.close(r));if(process.env.SG_KEEP_INSTALL_TEST)console.log('Retained isolated installation: '+temp);else fs.rmSync(temp,{recursive:true,force:true});});
  const setup=await exec(process.execPath,['scripts/setup.mjs','--controls','--model-url',`http://127.0.0.1:${provider.address().port}/v1`,'--model','example-model'],{cwd:root,env,timeout:780000,maxBuffer:1024*1024});
  assert.match(setup.stdout,/Genie connection verified/);const filename=path.join(root,'config.local.json'),config=JSON.parse(fs.readFileSync(filename));
  for(const runtimePath of [config.genie_chat.source,config.genie_chat.python])assert.ok(fs.realpathSync(runtimePath).startsWith(path.join(root,'runtime')+path.sep));assert.equal(config.genie_chat.reasoning_effort,null);
  assert.match(requests[0].messages[0].content,/loving prime directive/);assert.equal(requests[0].tools?.length??0,0);assert.equal(requests[0].reasoning_effort,undefined);
  assert.doesNotMatch(setup.stdout,new RegExp(config.api_key));assert.equal(fs.statSync(filename).mode&0o777,0o600);assert.deepEqual(fs.readdirSync(home),[]);
  const personal=path.join(home,'.hermes');fs.mkdirSync(personal);fs.writeFileSync(path.join(personal,'SOUL.md'),'Personal Hermes must stay exactly this way.');
  const soul=path.join(root,'runtime/genie/chat/hermes-home/SOUL.md');fs.appendFileSync(soul,'\nMy private identity marker: silver compass.\n');const savedSoul=fs.readFileSync(soul),savedConfig=fs.readFileSync(filename);
  await exec(process.execPath,['scripts/setup.mjs'],{cwd:root,env});assert.deepEqual(fs.readFileSync(filename),savedConfig);assert.deepEqual(fs.readFileSync(soul),savedSoul);assert.equal(fs.readFileSync(path.join(personal,'SOUL.md'),'utf8'),'Personal Hermes must stay exactly this way.');
  const ports=[];for(let i=0;i<3;i++){const listener=http.createServer();listener.listen(0,'127.0.0.1');await once(listener,'listening');ports.push(listener.address().port);await new Promise(r=>listener.close(r));}
  [config.ui_port,config.port,config.continuity_door.core_port]=ports;fs.writeFileSync(filename,JSON.stringify(config));
  const doctor=await exec(process.execPath,['scripts/doctor.mjs'],{cwd:root,env});assert.equal(JSON.parse(doctor.stdout).ok,true);
  const uiPort=config.ui_port;
  for(const name of ['gateway','door'])services.push(spawn(process.execPath,['ds4-gateway/'+name+'.mjs'],{cwd:root,env,stdio:'ignore'}));
  const origin=`http://127.0.0.1:${uiPort}`;
  const start=async()=>{dashboard=spawn(process.execPath,['ds4-gateway/dashboard.mjs'],{cwd:root,env,stdio:'ignore'});return until(async()=>{try{const r=await fetch(origin+'/api/genie/chat');return r.ok?await r.json():false;}catch{return false;}});};
  let status=await start();assert.equal(status.available,true);await until(async()=>{const s=await(await fetch(origin+'/api/status')).json();return s.gateway?.total===0;});
  await until(async()=>{try{const r=await fetch(`http://127.0.0.1:${config.port}/gateway/status`,{headers:{authorization:`Bearer ${config.api_key}`}});return r.ok&&(await r.json()).total===0;}catch{return false;}});
  const action=async body=>{const r=await fetch(origin+'/api/genie/chat',{method:'POST',headers:{origin,'content-type':'application/json','x-dsg-csrf':status.csrf_token},body:JSON.stringify(body)});assert.ok(r.ok);return r.json();};
  const chat=await action({action:'new'});
  for(const [i,text]of ['My name is Ada.','What is my name?'].entries()){
    await action({action:'send',conversation_id:chat.id,text,request_id:'install-'+i});
    const result=await until(async()=>{const c=await(await fetch(origin+'/api/genie/chat/'+chat.id)).json();return !c.busy?c:false;});assert.equal(result.messages.at(-1).state,'complete');assert.match(result.messages.at(-1).text,/Ada/);
  }
  assert.match(requests.at(-1).messages[0].content,/silver compass/);assert.equal(requests.at(-1).messages.filter(m=>m.role==='user').length,2);
  await stop();status=await start();const restored=await(await fetch(origin+'/api/genie/chat/'+chat.id)).json();assert.equal(restored.messages.length,4);assert.match(restored.messages.at(-1).text,/Ada/);
});
