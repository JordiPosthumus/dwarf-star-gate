import {test} from 'node:test';import assert from 'node:assert/strict';
import {preparePiModelRoutes,verifyPiModelRouteSource,SHARED_QWEN_MODEL as shared,NATIVE_QWEN_MODEL as native} from './pi-model-routes.mjs';
import extension,{preserveDsgQwenRouteHistory} from '../pi-extensions/dsg-qwen-route-history.js';
const config=()=>({providers:{'spark-gateway':{compat:{thinkingFormat:'chat-template'},models:[{id:shared,name:'Owner name',reasoning:true,thinkingLevelMap:{xhigh:'xhigh',off:null},input:['text','image'],contextWindow:262144,maxTokens:262144,samplingParams:{temperature:1,top_p:0.95,top_k:20,min_p:0},headers:{'x-owner':'kept'}}]}}});
test('staged routing inherits current sampling, reasoning, capacities and headers and rejects stale source profiles',()=>{
 const current=config(),original=structuredClone(current),staged=preparePiModelRoutes(current);assert.deepEqual(current,original);
 for(const model of staged.models){assert.deepEqual(model.samplingParams,original.providers['spark-gateway'].models[0].samplingParams);assert.equal(model.contextWindow,262144);assert.equal(model.maxTokens,262144);assert.deepEqual(model.input,['text','image']);assert.equal(model.headers['x-owner'],'kept');assert.equal(model.headers['x-dsg-model'],model.id);assert.deepEqual(model.thinkingLevelMap,{xhigh:'xhigh',off:null});}
 assert.equal(verifyPiModelRouteSource(staged,current),true);current.providers['spark-gateway'].models[0].samplingParams.top_k=40;assert.equal(verifyPiModelRouteSource(staged,current),false);assert.equal(staged.required_context_extension,'pi-extensions/dsg-qwen-route-history.js');
});
test('existing native profile settings remain deliberate and untouched',()=>{
 const current=config();current.providers['spark-gateway'].models.push({id:native,name:'Owner native',samplingParams:{temperature:0.9,top_k:30},maxTokens:123456,headers:{'x-owner-native':'kept'}});
 const staged=preparePiModelRoutes(current);assert.equal(staged.models[1].samplingParams.temperature,0.9);assert.equal(staged.models[1].maxTokens,123456);assert.equal(staged.models[1].name,'Owner native');assert.equal(staged.models[1].headers['x-owner-native'],'kept');
});
const model=id=>({id,api:'openai-completions',provider:'spark-gateway'});
const message=(id,extra={})=>({role:'assistant',model:id,api:'openai-completions',provider:'spark-gateway',stopReason:'stop',content:[{type:'thinking',thinking:'Original thought',thinkingSignature:'reasoning_content'},{type:'text',text:'Original answer'}],...extra});
test('route-only changes preserve plain reasoning identity without mutating saved history or request selection',()=>{
 for(const [from,to]of [[shared,native],[native,shared]]){
  const saved=[message(from)],original=structuredClone(saved),target=model(to),result=preserveDsgQwenRouteHistory(saved,target);
  assert.notEqual(result,saved);assert.deepEqual(saved,original);assert.equal(result[0].model,to);assert.equal(result[0].content,saved[0].content);assert.equal(target.id,to);assert.equal(result[0].stopReason,'stop');
 }
 const saved=[message(shared)];assert.equal(preserveDsgQwenRouteHistory(saved,model(shared)),saved);
});
test('foreign models, providers, error statuses and opaque signatures are not promoted or rewritten as valid Qwen reasoning',()=>{
 for(const row of [message('other'),message(shared,{provider:'other'}),message(shared,{content:[{type:'thinking',thinking:'opaque',thinkingSignature:'encrypted',redacted:true}]})]){
  const messages=[row];assert.equal(preserveDsgQwenRouteHistory(messages,model(native)),messages);
 }
 const failed=[message(shared,{stopReason:'error'})];assert.equal(preserveDsgQwenRouteHistory(failed,model(native))[0].stopReason,'error');
 const saved=[message(shared)];assert.equal(preserveDsgQwenRouteHistory(saved,{...model(native),provider:'other'}),saved);
});
test('Pi extension transforms only the transient context event',()=>{
 let hook;extension({on:(name,fn)=>{assert.equal(name,'context');hook=fn;}});const saved=[message(shared)];const result=hook({messages:saved},{model:model(native)});assert.equal(result.messages[0].model,native);assert.equal(saved[0].model,shared);
});
