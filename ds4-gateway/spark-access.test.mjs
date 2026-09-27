import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {randomUUID,createHash} from 'node:crypto';
import {SparkAccess,handleSparkAccessSettings} from './spark-access.mjs';
import {sparkIdentity} from './spark-discovery.mjs';
import {createSparkSetupTools} from './genie-spark-setup.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const facts=(id='a')=>({system:'Linux',architecture:'aarch64',machine_id:id.repeat(64),gpus:[{name:'NVIDIA GB10',uuid:`GPU-${id.repeat(32)}`}]});
function fixture(t,{count=1,known=[],transport={}}={}){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'sg-access-'));
  const knownHosts=path.join(directory,'scan_hosts');fs.writeFileSync(knownHosts,'# private fixture\n',{mode:0o600});
  let enabled=true,testing=false,now=100000;
  const calls=[],proof={scan_id:randomUUID(),knownHosts,known_hosts_sha256:hash(fs.readFileSync(knownHosts)),known_identities:known,
    endpoints:Array.from({length:count},(_,n)=>({endpoint_id:hash('endpoint-'+n),host:[10,27,0,n+2].join('.'),username:'owner'}))};
  const discovery={accessCandidates:async()=>structuredClone(proof)};
  const underlying={key:async()=>({public_key:'ssh-ed25519 Zml4dHVyZQ==',fingerprint:'SHA256:fixture'}),inspect:async()=>facts(),install:async()=>({state:'key_installed',changed:true}),verify:async()=>facts(),...transport};
  const wrapped=Object.fromEntries(Object.keys(underlying).map(name=>[name,async(...args)=>{calls.push({name,args});return underlying[name](...args);} ]));
  const options={directory:path.join(directory,'access'),discovery,transport:wrapped,isEnabled:()=>enabled,isTesting:()=>testing,now:()=>now};
  const access=new SparkAccess(options);
  t.after(async()=>{access.close();await access.settled();fs.rmSync(directory,{recursive:true,force:true});});
  const request=()=>access.request({scan_id:proof.scan_id,endpoint_ids:proof.endpoints.map(e=>e.endpoint_id)});
  const grant=(id,password='private-fixture-secret')=>access.authorize({access_id:id,username:'owner',password});
  return {access,options,proof,calls,underlying,directory,request,grant,enable:value=>enabled=value,test:value=>testing=value,advance:value=>now+=value};
}
const run=async(f,id)=>{await f.access.begin({access_id:id});await f.access.settled();return f.access.status({access_id:id});};

test('saved endpoint request and local grant are inert, secret-free, bounded and idempotent',async t=>{
  const f=fixture(t),first=await f.request();assert.equal(first.state,'credentials_required');assert.equal(f.calls.length,0);
  assert.equal((await f.request()).access_id,first.access_id);
  const authorized=f.grant(first.access_id);assert.equal(authorized.credential_available,true);assert.equal(f.calls.length,0);
  assert.equal(fs.statSync(f.access.file).mode&0o777,0o600);
  assert.doesNotMatch(fs.readFileSync(f.access.file,'utf8'),/private-fixture-secret/);
  assert.doesNotMatch(JSON.stringify(f.access.status()),/private-fixture-secret|scan_hosts|public_key/);
  for(const extra of [{password:'no'},{host:'elsewhere'}])await assert.rejects(f.access.request({scan_id:f.proof.scan_id,endpoint_ids:[f.proof.endpoints[0].endpoint_id],...extra}));
  await assert.rejects(f.access.request({scan_id:f.proof.scan_id,endpoint_ids:['a'.repeat(64)]}));
});
test('successful access proves hardware before key installation and key-only identity afterward',async t=>{
  const f=fixture(t),{access_id}=await f.request();f.grant(access_id);
  const result=await run(f,access_id);assert.equal(result.state,'complete');assert.equal(result.endpoints[0].identity,sparkIdentity(facts()));
  assert.equal(result.credential_available,false);assert.equal(result.endpoints[0].key_change,true);
  assert.deepEqual(f.calls.map(c=>c.name),['key','inspect','install','verify']);
  assert.equal(f.calls[2].args[2].operation_id,access_id);assert.equal(f.calls[2].args[2].identity,sparkIdentity(facts()));
  await run(f,access_id);assert.equal(f.calls.length,4);
  assert.doesNotMatch(fs.readFileSync(f.access.file,'utf8'),/private-fixture-secret/);
});
test('known hardware and non-Sparks never get a key installed',async t=>{
  for(const spec of [{known:[sparkIdentity(facts())],state:'existing_machine'},{transport:{inspect:async()=>({...facts(),architecture:'x86_64'})},state:'blocked'}]){
    const f=fixture(t,spec),{access_id}=await f.request();f.grant(access_id);const result=await run(f,access_id);
    assert.equal(result.endpoints[0].state,spec.state);assert.equal(f.calls.filter(c=>c.name==='install').length,0);
  }
});
test('two addresses of the same new machine install once and retain both observations',async t=>{
  const f=fixture(t,{count:2}),{access_id}=await f.request();f.grant(access_id);const result=await run(f,access_id);
  assert.equal(result.state,'complete');assert.deepEqual(result.endpoints.map(e=>e.state),['key_ready','same_verified_machine']);
  assert.equal(f.calls.filter(c=>c.name==='install').length,1);
});
test('switch off, testing mode, expired and revoked grants prevent new native work',async t=>{
  const f=fixture(t),{access_id}=await f.request();f.grant(access_id);f.enable(false);
  await assert.rejects(f.access.begin({access_id}),/switched off/);f.enable(true);f.test(true);
  await assert.rejects(f.access.begin({access_id}),/testing/);f.test(false);f.advance(16*60*1000);
  assert.equal((await run(f,access_id)).state,'credentials_required');assert.equal(f.calls.length,0);
  f.grant(access_id);f.access.revoke(access_id);await run(f,access_id);assert.equal(f.calls.length,0);
});
test('grant revocation during inspection prevents installation but preserves observed hardware',async t=>{
  const f=fixture(t),{access_id}=await f.request();f.grant(access_id);
  f.underlying.inspect=async()=>{f.access.revoke(access_id);return facts();};
  const result=await run(f,access_id);assert.equal(result.endpoints[0].identity,sparkIdentity(facts()));assert.equal(result.endpoints[0].state,'permission_paused');
  assert.equal(f.calls.filter(c=>c.name==='install').length,0);
});
test('topology and host-key evidence are revalidated before any remote write',async t=>{
  const f=fixture(t),{access_id}=await f.request();f.grant(access_id);fs.appendFileSync(f.proof.knownHosts,'changed\n');
  assert.equal((await run(f,access_id)).endpoints[0].reason,'scan_host_keys_changed');assert.equal(f.calls.length,0);
  const g=fixture(t),second=await g.request();g.grant(second.access_id);g.underlying.inspect=async()=>{g.proof.endpoints=[];return facts();};
  await run(g,second.access_id);assert.equal(g.calls.filter(c=>c.name==='install').length,0);
});
test('wrong password can be corrected locally, but never retried without a fresh grant',async t=>{
  const f=fixture(t),{access_id}=await f.request();f.grant(access_id);
  f.underlying.inspect=async()=>{throw Error('raw secret private-fixture-secret');};
  let result=await run(f,access_id);assert.equal(result.state,'credentials_required');assert.equal(result.credential_available,false);
  assert.doesNotMatch(JSON.stringify(result),/private-fixture-secret/);const before=f.calls.length;await run(f,access_id);assert.equal(f.calls.length,before);
  f.underlying.inspect=async()=>facts();f.grant(access_id,'corrected-fixture-secret');result=await run(f,access_id);assert.equal(result.state,'complete');
});
test('lost installation acknowledgement is resolved with key-only observation, never a replay',async t=>{
  const f=fixture(t,{transport:{install:async()=>{throw Error('lost reply');},verify:async()=>{throw Error('offline');}}}),{access_id}=await f.request();f.grant(access_id);
  assert.equal((await run(f,access_id)).state,'verification_pending');assert.throws(()=>f.grant(access_id),/no unstarted/);
  f.underlying.verify=async()=>facts();assert.equal((await run(f,access_id)).state,'complete');assert.equal(f.calls.filter(c=>c.name==='install').length,1);
});
test('restart during installation discards the password and verifies without repeating the write',async t=>{
  const f=fixture(t),{access_id}=await f.request();f.grant(access_id);
  const op=f.access.operations[access_id];op.state='running';op.endpoints[0].state='key_installing';op.endpoints[0].identity=sparkIdentity(facts());f.access.save();
  const restored=new SparkAccess(f.options);t.after(()=>restored.close());assert.equal(restored.status({access_id}).credential_available,false);
  await restored.begin({access_id});await restored.settled();assert.equal(restored.status({access_id}).state,'complete');assert.deepEqual(f.calls.map(c=>c.name),['verify']);
});
test('restart forgets an unused local grant and malformed receipts are preserved without native calls',async t=>{
  const f=fixture(t),{access_id}=await f.request();f.grant(access_id);
  const restored=new SparkAccess(f.options);assert.equal(restored.status({access_id}).state,'credentials_required');assert.equal(restored.status({access_id}).credential_available,false);restored.close();
  const data=JSON.parse(fs.readFileSync(f.access.file));data[access_id].endpoints[0].host='unexpected-host';const bytes=JSON.stringify(data);fs.writeFileSync(f.access.file,bytes);
  const invalid=new SparkAccess(f.options);assert.equal(invalid.status().available,false);assert.equal(fs.readFileSync(f.access.file,'utf8'),bytes);assert.equal(f.calls.length,0);invalid.close();
});
test('actual setup tool dispatch accepts only IDs and preserves independent status reads',async t=>{
  const f=fixture(t);let enabled=true;
  const tools=createSparkSetupTools({ui_worker_management:true,spark_setup:{enabled:true}},{access:f.access,isEnabled:()=>enabled});
  const request={action:'request_access',scan_id:f.proof.scan_id,endpoint_ids:f.proof.endpoints.map(e=>e.endpoint_id)};
  const {access_id}=await tools.tool(request);assert.equal(f.calls.length,0);
  for(const action of ['request_access','bootstrap_access','access_status'])await assert.rejects(tools.tool({...request,action,access_id,password:'must-not-pass'}));
  enabled=false;await assert.rejects(tools.tool({action:'bootstrap_access',access_id}),/switched off/);assert.equal((await tools.tool({action:'access_status',access_id})).state,'credentials_required');
  enabled=true;f.grant(access_id);await tools.tool({action:'bootstrap_access',access_id});await f.access.settled();assert.equal((await tools.tool({action:'access_status',access_id})).state,'complete');
});
test('changed identity or restricted existing key cannot be presented as successful setup',async t=>{
  for(const state of ['identity_changed','existing_key_restricted']){
    const f=fixture(t,{transport:{install:async()=>({state,changed:false})}}),{access_id}=await f.request();f.grant(access_id);
    const result=await run(f,access_id);assert.equal(result.state,'needs_attention');assert.equal(result.endpoints[0].reason,state);assert.equal(f.calls.some(c=>c.name==='verify'),false);
  }
  const f=fixture(t,{transport:{verify:async()=>facts('b')}}),{access_id}=await f.request();f.grant(access_id);
  assert.equal((await run(f,access_id)).state,'verification_pending');
});
test('local HTTP grant requires same origin and CSRF, never sends the password into tool calls',async t=>{
  const f=fixture(t),{access_id}=await f.request();
  const server=http.createServer((req,res)=>handleSparkAccessSettings(req,res,{access:f.access,csrf:'fixture-csrf',reply:(code,value)=>{res.writeHead(code,{'content-type':'application/json'});res.end(JSON.stringify(value));}}));
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close();});
  const base=`http://127.0.0.1:${server.address().port}`,body={action:'authorize',access_id,username:'owner',password:'private-fixture-secret'};
  const post=(headers={})=>fetch(base+'/api/genie/spark-access',{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});
  assert.equal((await post()).status,403);assert.equal((await post({origin:'http://other.invalid','x-dsg-csrf':'fixture-csrf'})).status,403);
  const reply=await post({origin:base,'x-dsg-csrf':'fixture-csrf'});assert.equal(reply.status,200);assert.doesNotMatch(await reply.text(),/private-fixture-secret/);assert.equal(f.calls.length,0);
  assert.doesNotMatch(await(await fetch(base+'/api/genie/spark-access')).text(),/private-fixture-secret/);
});
