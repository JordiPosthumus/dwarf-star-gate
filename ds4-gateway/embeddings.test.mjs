import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {setTimeout as delay} from 'node:timers/promises';
import {EmbeddingCollector,extractRequest,ENCODER_MODEL,ENCODER_REVISION} from './embeddings.mjs';
import {evidence} from './dataset.mjs';
import {RequestedThinkingObserver,THINKING_CAPTURE_BYTES} from './requested-thinking.mjs';
import {UsageObserver} from './gateway.mjs';
const config={enabled:true,python:'/usr/bin/python3',model_dir:'/tmp/encoder-fixture'};
const meta={request_id:'request-one',node:'worker-one',route:'/v1/chat/completions',traffic_class:'unclassified'};
const body={messages:[{role:'system',content:'SECRET_SYSTEM'},{role:'developer',content:'SECRET_DEVELOPER'},{role:'user',content:'Earlier question'},{role:'assistant',content:[{type:'text',text:'Earlier response'},{type:'thinking',thinking:'SECRET_THINKING'}],tool_calls:[{arguments:'SECRET_TOOL'}]},{role:'tool',content:'SECRET_TOOL_RESULT'},{role:'user',content:[{type:'image_url',image_url:{url:'SECRET_IMAGE'}},{type:'text',text:'Latest question'}]}]};
function fixture(t,options={}){
 const records=[],child=new EventEmitter();child.stdout=new PassThrough();child.stdin=new PassThrough();child.kill=()=>{child.killed=true;};let wire='';child.stdin.on('data',x=>{wire+=x;});
 const collector=new EmbeddingCollector(config,(kind,row)=>records.push(evidence(kind,row)),{spawnImpl:()=>child,...options});t.after(()=>collector.close());
 const send=x=>child.stdout.write(JSON.stringify(x)+'\n');
 return {collector,records,child,wire:()=>wire,send,ready:()=>send({ready:true,model:ENCODER_MODEL,revision:ENCODER_REVISION,dimensions:384})};
}
test('extractor excludes system, developer, tools, images and hidden reasoning; supports visible API formats',()=>{
 for(const route of ['/v1/chat/completions','/v1/messages']){
  const x=extractRequest(body,route);assert.equal(x.texts[0],'Latest question');assert.ok(x.texts[1].includes('Earlier response'));assert.ok(!JSON.stringify(x).includes('SECRET'));
 }
 assert.equal(extractRequest({input:'Hello'},'/v1/responses').texts[0],'Hello');
 assert.equal(extractRequest({input:body.messages},'/v1/responses').texts[0],'Latest question');
 assert.equal(extractRequest({prompt:'SECRET'},'/v1/completions').status,'unsupported_route');
 const x=extractRequest({messages:Array.from({length:300},()=>({role:'user',content:'a'.repeat(10000)}))},meta.route);assert.equal(x.history_scan_limited,true);assert.ok(x.texts.every(t=>t.length<=8192));
});
test('body hook runs once, excludes partial/encoded/oversized input and cannot break thinking observation',()=>{
 let calls=0;const o=new RequestedThinkingObserver(null,(body,result)=>{calls++;assert.equal(body.reasoning_effort,'xhigh');assert.equal(result.fields.reasoning_effort,'xhigh');throw new Error('observer failed');});
 o.accept(Buffer.from('{"reasoning_effort":"xhigh"}'));o.finish();o.finish();o.dispose();assert.equal(calls,1);
 for(const [encoding,chunk,finish] of [['gzip','{}',true],[null,'{',true],[null,'{',false],[null,'x'.repeat(THINKING_CAPTURE_BYTES+1),true]]){
  let seen='unset';const x=new RequestedThinkingObserver(encoding,b=>{seen=b;});x.accept(Buffer.from(chunk));finish?x.finish():x.dispose();assert.equal(seen,undefined);
 }
});
test('private worker response is correlated, normalized and persisted as vectors only, with feature availability',t=>{
 const f=fixture(t);f.ready();f.collector.observe(body,{status:'not_specified'},meta);const wire=JSON.parse(f.wire());assert.equal(wire.texts.length,2);assert.ok(!f.wire().includes('SECRET'));
 const vector=Array(384).fill(0);vector[0]=1;
 f.send({id:meta.request_id,results:wire.texts.map(()=>({vector,input_tokens:20,used_tokens:20,truncated:false})),elapsed_ms:12});
 assert.equal(f.collector.snapshot().completed,1);assert.equal(f.records[0].prediction_point,'after_upload');assert.equal(f.records[1].vectors.latest_user.vector.length,384);
 assert.ok(f.records[1].available_at>=f.records[1].queued_at);assert.ok(!JSON.stringify(f.records).includes('Latest question'));assert.ok(!JSON.stringify(f.collector.snapshot()).includes('vector'));
 const invalid={...f.records[1],model:'other'};assert.equal(evidence('embedding',invalid),null);
});
test('queue caps, failure, timeout, malformed output and disabled mode do not wait on inference',async t=>{
 const f=fixture(t,{maxPending:1});f.collector.observe(body,null,meta);f.collector.observe(body,null,{...meta,request_id:'two'});assert.equal(f.collector.snapshot().dropped,1);
 f.send({ready:true,model:'wrong',revision:ENCODER_REVISION,dimensions:384});assert.equal(f.collector.snapshot().failed,1);assert.ok(f.child.killed);
 const timeout=fixture(t,{timeoutMs:15});timeout.ready();timeout.collector.observe(body,null,meta);await delay(30);assert.equal(timeout.collector.snapshot().error,'worker_timeout');
 const bad=fixture(t);bad.ready();bad.collector.observe(body,null,meta);bad.child.stdout.write('x'.repeat(65537));assert.equal(bad.collector.snapshot().error,'invalid_worker_output');
 let calls=0;const off=new EmbeddingCollector(null,()=>{calls++;},{spawnImpl:()=>{throw new Error('must not start');}});off.observe(body,null,meta);off.close();assert.equal(calls,0);
});
test('progress classifies semantic deltas without retaining their text or treating a heartbeat as progress',()=>{
 const o=new UsageObserver();o.accept(Buffer.from(': heartbeat\n\n'));assert.equal(o.lastSemanticAt,null);
 o.accept(Buffer.from('data: {"choices":[{"delta":{"reasoning_content":"PRIVATE"}}]}\n\n'));assert.equal(o.phase,'thinking');assert.equal(o.semanticCharacters,7);assert.ok(o.lastSemanticAt!==null);
 o.accept(Buffer.from('data: {"choices":[{"delta":{"content":"OK"}}]}\n\n'));assert.equal(o.phase,'answering');
 const row=evidence('progress',{...meta,phase:o.phase,semantic_characters:o.semanticCharacters,active_elapsed_ms:1000,semantic_age_ms:20,text:'PRIVATE'});assert.ok(!JSON.stringify(row).includes('PRIVATE'));assert.equal(row.semantic_characters,9);
 o.accept(Buffer.from('data: {"choices":[{"delta":{"reasoning_content":"","content":"abc","tool_calls":[null,{"function":{"arguments":"{}"}}]}}]}\n\n'));
 assert.equal(o.semanticCharacters,14);assert.equal(o.phase,'tool_output');
});
