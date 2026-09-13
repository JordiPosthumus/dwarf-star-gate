import {test} from 'node:test';
import assert from 'node:assert/strict';
import {servingProfiles,servingProfileTransform} from './serving-profile.mjs';
export const profile={context_window:262144,max_output_tokens:262144,input:['text','image'],reasoning:true,defaults:{temperature:1,top_p:0.95,top_k:20,min_p:0,presence_penalty:0,repetition_penalty:1,chat_template_kwargs:{enable_thinking:true,preserve_thinking:true,reasoning_effort:'xhigh'}}};
async function transform(body,size=7,p=profile,encoding,route='/v1/chat/completions'){
 const t=servingProfileTransform(p,encoding,route),chunks=[];t.on('data',c=>chunks.push(c));
 const done=new Promise((resolve,reject)=>{t.on('end',resolve);t.on('error',reject)});
 const bytes=Buffer.from(body);for(let i=0;i<bytes.length;i+=size)t.write(bytes.subarray(i,i+size));t.end();await done;return Buffer.concat(chunks).toString();
}
test('profile validation rejects unknown workers, fields and incompatible Spark settings',()=>{
 assert.deepEqual(servingProfiles({spark:profile},[{id:'spark'}]),{spark:profile});
 for(const p of [{...profile,defaults:{...profile.defaults,min_p:0.1}},{...profile,defaults:{...profile.defaults,temperature:0.001}},{...profile,extra:1}])assert.throws(()=>servingProfiles({spark:p},[{id:'spark'}]));
 assert.throws(()=>servingProfiles({spark:profile},[]));
});
test('missing defaults are injected across every chunk size without adding a token budget',async()=>{
 const raw=' { "model":"qwen", "messages":[{"role":"user","content":"Héllo \\\" 🌍 { }"}], "stream":true } ';
 for(let size=1;size<=raw.length;size++){
  const result=JSON.parse(await transform(raw,size));assert.deepEqual(result,{...JSON.parse(raw),...profile.defaults});assert.equal('max_tokens' in result,false);
 }
 assert.deepEqual(JSON.parse(await transform('{}')),profile.defaults);
});
test('explicit sampling, output, tools and nested thinking choices survive',async()=>{
 const body={messages:[{role:'assistant',reasoning_content:'thought',tool_calls:[{id:'x',function:{arguments:'{"a":1}'}}]}],max_tokens:262000,temperature:0,top_p:0.8,min_p:0,top_k:-1,presence_penalty:1.5,repetition_penalty:1.1,chat_template_kwargs:{enable_thinking:false,preserve_thinking:false}};
 assert.deepEqual(JSON.parse(await transform(JSON.stringify(body))),body);
 const low={chat_template_kwargs:{reasoning_effort:'low'}};
 assert.deepEqual(JSON.parse(await transform(JSON.stringify(low))).chat_template_kwargs,{enable_thinking:true,preserve_thinking:true,reasoning_effort:'low'});
 const nul={temperature:null,chat_template_kwargs:null};const actual=JSON.parse(await transform(JSON.stringify(nul)));assert.equal(actual.temperature,null);assert.equal(actual.chat_template_kwargs,null);
});
test('top-level effort in either order never acquires a conflicting nested default',async()=>{
 for(const effort of ['none','low','medium','xhigh',null,'invalid'])for(const body of [{reasoning_effort:effort,chat_template_kwargs:{preserve_thinking:false}},{chat_template_kwargs:{preserve_thinking:false},reasoning_effort:effort}]){
  const result=JSON.parse(await transform(JSON.stringify(body)));assert.equal(result.reasoning_effort,effort);assert.equal(Object.hasOwn(result.chat_template_kwargs,'reasoning_effort'),false);assert.equal(result.chat_template_kwargs.enable_thinking,effort!=='none');assert.equal(result.chat_template_kwargs.preserve_thinking,false);
 }
});
test('unprofiled, encoded and non-chat requests remain byte-identical',async()=>{
 const raw=' { "messages" : [] } ';assert.equal(await transform(raw,2,null),raw);assert.equal(await transform(raw,2,profile,'gzip'),raw);assert.equal(await transform(raw,2,profile,undefined,'/v1/responses'),raw);
});
test('large messages stream before upload completion; nested fake setting names do not suppress defaults',async()=>{
 const t=servingProfileTransform(profile,undefined,'/v1/chat/completions');const chunks=[];t.on('data',c=>chunks.push(c));
 const prefix='{"messages":[{"role":"user","content":"'+ 'x'.repeat(1024*1024);
 t.write(Buffer.from(prefix));assert.ok(Buffer.concat(chunks).length>=prefix.length-4);
 t.end(Buffer.from('"}],"metadata":{"temperature":0}}'));await new Promise(r=>t.on('end',r));
 const result=JSON.parse(Buffer.concat(chunks));assert.equal(result.temperature,1);assert.equal(result.messages[0].content.length,1024*1024);
});
