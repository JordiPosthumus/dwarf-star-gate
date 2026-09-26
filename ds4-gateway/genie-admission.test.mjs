import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createAdmissionTools} from './genie-admission.mjs';

const ACTION_ID='12345678-1234-4234-8234-123456789012';
function rig({workers=[],models=null,door=null,configBody={}}={}) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'admission-test-'));
  const configFile=path.join(dir,'config.local.json');
  fs.writeFileSync(configFile,JSON.stringify({model_routes:{...(configBody.model_routes??{})},workers:[]}));
  const oldEnv=process.env.DWARF_GATE_CONFIG;
  process.env.DWARF_GATE_CONFIG=configFile;
  const calls=[];
  const control=async(route,body)=>{calls.push([route,body]);if(route==='/workers')return {conditional_resume_version:1,workers:live.workers.map(w=>({...w}))};if(route==='/add-worker'){live.workers=[...live.workers,{id:body.worker.id,url:body.worker.url,is_healthy:true,drained:true,operator_paused:true,holds:[],maintenance_locks:[],last_operator_action:null}];return {conditional_resume_version:1,workers:live.workers.map(w=>({...w}))};}if(route==='/resume-workers'){for(const worker of live.workers)if(body.workers.includes(worker.id)){worker.drained=false;worker.operator_paused=false;}return {ok:true};}if(route==='/remove-worker'){live.workers=live.workers.filter(w=>w.id!==body.id);return {removed:body.id};}return {ok:true};};
  const live={workers};
  const read=async()=>({version:1,conditional_resume_version:1,workers:live.workers.map(w=>({...w}))});
  const probe=async url=>[{id:'Test-Model-X',context_length:40960}];
  const spawnPark=async(args,opts,done)=>{calls.push(['park',args]);done(null,JSON.stringify({action:'park',verified:true}));};
  const spawnStart=(args,opts)=>{calls.push(['start',args]);return {unref(){},on(){}};};
  const readDoor=door===null?null:async()=>door;
  const tools=createAdmissionTools({config:{port:30000,api_key:'test'},control,read,readDoor,probe,spawnPark,spawnStart,isTesting:()=>false,isEnabled:()=>true,checkRunner:async({worker,check})=>{calls.push(['canary',worker.id,check]);return {state:'passed',samples:[{worker:worker.id}]};}});
  return {tools,calls,configFile,setWorkers(rows){live.workers=rows;},cleanup(){if(oldEnv===undefined)delete process.env.DWARF_GATE_CONFIG;else process.env.DWARF_GATE_CONFIG=oldEnv;fs.rmSync(dir,{recursive:true,force:true});}};
}
const inspect=async(tools,url='http://127.0.0.1:8013/v1')=>tools.tool({action:'inspect',url});

test('admission inspect drafts an honest proposal from an endpoint probe',async()=>{
  const r=rig();try{
    const value=await inspect(r.tools);
    assert.equal(value.proposal.served_model,'Test-Model-X');
    assert.equal(value.proposal.worker.id,'test-model-x');
    assert.equal(value.proposal.worker.context_length,40960);
    assert.equal(value.proposal.worker.model_aliases.PoolModel,'Test-Model-X');
    assert.deepEqual(value.proposal.route,{name:'Test-Model-X',workers:['test-model-x']});
    assert.deepEqual(value.proposal.needs_removal,[]);
    assert.match(value.proposal.steps.join(' '),/add-worker/);
    assert.ok(value.fingerprint);
  }finally{r.cleanup();}
});

test('admission inspect refuses non-loopback targets and flags same-endpoint conflicts',async()=>{
  const r=rig({workers:[{id:'old-worker',url:'http://127.0.0.1:8013/v1',is_healthy:false,drained:false,quarantine:false}]});try{
    await assert.rejects(()=>r.tools.tool({action:'inspect',url:'http://192.0.2.10:8000/v1'}),/loopback/);
    const value=await inspect(r.tools);
    assert.deepEqual(value.proposal.needs_removal,['old-worker']);
    assert.equal(value.proposal.worker.id,'test-model-x');
  }finally{r.cleanup();}
});

test('admission stages enforce order, fingerprints, capability and action ids',async()=>{
  const r=rig();try{
    const value=await inspect(r.tools);
    await assert.rejects(()=>r.tools.tool({action:'admit',stage:'route',fingerprint:'wrong',action_id:ACTION_ID}),/Fingerprint/);
    await assert.rejects(()=>r.tools.tool({action:'admit',stage:'route',fingerprint:value.fingerprint,action_id:'nope'}),/action ID/);
    await assert.rejects(()=>r.tools.tool({action:'admit',stage:'verify',fingerprint:value.fingerprint,action_id:ACTION_ID}),/Stage order/);
    const off=createAdmissionTools({config:{port:30000},control:r.calls.push?async()=>({}):async()=>({}),read:r.tools.tool?async()=>({version:1,workers:[]}):async()=>({}),probe:async()=>[],isEnabled:()=>false});
    await assert.rejects(()=>off.tool({action:'admit',stage:'add-worker',fingerprint:value.fingerprint,action_id:ACTION_ID}),/switched off/);
  }finally{r.cleanup();}
});

test('admission remove-dead drains and removes only still-dead workers',async()=>{
  const r=rig({workers:[{id:'old-worker',url:'http://127.0.0.1:8013/v1',is_healthy:false,drained:false,quarantine:false}]});try{
    const value=await inspect(r.tools);
    const receipt=await r.tools.tool({action:'admit',stage:'remove-dead',fingerprint:value.fingerprint,action_id:ACTION_ID});
    assert.deepEqual(r.calls.map(c=>c[0]),['/drain-workers','/remove-worker']);
    assert.equal(receipt.receipts[0].worker,'old-worker');
    r.calls.length=0;
    const healthy=rig({workers:[{id:'old-worker',url:'http://127.0.0.1:8013/v1',is_healthy:false,drained:false,quarantine:false}]});
    try{
      const v2=await inspect(healthy.tools);
      healthy.setWorkers([{id:'old-worker',url:'http://127.0.0.1:8013/v1',is_healthy:true,drained:false,quarantine:false}]);
      await assert.rejects(()=>healthy.tools.tool({action:'admit',stage:'remove-dead',fingerprint:v2.fingerprint,action_id:ACTION_ID}),/healthy now; refusing/);
    }finally{healthy.cleanup();}
  }finally{r.cleanup();}
});

test('admission add-worker registers the drafted worker and refuses existing ids',async()=>{
  const r=rig({workers:[{id:'old-worker',url:'http://127.0.0.1:8013/v1',is_healthy:false,drained:false,quarantine:false}]});try{
    const value=await inspect(r.tools);
    await r.tools.tool({action:'admit',stage:'remove-dead',fingerprint:value.fingerprint,action_id:ACTION_ID});
    const receipt=await r.tools.tool({action:'admit',stage:'add-worker',fingerprint:value.fingerprint,action_id:ACTION_ID});
    assert.equal(receipt.worker_id,'test-model-x');
    assert.deepEqual(r.calls.find(c=>c[0]==='/add-worker')[1].worker.url,'http://127.0.0.1:8013');
    assert.equal((await r.tools.tool({action:'admit',stage:'add-worker',fingerprint:value.fingerprint,action_id:ACTION_ID})).deduplicated,true);
    assert.equal(r.calls.filter(([route])=>route==='/add-worker').length,1);
  }finally{r.cleanup();}
});

test('admission route writes the private config with a backup and honors overwrite confirmation',async()=>{
  const r=rig({configBody:{model_routes:{'Existing-Model':['other']}}});try{
    const value=await inspect(r.tools);
    await r.tools.tool({action:'admit',stage:'add-worker',fingerprint:value.fingerprint,action_id:ACTION_ID});
    await r.tools.tool({action:'admit',stage:'route',fingerprint:value.fingerprint,action_id:ACTION_ID});
    const parsed=JSON.parse(fs.readFileSync(r.configFile,'utf8'));
    assert.deepEqual(parsed.model_routes['Test-Model-X'],['test-model-x']);
    const backups=fs.readdirSync(path.dirname(r.configFile)).filter(f=>f.startsWith('config.local.json.bak-admission-'));
    assert.equal(backups.length,1);
    assert.equal(fs.statSync(r.configFile).mode&0o777,0o600);
    assert.equal(fs.statSync(path.join(path.dirname(r.configFile),backups[0])).mode&0o777,0o600);
    const r2=rig({configBody:{model_routes:{'Test-Model-X':['someone-else']}}});
    try{
      const v2=await inspect(r2.tools);
      await r2.tools.tool({action:'admit',stage:'add-worker',fingerprint:v2.fingerprint,action_id:ACTION_ID});
      await assert.rejects(()=>r2.tools.tool({action:'admit',stage:'route',fingerprint:v2.fingerprint,action_id:ACTION_ID}),/overwrite_route/);
      await r2.tools.tool({action:'admit',stage:'route',fingerprint:v2.fingerprint,action_id:ACTION_ID,overwrite_route:true});
      assert.deepEqual(JSON.parse(fs.readFileSync(r2.configFile,'utf8')).model_routes['Test-Model-X'],['test-model-x']);
    }finally{r2.cleanup();}
  }finally{r.cleanup();}
});

test('admission restart parks synchronously and spawns start detached',async()=>{
  const r=rig();try{
    const value=await inspect(r.tools);
    await r.tools.tool({action:'admit',stage:'add-worker',fingerprint:value.fingerprint,action_id:ACTION_ID});
    await r.tools.tool({action:'admit',stage:'route',fingerprint:value.fingerprint,action_id:ACTION_ID});
    const receipt=await r.tools.tool({action:'admit',stage:'restart',fingerprint:value.fingerprint,action_id:ACTION_ID});
    assert.equal(receipt.start_spawned,true);
    const park=r.calls.find(c=>c[0]==='park'),start=r.calls.find(c=>c[0]==='start');
    assert.match(park[1].join(' '),/lifecycle.mjs park --config/);
    assert.match(start[1].join(' '),/lifecycle.mjs start --config/);
    assert.ok(receipt.parked.includes('verified'));
  }finally{r.cleanup();}
});

test('admission verify reports door, worker and canary honestly and only completes on success',async()=>{
  const r=rig({door:{holding:false,core_ready:true}});try{
    const value=await inspect(r.tools);
    await r.tools.tool({action:'admit',stage:'add-worker',fingerprint:value.fingerprint,action_id:ACTION_ID});
    await r.tools.tool({action:'admit',stage:'route',fingerprint:value.fingerprint,action_id:ACTION_ID});
    await r.tools.tool({action:'admit',stage:'restart',fingerprint:value.fingerprint,action_id:ACTION_ID});
    await r.tools.tool({action:'admit',stage:'resume',fingerprint:value.fingerprint,action_id:ACTION_ID});
    const receipt=await r.tools.tool({action:'admit',stage:'verify',fingerprint:value.fingerprint,action_id:ACTION_ID});
    assert.equal(receipt.verdict,'admitted and verified');
    assert.deepEqual(r.calls.find(c=>c[0]==='canary'),['canary','test-model-x','gateway']);
    const status=await r.tools.tool({action:'status'});
    assert.deepEqual(status.completed,['add-worker','route','restart','resume','verify']);
  }finally{r.cleanup();}
  const blockedDoor={holding:false,core_ready:true},blocked=rig({door:blockedDoor});
  try{
    const value=await inspect(blocked.tools);
    await blocked.tools.tool({action:'admit',stage:'add-worker',fingerprint:value.fingerprint,action_id:ACTION_ID});
    await blocked.tools.tool({action:'admit',stage:'route',fingerprint:value.fingerprint,action_id:ACTION_ID});
    await blocked.tools.tool({action:'admit',stage:'restart',fingerprint:value.fingerprint,action_id:ACTION_ID});
    await blocked.tools.tool({action:'admit',stage:'resume',fingerprint:value.fingerprint,action_id:ACTION_ID});
    blockedDoor.holding=true;
    const receipt=await blocked.tools.tool({action:'admit',stage:'verify',fingerprint:value.fingerprint,action_id:ACTION_ID});
    assert.equal(receipt.verdict,'unverified — resolve the problems or inspect honestly');
    assert.ok(receipt.problems.some(p=>p.includes('holding')));
    const status=await blocked.tools.tool({action:'status'});
    assert.ok(!status.completed.includes('verify'),'failed verification must not count as complete');
  }finally{blocked.cleanup();}
});

test('admission resume preserves newer operator decisions, maintenance holds and direct work',async()=>{
 for(const change of [
  {last_operator_action:{id:'87654321-4321-4321-8321-210987654321'}},
  {maintenance_locks:[{id:'fixture-lock'}]}, {holds:[{id:'fixture-hold'}]}, {direct_reserved:true},
 ]){
  const r=rig({door:{holding:false,core_ready:true}});
  try{
   const value=await inspect(r.tools),args={action:'admit',fingerprint:value.fingerprint,action_id:ACTION_ID};
   for(const stage of ['add-worker','route','restart'])await r.tools.tool({...args,stage});
   r.setWorkers([{id:'test-model-x',url:'http://127.0.0.1:8013',is_healthy:true,drained:true,
    operator_paused:true,last_operator_action:null,holds:[],maintenance_locks:[],...change}]);
   await assert.rejects(r.tools.tool({...args,stage:'resume'}),/changed|held|reserved/);
   assert.equal(r.calls.some(([route])=>route==='/resume-workers'),false);
  }finally{r.cleanup();}
 }
});

test('existing-worker checks run asynchronously, persist observations and never repeat an action ID',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'serving-check-receipt-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 let release,calls=0;
 const options={config:{state_file:path.join(dir,'state.json')},control:async()=>{throw Error('No infrastructure writes allowed');},read:async()=>({version:1,workers:[{id:'fixture-worker',url:'http://127.0.0.1:1',served_model:'fixture',is_healthy:true,drained:false}]}),checkRunner:async({onSample})=>{calls++;onSample({label:'proof',cached_tokens:0});await new Promise(r=>{release=r;});return {state:'passed',samples:[{label:'proof',cached_tokens:0}]};}};
 const tools=createAdmissionTools(options),input={action:'verify-worker',worker:'fixture-worker',check:'cache',action_id:ACTION_ID};
 assert.equal((await tools.tool(input)).state,'running');assert.equal((await tools.tool(input)).state,'running');assert.equal(calls,1);assert.equal((await tools.tool({action:'status'})).busy,true);
 await assert.rejects(tools.tool({...input,check:'tools'}),/different serving check/);
 release();await new Promise(r=>setImmediate(r));assert.equal((await tools.tool(input)).state,'passed');assert.equal((await tools.tool({action:'status'})).busy,false);
 const reloaded=createAdmissionTools(options);assert.equal((await reloaded.tool(input)).state,'passed');assert.equal(calls,1);
});

test('native checks resolve private credentials without exposing them and reject endpoint drift',async()=>{
 let observed;
 const worker={id:'fixture-worker',url:'http://127.0.0.1:34567/v1',served_model:'fixture',is_healthy:true,drained:false};
 const base={config:{port:30000},control:async()=>({}),read:async()=>({workers:[worker]}),checkRunner:async args=>{observed=args.worker;return {state:'passed'};}};
 const tools=createAdmissionTools({...base,resolveNativeWorker:async()=>({...worker,api_key_file:'/private/fixture-key'})});
 await tools.tool({action:'verify-worker',worker:worker.id,check:'cache',action_id:ACTION_ID});
 await new Promise(r=>setImmediate(r));
 assert.equal(observed.api_key_file,'/private/fixture-key');assert.ok(!JSON.stringify(await tools.tool({action:'status'})).includes('/private/fixture-key'));
 const drift=createAdmissionTools({...base,resolveNativeWorker:async()=>({...worker,url:'http://different.invalid/v1',api_key_file:'/private/fixture-key'})});
 await assert.rejects(drift.tool({action:'verify-worker',worker:worker.id,check:'cache',action_id:ACTION_ID}),/identity changed/);
});

test('an interrupted durable admission is visible and never replayed or replaced',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'admission-interrupted-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 fs.mkdirSync(path.join(dir,'genie'));
 const intent={stage:'add-worker',fingerprint:'fixture',action_id:ACTION_ID};
 fs.writeFileSync(path.join(dir,'genie','admission-session.json'),JSON.stringify({proposal:{worker:{id:'fixture'}},fingerprint:'fixture',completed:[],receipts:[],busy:true,inspected_at:null,intent}));
 let mutations=0;
 const tools=createAdmissionTools({config:{state_file:path.join(dir,'state.json')},control:async()=>{mutations++;},read:async()=>({version:1,workers:[]})});
 const status=await tools.tool({action:'status'});assert.equal(status.interrupted,true);assert.deepEqual(status.intent,intent);
 await assert.rejects(tools.tool({action:'admit',...intent}),/do not replay/);
 await assert.rejects(tools.tool({action:'inspect',url:'http://127.0.0.1:1234/v1'}),/needs reconciliation/);
 assert.equal(mutations,0);
});

test('diagnostic inference cannot enter an owned maintenance trial',async()=>{
 let calls=0;
 for(const restriction of [{drained:true},{operator_paused:true},{maintenance_locks:[{}]},{holds:[{}]},{direct_reserved:true}]){
  const tools=createAdmissionTools({config:{},control:async()=>({}),read:async()=>({workers:[{id:'fixture-worker',is_healthy:true,drained:false,...restriction}]}),checkRunner:async()=>{calls++;return {state:'passed'};}});
  await assert.rejects(tools.tool({action:'verify-worker',worker:'fixture-worker',check:'cache',action_id:ACTION_ID}),/maintenance hold/);
 }
 assert.equal(calls,0);
});
