import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createGateway} from './gateway.mjs';
import {createDoor} from './door.mjs';
import {createAdmissionTools} from './genie-admission.mjs';

const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(check){for(let i=0;i<300;i++){if(await check())return;await pause(20);}throw Error('Fixture did not reach the expected state');}

test('routed context uses the real shared scheduler and Door while a household request remains active',{timeout:30000},async t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'routed-context-')),sources=[];
 let gateway,door,household,release;
 t.after(async()=>{
  release?.();await household?.catch(()=>{});if(door)await door.close();if(gateway)await gateway.close();
  for(const s of sources){s.server.closeAllConnections();await new Promise(r=>s.server.close(r));}
  fs.rmSync(directory,{recursive:true,force:true});
 });
 for(let i=0;i<2;i++){
  const source={calls:[],active:0,peak:0,aborted:0};
  source.server=http.createServer((req,res)=>{
   res.setHeader('content-type','application/json');
   if(req.method==='GET')return res.end(JSON.stringify({data:[{id:'Fixture-Model',max_model_len:8192}]}));
   let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{
    const body=JSON.parse(raw);source.calls.push(body);source.active++;source.peak=Math.max(source.peak,source.active);
    let complete=false;res.on('close',()=>{if(!complete)source.aborted++;});
    const finish=()=>{if(complete)return;complete=true;source.active--;const tokens=Array.isArray(body.prompt)?body.prompt.length:4;
     res.end(JSON.stringify({model:'Fixture-Model',choices:[{index:0,text:'x',finish_reason:'length'}],usage:{prompt_tokens:tokens,completion_tokens:1,total_tokens:tokens+1}}));};
    if(body.prompt==='household')release=finish;else finish();
   });
  });
  await new Promise(r=>source.server.listen(0,'127.0.0.1',r));
  source.url=`http://127.0.0.1:${source.server.address().port}/v1`;sources.push(source);
 }
 const config={host:'127.0.0.1',port:0,api_key:'fixture',model:'PoolModel',model_agnostic:true,context_length:8192,
  request_timeout_ms:30000,state_file:path.join(directory,'state.json'),health_interval_ms:60000,
  model_routes:{'Fixture-Model':['first','second']},nodes:sources.map((s,i)=>({id:i?'second':'first',backend:'openai',url:s.url,context_length:8192,max_concurrent_requests:1,model_aliases:{PoolModel:'Fixture-Model'}}))};
 gateway=createGateway(config);const corePort=(await gateway.start()).port;
 const doorConfig={...config,continuity_door:{enabled:true,core_port:corePort,control_socket:path.join(directory,'door.sock'),health_interval_ms:250,startup_probe_ms:1000}};
 door=createDoor(doorConfig);await door.start();config.port=door.server.address().port;await until(()=>door.status().core_ready);door.release();
 household=fetch(`http://127.0.0.1:${config.port}/v1/completions`,{method:'POST',headers:{authorization:'Bearer fixture','content-type':'application/json','x-dsg-model':'Fixture-Model'},body:JSON.stringify({model:'PoolModel',prompt:'household',max_tokens:1,stream:false})}).then(async r=>({status:r.status,result:await r.json()}));
 await until(()=>sources.some(s=>s.active===1));
 const busyIndex=sources.findIndex(s=>s.active===1),target=busyIndex?'first':'second';
 const tools=createAdmissionTools({config,control:async()=>{throw Error('Diagnostic must not mutate control state');},read:async()=>gateway.stats(),readDoor:async()=>door.status(),resolveNativeWorker:async()=>{throw Error('No direct native access');}});
 const input={action:'verify-worker',worker:target,check:'routed-context',action_id:'12345678-1234-4234-8234-123456789012'};
 assert.equal((await tools.tool(input)).state,'running');await until(async()=>(await tools.tool(input)).state!=='running');
 const receipt=await tools.tool(input);assert.equal(receipt.state,'passed',JSON.stringify(receipt));assert.equal(receipt.observed_worker,target);
 assert.equal(receipt.proof.context_length,8192);assert.ok(receipt.proof.request_id);
 assert.equal(sources[busyIndex].active,1,'household generation remains active');assert.equal(sources[busyIndex].calls.length,1);
 assert.equal(sources[1-busyIndex].calls.length,1);assert.equal(sources[1-busyIndex].calls[0].model,'Fixture-Model');
 assert.ok(sources.every(s=>s.peak===1&&s.aborted===0));assert.equal(door.status().holding,false);
 release();assert.equal((await household).status,200);assert.equal(gateway.stats().active,0);
});
