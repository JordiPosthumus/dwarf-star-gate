import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {test} from 'node:test';import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {createPowerRunner,createReadinessVerifier,powerScript,powerWorkers,machineGroup} from './power-scripts.mjs';
import {createFleetPowerTools} from './genie-power.mjs';
import http from 'node:http';import {once} from 'node:events';

const UUID=()=>crypto.randomUUID();
const crypto=await import('node:crypto');

test('power script allowlist refuses unknown workers, actions and non-executable paths',()=>{
  assert.equal(powerScript('glm53f-m3','status'),path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..','..','startScripts','status-glm53-m3'));
  assert.equal(powerScript('nope','start'),null);
  assert.equal(powerScript('glm53f-m3','reboot'),null);
  assert.ok(powerWorkers().includes('qwen-image'));
  assert.deepEqual(machineGroup('glm53f-sparks12'),['spark1','spark2']);
  assert.deepEqual(machineGroup('qwen-image'),['m3-ultra']);
});

test('power runner serializes mutations per physical machine and records verified receipts',async t=>{
  let slowRelease,calls=0;
  const runner=createPowerRunner({
    spawn:async()=>{calls++;if(calls===1)await new Promise(r=>{slowRelease=r;});return {exit_code:0,output:'ran'};},
    verify:async(worker,action)=>({state:action==='start'?'ready':'stopped',detail:'mock'}),
  });
  const slow=runner.run('glm53f-sparks12','start');
  await new Promise(r=>setTimeout(r,40));
  const blocked=await runner.run('ds41-sparks12','stop');
  assert.equal(blocked.busy,true);assert.match(blocked.output,/same hardware/);
  slowRelease();
  const done=await slow;
  assert.equal(done.ok,true);assert.equal(done.verified.state,'ready');
  const free=await runner.run('ds41-sparks12','stop');
  assert.equal(free.ok,true);assert.equal(free.verified.state,'stopped');
  assert.equal(calls,2,'no overlapping spawns on one machine');
  const stat=await runner.run('glm53f-m3','status');
  assert.equal(stat.ok,true);assert.equal(stat.verified.state,'unverified');
  // failing script marks verified failed and ok false
  const failing=createPowerRunner({spawn:async()=>({exit_code:1,output:'boom'}),verify:async()=>({state:'ready',detail:'x'})});
  const bad=await failing.run('glm53f-m3','start');
  assert.equal(bad.ok,false);assert.equal(bad.verified.state,'failed');
});

test('readiness verifier reports ready/stopped/timeout from real endpoint state',async t=>{
  let up=false;
  const srv=http.createServer((req,res)=>{if(up){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({data:[{id:'GLM'}]}));}else res.destroy();});
  await new Promise(r=>srv.listen(0,'127.0.0.1',r));t.after(()=>{srv.closeAllConnections();srv.close();});
  const port=srv.address().port;
  const verifier=createReadinessVerifier({resolveEndpoint:async()=>({url:`http://127.0.0.1:${port}/v1`,headers:{authorization:'Bearer none'}}),startTimeoutMs:1500,stopTimeoutMs:1500,intervalMs:100});
  assert.equal((await verifier('glm53f-m3','start')).state,'timeout');
  up=true;
  assert.equal((await verifier('glm53f-m3','start')).state,'ready');
  assert.equal((await verifier('glm53f-m3','stop')).state,'timeout');
  up=false;srv.close();srv.closeAllConnections();await new Promise(r=>setTimeout(r,50));
  assert.equal((await verifier('glm53f-m3','stop')).state,'stopped');
  assert.equal((await verifier('glm53f-m3','status')).state,'unverified');
  const unknown=createReadinessVerifier({resolveEndpoint:async()=>null,startTimeoutMs:100,stopTimeoutMs:100,intervalMs:10});
  assert.equal((await unknown('glm53f-m3','start')).state,'unverified');
});

test('fleet power tools: status evidence, stop interlocks, exact action IDs',async t=>{
  let state={version:1,workers:[
    {id:'glm53f-m3',is_healthy:true,drained:false,load:1,queued:0},
    {id:'glm53f-sparks12',is_healthy:true,drained:false,load:0,queued:0},
  ]};
  const runner=createPowerRunner({spawn:async()=>({exit_code:0,output:'ran'}),verify:async(worker,action)=>({state:action==='start'?'ready':'stopped',detail:'mock'})});
  const tools=createFleetPowerTools({runner,read:async()=>state,isEnabled:()=>true});
  const status=await tools.tool({action:'status'});
  assert.equal(status.schema,1);
  assert.ok(status.members.some(m=>m.worker_id==='glm53f-m3'&&m.routing.load===1));
  assert.deepEqual(status.members.find(m=>m.worker_id==='glm53f-sparks12').machine,['spark1','spark2']);
  assert.match(status.scope,/physical-machine groups/);
  // stop interlock: serving worker refused
  await assert.rejects(tools.tool({action:'power',worker:'glm53f-m3',power_action:'stop',action_id:UUID()}),/Drain it first/);
  // precheck path reports the same refusal without running anything
  const pre=await tools.precheck('glm53f-m3','stop');
  assert.equal(pre.allowed,false);assert.match(pre.refusals.join(' '),/Drain it first/);
  // stop interlock: last healthy worker refused
  state={version:1,workers:[{id:'glm53f-sparks12',is_healthy:true,drained:false,load:0,queued:0}]};
  await assert.rejects(tools.tool({action:'power',worker:'glm53f-sparks12',power_action:'stop',action_id:UUID()}),/last healthy worker/);
  // direct-reserve refusal
  state={version:1,workers:[
    {id:'glm53f-sparks12',is_healthy:true,drained:false,load:0,queued:0},
    {id:'glm53f-m3',is_healthy:true,drained:false,load:0,queued:0,direct_reserved:true},
  ]};
  await assert.rejects(tools.tool({action:'power',worker:'glm53f-m3',power_action:'stop',action_id:UUID()}),/direct owner use/);
  // engine-reported direct activity refusal
  state.workers[1].direct_reserved=false;
  const toolsWithEngine=createFleetPowerTools({runner,read:async()=>state,isEnabled:()=>true,directRunning:async()=>2});
  await assert.rejects(toolsWithEngine.tool({action:'power',worker:'glm53f-m3',power_action:'stop',action_id:UUID()}),/outside gateway accounting/);
  // allowed stop passes through to the runner (verified stopped; another worker keeps serving)
  state={version:1,workers:[
    {id:'glm53f-sparks12',is_healthy:true,drained:false,load:0,queued:0},
    {id:'glm53f-m3',is_healthy:false,drained:true,load:0,queued:0},
  ]};
  const result=await tools.tool({action:'power',worker:'glm53f-m3',power_action:'stop',action_id:UUID()});
  assert.equal(result.receipt.ok,true);assert.match(result.next_step,/Verified stopped/);
  // precheck allowed path
  const okPre=await tools.precheck('glm53f-m3','stop');
  assert.equal(okPre.allowed,true);assert.deepEqual(okPre.machine,['m3-ultra']);
  // machine-mate with gateway work blocks the stop
  state={version:1,workers:[
    {id:'glm53f-sparks12',is_healthy:true,drained:false,load:0,queued:0},
    {id:'glm53f-m3',is_healthy:false,drained:true,load:0,queued:0},
    {id:'ds41-m3',is_healthy:true,drained:false,load:1,queued:0},
  ]};
  await assert.rejects(tools.tool({action:'power',worker:'glm53f-m3',power_action:'stop',action_id:UUID()}),/Same-hardware model/);
  // unknown worker refused without spawning
  await assert.rejects(tools.tool({action:'power',worker:'ghost',power_action:'stop',action_id:UUID()}),/No enrolled script/);
  // capability off blocks mutations, status still works
  const off=createFleetPowerTools({runner,read:async()=>state,isEnabled:()=>false});
  await assert.rejects(off.tool({action:'power',worker:'glm53f-m3',power_action:'stop',action_id:UUID()}),/switched off/);
  assert.equal((await off.tool({action:'status'})).schema,1);
});

test('fleet power tool endpoint authenticates like the other private chat tools',async t=>{
  const runner=createPowerRunner({spawn:async()=>({exit_code:0,output:'ok'}),verify:async()=>({state:'stopped',detail:'x'})});
  const tools=createFleetPowerTools({runner,read:async()=>({version:1,workers:[]})});
  const server=http.createServer((req,res)=>{if(tools.handle(req,res))return;res.writeHead(404);res.end();});
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});
  tools.bind(server.address().port);
  const base=`http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base+'/api/genie/power-tools',{method:'POST',headers:{'content-type':'application/json','x-sg-power-tool':'wrong'},body:'{}'})).status,403);
  const good=await fetch(base+'/api/genie/power-tools',{method:'POST',headers:{'content-type':'application/json','x-sg-power-tool':tools.toolConfig.token},body:JSON.stringify({action:'status'})});
  assert.equal(good.status,200);assert.equal((await good.json()).schema,1);
});