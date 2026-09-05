import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createPiClientMetadata} from './pi-client-metadata.mjs';
import {registerPiContinuity} from './continuity-client.mjs';

const baseUrl='http://127.0.0.1:30000/v1',provider='fixture-dsg',model={provider,api:'openai-completions',baseUrl};
function fixture(reason='new'){
  const entries=[],header={type:'session',id:'private-session'},manager={getSessionId:()=>header.id,getHeader:()=>header,getEntries:()=>entries,getBranch:()=>entries,getSessionFile:()=>'/not-read/session.jsonl'};
  const metadata=createPiClientMetadata({provider,baseUrl});metadata.start({reason},{sessionManager:manager});
  const snapshot=(options={})=>{const raw=metadata.snapshot(model,{sessionId:header.id,reasoning:'xhigh',...options});return raw?JSON.parse(raw):null;};
  const message=(id,role,stopReason)=>entries.push({id,type:'message',message:{role,provider,stopReason,get content(){throw new Error('Do not read private content');}}});
  return {metadata,entries,header,manager,snapshot,message};
}
test('fresh Pi metadata counts logical inputs, preserves retry index and reads no message/summary content',()=>{
  const f=fixture();f.message('user','user');
  assert.deepEqual(f.snapshot(),{schema:1,reasoning_effort:'xhigh',compaction_count:0,turn_index:0});
  assert.equal(f.snapshot().turn_index,0);
  f.message('failed','assistant','error');assert.equal(f.snapshot().turn_index,0);
  f.entries.push({id:'compact',type:'compaction',get summary(){throw new Error('Do not read summary');}});
  assert.deepEqual(f.snapshot(),{schema:1,reasoning_effort:'xhigh',compaction_count:1,turn_index:0});
  f.message('answer','assistant','tool_calls');f.message('result','toolResult');
  assert.equal(f.snapshot().turn_index,1);
  f.message('failed-again','assistant','error');assert.equal(f.snapshot().turn_index,1);
  f.message('proceed','user');assert.equal(f.snapshot().turn_index,2);
  assert.equal(f.snapshot().prompt_tokens_estimate,undefined);
});
test('resumed/reloaded/forked history never invents an absolute model-call index',()=>{
  for(const reason of ['startup','resume','reload','fork']){
    const f=fixture(reason);f.entries.push({id:'c1',type:'compaction'});
    assert.deepEqual(f.snapshot(),{schema:1,reasoning_effort:'xhigh',compaction_count:1});
  }
  const f=fixture();f.header.parentSession='private-parent';
  assert.deepEqual(f.snapshot(),{schema:1,reasoning_effort:'xhigh'});
  f.metadata.start({reason:'new'},{sessionManager:f.manager});assert.equal(f.snapshot().turn_index,undefined);
  for(const missing of [undefined,null]){
    const fresh=fixture('startup');fresh.manager.getSessionFile=()=>missing;
    fresh.metadata.start({reason:'startup'},{sessionManager:fresh.manager});
    assert.equal(fresh.snapshot().turn_index,0);
  }
});
test('new sessions with seeded history, branch changes, foreign providers and broken state abstain',()=>{
  const f=fixture();f.message('preexisting','assistant','stop');
  f.metadata.start({reason:'new'},{sessionManager:f.manager});assert.equal(f.snapshot().turn_index,undefined);
  const fresh=fixture();assert.equal(fresh.snapshot().turn_index,0);fresh.metadata.invalidate();assert.equal(fresh.snapshot().turn_index,undefined);
  const foreign=fixture();foreign.entries.push({id:'foreign',type:'message',message:{role:'assistant',provider:'other'}});assert.equal(foreign.snapshot().turn_index,undefined);
  const broken=fixture();broken.manager.getEntries=()=>{throw new Error('private error');};assert.equal(broken.snapshot(),null);
  const duplicate=fixture();duplicate.entries.push({id:'duplicate',type:'compaction'},{id:'duplicate',type:'compaction'});
  assert.deepEqual(duplicate.snapshot(),{schema:1,reasoning_effort:'xhigh'});
  const inconsistent=fixture();inconsistent.manager.getBranch=()=>[{id:'not-in-entries',type:'compaction'}];
  assert.deepEqual(inconsistent.snapshot(),{schema:1,reasoning_effort:'xhigh'});
  const oversized=fixture();oversized.entries.push(...Array.from({length:10001},(_,i)=>({id:String(i),type:'compaction'})));
  assert.deepEqual(oversized.snapshot(),{schema:1,reasoning_effort:'xhigh'});
  assert.equal(fresh.snapshot({sessionId:'another-subagent'}),null);
  fresh.metadata.stop();assert.equal(fresh.snapshot(),null);
});
test('metadata decoration is exact-scope, preserves explicit hints and never modifies a body',()=>{
  const f=fixture(),hints=JSON.stringify(f.snapshot()),body='{"original":true}',init={method:'POST',body,headers:{authorization:'Bearer fixture'}};
  const decorated=f.metadata.decorate(baseUrl+'/chat/completions',init,hints);
  assert.equal(decorated.headers.get('x-dsg-client-metadata'),hints);assert.equal(decorated.body,body);assert.equal(init.headers['x-dsg-client-metadata'],undefined);
  const explicit={...init,headers:{'X-DSG-Client-Metadata':'caller supplied'}};
  assert.equal(f.metadata.decorate(baseUrl+'/chat/completions',explicit,hints),explicit);
  for(const url of [baseUrl+'/models',baseUrl+'/chat/completions?extra=1','http://another.example/v1/chat/completions'])assert.equal(f.metadata.decorate(url,init,hints),init);
  const stream={...init,body:new ReadableStream()};assert.equal(f.metadata.decorate(baseUrl+'/chat/completions',stream,hints),stream);
});
test('registered opt-in snapshots hints once and preserves payload hooks, scopes and settings',async()=>{
  const f=fixture(),handlers=new Map();let config,observed;
  registerPiContinuity({on:(name,fn)=>handlers.set(name,fn),registerProvider:(_id,c)=>config=c},{provider,baseUrl,clientMetadata:true,streamSimple:async(m,context,options)=>{
    assert.equal(m,model);assert.equal(options.maxTokens,262144);assert.equal(options.reasoning,'xhigh');assert.equal(options.onPayload,'fixture-hook');
    f.entries.push({id:'too-late-compaction',type:'compaction'});
    return options.fetch(baseUrl+'/chat/completions',{method:'POST',body:'{"untouched":true}'});
  }});
  handlers.get('session_start')({reason:'new'},{sessionManager:f.manager,ui:{}});
  assert.equal(handlers.has('before_provider_request'),false,'Do not replace serialized payloads');
  await config.streamSimple(model,{}, {sessionId:f.header.id,reasoning:'xhigh',maxTokens:262144,onPayload:'fixture-hook',fetch:async(_url,init)=>{observed=init;return new Response('fixture');}});
  assert.equal(observed.body,'{"untouched":true}');assert.equal(JSON.parse(observed.headers.get('x-dsg-client-metadata')).compaction_count,0);
  assert.equal(config.models,undefined);assert.equal(observed.redirect,'manual');
});
