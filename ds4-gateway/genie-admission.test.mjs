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
  const control=async(route,body)=>{calls.push([route,body]);if(route==='/add-worker'){live.workers=[...live.workers,{id:body.worker.id,url:body.worker.url,is_healthy:true,drained:false}];return {added:true,worker:body.worker.id};}if(route==='/remove-worker'){live.workers=live.workers.filter(w=>w.id!==body.id);return {removed:body.id};}return {ok:true};};
  const live={workers};
  const read=async()=>({version:1,workers:live.workers.map(w=>({...w}))});
  const probe=async url=>[{id:'Test-Model-X',context_length:40960}];
  const spawnPark=async(args,opts,done)=>{calls.push(['park',args]);done(null,JSON.stringify({action:'park',verified:true}));};
  const spawnStart=(args,opts)=>{calls.push(['start',args]);return {unref(){},on(){}};};
  const readDoor=door===null?null:async()=>door;
  const tools=createAdmissionTools({config:{port:30000,api_key:'test'},control,read,readDoor,probe,spawnPark,spawnStart,isTesting:()=>false,isEnabled:()=>true});
  return {tools,calls,configFile,setWorkers(rows){live.workers=rows;},cleanup(){if(oldEnv===undefined)delete process.env.DWARF_GATE_CONFIG;else process.env.DWARF_GATE_CONFIG=oldEnv;fs.rmSync(dir,{recursive:true,force:true});}};
}
const inspect=async(tools,url='http://127.0.0.1:8013/v1')=>tools.tool({action:'inspect',url});

test('admission inspect drafts an honest proposal from an endpoint probe',async()=>{
  const r=rig();try{
    const value=await inspect(r.tools);
    assert.equal(value.proposal.served_model,'Test-Model-X');
    assert.equal(value.proposal.worker.id,'test-model-x');
    assert.equal(value.proposal.worker.context_length,40960);
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
    await assert.rejects(()=>r.tools.tool({action:'admit',stage:'add-worker',fingerprint:value.fingerprint,action_id:ACTION_ID}),/already exists|Stage order/);
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
    const receipt=await r.tools.tool({action:'admit',stage:'verify',fingerprint:value.fingerprint,action_id:ACTION_ID});
    assert.equal(receipt.verdict,'admitted and verified');
    const status=await r.tools.tool({action:'status'});
    assert.deepEqual(status.completed,['add-worker','route','restart','verify']);
  }finally{r.cleanup();}
  const blocked=rig({door:{holding:true,core_ready:true}});
  try{
    const value=await inspect(blocked.tools);
    await blocked.tools.tool({action:'admit',stage:'add-worker',fingerprint:value.fingerprint,action_id:ACTION_ID});
    await blocked.tools.tool({action:'admit',stage:'route',fingerprint:value.fingerprint,action_id:ACTION_ID});
    await blocked.tools.tool({action:'admit',stage:'restart',fingerprint:value.fingerprint,action_id:ACTION_ID});
    const receipt=await blocked.tools.tool({action:'admit',stage:'verify',fingerprint:value.fingerprint,action_id:ACTION_ID});
    assert.equal(receipt.verdict,'unverified — resolve the problems or inspect honestly');
    assert.ok(receipt.problems.some(p=>p.includes('holding')));
    const status=await blocked.tools.tool({action:'status'});
    assert.ok(!status.completed.includes('verify'),'failed verification must not count as complete');
  }finally{blocked.cleanup();}
});
