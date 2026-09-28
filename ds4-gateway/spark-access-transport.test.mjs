import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {PassThrough,Writable} from 'node:stream';
import {execFileSync} from 'node:child_process';
import {gatewayPublicKey,createSparkAccessTransport} from './spark-access-transport.mjs';

test('gateway key selection reads an existing public key without changing the private key or its options',async t=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'sg-access-key-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const key=path.join(home,'fixture_key');execFileSync('ssh-keygen',['-q','-t','ed25519','-N','','-f',key]);const before=fs.readFileSync(key),pub=fs.readFileSync(key+'.pub','utf8');
  const result=await gatewayPublicKey('fixture',{home,command:async(command,args)=>{assert.equal(command,'ssh');assert.deepEqual(args,['-G','--','fixture']);return {stdout:'identityfile '+key+'\nidentityagent none\n'};}});
  assert.equal(result.public_key,pub.trim().split(/\s+/).slice(0,2).join(' '));assert.match(result.fingerprint,/^SHA256:/);assert.deepEqual(fs.readFileSync(key),before);
});
test('missing key reports prerequisite without creating one or consulting a disabled agent',async t=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'sg-access-no-key-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));let calls=0;
  await assert.rejects(gatewayPublicKey('fixture',{home,command:async()=>{calls++;return {stdout:'identityfile ~/missing\nidentityagent none\n'};}}),/No public key/);assert.equal(calls,1);assert.deepEqual(fs.readdirSync(home),[]);
});
test('password crosses only the private input pipe and fixed operation source never includes it',async()=>{
  const password='private-transport-fixture',calls=[];
  const transport=createSparkAccessTransport({python:'fixture-python',directory:'/unused',spawnImpl:(file,args,options)=>{
    const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();let body='';
    child.kill=()=>{};child.stdin=new Writable({write(chunk,_encoding,done){body+=chunk;done();},final(done){calls.push({file,args,options,payload:JSON.parse(body)});child.stdout.end(JSON.stringify({ok:true,result:{state:'observed'}}));queueMicrotask(()=>child.emit('close',0));done();}});return child;
  }});
  const target={ssh:'owner@'+[10,27,0,2].join('.'),knownHosts:'/private-fixture/known_hosts'};
  await transport.inspect(target,password);await transport.install(target,password,{operation_id:'00000000-0000-4000-8000-000000000000',identity:'a'.repeat(64),public_key:'ssh-ed25519 Zml4dHVyZQ=='});
  assert.equal(calls.length,2);
  for(const call of calls){assert.equal(call.payload.password,password);assert.doesNotMatch(JSON.stringify([call.file,call.args,call.options,call.payload.code]),new RegExp(password));assert.deepEqual(call.options.stdio,['pipe','pipe','pipe']);assert.equal(call.payload.known_hosts,target.knownHosts);}
  assert.match(calls[0].payload.code,/DSG_ACCESS_RESULT=/);assert.match(calls[1].payload.code,/operation_id/);
});
test('raw transport errors and malformed native output do not escape to the controller',async()=>{
  for(const reply of ['raw fixture-secret',{ok:false,reason:'fixture-secret'},{ok:true,result:{}}]){
    const transport=createSparkAccessTransport({python:'fixture',spawnImpl:()=>{const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{};child.stdin=new Writable({write(_c,_e,done){done();},final(done){child.stdout.end(typeof reply==='string'?reply:JSON.stringify(reply));queueMicrotask(()=>child.emit('close',reply.ok?255:0));done();}});return child;}});
    await assert.rejects(transport.inspect({ssh:'fixture',knownHosts:'fixture'},'fixture-secret'),error=>!error.message.includes('fixture-secret'));
  }
});
