import test from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {hermesReviewFetch} from './genie-hermes-review.mjs';
import {genieNotDispatched} from './genie-transport.mjs';
import {seedGenieHome} from './genie-identity.mjs';
import {Genie} from './genie.mjs';
const report=JSON.stringify({assessment:'Synthetic review.',ticker:[{severity:'info',text:'Synthetic observation.',evidence_refs:['fleet']}]});
const payload=()=>({model:'example-model',max_tokens:8192,reasoning_effort:'xhigh',stream:false,messages:[{role:'system',content:'Return a structured JSON fleet review.'},{role:'user',content:JSON.stringify({question:'Review this example.',evidence:{context_length:262144},notebook_history:{notes:[]}})}]});
const input=()=>({body:JSON.stringify(payload()),headers:{'content-type':'application/json','authorization':'Bearer private-test-key','x-dsg-observer':'gate-genie','x-dsg-review-flexible':'1'},timeoutMs:120000});
async function listen(t,fn){const s=http.createServer(fn);await new Promise(r=>s.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{s.closeAllConnections();s.close(r);}));return {server:s,url:`http://127.0.0.1:${s.address().port}/v1/chat/completions`};}
const mockProvider=({retry=false}={})=>(config,options)=>({generate:async request=>{
  assert.equal(options.review,true);assert.equal(config.max_tokens,8192);assert.equal(config.reasoning_effort,'xhigh');assert.equal(config.timeout_ms,120000);
  const call=()=>fetch(config.url+'/chat/completions',{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${config.api_key}`},body:JSON.stringify({model:config.model,max_tokens:99,reasoning_effort:'low',temperature:0.2,stream:false,messages:[{role:'system',content:request.instructions},{role:'user',content:request.message}]}),signal:request.signal});
  let response=await call();if(retry&&!response.ok)response=await call();if(!response.ok)throw new Error('Private fake library failure');return {text:(await response.json()).choices[0].message.content};
},close(){}});
test('Hermes review preserves the selected endpoint, headers, output allowance, reasoning and worker attribution',async t=>{
  let calls=0;const upstream=await listen(t,(req,res)=>{let body='';req.on('data',x=>body+=x);req.on('end',()=>{calls++;const p=JSON.parse(body);assert.equal(req.headers.authorization,'Bearer private-test-key');assert.equal(req.headers['x-dsg-review-flexible'],'1');assert.equal(p.max_tokens,8192);assert.equal(p.reasoning_effort,'xhigh');assert.equal(p.temperature,undefined);assert.deepEqual(Object.fromEntries(Object.entries(p).filter(([k])=>k!=='messages')),Object.fromEntries(Object.entries(payload()).filter(([k])=>k!=='messages')));res.writeHead(200,{'content-type':'application/json','x-ds4-node':'example-one'});res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:report}}]}));});});
  const run=hermesReviewFetch({}, {providerFactory:mockProvider()});const result=await run(upstream.url,input());assert.equal(result.node,'example-one');assert.equal(calls,1);assert.equal(result.status,200);
});
test('an ambiguous failure cannot cause a second upstream dispatch even when Hermes retries',async t=>{
  let calls=0;const upstream=await listen(t,(req,res)=>{req.resume();req.on('end',()=>{calls++;res.destroy();});});
  const run=hermesReviewFetch({}, {providerFactory:mockProvider({retry:true})});await assert.rejects(run(upstream.url,input()),e=>!genieNotDispatched(e));assert.equal(calls,1);
});
test('a witnessed refusal retains the exact pre-dispatch proof used for dedicated fallback',async t=>{
  const server=http.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));
  const run=hermesReviewFetch({}, {providerFactory:mockProvider({retry:true})});await assert.rejects(run(`http://127.0.0.1:${port}/v1/chat/completions`,input()),e=>genieNotDispatched(e));
});
test('output-limited and HTTP-rejected reviews do not become accepted advice',async t=>{
  let status=200;const upstream=await listen(t,(req,res)=>{req.resume();req.on('end',()=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(status===200?{choices:[{finish_reason:'length',message:{content:report}}]}:{error:{message:'PRIVATE_ERROR'}}));});});
  const run=hermesReviewFetch({}, {providerFactory:mockProvider()});await assert.rejects(run(upstream.url,input()),/token budget/);status=400;const rejected=await run(upstream.url,input());assert.equal(rejected.status,400);let text='';for await(const c of rejected.body)text+=c;assert.ok(!text.includes('PRIVATE_ERROR'));
});
test('cancelling a review closes its active upstream without replay',async t=>{
  let started,closed;const start=new Promise(r=>started=r),close=new Promise(r=>closed=r);
  const upstream=await listen(t,(req,res)=>{req.resume();req.on('end',()=>{started();res.on('close',closed);});});
  const signal=new AbortController(),run=hermesReviewFetch({}, {providerFactory:mockProvider()});const pending=run(upstream.url,{...input(),signal:signal.signal});await start;signal.abort();await assert.rejects(pending,e=>e.name==='AbortError');await close;
});
test('actual installed Hermes loads the same SOUL for a structured review and never retries the real provider',{
 skip:!process.env.DSG_TEST_HERMES_SOURCE||!process.env.DSG_TEST_HERMES_PYTHON,timeout:120000
},async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'sg-review-hermes-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));const home=seedGenieHome(directory);fs.appendFileSync(path.join(home,'SOUL.md'),'\nIdentity marker: attentive starlight.\n');
  let fail=false,calls=[];const upstream=await listen(t,(req,res)=>{let body='';req.on('data',x=>body+=x);req.on('end',()=>{const p=JSON.parse(body);calls.push(p);if(fail){res.destroy();return;}const choice={finish_reason:'stop',message:{role:'assistant',content:report}};res.writeHead(200,{'content-type':p.stream?'text/event-stream':'application/json','x-ds4-node':'example-one'});if(p.stream)res.end('data: '+JSON.stringify({choices:[{index:0,delta:{content:report},finish_reason:null}]})+'\n\ndata: '+JSON.stringify({choices:[{index:0,delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');else res.end(JSON.stringify({id:'example',choices:[choice],usage:{prompt_tokens:100,completion_tokens:50,total_tokens:150}}));});});
  const run=hermesReviewFetch({python:process.env.DSG_TEST_HERMES_PYTHON,source:process.env.DSG_TEST_HERMES_SOURCE},{directory});
  const done=await run(upstream.url,input());assert.equal(done.status,200);assert.equal(done.node,'example-one');assert.equal(calls.length,1);assert.match(JSON.stringify(calls[0].messages),/attentive starlight/);assert.match(JSON.stringify(calls[0].messages),/structured JSON/);assert.equal(calls[0].stream,false,'preserve the reviewers non-streaming response budget');assert.equal(calls[0].tools?.length??0,0);assert.equal(calls[0].max_tokens,8192);assert.equal(calls[0].reasoning_effort,'xhigh');
  fail=true;await assert.rejects(run(upstream.url,input()));assert.equal(calls.length,2,'one new real provider attempt despite an ambiguous disconnect');assert.deepEqual(fs.readdirSync(home).filter(x=>x.startsWith('review-')),[]);assert.match(fs.readFileSync(path.join(home,'SOUL.md'),'utf8'),/attentive starlight/);fs.unlinkSync(path.join(home,'SOUL.md'));await assert.rejects(run(upstream.url,input()));assert.equal(calls.length,2,'missing identity cannot dispatch or silently reseed a different soul');assert.equal(fs.existsSync(path.join(home,'SOUL.md')),false);
});

test('the owner-question exception still replaces only Genies own routine review',async t=>{
  let first,closed,calls=0;const started=new Promise(r=>first=r),cancelled=new Promise(r=>closed=r);
  const upstream=await listen(t,(req,res)=>{req.resume();req.on('end',()=>{calls++;if(calls===1){first();res.on('close',closed);return;}res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:report}}]}));});});
  const g=new Genie({url:upstream.url.replace('/chat/completions',''),model:'example-model',reasoning_effort:'xhigh',timeout_ms:120000},()=>({time:Date.now(),gateway:{workers:[],context_length:262144}}),{fetchImpl:hermesReviewFetch({}, {providerFactory:mockProvider()})});t.after(()=>g.close());
  const routine=g.ask(undefined,{kind:'scheduled'});await started;g.submit('Owner question');await routine;await cancelled;
  const deadline=Date.now()+3000;while(g.status().question.state!=='answered'&&Date.now()<deadline)await new Promise(r=>setTimeout(r,10));
  assert.equal(g.status().question.state,'answered');assert.equal(calls,2);assert.equal(g.status().engine,'Hermes');
});
