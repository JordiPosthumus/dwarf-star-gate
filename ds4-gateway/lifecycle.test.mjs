import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {once} from 'node:events';
import {execFileSync} from 'node:child_process';
import {parseArgs,checkRuntime,backupControlState,fleetSummary,lifecycle,portListening,formatResult} from './lifecycle.mjs';
import {projectRoot} from './config.mjs';

function fixture(overrides={}){
  const calls=[];
  const status={gateway:{version:1,available:1,total:2,active:1,queued:3,draining:false,context_length:262144,workers:[{id:'worker-a',is_healthy:true,drained:false},{id:'worker-b',is_healthy:false,drained:true,operator_paused:true,quarantine:{reason:'fault'},holds:[{}]}]},door:{service:'dwarf-star-gate-continuity-door'},dashboard:{service:'dwarf-star-gate-dashboard'}};
  const ops={preflight:()=>calls.push(['preflight']),check:async()=>{calls.push(['check']);return[];},backup:()=>{calls.push(['backup']);return'/private-backup';},registered:()=>true,managed:()=>false,listening:async()=>false,progress:()=>{},open:()=>calls.push(['open']),service:async(...args)=>{calls.push(args);return status;},...overrides};
  return {ops,calls,status};
}

test('strict CLI: safe defaults, explicit interruption, valid components and no unsafe options',()=>{
  assert.deepEqual(parseArgs(['start']).kinds,['gateway','door','dashboard']);
  assert.equal(parseArgs(['stop']).interrupt,false);
  assert.equal(parseArgs(['stop','--interrupt','--confirm-interrupt']).interrupt,true);
  const selected=parseArgs(['start','--only','dashboard','--config','my file.json','--open','--json']);
  assert.equal(selected.config,'my file.json');assert.equal(selected.open,true);assert.equal(selected.json,true);assert.deepEqual(selected.kinds,['dashboard']);
  for(const args of [['start','--interrupt'],['stop','--interrupt'],['stop','--confirm-interrupt'],['stop','--open'],['start','--only','constructor'],['start','--only','toString'],['start','--config'],['start','--only','gateway','--open'],['start','--json','--json'],['start','--force'],['restart']])assert.throws(()=>parseArgs(args),undefined,args.join(' '));
});
test('platform/user/version gates run before mutation; later Node majors work',()=>{
  for(const version of ['22.22.2','22.23.0','24.0.0','26.0.0'])checkRuntime({platform:'darwin',version,uid:501});
  for(const version of ['20.0.0','22.22.1','22.0.0','bad'])assert.throws(()=>checkRuntime({platform:'darwin',version,uid:501}));
  assert.throws(()=>checkRuntime({platform:'linux',version:'24.0.0',uid:501}),/Linux/);
  assert.throws(()=>checkRuntime({platform:'darwin',version:'24.0.0',uid:0}),/not sudo/);
});
test('start installs only missing component; preserves running gateway and reports unchanged exclusions',async()=>{
  const {ops,calls}=fixture({registered:k=>k==='gateway'||k==='door'});
  const result=await lifecycle(parseArgs(['start','--open']),ops);
  assert.deepEqual(calls,[['preflight'],['check'],['backup'],['install',['dashboard']],['start',['gateway','door','dashboard']],['status',['gateway','door','dashboard']],['open']]);
  assert.equal(result.fleet.context_length,262144);assert.equal(result.fleet.active,1);assert.equal(result.fleet.queued,3);
  assert.ok(formatResult(result).includes('operator paused; 1 agent hold(s); drained; quarantined; not healthy (unchanged)'));
  assert.equal(result.model_servers_unchanged,true);
});
test('repeat start never issues restart, install, pause, resume or recovery actions',async()=>{
  const {ops,calls}=fixture();
  await lifecycle(parseArgs(['start']),ops);await lifecycle(parseArgs(['start']),ops);
  assert.equal(calls.filter(c=>c[0]==='start').length,2);
  assert.ok(calls.every(c=>['preflight','check','backup','start','status'].includes(c[0])));
});
test('fresh install preflights all missing components before writing; unmanaged or orphaned services are refused',async()=>{
  for(const extra of [{listening:async k=>k==='dashboard'},{managed:k=>k==='gateway'}]){
    const {ops,calls}=fixture({registered:()=>false,...extra});
    await assert.rejects(lifecycle(parseArgs(['start']),ops),/no saved DSG registration/);
    assert.deepEqual(calls,[['preflight'],['check']]);
  }
  const {ops,calls}=fixture({registered:()=>false});
  await lifecycle(parseArgs(['start']),ops);
  assert.deepEqual(calls.find(c=>c[0]==='install'),['install',['gateway','door','dashboard']]);
});
test('preflight and backup errors cannot start services; readiness failure does not trigger destructive rollback',async()=>{
  for(const fail of ['preflight','check','backup']){
    const {ops,calls}=fixture({[fail]:()=>{throw new Error('injected '+fail);}});
    await assert.rejects(lifecycle(parseArgs(['start']),ops),new RegExp('injected '+fail));
    assert.ok(!calls.some(c=>['install','start','stop'].includes(c[0])));
  }
  const {ops,calls}=fixture({service:async(...args)=>{calls.push(args);throw new Error('not ready');}});
  await assert.rejects(lifecycle(parseArgs(['start']),ops),/not ready/);
  assert.ok(!calls.some(c=>['stop','restart'].includes(c[0])));
});
test('zero workers or retained global drain is clearly degraded, not falsely ready for inference',async()=>{
  const {ops,status}=fixture();status.gateway.available=0;status.gateway.draining=true;
  const r=await lifecycle(parseArgs(['start']),ops);
  assert.ok(r.warnings.some(w=>w.includes('No DS4 servers')));assert.ok(r.warnings.some(w=>w.includes('admission is draining')));
  assert.equal(r.verified,true,'process startup can succeed with a deliberately excluded fleet');
});
test('stop delegates fenced idle check and does not run source/optional dependency checks',async()=>{
  const {ops,calls}=fixture();const result=await lifecycle(parseArgs(['stop']),ops);
  assert.deepEqual(calls,[['preflight'],['backup'],['stop',['gateway','door','dashboard'],{interrupt:false}]]);
  assert.equal(result.verified,true);
  const bad=fixture({service:async(...a)=>{bad.calls.push(a);throw new Error('busy');}});
  await assert.rejects(lifecycle(parseArgs(['stop']),bad.ops),/busy/);
  assert.ok(!bad.calls.some(c=>c[2]?.interrupt));
});
test('explicit interrupt is scoped; stop is idempotent before installation; surviving listener fails verification',async()=>{
  const {ops,calls}=fixture();await lifecycle(parseArgs(['stop','--only','gateway','--interrupt','--confirm-interrupt']),ops);
  assert.deepEqual(calls.at(-1),['stop',['gateway'],{interrupt:true}]);
  const absent=fixture({registered:()=>false});await lifecycle(parseArgs(['stop']),absent.ops);
  assert.ok(!absent.calls.some(c=>c[0]==='stop'));
  const survivor=fixture({listening:async()=>true});await assert.rejects(lifecycle(parseArgs(['stop']),survivor.ops),/port still has a listener/);
  const orphan=fixture({registered:()=>false,managed:()=>true});await assert.rejects(lifecycle(parseArgs(['stop']),orphan.ops),/no saved DSG registration/);
});
test('private backup is unique, restrictive, byte-exact and never mutates source; missing state is allowed',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dsg-lifecycle-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const filename=path.join(root,'private.json'),state=path.join(root,'runtime','affinity.json');
  fs.mkdirSync(path.dirname(state));const configBytes=Buffer.from('{"example":"synthetic secret"}\n'),stateBytes=Buffer.from('{"sessions":{},"drained":{"worker-a":true}}\n');
  fs.writeFileSync(filename,configBytes);fs.writeFileSync(state,stateBytes);
  const loaded={filename,config:{state_file:state}},options={root,now:new Date('2026-01-01T00:00:00Z')};
  const a=backupControlState(loaded,options),b=backupControlState(loaded,options);assert.notEqual(a,b);
  assert.equal(fs.statSync(a).mode&0o777,0o700);
  for(const [name,bytes] of [['config.json',configBytes],['affinity.json',stateBytes]]){assert.deepEqual(fs.readFileSync(path.join(a,name)),bytes);assert.equal(fs.statSync(path.join(a,name)).mode&0o777,0o600);}
  assert.deepEqual(fs.readFileSync(filename),configBytes);assert.deepEqual(fs.readFileSync(state),stateBytes);
  fs.unlinkSync(state);const c=backupControlState(loaded,options);assert.ok(!fs.existsSync(path.join(c,'affinity.json')));
  fs.symlinkSync(filename,state);assert.throws(()=>backupControlState(loaded,options),/non-regular/);
});
test('local port verification distinguishes listening from closed without HTTP credentials',async()=>{
  const server=net.createServer(s=>s.end());server.listen(0,'127.0.0.1');await once(server,'listening');const port=server.address().port;
  try{assert.equal(await portListening(port),true);}finally{await new Promise(r=>server.close(r));}
  assert.equal(await portListening(port),false);
});
test('shell launchers are executable, work outside checkout, and help requires no configuration',()=>{
  const env={...process.env,DWARF_GATE_CONFIG:'/nonexistent/lifecycle-help.json'};
  for(const file of ['start-dsg.sh','stop-dsg.sh']){
    const script=path.join(projectRoot,file);assert.ok(fs.statSync(script).mode&0o111);
    const output=execFileSync(script,['--help'],{cwd:os.tmpdir(),env,encoding:'utf8'});
    assert.ok(output.includes('DS4 servers are never stopped.'));
    assert.ok(!output.includes('synthetic secret'));
  }
  assert.equal(fleetSummary(null).available,null);
});
