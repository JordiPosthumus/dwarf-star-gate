import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {diagnoseSparkConnection,sshAuthenticationEvidence} from './spark-connection-diagnosis.mjs';
import {sparkIdentity} from './spark-discovery.mjs';
import {createSparkSetupTools} from './genie-spark-setup.mjs';
import http from 'node:http';
import {hermesProvider} from './genie-hermes.mjs';
import {GenieChat} from './genie-chat.mjs';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
function fixture(t){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'sg-auth-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const knownHosts=path.join(directory,'known_hosts'),key=path.join(directory,'configured key');
  fs.writeFileSync(knownHosts,'retained pin',{mode:0o600});fs.writeFileSync(key,'not-a-real-private-key',{mode:0o600});
  const facts={home:'/home/fixture',system:'Linux',architecture:'aarch64',machine_id:'a'.repeat(64),gpus:[{name:'NVIDIA GB10',uuid:'GPU-'+'a'.repeat(32)}]};
  const proof={connection:'FixtureSpark',host:'192.0.2.10',username:'owner',identity:sparkIdentity(facts),knownHosts,known_hosts_sha256:sha(fs.readFileSync(knownHosts)),scan_id:'retained-scan',observed_at:'retained-time'};
  const f={directory,knownHosts,key,facts,proof,calls:[],stderr:'',fail:false,rechecks:0};
  f.options={env:{SSH_AUTH_SOCK:'/fixture/agent'},home:directory,discovery:{connectionProof:async connection=>{assert.equal(connection,'FixtureSpark');f.rechecks++;return {...proof};}},command:async(name,args)=>{
    assert.equal(name,'ssh');f.calls.push(args);
    if(args[0]==='-G')return {stdout:`hostname 192.0.2.10\nuser owner\nidentityfile ${key}\nidentityfile ${directory}/missing\nidentitiesonly no\n`};
    if(f.fail)throw Object.assign(Error('raw sensitive error'),{stderr:f.stderr});
    return {stdout:JSON.stringify(f.facts),stderr:f.stderr};
  }};
  f.inspect=()=>diagnoseSparkConnection({connection:'FixtureSpark'},f.options);return f;
}
test('strict pinned authentication diagnosis proves connection identity without any write or exposing raw logs',async t=>{
  const f=fixture(t);f.stderr='Host is known and matches the ED25519 host key.\nOffering public key: PRIVATE-REFERENCE\nServer accepts key: PRIVATE-REFERENCE\nAuthenticated to fixture using "publickey".\n';
  const before=fs.readFileSync(f.knownHosts);const r=await f.inspect();
  assert.equal(r.connection_state,'verified_connection');assert.equal(r.hardware_identity_verified,true);assert.equal(r.ssh.authenticated,true);
  assert.deepEqual(r.local.configured_keys,[{index:0,state:'readable',permissions:'600'},{index:1,state:'missing'}]);
  assert.equal(r.service_state,'not_observed');assert.equal(r.physical_access_required,null);
  for(const flag of ['StrictHostKeyChecking=yes','UpdateHostKeys=no','GlobalKnownHostsFile=/dev/null','ControlMaster=no','ControlPath=none','KnownHostsCommand=none','VerifyHostKeyDNS=no','BatchMode=yes'])assert.ok(f.calls[1].includes(flag));
  assert.ok(f.calls[1].includes('UserKnownHostsFile='+f.knownHosts));assert.equal(f.calls[1][0],'-vv');
  assert.deepEqual(fs.readFileSync(f.knownHosts),before);assert.equal(fs.readdirSync(f.directory).length,2);
  assert.doesNotMatch(JSON.stringify(r),/PRIVATE-REFERENCE|not-a-real-private-key|configured key|raw sensitive/);
});
test('rejected credentials remain an undetermined cause; signing and missing keys stay distinguishable',async t=>{
  const f=fixture(t);f.fail=true;f.stderr='Host is known and matches the RSA host key.\nagent returned 0 keys\nOffering public key: hidden\nAuthentications that can continue: publickey,password\nPermission denied (publickey,password).';
  const r=await f.inspect();assert.equal(r.connection_state,'authentication_unavailable');assert.equal(r.cause,'undetermined');assert.equal(r.physical_access_required,null);
  assert.equal(r.ssh.keys_offered,1);assert.equal(r.ssh.agent_identity_count,0);assert.equal(r.ssh.server_accepted_key,false);assert.equal(r.ssh.authentication_rejected,true);assert.deepEqual(r.ssh.server_authentication_methods,['publickey','password']);
  assert.equal(sshAuthenticationEvidence('Server accepts key: hidden\nsign_and_send_pubkey: signing failed: agent refused operation').signing_failed,true);
  assert.equal(sshAuthenticationEvidence('').agent_identity_count,null);
});
test('unreachable transport, changed hardware and changed pinned evidence do not become verified connections',async t=>{
  const f=fixture(t);f.fail=true;f.stderr='No route to host';
  assert.equal((await f.inspect()).connection_state,'connection_unavailable');
  f.fail=false;f.facts={...f.facts,machine_id:'b'.repeat(64)};assert.equal((await f.inspect()).connection_state,'hardware_identity_mismatch');
  fs.writeFileSync(f.knownHosts,'changed pin');const calls=f.calls.length;await assert.rejects(f.inspect(),/changed/);assert.equal(f.calls.length,calls);
});
test('destination changes, extra input, missing local config and concurrent proof changes fail closed',async t=>{
  const f=fixture(t);
  await assert.rejects(diagnoseSparkConnection({connection:'FixtureSpark',password:'secret'},f.options),/no credentials/);assert.equal(f.calls.length,0);
  f.proof.host='192.0.2.11';await assert.rejects(f.inspect(),/destination/);assert.equal(f.calls.length,1);
  f.options.command=async()=>{throw Error('raw secret');};const unavailable=await f.inspect();assert.equal(unavailable.state,'unavailable');assert.doesNotMatch(JSON.stringify(unavailable),/raw secret/);
  const g=fixture(t);g.options.discovery.connectionProof=async()=>({...g.proof,scan_id:++g.rechecks===1?'first':'changed'});
  await assert.rejects(g.inspect(),/changed during/);
});
test('read-only diagnosis follows inspection permission independently from mutation permission',async()=>{
  let inspection=true,testing=false,calls=0;
  const tools=createSparkSetupTools({ui_worker_management:true,spark_setup:{enabled:true}},{isEnabled:()=>false,isDiscoveryEnabled:()=>inspection,isTesting:()=>testing,connectionRepair:{inspect:async input=>{calls++;return {connection:input.connection,state:'observed'};}}});
  assert.equal((await tools.tool({action:'inspect_connection',connection:'FixtureSpark'})).state,'observed');
  inspection=false;await assert.rejects(tools.tool({action:'inspect_connection',connection:'FixtureSpark'}),/switched off/);
  inspection=true;testing=true;await assert.rejects(tools.tool({action:'inspect_connection',connection:'FixtureSpark'}),/testing mode/);assert.equal(calls,1);
});

test('installed Hermes diagnoses through the real tool registry and preserves its diagnostic receipt',{skip:!process.env.DSG_TEST_HERMES_SOURCE||!process.env.DSG_TEST_HERMES_PYTHON},async t=>{
  const f=fixture(t);f.fail=true;f.stderr='Offering public key: private-reference\nPermission denied (publickey,password).';let calls=0;
  const tools=createSparkSetupTools({ui_worker_management:true,spark_setup:{enabled:true}},{connectionRepair:{inspect:input=>diagnoseSparkConnection(input,f.options)}});
  const server=http.createServer((req,res)=>{
    if(tools.handle(req,res))return;
    if(req.method==='GET'){res.end(JSON.stringify({data:[{id:'fixture'}]}));return;}
    let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{
      if(req.url!=='/v1/chat/completions'){res.end('{}');return;}calls++;if(calls===2)assert.ok(raw.includes('authentication_unavailable'),JSON.stringify(JSON.parse(raw).messages.slice(-2)));
      const message=calls===1?{role:'assistant',content:null,tool_calls:[{id:'diagnosis',type:'function',function:{name:'tool_call',arguments:JSON.stringify({name:'inspect_spark_connection',arguments:{connection:'FixtureSpark'}})}}]}:{role:'assistant',content:'Authentication failed. Its cause is undetermined; physical access is not established.'};
      const delta={...message,...(message.tool_calls?{tool_calls:message.tool_calls.map((v,index)=>({...v,index}))}:{})};
      res.setHeader('content-type','text/event-stream');res.end('data: '+JSON.stringify({id:'fixture',model:'fixture',choices:[{index:0,delta,finish_reason:null}]})+'\n\ndata: '+JSON.stringify({id:'fixture',model:'fixture',choices:[{index:0,delta:{},finish_reason:calls===1?'tool_calls':'stop'}]})+'\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));tools.bind(server.address().port);
  const provider=hermesProvider({python:process.env.DSG_TEST_HERMES_PYTHON,source:process.env.DSG_TEST_HERMES_SOURCE,url:`http://127.0.0.1:${server.address().port}/v1`,model:'fixture',spark_setup:tools.toolConfig},{directory:f.directory});
  const directory=path.join(f.directory,'chat'),chat=new GenieChat({directory,provider,getSnapshot:()=>({gateway:{}})});
  t.after(()=>{chat.close();server.closeAllConnections();server.close();});
  const c=chat.create();chat.submit(c.id,'Find why the enrolled connection is failing.','fixture-auth-request');await chat.idle();
  const reply=chat.get(c.id).messages.at(-1);assert.equal(reply.state,'complete',JSON.stringify(reply));assert.equal(calls,2);
  const event=reply.spark_setup.events.find(e=>e.state==='complete');assert.equal(event.tool,'inspect_spark_connection');assert.equal(event.result.cause,'undetermined');assert.equal(event.result.ssh.keys_offered,1);
  assert.deepEqual(new GenieChat({directory,provider}).get(c.id).messages.at(-1).spark_setup,reply.spark_setup);

});
