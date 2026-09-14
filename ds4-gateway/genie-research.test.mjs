import test from 'node:test';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import http from 'node:http';
import {GenieChat} from './genie-chat.mjs';
import {hermesProvider} from './genie-hermes.mjs';

function directory(t){const d=fs.mkdtempSync(path.join(os.tmpdir(),'genie-research-'));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));return d;}
test('web tools are available by default, with evidence and retry deduplication preserved',async t=>{
 const calls=[],d=directory(t),chat=new GenieChat({directory:d,provider:{info:{research_available:true},generate:async p=>{calls.push(p.research);assert.equal(JSON.parse(fs.readFileSync(path.join(d,p.sessionId+'.json'))).messages.at(-2).research,p.research||undefined);p.onResearch({kind:'read',state:'complete',at:new Date().toISOString(),sources:[{url:'https://example.org/source'}]});return {text:'Answer'};}}});
 const s=chat.create();chat.submit(s.id,'Check updates','research-on');assert.throws(()=>chat.submit(s.id,'Check updates','research-on',{research:false}),/already used/);await chat.idle();
 chat.submit(s.id,'Explain that','research-off',{research:false});await chat.idle();assert.deepEqual(calls,[true,false]);const saved=chat.get(s.id);assert.equal(saved.messages[1].research.events.length,1);assert.equal(saved.messages[3].research,undefined);assert.equal(new GenieChat({directory:d}).get(s.id).messages[1].research.events.length,1);
 assert.throws(()=>chat.submit(s.id,'Check','invalid-permission',{research:'true'}),/boolean/);
});
test('missing research setup cannot silently execute a requested study',t=>{
 const chat=new GenieChat({directory:directory(t),provider:{generate:()=>assert.fail('must not call model')}}),s=chat.create();assert.throws(()=>chat.submit(s.id,'Check','no-research-config',{research:true}),/not configured/);assert.equal(chat.get(s.id).messages.length,0);
});
test('malformed saved research evidence is preserved without exposing a broken conversation',t=>{
 const d=directory(t),chat=new GenieChat({directory:d}),s=chat.create(),file=path.join(d,s.id+'.json');s.messages=[{role:'assistant',text:'Kept',state:'complete',research:{authorized_at:1,events:{bad:true}}}];fs.writeFileSync(file,JSON.stringify(s));const before=fs.readFileSync(file,'utf8');const reopened=new GenieChat({directory:d});assert.deepEqual(reopened.status().unreadable_conversations,[s.id+'.json']);assert.equal(fs.readFileSync(file,'utf8'),before);assert.ok(reopened.create().id);
});
test('installed Hermes uses only the two research tools and records actual search/read evidence',{
 skip:!process.env.DSG_TEST_HERMES_SOURCE||!process.env.DSG_TEST_HERMES_PYTHON,timeout:120000,
},async t=>{
 let searches=0,reads=0;const modelRequests=[];
 const server=http.createServer(async(req,res)=>{
  let body='';for await(const b of req)body+=b;
  const reply=v=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(v));};
  if(req.url.startsWith('/search?')){searches++;assert.equal(req.headers.authorization,undefined);return reply({results:[{title:'Example release',url:'https://example.org/release',content:'Synthetic release notes'}]});}
  if(req.url==='/v1/scrape'){reads++;assert.equal(req.headers.authorization,undefined);assert.equal(JSON.parse(body).url,'https://example.org/release');return reply({success:true,data:{markdown:'Synthetic source: version example-two fixes the example bug.'}});}
  if(req.method==='GET')return reply({data:[{id:'example-model'}]});
  const p=JSON.parse(body);if(req.url==='/api/show')return reply({model_info:{'llama.context_length':262144}});modelRequests.push(p);assert.deepEqual(p.tools.map(x=>x.function.name).sort(),['web_extract','web_search']);
  const toolMessages=p.messages.filter(m=>m.role==='tool'),name=!toolMessages.length?'web_search':toolMessages.length===1?'web_extract':null;
  const message=name?{role:'assistant',content:null,tool_calls:[{id:'call-'+toolMessages.length,type:'function',function:{name,arguments:JSON.stringify(name==='web_search'?{query:'example-runtime release notes'}:{url:'https://example.org/release'})}}]}:{role:'assistant',content:'The synthetic release fixes the example bug. [Source](https://example.org/release)'};
  if(p.stream){res.setHeader('content-type','text/event-stream');const delta={...message};delete delta.role;if(delta.tool_calls)delta.tool_calls=delta.tool_calls.map((x,index)=>({...x,index}));res.write('data: '+JSON.stringify({id:'example',choices:[{index:0,delta,finish_reason:null}]})+'\n\n');res.end('data: '+JSON.stringify({id:'example',choices:[{index:0,delta:{},finish_reason:name?'tool_calls':'stop'}],usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120}})+'\n\ndata: [DONE]\n\n');}
  else reply({id:'example',choices:[{message,finish_reason:name?'tool_calls':'stop'}],usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120}});
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close();});const base=`http://127.0.0.1:${server.address().port}`,d=directory(t);
 const provider=hermesProvider({python:process.env.DSG_TEST_HERMES_PYTHON,source:process.env.DSG_TEST_HERMES_SOURCE,url:base+'/v1',model:'example-model',research:{search_url:base,extract_url:base}},{directory:d});t.after(()=>provider.close());
 const chat=new GenieChat({directory:path.join(d,'chats'),provider,getSnapshot:()=>({gateway:{workers:[{id:'private-worker'}]}})}),s=chat.create();chat.submit(s.id,'Research the example release','research-hermes');await chat.idle();
 const answer=chat.get(s.id).messages.at(-1);assert.equal(answer.state,'complete',JSON.stringify(answer));assert.match(answer.text,/synthetic release/);assert.equal(searches,1);assert.equal(reads,1);assert.equal(modelRequests.length,3);assert.equal(answer.research.events.filter(e=>e.state==='complete').length,2);assert.ok(answer.research.events.some(e=>e.content_sha256));
 const study=chat.study.change({action:'study-start',expected_revision:0,request_id:randomUUID()});await chat.idle();const studied=chat.get(study.last_run.conversation_id);assert.match(studied.title,/Setup research/);assert.equal(studied.messages.at(-1).state,'complete');assert.equal(searches,2);assert.equal(reads,2);assert.equal(modelRequests.length,6);assert.equal(studied.messages.at(-1).research.events.filter(e=>e.state==='complete').length,2);
});

test('ordinary chat works without web services and accepted retries survive a changed default',async t=>{
 const calls=[],provider={info:{research_available:false},generate:async p=>{calls.push(p.research);return {text:'Hello'};}};
 const chat=new GenieChat({directory:directory(t),provider}),s=chat.create();
 chat.submit(s.id,'Hello','default-before');await chat.idle();assert.deepEqual(calls,[false]);
 provider.info.research_available=true;
 chat.submit(s.id,'Hello','default-before');await chat.idle();assert.deepEqual(calls,[false],'accepted request is not replayed');
 chat.submit(s.id,'What changed?','default-after');await chat.idle();assert.deepEqual(calls,[false,true]);
 assert.equal(chat.get(s.id).messages.at(-1).research.mode,'automatic');
});
