import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
import {createSparkEnrollment} from './spark-enrollment.mjs';
import {createSparkSetupTools} from './genie-spark-setup.mjs';
import {SparkSetupWatch} from './spark-setup-watch.mjs';
import {capabilityStatus} from './genie-capability-status.mjs';
const details={target_id:'spark-new',host:'192.0.2.10',username:'owner'};
const facts={home:'/srv/fixture-home',system:'Linux',architecture:'aarch64',python:[3,12,3],docker_arch:'arm64',gpu:'NVIDIA GB10',gpu_processes:'',free_bytes:1000000000000};
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
