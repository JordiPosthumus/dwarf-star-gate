import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {createSparkConnectionRepair} from './spark-connection-repair.mjs';
import {createSparkDiscovery,sparkIdentity} from './spark-discovery.mjs';
import {inspectNewSpark} from './spark-enrollment.mjs';
import {createSparkSetupTools} from './spark-setup-transport.mjs';
import {assertDashboardIdle} from './service-control.mjs';
import http from 'node:http';



const sha=b=>createHash('sha256').update(b).digest('hex');
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'sg-connection-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const knownHosts=path.join(root,'known_hosts');fs.writeFileSync(knownHosts,'retained fixture pin\n',{mode:0o600});
  const facts={system:'Linux',architecture:'aarch64',machine_id:'a'.repeat(64),gpus:[{name:'NVIDIA GB10',uuid:'GPU-'+'a'.repeat(32)}]};
  const proof={scan_id:randomUUID(),connection:'FixtureSpark',identity:sparkIdentity(facts),host:'192.0.2.10',username:'owner',knownHosts,known_hosts_sha256:sha(fs.readFileSync(knownHosts)),scan_sha256:'b'.repeat(64),observed_at:'2026-09-27T00:00:00Z'};
  assert.ok(proof.identity);
  const f={root,facts,proof,inspections:[],promotions:[],input:{repair_id:randomUUID(),connection:'FixtureSpark'}};
  f.options={directory:path.join(root,'repairs'),discovery:{configuredConnections:async()=>['FixtureSpark'],connectionProof:async()=>structuredClone(proof)},
    inspect:async(alias,options)=>{f.inspections.push({alias,options});return facts;},promote:async input=>{f.promotions.push(input);return {changed:true,keys:1,added_sha256:'c'.repeat(64)};}};
  f.controller=createSparkConnectionRepair(f.options);return f;
}

test('repair verifies pinned identity before promotion and ordinary strict identity afterward, preserving the alias',async t=>{
  const f=fixture(t),overview=await f.controller.status();assert.equal(overview.connections[0].scan_id,f.proof.scan_id);assert.equal(f.inspections.length,0);
  const r=await f.controller.repair(f.input);assert.equal(r.state,'complete');assert.equal(r.stage,'verified_connection');assert.equal(r.normal_trust_changed,true);
  assert.equal(f.inspections.length,2);assert.equal(f.inspections[0].options.knownHosts,f.proof.knownHosts);assert.equal(f.inspections[1].options.knownHosts,undefined);
  assert.ok(f.inspections.every(i=>i.alias==='FixtureSpark'&&i.options.strict));assert.equal(f.promotions[0].ssh,'FixtureSpark');assert.equal(f.promotions[0].configuredAlias,true);
  assert.equal(fs.statSync(path.join(f.options.directory,f.input.repair_id+'.json')).mode&0o777,0o600);
  assert.deepEqual(await createSparkConnectionRepair(f.options).repair(f.input),r);assert.equal(f.promotions.length,1);assert.equal(f.inspections.length,2);
});

test('failed pinned inspection and different hardware cannot change trust',async t=>{
  const f=fixture(t);f.options.inspect=async()=>{throw Object.assign(Error('private stderr'),{discovery_reason:'authentication_unavailable'});};
  let c=createSparkConnectionRepair(f.options),r=await c.repair(f.input);assert.equal(r.state,'failed');assert.equal(r.diagnostic.kind,'authentication_unavailable');assert.doesNotMatch(JSON.stringify(r),/private stderr/);assert.equal(f.promotions.length,0);
  f.options.inspect=async()=>({...f.facts,machine_id:'d'.repeat(64)});c=createSparkConnectionRepair(f.options);r=await c.repair({...f.input,repair_id:randomUUID()});assert.equal(r.state,'failed');assert.match(r.error,/identity differs/);assert.equal(f.promotions.length,0);
});

test('configuration or saved pin drift during preflight cannot change normal trust',async t=>{
  const f=fixture(t);f.options.inspect=async()=>{fs.appendFileSync(f.proof.knownHosts,'changed\n');return f.facts;};
  const r=await createSparkConnectionRepair(f.options).repair(f.input);assert.equal(r.state,'failed');assert.match(r.error,/evidence changed/);assert.equal(f.promotions.length,0);
});

test('uncertain promotion survives restart and only a read-only normal-path check can reconcile it',async t=>{
  const f=fixture(t);f.options.promote=async()=>{f.promotions.push('uncertain append');throw Error('acknowledgment unavailable');};
  let c=createSparkConnectionRepair(f.options),r=await c.repair(f.input);assert.equal(r.state,'verification_pending');assert.equal(r.normal_trust_changed,null);assert.equal(f.promotions.length,1);
  c=createSparkConnectionRepair(f.options);await assert.rejects(c.repair({...f.input,repair_id:randomUUID()}),/existing repair_id/);
  const reads=f.inspections.length;r=await c.repair(f.input);assert.equal(r.state,'complete');assert.equal(r.reconciled_read_only,true);assert.equal(f.promotions.length,1);assert.equal(f.inspections.length,reads+1);assert.equal(f.inspections.at(-1).options.knownHosts,undefined);
});

test('process exit during promotion is never mistaken for a safe replay',async t=>{
  const f=fixture(t);f.options.promote=async()=>{throw Error('lost');};await createSparkConnectionRepair(f.options).repair(f.input);
  const file=path.join(f.options.directory,f.input.repair_id+'.json'),row=JSON.parse(fs.readFileSync(file));fs.writeFileSync(file,JSON.stringify({...row,state:'running'}));
  f.options.inspect=async()=>{throw Object.assign(Error('unreachable'),{discovery_reason:'connection_unavailable'});};
  const c=createSparkConnectionRepair(f.options);assert.equal((await c.status({repair_id:f.input.repair_id})).state,'observation_lost');const r=await c.repair(f.input);assert.equal(r.state,'verification_pending');assert.equal(r.diagnostic.stage,'normal_identity');
});

test('concurrent repairs expose the original handle and never start a second promotion',async t=>{
  const f=fixture(t);let release;f.options.discovery.connectionProof=()=>new Promise(r=>release=()=>r(f.proof));const c=createSparkConnectionRepair(f.options),first=c.repair(f.input);
  assert.equal(c.busy(),true);const duplicate=await c.repair({...f.input,repair_id:randomUUID()});assert.equal(duplicate.repair_id,f.input.repair_id);assert.equal(duplicate.state,'running');
  f.options.discovery.connectionProof=async()=>f.proof;release();assert.equal((await first).state,'complete');assert.equal(f.promotions.length,1);assert.equal(c.busy(),false);
});

test('retained connection proof selects authenticated matching hardware, never the newest unauthenticated key',async t=>{
  const f=fixture(t),dir=path.join(f.root,'scans');fs.mkdirSync(dir,{mode:0o700});let destination=f.proof.host;
  const save=(at,verified=true,identity=f.proof.identity)=>{const id=randomUUID(),folder=path.join(dir,id);fs.mkdirSync(folder,{mode:0o700});fs.writeFileSync(path.join(folder,'known_hosts'),'fixture pin',{mode:0o600});fs.writeFileSync(path.join(folder,'result.json'),JSON.stringify({scan_id:id,state:'complete',observed_at:at,configured_aliases:['FixtureSpark'],known_hosts:verified?[{ssh:'FixtureSpark',identity,destination:f.proof.host}]:[]}));return id;};
  save('2026-09-26T00:00:00Z');const verified=save('2026-09-27T00:00:00Z');save('2026-09-27T03:00:00Z',false);
  const d=createSparkDiscovery({directory:dir,aliases:async()=>['FixtureSpark'],resolve:async()=>({hostname:destination,username:'owner'})});
  assert.equal((await d.connectionProof('FixtureSpark')).scan_id,verified);await assert.rejects(d.connectionProof('Unknown'),/existing configured/);
  destination='192.0.2.11';await assert.rejects(d.connectionProof('FixtureSpark'),/No retained/);destination=f.proof.host;
  save('2026-09-25T00:00:00Z',true,'f'.repeat(64));await assert.rejects(d.connectionProof('FixtureSpark'),/identities conflict/);
});

test('strict ordinary connection check forbids implicit host-key updates and reused control sessions',async()=>{
  let argv;await inspectNewSpark('FixtureSpark',{strict:true,command:async(_cmd,args)=>{argv=args;return {stdout:JSON.stringify({home:'/home/fixture'})};}});
  for(const flag of ['StrictHostKeyChecking=yes','UpdateHostKeys=no','ControlMaster=no','ControlPath=none'])assert.ok(argv.includes(flag),flag);
  await assert.rejects(inspectNewSpark('FixtureSpark',{strict:true,command:async()=>{throw {stderr:'No route to host'};}}),e=>e.discovery_reason==='connection_unavailable');
});

test('connection tools obey the existing capability and testing gates while receipts remain readable',async()=>{
  let enabled=false,testing=false,repairs=0;
  const c=createSparkSetupTools({ui_worker_management:true,spark_setup:{enabled:true,targets:{}}},{isEnabled:()=>enabled,isTesting:()=>testing,connectionRepair:{busy:()=>true,status:async()=>({state:'complete'}),repair:async()=>{repairs++;return {state:'complete'};}}});
  assert.equal((await c.tool({action:'connection_status'})).state,'complete');assert.equal(c.connectionBusy(),true);
  await assert.rejects(c.tool({action:'repair_connection'}),/switched off/);enabled=true;testing=true;await assert.rejects(c.tool({action:'repair_connection'}),/testing mode/);assert.equal(repairs,0);
  testing=false;assert.equal((await c.tool({action:'repair_connection'})).state,'complete');assert.equal(repairs,1);
});

test('dashboard restart waits for connection work even when chat is idle',async()=>{
  await assert.rejects(assertDashboardIdle({port:30000},{fetchImpl:async url=>new Response(JSON.stringify(url.endsWith('/spark-connections')?{busy:true}:url.endsWith('/chat')?{conversations:[]}:url.endsWith('/power')?{enabled:false}:{busy:false}),{status:200})}),/connection repair is running/);
});
