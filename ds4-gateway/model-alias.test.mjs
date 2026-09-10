import {test} from 'node:test';
import assert from 'node:assert/strict';
import {modelAliasTransform} from './model-alias.mjs';
async function rewrite(s,size){const t=modelAliasTransform({pool:'M3-native-模型'}),out=[];t.on('data',b=>out.push(b));for(let i=0;i<s.length;i+=size)t.write(s.subarray(i,i+size));t.end();await new Promise((r,j)=>{t.on('end',r);t.on('error',j);});return Buffer.concat(out).toString();}
for(const size of [1,2,7,4096])test(`only top-level model is rewritten, chunk size ${size}`,async()=>{
 const s='{ "messages":[{"model":"pool","content":"héllo 🎉 \\\""}], "model" : "pool", "tools":[{"model":"pool"}]}';
 assert.equal(await rewrite(Buffer.from(s),size),s.replace('"model" : "pool"','"model" : "M3-native-模型"'));
});
test('unmapped, escaped keys, missing, oversized strings and truncated input',async()=>{for(const s of ['{"model":"other"}','{"messages":["pool"]}','{"model":"'+ 'a'.repeat(12000)+'"}','{"model":"pool','{"model":"pool","content":"'+'z'.repeat(20000)+'"}'])assert.equal(await rewrite(Buffer.from(s),3),s.replace('"model":"pool"','"model":"M3-native-模型"'));assert.equal(await rewrite(Buffer.from('{"mo\\u0064el":"pool"}'),1),'{"mo\\u0064el":"M3-native-模型"}');});
test('uploads forward before request end',()=>{const t=modelAliasTransform({pool:'native'});let seen='';t.on('data',b=>seen+=b);t.write('{"model":"pool","messages":[{"content":"hello');assert.equal(seen,'{"model":"native","messages":[{"content":"hello');t.destroy();});
test('identity aliases and encoded bodies are byte-preserving, including escaped model values',async()=>{
 for(const [aliases,encoding,input]of [[{pool:'pool'},null,Buffer.from('{"model":"po\\u006fl"}')],[{pool:'native'},'gzip',Buffer.from([31,139,0,34,123,34,109,111,100,101,108,34,58,34,112,111,111,108,34,125])]]){
  const t=modelAliasTransform(aliases,encoding),chunks=[];t.on('data',b=>chunks.push(b));t.end(input);await new Promise(r=>t.on('end',r));assert.deepEqual(Buffer.concat(chunks),input);
 }
});
