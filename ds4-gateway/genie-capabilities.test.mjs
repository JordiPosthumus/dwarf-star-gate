import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createGateway} from './gateway.mjs';
import {workerControl} from './worker-client.mjs';
import {createDashboard} from './dashboard.mjs';
import {hermesProvider} from './genie-hermes.mjs';
import {Genie} from './genie.mjs';
import {genieCapabilities} from './genie-capabilities.mjs';
import {capabilityStatus} from './genie-capability-status.mjs';

test('setup status exposes partial byte progress without claiming preparation passed',()=>{
  const target={target_id:'new-spark',state:'running',progress:{engine:'h3',phase:'verify_or_download_models'},model_download:{state:'observed',bytes_present:1e9,bytes_required:42.5e9,last_file_activity_at:'2026-09-16T12:00:00Z'}};
  const read=()=>capabilityStatus({gateway:{genie_capabilities:{spark_setup:true}}},{management:true,chat:{capabilities_configured:{spark_setup:true}},sparkSetup:{targets:[target]}}).capabilities.find(r=>r.key==='spark_setup');
  assert.equal(read().status,'Working');assert.match(read().detail,/1\.0 \/ 42\.5 GB present/);assert.match(read().detail,/File activity 2026-09-16 12:00:00 UTC/);assert.match(read().detail,/partial downloads; verification is separate/);
  target.model_download={state:'unavailable'};assert.equal(read().status,'Working');assert.match(read().detail,/download progress unavailable/);
  target.state='needs_attention';target.error='Download hash differs';assert.equal(read().status,'Needs attention');assert.match(read().detail,/Download hash differs/);
});

test('existing-worker media download exposes activity while preserving uncertainty and terminal failures',()=>{
 const setup={worker_id:'one',phase:'preparing_media',detail:'h3: verify_or_download_models.',preparation:{model_download:{state:'observed',bytes_present:13e9,bytes_required:42.5e9,last_file_activity_at:'2026-09-17T10:23:49Z'}}};
 const read=()=>capabilityStatus({gateway:{genie_capabilities:{media:true}}},{management:true,chat:{capabilities_configured:{media:true}},media:{setup:{connected:true,operations:[setup]}}}).capabilities.find(r=>r.key==='media');
 assert.equal(read().status,'Working');assert.match(read().detail,/13\.0 \/ 42\.5 GB present/);assert.match(read().detail,/2026-09-17 10:23:49 UTC/);assert.match(read().detail,/partial downloads; verification is separate/);
 setup.phase='observing_preparation';setup.detail='Status unavailable; observing original operation.';setup.preparation.model_download={state:'unavailable'};
 assert.match(read().detail,/Status unavailable/);assert.match(read().detail,/download progress unavailable/);
 setup.phase='failed_returned';setup.detail='Download failed; original LLM returned.';
 assert.equal(read().status,'Needs attention');assert.equal(read().detail,'one setup: Download failed; original LLM returned.');
 setup.phase='preparing_media';setup.preparation.model_download={state:'observed',bytes_present:13e9,bytes_required:42.5e9,last_file_activity_at:'invalid'};
 assert.match(read().detail,/13\.0 \/ 42\.5/);assert.doesNotMatch(read().detail,/File activity/);
});

test('switches persist independently through core restart and use the existing dashboard control',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sg-capabilities-'));
  const config={host:'127.0.0.1',port:0,api_key:'fixture',model:'fixture',context_length:262144,nodes:[],state_file:path.join(dir,'state.json'),control_socket:path.join(dir,'core.sock')};
  let core=createGateway(config);await core.start();
  const management={read:()=>workerControl(config.control_socket,'/workers'),act:(action,input)=>{assert.equal(action,'genie-capability');return workerControl(config.control_socket,'/genie-capability',input);}};
  const app=createDashboard(()=>({gateway:core.stats()}),undefined,management);
  await new Promise(r=>app.listen(0,'127.0.0.1',r));
  t.after(async()=>{await new Promise(r=>app.close(r));await core.close();fs.rmSync(dir,{recursive:true,force:true});});
  const base='http://127.0.0.1:'+app.address().port;
  const state=await (await fetch(base+'/api/genie/capabilities')).json();
  assert.equal(state.capabilities.length,9);
  assert.ok(state.capabilities.every(c=>c.available),'All switches work before connection');
  const send=(key,enabled)=>fetch(base+'/api/workers/genie-capability',{method:'POST',headers:{origin:base,'content-type':'application/json','x-dsg-csrf':state.csrf_token},body:JSON.stringify({key,enabled})});
  for(const key of ['hourglass','inspection','server_changes','fleet_reviews','recovery'])assert.equal((await send(key,false)).status,200,key);
  assert.equal((await send('recovery',true)).status,200);
  assert.equal(core.stats().recovery.configured,false);
  assert.equal(core.stats().recovery.automatic,true);
  assert.equal(core.stats().recovery.operations.length,0,'Policy does not enroll or start recovery');
  assert.equal((await send('rebalance',false)).status,200);
  assert.equal(core.stats().continuity.relocation.genie_enabled,false);
  assert.equal(core.stats().genie_capabilities.research,true);
  assert.equal((await send('research',false)).status,200);
  assert.equal((await send('spark_setup',true)).status,200);
  assert.equal((await send('shell',true)).status,400);
  await core.close();core=createGateway(config);await core.start();
  assert.equal(core.stats().genie_capabilities.spark_setup,true);
  assert.equal(core.stats().genie_capabilities.rebalance,false);
  assert.equal(core.stats().genie_capabilities.research,false);
  for(const key of ['hourglass','inspection','server_changes','fleet_reviews'])assert.equal(core.stats().genie_capabilities[key],false,key);
  assert.equal(core.stats().genie_capabilities.recovery,true);
  assert.equal(core.stats().recovery.configured,false);
  const after=await(await fetch(base+'/api/genie/capabilities')).json();
  assert.equal(after.capabilities.find(c=>c.key==='hourglass').status,'Off · not connected');
  assert.equal((await send('rebalance',true)).status,200);
  assert.equal(core.stats().genie_capabilities.research,false);
});

test('tool switches are checked for each new Hermes invocation without cancelling the provider',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sg-tools-policy-'));
  const shim=path.join(dir,'python-fixture');
  fs.writeFileSync(shim,'#!/usr/bin/env python3\nimport json,sys\np=json.load(sys.stdin)\nprint(json.dumps({"type":"done","text":json.dumps({k:bool(p[k]) for k in ["research","inspection","operations","hourglass"]})}))\n',{mode:0o700});
  const flags={};
  const provider=hermesProvider({python:shim,source:dir,url:'http://127.0.0.1:1/v1',model:'fixture',research:{search_url:'http://127.0.0.1:2',extract_url:'http://127.0.0.1:3'},inspection:{workers:{}},operations:{token:'fixture'},hourglass:{token:'fixture'}},{directory:path.join(dir,'chat'),isCapabilityEnabled:key=>flags[key]!==false});
  t.after(()=>{provider.close();fs.rmSync(dir,{recursive:true,force:true});});
  const invoke=async()=>JSON.parse((await provider.generate({research:true,message:'fixture',onDelta:()=>{}})).text);
  assert.deepEqual(await invoke(),{research:true,inspection:true,operations:true,hourglass:true});
  flags.research=false;flags.server_changes=false;
  assert.equal(provider.info.research_available,false);
  assert.equal(provider.info.capabilities_configured.research,true,'an off capability remains available to turn back on');
  assert.deepEqual(await invoke(),{research:false,inspection:true,operations:false,hourglass:true});
  flags.research=true;flags.inspection=false;flags.hourglass=false;
  assert.deepEqual(await invoke(),{research:true,inspection:false,operations:false,hourglass:false});
});

test('turning off routine reviews leaves urgent balancing reviews enabled',()=>{
  const snapshot={gateway:{genie_capabilities:{fleet_reviews:false},continuity:{relocation:{genie_enabled:true,genie_offers:[],diagnostics:{sources:[]}}}}};
  const g=new Genie({url:'http://127.0.0.1:1/v1',model:'fixture'},()=>snapshot);
  const calls=[];g.ask=async(_,options)=>{calls.push(options.kind);};
  g.tick();assert.deepEqual(calls,[]);
  snapshot.gateway.continuity.relocation.diagnostics.sources=[{genie_pressure:true,source:'one',request_id:'fixture',reason:'offer_ready'}];
  g.tick();assert.deepEqual(calls,['action']);g.close();
});

test('an enabled recovery switch never disguises missing service connections',()=>{
  const result=capabilityStatus({gateway:{genie_capabilities:genieCapabilities(undefined,{},true),recovery:{configured:true,automatic:true,workers:[{worker_id:'one',enrollment:{binding:'mismatch'}}]},workers:[{id:'one',is_healthy:false,quarantine:{reason:'fatal_accelerator_error'}}]}},{management:true});
  assert.equal(result.capabilities.find(r=>r.key==='recovery').status,'Not connected');
  assert.equal(result.capabilities.find(r=>r.key==='hourglass').available,true);
  assert.equal(result.capabilities.find(r=>r.key==='hourglass').connected,false);
  assert.equal(result.services[0].status,'Unavailable');
  assert.match(result.services[0].detail,/fatal accelerator error/);
  const research=capabilityStatus({gateway:{genie_capabilities:genieCapabilities(undefined,{},false)}},{management:true,chat:{capabilities_configured:{research:true}},activity:{research:{state:'failed',service:'Page extraction',error:'Service unavailable'}}});
  const row=research.capabilities.find(r=>r.key==='research');
  assert.equal(row.status,'Last attempt failed');assert.match(row.detail,/Page extraction: Service unavailable/);
});

test('partial recovery rollout names both connected and outstanding workers',()=>{
  const gateway={genie_capabilities:{},recovery:{configured:true,automatic:true,workers:[{worker_id:'one',enrollment:{binding:'matched'}},{worker_id:'two',enrollment:{binding:'mismatch'}}]}};
  const row=capabilityStatus({gateway},{management:true}).capabilities.find(r=>r.key==='recovery');
  assert.equal(row.connected,true);assert.equal(row.status,'Partly connected');
  assert.match(row.detail,/Connected: one\./);assert.match(row.detail,/needs connecting: two\./);
  gateway.recovery.automatic=false;
  const off=capabilityStatus({gateway},{management:true}).capabilities.find(r=>r.key==='recovery');
  assert.equal(off.enabled,false);assert.equal(off.status,'Off');assert.equal(off.connected,true);
});

test('a broken local recovery interpreter names the service while the model remains serving',()=>{
  const gateway={genie_capabilities:{},recovery:{configured:true,automatic:true,workers:[{worker_id:'local-model',enrollment:{binding:'matched'},reason:'adapter_local_interpreter_missing'}]},workers:[{id:'local-model',is_healthy:true}]};
  const read=()=>capabilityStatus({gateway},{management:true});
  const row=read().capabilities.find(r=>r.key==='recovery');
  assert.equal(row.status,'Needs attention');assert.equal(row.connected,true);
  assert.match(row.detail,/local-model: local recovery Python interpreter is missing/);
  assert.equal(read().services[0].status,'Serving');
  assert.match(read().services[0].detail,/Recovery: local recovery Python interpreter is missing/);
  gateway.recovery.workers[0].reason='no_supported_quarantine';
  assert.equal(read().capabilities.find(r=>r.key==='recovery').status,'Monitoring');
  assert.equal(read().services[0].detail,'');
  gateway.recovery.automatic=false;
  gateway.recovery.workers[0].reason='adapter_local_interpreter_missing';
  assert.equal(read().capabilities.find(r=>r.key==='recovery').status,'Off');
});
