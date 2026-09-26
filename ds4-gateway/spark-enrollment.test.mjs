import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
import {createSparkEnrollment,inspectNewSpark} from './spark-enrollment.mjs';
import {sparkIdentity} from './spark-discovery.mjs';
import {createSparkSetupTools} from './genie-spark-setup.mjs';
import {SparkSetupWatch} from './spark-setup-watch.mjs';
import {capabilityStatus} from './genie-capability-status.mjs';
const details={target_id:'spark-new',host:'192.0.2.10',username:'owner'};
const facts={home:'/srv/fixture-home',system:'Linux',architecture:'aarch64',python:[3,12,3],docker_arch:'arm64',gpu:'NVIDIA GB10',gpu_processes:'',free_bytes:1000000000000};
const hardware={...facts,machine_id:'a'.repeat(64),gpus:[{name:'NVIDIA GB10',uuid:'GPU-'+'a'.repeat(32)}]};
const discovered={target_id:'spark-new',scan_id:'00000000-0000-4000-8000-000000000000',candidate_id:sparkIdentity(hardware)};
function fixture(t){const directory=fs.mkdtempSync(path.join(os.tmpdir(),'sg-enroll-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));const calls=[];const options={directory,resolve:async ssh=>ssh.split('@').at(-1),inspect:async ssh=>{calls.push(ssh);return facts;}};return {directory,calls,options,enrollment:createSparkEnrollment(options)};}
test('chat enrolls an inspected host durably and setup sees it immediately without restarting',async t=>{
 const f=fixture(t),config={ui_worker_management:true,spark_setup:{enabled:true,targets:{}}};let watch;
 const tools=createSparkSetupTools(config,{enrollment:f.enrollment,transport:async()=>({state:'not_started'}),continuation:{request:id=>watch.request(id),status:id=>watch.status(id)}});
 watch=new SparkSetupWatch({filename:path.join(f.directory,'requests.json'),targets:tools.targets,chat:{},read:async()=>{},isEnabled:()=>true});
 const row=await tools.tool({action:'enroll',...details});assert.equal(row.readiness,'prerequisites_observed');assert.equal(row.target.ssh,'owner@192.0.2.10');assert.equal(row.target.directory,'/srv/fixture-home/.local/share/star-gate/spark-setup/spark-new');
 assert.equal((await tools.tool({action:'setup',target_id:details.target_id})).state,'requested');
 assert.equal((await tools.tool({action:'status'})).targets[0].target_id,details.target_id);
 const again=createSparkEnrollment(f.options);assert.deepEqual(again.targets,f.enrollment.targets);
 await again.enroll(details);assert.equal(f.calls.length,1,'Repeated acceptance must not reconnect or start anything');
 assert.equal(fs.statSync(path.join(f.directory,'targets.json')).mode&0o777,0o600);
 await assert.rejects(again.enroll({...details,host:'192.0.2.11'}),/another SSH/);
});
test('existing worker and SSH destinations are preserved, including a configured alias',async t=>{
 const f=fixture(t);const enrollment=createSparkEnrollment({...f.options,workers:async()=>[{id:'existing',ssh:'personal-alias'}],resolve:async ssh=>ssh==='personal-alias'?'192.0.2.10':ssh.split('@').at(-1)});
 await assert.rejects(enrollment.enroll({...details,target_id:'existing'}),/already belongs/);
 await assert.rejects(enrollment.enroll(details),/already enrolled or serving/);assert.equal(f.calls.length,0);assert.equal(fs.existsSync(path.join(f.directory,'targets.json')),false);
});
test('failed SSH and non-Spark hosts do not enroll; missing Docker is reported without changing the host',async t=>{
 const f=fixture(t);await assert.rejects(createSparkEnrollment({...f.options,inspect:async()=>{throw Error('SSH key access missing');}}).enroll(details),/SSH key/);
 await assert.rejects(createSparkEnrollment({...f.options,inspect:async()=>({...facts,gpu:'Other GPU'})}).enroll(details),/did not identify/);
 assert.deepEqual(f.enrollment.targets,{});
 const row=await createSparkEnrollment({...f.options,inspect:async()=>({...facts,docker_arch:null,gpu_processes:'123',free_bytes:1000})}).enroll(details);
 assert.equal(row.readiness,'needs_attention');assert.equal(row.issues.length,3);assert.match(row.issues.join(' '),/leave it running/);
});
test('enrollment obeys capability and testing switches, rejects command-like input and is visible before any target exists',async t=>{
 const f=fixture(t);let enabled=false,testing=false;
 const tools=createSparkSetupTools({ui_worker_management:true,spark_setup:{enabled:true}},{enrollment:f.enrollment,isEnabled:()=>enabled,isTesting:()=>testing});
 await assert.rejects(tools.tool({action:'enroll',...details}),/switched off/);enabled=true;testing=true;await assert.rejects(tools.tool({action:'enroll',...details}),/testing mode/);testing=false;
 for(const patch of [{host:'-oProxyCommand=bad'},{username:'owner; command'},{target_id:'../other'},{directory:'/personal'}])await assert.rejects(tools.tool({action:'enroll',...details,...patch}),/No commands/);
 const row=capabilityStatus({gateway:{genie_capabilities:{spark_setup:true}}},{management:true,chat:{capabilities_configured:{spark_setup:true}},sparkSetup:tools.status()}).capabilities.find(r=>r.key==='spark_setup');
 assert.equal(row.connected,true);assert.equal(row.status,'Ready');assert.match(row.detail,/address and SSH username/);assert.equal(f.calls.length,0);
});
function discoveryFixture(t,extra={}){
 const f=fixture(t),sequence=[];
 const proof={...discovered,identity:discovered.candidate_id,host:details.host,username:details.username,knownHosts:path.join(f.directory,'scan-known-hosts')};
 const options={...f.options,discovery:{candidate:async input=>{assert.deepEqual(input,discovered);sequence.push('candidate');return proof;}},inspect:async(ssh,opts)=>{assert.equal(ssh,'owner@'+details.host);sequence.push(opts.knownHosts?'pinned':'normal');assert.equal(opts.strict,true);return hardware;},promote:async input=>{sequence.push('promote');assert.equal(input.knownHosts,proof.knownHosts);},...extra};
 return {...f,proof,sequence,options,enrollment:createSparkEnrollment(options)};
}
test('discovery enrollment binds saved hardware and trust before exposing a target, and repeated IDs reuse the durable result',async t=>{
 const f=discoveryFixture(t),tools=createSparkSetupTools({ui_worker_management:true,spark_setup:{enabled:true}},{enrollment:f.enrollment,transport:async()=>({state:'not_started'})});
 const result=await tools.tool({action:'enroll_discovered',...discovered});
 assert.deepEqual(f.sequence,['candidate','pinned','promote','normal']);assert.equal(result.target.identity,discovered.candidate_id);
 assert.deepEqual(result.target.discovery,{scan_id:discovered.scan_id,candidate_id:discovered.candidate_id});
 const restored=createSparkEnrollment({...f.options,discovery:{candidate:async()=>{throw Error('Must not rescan or reselect accepted enrollment');}}});
 assert.equal((await restored.enrollDiscovered(discovered)).state,'enrolled');assert.equal(f.sequence.length,4);
 await assert.rejects(restored.enrollDiscovered({...discovered,candidate_id:'b'.repeat(64)}),/different enrollment/);
 assert.equal((await tools.tool({action:'status'})).targets.length,1);
});
test('changed hardware or host key prevents promotion; an uncertain normal transport never saves a target',async t=>{
 for(const failure of ['identity','key','normal']){
  let promoted=0,calls=0;const f=discoveryFixture(t,{promote:async()=>{promoted++;},inspect:async()=>{calls++;if(failure==='key'||failure==='normal'&&calls===2)throw Error('SSH unverified');return failure==='identity'?{...hardware,machine_id:'b'.repeat(64)}:hardware;}});
  await assert.rejects(f.enrollment.enrollDiscovered(discovered),failure==='identity'?/no longer matches/:failure==='normal'?/Normal SSH verification was not confirmed/:/SSH unverified/);
  assert.equal(promoted,failure==='normal'?1:0);assert.equal(fs.existsSync(path.join(f.directory,'targets.json')),false);assert.deepEqual(f.enrollment.targets,{});
 }
});
test('duplicate hardware, conflicting destinations, invalid IDs and disabled setup cannot enroll a discovered candidate',async t=>{
 const f=discoveryFixture(t,{targets:{prior:{ssh:'another-address',directory:'/srv/prior',identity:discovered.candidate_id}}});
 await assert.rejects(f.enrollment.enrollDiscovered(discovered),/hardware identity is already enrolled/);assert.deepEqual(f.sequence,['candidate']);
 const g=discoveryFixture(t),tools=createSparkSetupTools({ui_worker_management:true,spark_setup:{enabled:true}},{enrollment:g.enrollment,isEnabled:()=>false,isDiscoveryEnabled:()=>true});
 await assert.rejects(tools.tool({action:'enroll_discovered',...discovered}),/switched off/);assert.equal(g.sequence.length,0);
 for(const patch of [{host:details.host},{scan_id:'../escape'},{candidate_id:undefined},{target_id:'../escape'}])await assert.rejects(g.enrollment.enrollDiscovered({...discovered,...patch}),/no addresses or credentials/);
 assert.equal(g.sequence.length,0);
});
test('pinned inspection cannot accept a global/DNS key or reuse a previously connected control socket',async t=>{
 const f=fixture(t),knownHosts=path.join(f.directory,'receipt');let args;
 const observed=await inspectNewSpark('owner@'+details.host,{directory:f.directory,knownHosts,command:async(command,input)=>{assert.equal(command,'ssh');args=input;return {stdout:JSON.stringify(hardware)};}});
 assert.equal(sparkIdentity(observed),discovered.candidate_id);
 for(const option of ['UserKnownHostsFile='+knownHosts,'StrictHostKeyChecking=yes','GlobalKnownHostsFile=/dev/null','VerifyHostKeyDNS=no','UpdateHostKeys=no','ControlMaster=no','ControlPath=none'])assert.ok(args.includes(option));
 assert.equal(args.includes('StrictHostKeyChecking=accept-new'),false);assert.equal(fs.readdirSync(f.directory).length,0);
});
