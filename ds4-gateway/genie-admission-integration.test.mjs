import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {createGateway} from './gateway.mjs';
import {createDoor} from './door.mjs';
import {workerControl} from './worker-client.mjs';
import {createAdmissionTools} from './genie-admission.mjs';

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check){for(let i=0;i<300;i++){if(await check())return;await delay(20);}throw Error('Fixture condition did not complete');}
async function backend(model){
 const calls=[];
 const server=http.createServer((req,res)=>{
  res.setHeader('content-type','application/json');
  if(req.method==='GET')return res.end(JSON.stringify({data:[{id:model,context_length:400000}]}));
  let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{
   const parsed=JSON.parse(body);calls.push(parsed);if(parsed.model!==model){res.statusCode=404;return res.end(JSON.stringify({error:'unknown model'}));}res.end(JSON.stringify({model,choices:[{message:{role:'assistant',content:'CANARY_7319'},finish_reason:'stop'}],usage:{prompt_tokens:64,completion_tokens:4}}));
  });
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 return {server,calls,url:`http://127.0.0.1:${server.address().port}/v1`};
}

test('Genie admission crosses a real core restart, conditional resume and Door generation',{timeout:30000},async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'genie-admission-native-'));
 const old=await backend('Existing-Model'),candidate=await backend('Trial-Model');
 const configFile=path.join(dir,'config.local.json'),oldEnv=process.env.DWARF_GATE_CONFIG;
 process.env.DWARF_GATE_CONFIG=configFile;
 let gateway,door,startPromise,corePort;
 t.after(async()=>{
  if(startPromise)await startPromise.catch(()=>{});
  if(door)await door.close();if(gateway)await gateway.close();
  for(const source of [old,candidate]){source.server.closeAllConnections();await new Promise(resolve=>source.server.close(resolve));}
  if(oldEnv===undefined)delete process.env.DWARF_GATE_CONFIG;else process.env.DWARF_GATE_CONFIG=oldEnv;
  fs.rmSync(dir,{recursive:true,force:true});
 });
 const initial={host:'127.0.0.1',port:0,api_key:'fixture',model:'PoolModel',model_agnostic:true,
  context_length:262144,state_file:path.join(dir,'state.json'),control_socket:path.join(dir,'gateway.sock'),health_interval_ms:60000,
  model_routes:{'Existing-Model':['existing']},nodes:[{id:'existing',backend:'openai',url:old.url,context_length:400000,model_aliases:{PoolModel:'Existing-Model'}}]};
 gateway=createGateway(initial);corePort=(await gateway.start()).port;
 const config={...initial,continuity_door:{enabled:true,core_port:corePort,control_socket:path.join(dir,'door.sock'),health_interval_ms:250,startup_probe_ms:1000}};
 door=createDoor(config);await door.start();config.port=door.server.address().port;
 fs.writeFileSync(configFile,JSON.stringify(config));
 await until(()=>door.status().core_ready);door.release();
 const control=(route,body)=>workerControl(config.control_socket,route,body,{channel:'gate_genie'});
 const read=async()=>gateway.stats();
 const options={config,control,read,readDoor:async()=>door.status(),
  spawnPark(args,options,done){door.hold('fixture admitted route restart');gateway.close().then(()=>done(null,'{"verified":true}'),done);},
  spawnStart(){
   const child=new EventEmitter();child.unref=()=>{};
   startPromise=(async()=>{
    const current=JSON.parse(fs.readFileSync(configFile));gateway=createGateway(current);
    await gateway.start();await until(()=>door.status().core_ready);door.release();
   })();return child;
  }};
 let tools=createAdmissionTools(options);
 const draft=await tools.tool({action:'inspect',url:candidate.url});
 const stage=name=>tools.tool({action:'admit',stage:name,fingerprint:draft.fingerprint,action_id:randomUUID()});
 await stage('add-worker');
 assert.equal((await read()).workers.find(w=>w.id==='trial-model').drained,true,'real registration stays paused');
 await stage('route');await stage('restart');await startPromise;
 tools=createAdmissionTools(options);
 assert.deepEqual((await tools.tool({action:'status'})).completed,['add-worker','route','restart'],'a dashboard reload retains completed admission stages');
 assert.equal((await read()).workers.find(w=>w.id==='trial-model').drained,true,'core restart must not silently enable it');
 await stage('resume');const receipt=await stage('verify');
 assert.equal(receipt.verdict,'admitted and verified');assert.equal(receipt.canary.state,'passed');
 assert.equal(receipt.canary.samples[0].worker,'trial-model');assert.equal(candidate.calls.length,1);
 assert.equal(old.calls.length,0,'exclusive canary must not spill into the existing household route');
 assert.equal(door.status().holding,false);
});
