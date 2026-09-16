import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyRecovery,qwenRecoveryProofValid} from './recovery-verify.mjs';
import {bootstrapProofValid} from './recovery-bootstrap.mjs';
import {recoveryConfig} from './recovery-transport.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function fixture({cached=3000,context=262144,finish='stop'}={}){
 const calls=[];
 return {calls,fetchImpl:async(url,options)=>{
  if(url.pathname==='/v1/models')return Response.json({data:[{id:'example',max_model_len:context}]});
  const body=JSON.parse(options.body);calls.push(body);const warm=body.messages.length===3,id=body.messages[0].content.includes('-A.')?'A':'B';
  return Response.json({choices:[{finish_reason:finish,message:{role:'assistant',content:`${warm?'WARM':'CHECK'}_${id}_OK`,reasoning_content:'Fixture reasoning retained'}}],usage:{prompt_tokens:warm?6100:6000,prompt_tokens_details:{cached_tokens:warm?cached:0}}});
 }};
}
test('Qwen verification proves two real cold/warm conversations with native thinking fields and partial cache evidence',async()=>{
 const f=fixture(),proof=await verifyRecovery('http://127.0.0.1:8001/v1','example',262144,{...f,kind:'qwen_vllm'});
 assert.equal(f.calls.length,4);assert.equal(qwenRecoveryProofValid(proof,262144),true);assert.equal(bootstrapProofValid(proof,262144),false);
 for(const body of f.calls){assert.equal(body.max_tokens,262144);assert.deepEqual(body.chat_template_kwargs,{enable_thinking:true,preserve_thinking:true,reasoning_effort:'xhigh'});assert.equal(body.thinking,undefined);}
 assert.equal(f.calls[2].messages[1].reasoning_content,'Fixture reasoning retained');
 assert.equal(f.calls[3].messages[1].content,'CHECK_B_OK');
 assert.equal(qwenRecoveryProofValid({...proof,context_length:8192},262144),false);
});
test('Qwen verification refuses absent cache reuse, changed context, and unfinished generation',async()=>{
 for(const [options,message] of [[{cached:0},/warm_cache/],[{context:8192},/context_changed/],[{finish:'length'},/generation_or_usage/]]){
  await assert.rejects(verifyRecovery('http://127.0.0.1:8001','example',262144,{...fixture(options),kind:'qwen_vllm'}),message);
 }
});
test('oMLX recovery checks use the enrolled credential, API base and model alias, retaining distinct proof',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sg-recovery-endpoint-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const key=path.join(dir,'key');fs.writeFileSync(key,'fixture-token',{mode:0o600});
 const endpoint={url:'http://127.0.0.1:39001/custom/v1',backend:'openai',api_key_file:key,model_aliases:{gateway:'example'}};
 const f=fixture();let requests=0;
 const fetchImpl=async(url,options)=>{
  requests++;assert.equal(options.headers.authorization,'Bearer fixture-token');assert.equal(options.redirect,'error');assert.match(url.pathname,/^\/custom\/v1\//);
  if(options.body)assert.equal(JSON.parse(options.body).model,'example');
  return f.fetchImpl(new URL(url.pathname.replace('/custom',''),'http://127.0.0.1'),options);
 };
 const proof=await verifyRecovery(endpoint.url,'gateway',262144,{kind:'qwen_omlx',endpoint,fetchImpl});
 assert.equal(requests,5);assert.equal(qwenRecoveryProofValid(proof,262144,'qwen_omlx'),true);assert.equal(qwenRecoveryProofValid(proof,262144),false);assert.equal(bootstrapProofValid(proof,262144),false);
 assert.ok(!JSON.stringify(proof).includes('fixture-token'));assert.ok(!JSON.stringify(proof).includes(key));
 await assert.rejects(verifyRecovery('http://127.0.0.1:39002/v1','gateway',262144,{kind:'qwen_omlx',endpoint,fetchImpl}),/endpoint_changed/);
 fs.unlinkSync(key);await assert.rejects(verifyRecovery(endpoint.url,'gateway',262144,{kind:'qwen_omlx',endpoint,fetchImpl}),/credential unavailable/);assert.equal(requests,5);
});
test('Docker enrollment selects explicit verification and preserves native stopped-container policy',()=>{
 const c={id:'example',backend:'openai',url:'http://127.0.0.1:38011/v1',ssh:'example',remote_port:8001,adapter:'docker',verification:'qwen_vllm',exclusive:true,helper:'/opt/example/recovery-docker.py',config:'/opt/example/recovery.json',machine:'a'.repeat(64),profile:'b'.repeat(64)};
 assert.equal(recoveryConfig({workers:[c]}).get('example').verification,'qwen_vllm');
 assert.throws(()=>recoveryConfig({workers:[{...c,start_stopped:true,service_profile:'c'.repeat(64)}]}),/preserves stopped/);
 assert.throws(()=>recoveryConfig({workers:[{...c,verification:'guess'}]}),/Unsupported recovery verification/);
});
test('direct oMLX enrollment is explicitly local with a separate stopped-start pin',()=>{
 const c={id:'local',url:'http://127.0.0.1:39001/v1',backend:'openai',adapter:'omlx',transport:'local',python:'/fixture/python',helper:'/fixture/recovery-omlx.py',config:'/fixture/config.json',machine:'a'.repeat(64),profile:'b'.repeat(64),verification:'qwen_omlx',exclusive:true};
 assert.equal(recoveryConfig({workers:[c]}).get('local').adapter,'omlx');
 assert.throws(()=>recoveryConfig({workers:[{...c,transport:'ssh',ssh:'fixture'}]}),/local/);
 assert.throws(()=>recoveryConfig({workers:[{...c,start_stopped:true}]}),/static service profile/);
 assert.equal(recoveryConfig({workers:[{...c,start_stopped:true,service_profile:'c'.repeat(64)}]}).get('local').start_stopped,true);
});
