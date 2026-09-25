import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {test} from 'node:test';import assert from 'node:assert/strict';
import {createPowerRunner,createReadinessVerifier,powerScript,powerWorkers,machineGroup} from './power-scripts.mjs';
import {createFleetPowerTools} from './genie-power.mjs';
import http from 'node:http';import {once} from 'node:events';

const UUID=()=>crypto.randomUUID();
const crypto=await import('node:crypto');
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'fleet-power-test-'));
for(const name of ['status-glm53-m3','start-glm53-m3','stop-glm53-m3','status-sparks12','start-glm53f-sparks12','stop-sparks12','stop-ds41-m3','start-ds41-sparks12']){
  fs.writeFileSync(path.join(directory,name),'#!/bin/sh\nexit 0\n',{mode:0o700});
}
process.once('exit',()=>fs.rmSync(directory,{recursive:true,force:true}));

test('power script allowlist refuses unknown workers, actions and non-executable paths',()=>{
  assert.equal(powerScript('glm53f-m3','status',directory),path.join(directory,'status-glm53-m3'));
  assert.equal(powerScript('nope','start'),null);
  assert.equal(powerScript('glm53f-m3','reboot'),null);
  assert.ok(powerWorkers().includes('qwen-image'));
  assert.deepEqual(machineGroup('glm53f-sparks12'),['spark1','spark2']);
  assert.deepEqual(machineGroup('qwen-image'),['m3-ultra']);
});

test('power runner serializes mutations per physical machine and records verified receipts',async t=>{
  let slowRelease,calls=0;
  const runner=createPowerRunner({directory,
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
  const failing=createPowerRunner({directory,spawn:async()=>({exit_code:1,output:'boom'}),verify:async()=>({state:'ready',detail:'x'})});
  const bad=await failing.run('glm53f-m3','start');
  assert.equal(bad.ok,false);assert.equal(bad.verified.state,'ready','real verification survives a failed launcher receipt');
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
  const runner=createPowerRunner({directory,spawn:async()=>({exit_code:0,output:'ran'}),verify:async(worker,action)=>({state:action==='start'?'ready':'stopped',detail:'mock'})});
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
  assert.equal(result.accepted,true);
  await new Promise(r=>setImmediate(r));
  const completed=await tools.tool({action:'power',worker:'glm53f-m3',power_action:'stop',action_id:result.action_id});
  assert.equal(completed.receipt.ok,true);assert.match(completed.next_step,/Verified stopped/);
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
  assert.equal((await off.tool({action:'power',worker:'glm53f-m3',power_action:'status',action_id:UUID()})).receipt.ok,true);
});

test('fleet power tool endpoint authenticates like the other private chat tools',async t=>{
  const runner=createPowerRunner({directory,spawn:async()=>({exit_code:0,output:'ok'}),verify:async()=>({state:'stopped',detail:'x'})});
  const tools=createFleetPowerTools({runner,read:async()=>({version:1,workers:[]})});
  const server=http.createServer((req,res)=>{if(tools.handle(req,res))return;res.writeHead(404);res.end();});
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});
  tools.bind(server.address().port);
  const base=`http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base+'/api/genie/power-tools',{method:'POST',headers:{'content-type':'application/json','x-sg-power-tool':'wrong'},body:'{}'})).status,403);
  const good=await fetch(base+'/api/genie/power-tools',{method:'POST',headers:{'content-type':'application/json','x-sg-power-tool':tools.toolConfig.token},body:JSON.stringify({action:'status'})});
  assert.equal(good.status,200);assert.equal((await good.json()).schema,1);
});
test('dashboard preflight is read-only and action IDs survive long asynchronous startup',async()=>{
  let release,calls=0,scriptTimeout;
  const runner=createPowerRunner({directory,spawn:async(_file,{timeoutMs})=>{calls++;scriptTimeout=timeoutMs;await new Promise(r=>{release=r;});return {exit_code:0};},verify:async()=>({state:'ready'})});
  const tools=createFleetPowerTools({runner,read:async()=>({version:1,workers:[{id:'glm53f-m3'}]})});
  const input={action:'power',worker:'glm53f-m3',power_action:'start',action_id:UUID()};
  assert.equal((await tools.tool({...input,mode:'check'})).allowed,true);
  assert.equal(calls,0);
  const accepted=await tools.tool(input);
  assert.equal(accepted.accepted,true);
  assert.ok(scriptTimeout>900000,'existing launcher may wait fifteen minutes');
  assert.equal((await tools.tool(input)).accepted,true);
  assert.equal(calls,1);
  const pending=(await tools.tool({action:'status'})).recent.find(r=>r.action_id===input.action_id);
  assert.equal(pending.state,'running');assert.equal(pending.verified.state,'pending');
  await assert.rejects(tools.tool({...input,power_action:'stop'}),/different request/);
  await assert.rejects(tools.tool({...input,mode:'execute'}),/Specify/);
  release();await new Promise(r=>setImmediate(r));
  assert.equal((await tools.tool(input)).receipt.verified.state,'ready');
  assert.equal(calls,1);
});

test('network failures cannot prove shutdown and wrong model cannot prove startup',async t=>{
  for(const detail of ['connect timed out','EHOSTUNREACH','ENETUNREACH','invalid URL']){
    const verify=createReadinessVerifier({resolveEndpoint:async()=>({url:'http://127.0.0.1:1'}),stopTimeoutMs:0,probe:async()=>({reachable:false,detail})});
    assert.equal((await verify('glm53f-m3','stop')).state,'timeout',detail);
  }
  const srv=http.createServer((_req,res)=>{res.end(JSON.stringify({data:[{id:'other-model'}]}));});
  await new Promise(r=>srv.listen(0,'127.0.0.1',r));t.after(()=>{srv.closeAllConnections();srv.close();});
  const verify=createReadinessVerifier({resolveEndpoint:async()=>({url:`http://127.0.0.1:${srv.address().port}`,model:'expected-model'}),startTimeoutMs:0});
  assert.equal((await verify('glm53f-m3','start')).state,'timeout');
});

test('timed-out launcher still gets endpoint verification while retaining the hardware lock',async()=>{
  let release;
  const runner=createPowerRunner({directory,spawn:async()=>({exit_code:null,timed_out:true}),verify:async()=>{await new Promise(r=>{release=r;});return {state:'ready'};}});
  const pending=runner.run('glm53f-m3','start',{actionId:UUID()});
  await new Promise(r=>setImmediate(r));
  assert.equal(runner.busy('ds41-m3'),true);
  assert.equal((await runner.run('ds41-m3','stop')).busy,true);
  release();const done=await pending;
  assert.equal(done.ok,false);assert.equal(done.verified.state,'ready');assert.equal(done.timed_out,true);
  assert.equal(runner.busy('glm53f-m3'),false);
});

test('stop requires drained hardware, fresh native idle evidence and a separate serving machine',async()=>{
  let workers=[{id:'glm53f-sparks12',is_healthy:true,drained:true},{id:'ds41-sparks12',is_healthy:true,drained:false}];
  const runner=createPowerRunner({directory,spawn:async()=>{throw Error('preflight must not spawn');}});
  const tools=createFleetPowerTools({runner,read:async()=>({version:1,workers}),directRunning:async()=>null});
  let check=await tools.precheck('glm53f-sparks12','stop');
  assert.equal(check.allowed,false);assert.match(check.refusals.join(' '),/last healthy worker/);assert.match(check.refusals.join(' '),/Native activity is unknown/);
  workers=[{id:'glm53f-m3',is_healthy:true,drained:false},{id:'glm53f-sparks12',is_healthy:true,drained:false}];
  check=await tools.precheck('glm53f-m3','stop');
  assert.equal(check.allowed,false);assert.match(check.refusals.join(' '),/Drain the worker/);
});

test('a real launcher leaves its background server outside the dashboard process group',async t=>{
  if(process.platform==='win32'){t.skip('Unix process-group check');return;}
  const {execFileSync}=await import('node:child_process');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'power-detachment-'));let childPid;
  t.after(()=>{if(childPid)try{process.kill(childPid,'SIGTERM');}catch{}fs.rmSync(dir,{recursive:true,force:true});});
  fs.writeFileSync(path.join(dir,'start-glm53-m3'),'#!/bin/sh\n/bin/sleep 30 >/dev/null 2>&1 &\necho "$! $$"\n',{mode:0o700});
  const runner=createPowerRunner({directory:dir});const receipt=await runner.run('glm53f-m3','start');
  const parts=receipt.output.trim().split(/\s+/).map(Number);assert.equal(parts.length,2);assert.ok(parts.every(Number.isSafeInteger));[childPid]=parts;
  const group=Number(execFileSync('/bin/ps',['-p',String(childPid),'-o','pgid='],{encoding:'utf8'}).trim());
  const parentGroup=Number(execFileSync('/bin/ps',['-p',String(process.pid),'-o','pgid='],{encoding:'utf8'}).trim());
  assert.equal(group,parts[1],'background server inherits the detached launcher group');assert.notEqual(group,parentGroup,'dashboard group termination cannot reach the model');
});

test('Genie drains and conditionally resumes through existing controls without overriding a later pause',async()=>{
 const first=UUID(),later=UUID();let rows=[{id:'glm53f-m3',is_healthy:true,drained:false,load:0,queued:0},{id:'glm53f-sparks12',is_healthy:true,drained:false,load:0,queued:0}];const calls=[];
 const runner=createPowerRunner({directory});
 const tools=createFleetPowerTools({runner,read:async()=>({version:1,workers:rows}),control:async(route,body)=>{
  calls.push({route,body});
  if(route==='/resume-workers'&&body.expected_operator_actions['glm53f-m3']!==rows[0].last_operator_action.id)throw Error('Operator action changed');
  rows[0]={...rows[0],drained:route==='/drain-workers',last_operator_action:{id:first}};
 }});
 const input={action:'routing',worker:'glm53f-m3',routing_action:'drain',action_id:UUID()};
 const drained=await tools.tool(input);assert.equal(drained.state,'complete');assert.equal(drained.operator_action,first);assert.equal(drained.was_drained,false);
 assert.equal((await tools.tool(input)).state,'complete');assert.equal(calls.length,1);
 rows[0].last_operator_action={id:later};
 const resumed=await tools.tool({action:'routing',worker:'glm53f-m3',routing_action:'resume',action_id:UUID(),expected_operator_action:first});
 assert.equal(resumed.state,'unverified');assert.match(resumed.error,/Operator action changed/);assert.equal(rows[0].drained,true);
 rows=[rows[0]];
 await assert.rejects(tools.tool({...input,action_id:UUID()}),/separate hardware/);
});
