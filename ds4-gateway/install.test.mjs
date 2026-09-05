import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {spawn,execFile,execFileSync} from 'node:child_process';
import {promisify} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import {configPath,loadConfig,projectRoot,dashboardPort,gatewayHost,isDashboard,isMain} from './config.mjs';
import {serviceSpec,assertIdle,assertDoorIdle,assertRegistration,unloadService,coordinatedCoreRestart,coordinatedCorePark,releaseParkedCore,PARK_REASON} from './service-control.mjs';
const exec=promisify(execFile);
const ownedHold={holding:true,hold_kind:'manual',hold_ownership:1,hold_id:'fixture-hold'};
test('restart waits for launchd removal; timeout cannot skip into bootstrap',async()=>{
  let now=0;const calls=[];
  await unloadService('gateway',{domain:'gui/test',interrupt:true,launch:(...a)=>calls.push(a),loaded:()=>now<300,now:()=>now,wait:async ms=>{now+=ms;}});
  assert.equal(now,300);assert.deepEqual(calls,[['kill','SIGKILL','gui/test/local.dwarf-star-gate.gateway'],['bootout','gui/test/local.dwarf-star-gate.gateway']]);
  await assert.rejects(unloadService('dashboard',{domain:'gui/test',launch:()=>{},loaded:()=>true,now:()=>now,timeoutMs:200,wait:async ms=>{now+=ms;}}),/unload not confirmed/);
  await assert.rejects(unloadService('other',{domain:'gui/test'}),/Choose gateway, door or dashboard/);
});
test('coordinated core restart holds first, waits for idle, and releases only after clean readiness',async()=>{
  const config={continuity_door:{enabled:true,control_socket:'/tmp/fixture.sock'},request_timeout_ms:10000};let now=0,index=0;const calls=[],states=[{active:1,queued:2},{active:0,queued:0},{active:0,queued:0,startup:{complete:true}}];
  const result=await coordinatedCoreRestart(config,{doorStatus:async()=>({hold_ownership:1}),hold:async b=>{calls.push(['hold',b.reason]);return ownedHold;},release:async body=>{assert.deepEqual(body,{if_hold_id:'fixture-hold'});calls.push(['release']);},read:async()=>states[Math.min(index++,states.length-1)],stop:async()=>calls.push(['stop']),start:async()=>calls.push(['start']),wait:async ms=>{now+=ms;},now:()=>now});
  assert.equal(result.replacement_ready,true);assert.deepEqual(calls.map(x=>x[0]),['hold','stop','start','release']);
  await assert.rejects(coordinatedCoreRestart(config,{doorStatus:async()=>({hold_ownership:1}),hold:async()=>ownedHold,release:async()=>{throw new Error('must not release');},read:async()=>({active:0,queued:0}),stop:async()=>{},start:async()=>{throw new Error('failed replacement');}}),error=>error.continuity_door_holding===true);
});
test('legacy Door cannot silently ignore ownership fencing during automated restart/release',async()=>{
  const config={continuity_door:{enabled:true}},calls=[];
  await assert.rejects(coordinatedCoreRestart(config,{doorStatus:async()=>({holding:false}),hold:async()=>calls.push('hold'),read:async()=>calls.push('read'),stop:async()=>calls.push('stop'),start:async()=>calls.push('start')}),/lacks hold ownership/);
  await assert.rejects(releaseParkedCore(config,{doorStatus:async()=>({holding:true,hold_kind:'manual',reason:PARK_REASON}),coreStatus:async()=>calls.push('read'),release:async()=>calls.push('release')}),/lacks hold ownership/);
  assert.deepEqual(calls,[]);
});
test('coordinated park drains after holding; start releases only the exact verified park hold',async()=>{
  const config={continuity_door:{enabled:true,control_socket:'/tmp/fixture.sock'},request_timeout_ms:10000};let now=0,index=0;const calls=[],states=[{active:1,queued:1},{active:0,queued:0}];
  const parked=await coordinatedCorePark(config,{doorStatus:async()=>({holding:false}),hold:async body=>calls.push(['hold',body]),read:async()=>states[Math.min(index++,states.length-1)],stop:async()=>calls.push(['stop']),wait:async ms=>{now+=ms;},now:()=>now});
  assert.equal(parked.core_parked,true);assert.deepEqual(calls.map(x=>x[0]),['hold','stop']);assert.equal(calls[0][1].reason,PARK_REASON);assert.equal(calls[0][1].if_unheld,true);
  const released=[];assert.deepEqual(await releaseParkedCore(config,{doorStatus:async()=>({...ownedHold,reason:PARK_REASON}),coreStatus:async()=>({startup:{complete:true},active:0,queued:0}),release:async body=>{assert.deepEqual(body,{if_hold_id:'fixture-hold'});released.push('release');}}),{released:true,reason:PARK_REASON});assert.deepEqual(released,['release']);
  const preserved=await releaseParkedCore(config,{doorStatus:async()=>({holding:true,hold_kind:'manual',reason:'operator maintenance'}),coreStatus:async()=>{throw new Error('must not inspect core');},release:async()=>{throw new Error('must not release');}});assert.deepEqual(preserved,{released:false,preserved_hold:true});
  await assert.rejects(coordinatedCorePark(config,{doorStatus:async()=>({holding:true,hold_kind:'manual',reason:'operator maintenance'})}),/different hold/);
  for(const core of [{startup:{complete:false},active:0,queued:0},{startup:{complete:true},active:1,queued:0},{startup:{complete:true},active:0,queued:1}])await assert.rejects(releaseParkedCore(config,{doorStatus:async()=>({...ownedHold,reason:PARK_REASON}),coreStatus:async()=>core,release:async()=>{throw new Error('must not release');}}),/clean idle startup barrier/);
});
const temporary=t=>{const dir=fs.mkdtempSync('/tmp/dsg-install-');t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;};
async function until(fn,ms=8000){const end=Date.now()+ms;while(Date.now()<end){try{const v=await fn();if(v)return v;}catch{}await delay(30);}throw new Error('Readiness timeout');}
async function port(){const s=http.createServer();s.listen(0,'127.0.0.1');await once(s,'listening');const p=s.address().port;await new Promise(r=>s.close(r));return p;}
test('configuration precedence and relative local paths are independent of caller cwd; remote paths unchanged',t=>{
  const root=temporary(t),file=path.join(root,'custom.json');
  const raw={state_file:'runtime/affinity.json',control_socket:'runtime/control.sock',telemetry_files:{worker:'engine.log'},cache_directories:{worker:'cache'},hardware_telemetry:{enabled:true,workers:{worker:{adapter:'jsonl-file',path:'hardware.jsonl'},spark:{adapter:'nvidia-linux'}}},predictor:{enabled:true,python:'predictor/bin/python',profiles:'runtime/profiles.json'},embeddings:{enabled:true,python:'encoder/bin/python',model_dir:'models/encoder'},recovery:{workers:[{helper:'/remote/helper.py',config:'/remote/policy.json'}]},context_length:262144,request_timeout_ms:360000000};
  fs.writeFileSync(file,JSON.stringify(raw));
  assert.equal(configPath(null,{env:{},cwd:'/unrelated',root}),path.join(root,'config.local.json'));
  assert.equal(configPath('custom.json',{env:{DWARF_GATE_CONFIG:'other'},cwd:root}),file);
  const {config}=loadConfig(null,{env:{DWARF_GATE_CONFIG:file},cwd:'/unrelated'});
  assert.equal(config.state_file,path.join(root,'runtime/affinity.json'));assert.equal(config.embeddings.model_dir,path.join(root,'models/encoder'));
  assert.equal(config.predictor.python,path.join(root,'predictor/bin/python'));assert.equal(config.predictor.profiles,path.join(root,'runtime/profiles.json'));
  assert.equal(config.telemetry_files.worker,path.join(root,'engine.log'));assert.deepEqual(config.recovery,raw.recovery);assert.equal(config.context_length,262144);assert.equal(config.request_timeout_ms,360000000);
  assert.equal(config.cache_directories.worker,path.join(root,'cache'));
  assert.equal(config.hardware_telemetry.workers.worker.path,path.join(root,'hardware.jsonl'));assert.deepEqual(config.hardware_telemetry.workers.spark,{adapter:'nvidia-linux'});
  assert.equal(gatewayHost({host:'0.0.0.0'}),'0.0.0.0');
  assert.equal(gatewayHost({host:'0.0.0.0',continuity_door:{enabled:true}}),'127.0.0.1');
  assert.equal(dashboardPort({ui_port:31000},{}),31000);assert.equal(dashboardPort({ui_port:31000},{GATEWAY_UI_PORT:'32000'}),32000);assert.throws(()=>dashboardPort({}, {GATEWAY_UI_PORT:'0'}));
});
test('readiness accepts enabled management; service manifests are portable and never contain API keys',()=>{
  assert.equal(isMain(import.meta.url,'-'),false);assert.equal(isMain(import.meta.url,'/does/not/exist'),false);
  for(const controls of [true,false])assert.ok(isDashboard({service:'dwarf-star-gate-dashboard',version:1,read_only:!controls,worker_management:controls}));
  assert.ok(!isDashboard({version:1,read_only:true}));
  const spec=serviceSpec('gateway','/tmp/DSG & space/config.local.json',{state_file:'/tmp/DSG & space/runtime/state.json',api_key:'PRIVATE_KEY_NOT_IN_MANIFEST'},{root:'/tmp/DSG & space',node:'/tmp/node',env:{PATH:'/usr/bin'}});
  assert.ok(spec.text.includes('DSG &amp; space'));assert.ok(!spec.text.includes('PRIVATE_KEY_NOT_IN_MANIFEST'));assert.ok(spec.args[1].endsWith('/ds4-gateway/gateway.mjs'));
  assert.ok(spec.text.includes('<key>ExitTimeOut</key><integer>360000</integer>'));
  const registration={Label:spec.label,ProgramArguments:['/installed/node',...spec.args.slice(1)],WorkingDirectory:spec.root,EnvironmentVariables:spec.variables};
  assertRegistration(registration,spec);
  assert.throws(()=>assertRegistration({...registration,WorkingDirectory:'/other/checkout'},spec));
  assert.throws(()=>assertRegistration({...registration,ProgramArguments:['/installed/node','/other/gateway.mjs',spec.args[2]]},spec));
  assert.throws(()=>assertRegistration({...registration,EnvironmentVariables:{GATEWAY_UI_PORT:'1'}},spec));
  assertIdle({active:0,queued:0});for(const state of [null,{active:1,queued:0},{active:0,queued:1}]){assert.throws(()=>assertIdle(state));assertIdle(state,true);}
  assertDoorIdle({active:0,held:0});for(const state of [null,{active:1,held:0},{active:0,held:1}]){assert.throws(()=>assertDoorIdle(state));assertDoorIdle(state,true);}
  const door=serviceSpec('door','/tmp/config.json',{state_file:'/tmp/runtime/state.json',request_timeout_ms:1000},{root:'/tmp/DSG',node:'/tmp/node',env:{PATH:'/usr/bin'}});assert.ok(door.args[1].endsWith('/ds4-gateway/door.mjs'));assert.ok(door.text.includes('local.dwarf-star-gate.continuity-door'));
});
test('clean checkout: initialize, doctor, UI registration, exact forwarding, CLI status and persisted restart',async t=>{
  const dir=temporary(t),checkout=path.join(dir,'DSG checkout & spaces'),elsewhere=path.join(dir,'elsewhere');fs.mkdirSync(checkout);fs.mkdirSync(elsewhere);
  // Export the staged publication, never private configs, runtime or dependencies.
  execFileSync('git',['checkout-index','--all',`--prefix=${checkout}/`],{cwd:projectRoot});
  execFileSync('git',['init','-q',checkout]);
  const env={...process.env};delete env.DWARF_GATE_CONFIG;delete env.GATEWAY_UI_PORT;
  const cli=(script,args=[])=>exec(process.execPath,[path.join(checkout,script),...args],{cwd:elsewhere,env,timeout:10000});
  const imported=execFileSync(process.execPath,['--input-type=module','-'],{cwd:checkout,env,encoding:'utf8',timeout:10000,input:"await import('./ds4-gateway/config.mjs'); await import('./ds4-gateway/gateway.mjs'); await import('./ds4-gateway/door.mjs'); await import('./ds4-gateway/dashboard.mjs'); await import('./ds4-gateway/service-control.mjs'); console.log('imports only');"});
  assert.equal(imported.trim(),'imports only');
  for(const launcher of ['start-dsg.sh','park-dsg.sh','stop-dsg.sh']){
    const help=execFileSync(path.join(checkout,launcher),['--help'],{cwd:elsewhere,env,encoding:'utf8',timeout:10000});
    assert.ok(help.includes('DS4 servers are never stopped.'));
  }
  const initialized=await cli('scripts/setup.mjs',['--controls']),configFile=path.join(checkout,'config.local.json');
  const c=JSON.parse(fs.readFileSync(configFile));assert.equal(fs.statSync(configFile).mode&0o777,0o600);assert.equal(c.nodes.length,0);assert.ok(!initialized.stdout.includes(c.api_key));
  await assert.rejects(cli('scripts/setup.mjs',['--controls']),/nothing overwritten/);assert.deepEqual(JSON.parse(fs.readFileSync(configFile)),c);
  const ports=new Set;while(ports.size<3)ports.add(await port());[c.port,c.continuity_door.core_port,c.ui_port]=ports;
  fs.writeFileSync(configFile,JSON.stringify(c));const checked=JSON.parse((await cli('scripts/doctor.mjs')).stdout);assert.ok(checked.ok);assert.equal(checked.workers,0);assert.ok(!fs.existsSync(path.join(checkout,'runtime')),'doctor must not create state');
  const backend=http.createServer((req,res)=>{if(req.url==='/v1/models')return res.end(JSON.stringify({data:[{id:c.model,context_length:c.context_length}]}));const chunks=[];req.on('data',x=>chunks.push(x));req.on('end',()=>{received=Buffer.concat(chunks).toString();res.writeHead(200,{'content-type':'text/event-stream'});res.end('data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');});});
  let received='';backend.listen(0,'127.0.0.1');await once(backend,'listening');
  const children=[];let logs='';
  const start=kind=>{const child=spawn(process.execPath,[path.join(checkout,'ds4-gateway',kind+'.mjs')],{cwd:elsewhere,env,stdio:['ignore','pipe','pipe']});children.push(child);child.stdout.on('data',x=>{logs+=x;});child.stderr.on('data',x=>{logs+=x;});return child;};
  const stop=async child=>{if(child.exitCode!==null)return;const exited=once(child,'exit');child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),3000);try{await exited;}finally{clearTimeout(timer);}};
  t.after(async()=>{await Promise.all(children.map(stop));backend.closeAllConnections();await new Promise(r=>backend.close(r));});
  let gateway=start('gateway');start('door');start('dashboard');
  const base=`http://127.0.0.1:${c.ui_port}`,headers={authorization:`Bearer ${c.api_key}`};
  try{await until(async()=>{const s=await(await fetch(base+'/api/status')).json();return isDashboard(s)&&s.gateway?.total===0;});}catch(error){throw new Error(`${error.message}; child logs: ${logs}`);}
  const management=await(await fetch(base+'/api/workers')).json();
  const action=async (name,body)=>{const r=await fetch(base+'/api/workers/'+name,{method:'POST',headers:{origin:base,'content-type':'application/json','x-dsg-csrf':management.csrf_token},body:JSON.stringify(body)});assert.equal(r.status,200,await r.clone().text());return r.json();};
  await action('add',{worker:{id:'worker-a',url:`http://127.0.0.1:${backend.address().port}`}});
  await action('resume',{workers:['worker-a']});
  const payload=JSON.stringify({model:c.model,messages:[{role:'user',content:'Synthetic install test'}],reasoning_effort:'xhigh',max_tokens:131072,stream:true});
  const response=await fetch(`http://127.0.0.1:${c.port}/v1/chat/completions`,{method:'POST',headers:{...headers,'content-type':'application/json','x-session-affinity':'install-fixture'},body:payload});assert.equal(response.status,200);assert.ok((await response.text()).includes('[DONE]'));assert.equal(received,payload);
  const status=JSON.parse((await cli('ds4-gateway/control.mjs',['status'])).stdout);assert.equal(status.context_length,262144);
  const uiStatus=JSON.parse((await cli('ds4-gateway/dashboard-control.mjs',['status'])).stdout);assert.equal(uiStatus.read_only,false);
  await action('drain',{workers:['worker-a']});await stop(gateway);gateway=start('gateway');
  await until(async()=>{const s=await(await fetch(`http://127.0.0.1:${c.port}/gateway/status`,{headers})).json();return s.workers?.[0]?.drained===true;});
  const state=JSON.parse(fs.readFileSync(path.join(checkout,'runtime/affinity.json')));assert.equal(Object.keys(state.sessions).length,1);assert.equal(state.drained['worker-a'],true);
  assert.ok(!fs.existsSync(path.join(elsewhere,'runtime')));assert.ok(!logs.includes(c.api_key));
  execFileSync('git',['add','--all'],{cwd:checkout});const tracked=execFileSync('git',['ls-files'],{cwd:checkout,encoding:'utf8'});assert.ok(!tracked.includes('config.local.json'));assert.ok(!tracked.includes('runtime/'));
});
test('doctor exposes durable worker and recovery-route drift without leaking route names or mutating state',async t=>{
  const dir=temporary(t),stateFile=path.join(dir,'affinity.json'),configFile=path.join(dir,'config.json');
  const configured={id:'spark',url:'http://127.0.0.1:18001',ssh:'configured-primary',ssh_fallbacks:['configured-fallback'],remote_port:8000};
  const durable={id:'spark',url:'http://127.0.0.1:18001',ssh:'durable-primary',remote_port:8000};
  const config={api_key:'fixture-key',model:'fixture-model',context_length:262144,host:'127.0.0.1',port:19000,ui_port:19010,state_file:stateFile,nodes:[configured]};
  fs.writeFileSync(configFile,JSON.stringify(config));fs.chmodSync(configFile,0o600);
  fs.writeFileSync(stateFile,JSON.stringify({version:1,sessions:{},workers:[durable]}));
  const before=fs.readFileSync(stateFile);
  const result=JSON.parse(execFileSync(process.execPath,[path.join(projectRoot,'scripts/doctor.mjs')],{cwd:projectRoot,env:{...process.env,DWARF_GATE_CONFIG:configFile},encoding:'utf8'}));
  assert.deepEqual(result.worker_registry,{present:true,configured_workers:1,durable_workers:1,configured_workers_missing:0,recovery_bindings_differ:1});
  assert.ok(result.warnings.some(warning=>warning.includes('recovery routes differ')));
  assert.ok(!JSON.stringify(result).includes('configured-primary'));assert.ok(!JSON.stringify(result).includes('configured-fallback'));assert.ok(!JSON.stringify(result).includes('durable-primary'));
  assert.deepEqual(fs.readFileSync(stateFile),before);
});
