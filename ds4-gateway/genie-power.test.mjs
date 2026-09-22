import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {test} from 'node:test';import assert from 'node:assert/strict';
import {createPowerRunner,powerScript,powerWorkers} from './power-scripts.mjs';
import {createFleetPowerTools} from './genie-power.mjs';
import http from 'node:http';import {once} from 'node:events';

const UUID=()=>crypto.randomUUID();
const crypto=await import('node:crypto');

test('power script allowlist refuses unknown workers, actions and non-executable paths',()=>{
  assert.equal(powerScript('glm53f-m3','status'),path.join('/Users/jordiposthumus','startScripts','status-glm53-m3'));
  assert.equal(powerScript('nope','start'),null);
  assert.equal(powerScript('glm53f-m3','reboot'),null);
  assert.ok(powerWorkers().includes('qwen-image'));
});

test('power runner is single-flight per worker/action and records receipts',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'power-runner-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  let calls=0;
  const runner=createPowerRunner({spawn:async()=>{calls++;await new Promise(r=>setTimeout(r,80));return {exit_code:0,output:'done'};}});
  const first=runner.run('glm53f-m3','stop');
  const second=await runner.run('glm53f-m3','stop');
  assert.equal(second.busy,true,'second stop while first runs is refused, not queued');
  const receipt=await first;
  assert.equal(receipt.ok,true);assert.equal(calls,1,'only one spawn');
  assert.equal(runner.receipts()[0].worker,'glm53f-m3');
  // status can run concurrently with stop (no single-flight on read-only status)
  const status=await runner.run('glm53f-m3','status');assert.equal(status.ok,true);
});

test('fleet power tools: status evidence, stop interlocks, exact action IDs',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'power-tools-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  let state={version:1,workers:[
    {id:'glm53f-m3',is_healthy:true,drained:false,load:1,queued:0},
    {id:'glm53f-sparks12',is_healthy:true,drained:false,load:0,queued:0},
  ]};
  const runner=createPowerRunner({spawn:async(file,{timeoutMs})=>({exit_code:0,output:`script ${file} ran (timeout ${timeoutMs})`})});
  const tools=createFleetPowerTools({runner,read:async()=>state,isEnabled:()=>true});
  const status=await tools.tool({action:'status'});
  assert.equal(status.schema,1);
  assert.ok(status.members.some(m=>m.worker_id==='glm53f-m3'&&m.routing.load===1));
  assert.match(status.scope,/Scripts remain the source of truth/);
  // stop interlock: serving worker refused
  await assert.rejects(tools.tool({action:'power',worker:'glm53f-m3',power_action:'stop',action_id:UUID()}),/action ID|Drain it first/);
  // stop interlock: last healthy worker refused
  state={version:1,workers:[{id:'glm53f-sparks12',is_healthy:true,drained:false,load:0,queued:0}]};
  await assert.rejects(tools.tool({action:'power',worker:'glm53f-sparks12',power_action:'stop',action_id:UUID()}),/last healthy worker/);
  // allowed stop passes through to the runner (m3 already drained; another worker keeps serving)
  state={version:1,workers:[
    {id:'glm53f-sparks12',is_healthy:true,drained:false,load:0,queued:0},
    {id:'glm53f-m3',is_healthy:false,drained:true,load:0,queued:0},
  ]};
  const result=await tools.tool({action:'power',worker:'glm53f-m3',power_action:'stop',action_id:UUID()});
  assert.equal(result.receipt.ok,true);assert.match(result.next_step,/not model-down proof|model-down proof/);
  // unknown worker refused without spawning
  await assert.rejects(tools.tool({action:'power',worker:'ghost',power_action:'stop',action_id:UUID()}),/No enrolled script/);
});

test('fleet power tool endpoint authenticates like the other private chat tools',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'power-endpoint-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const runner=createPowerRunner({spawn:async()=>({exit_code:0,output:'ok'})});
  const tools=createFleetPowerTools({runner,read:async()=>({version:1,workers:[]})});
  const server=http.createServer((req,res)=>{if(tools.handle(req,res))return;res.writeHead(404);res.end();});
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});
  tools.bind(server.address().port);
  const base=`http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base+'/api/genie/power-tools',{method:'POST',headers:{'content-type':'application/json','x-sg-power-tool':'wrong'},body:'{}'})).status,403);
  const good=await fetch(base+'/api/genie/power-tools',{method:'POST',headers:{'content-type':'application/json','x-sg-power-tool':tools.toolConfig.token},body:JSON.stringify({action:'status'})});
  assert.equal(good.status,200);assert.equal((await good.json()).schema,1);
});