import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyRecovery,qwenRecoveryProofValid} from './recovery-verify.mjs';
import {bootstrapProofValid} from './recovery-bootstrap.mjs';
import {recoveryConfig} from './recovery-transport.mjs';

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
test('Docker enrollment selects explicit verification and preserves native stopped-container policy',()=>{
 const c={id:'example',backend:'openai',url:'http://127.0.0.1:38011/v1',ssh:'example',remote_port:8001,adapter:'docker',verification:'qwen_vllm',exclusive:true,helper:'/opt/example/recovery-docker.py',config:'/opt/example/recovery.json',machine:'a'.repeat(64),profile:'b'.repeat(64)};
 assert.equal(recoveryConfig({workers:[c]}).get('example').verification,'qwen_vllm');
 assert.throws(()=>recoveryConfig({workers:[{...c,start_stopped:true,service_profile:'c'.repeat(64)}]}),/preserves stopped/);
 assert.throws(()=>recoveryConfig({workers:[{...c,verification:'guess'}]}),/Unsupported recovery verification/);
});
