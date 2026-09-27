import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {studyEvidence} from './genie-study.mjs';
import {NativeHermesChatClient,nativeRequestId,projectNativeConversation,readNativeGatewayDescriptor} from './genie-native-chat.mjs';

const observed={state:'observed',session_key:'agent:main:telegram:dm:fixture',session_id:'native-session',busy:false,queued:0,observed_at:'2026-09-27T05:00:00Z'};
const rows=[
  {id:1,role:'user',content:'Inspect the service.',timestamp:100},
  {id:2,role:'assistant',content:'',tool_calls:[{id:'call-1',function:{name:'tool_call',arguments:JSON.stringify({name:'inspect_fleet_service',arguments:{worker:'fixture'}})}}],finish_reason:'tool_calls',timestamp:101,reasoning_content:'private reasoning'},
  {id:3,role:'tool',content:JSON.stringify({state:'running',action_id:'fixture-action'}),tool_call_id:'call-1',tool_name:'inspect_fleet_service',timestamp:102},
  {id:4,role:'assistant',content:'Inspection has started.',finish_reason:'stop',timestamp:103},
];

test('native transcript projects receipts without turning running operations into completed outcomes',()=>{
  const result=projectNativeConversation({id:'conversation',session:observed,messages:rows,pagination:{offset:0,limit:500,returned:4,total:4}});
  assert.equal(result.messages.length,2);
  assert.equal(result.messages[1].state,'complete');
  const event=result.messages[1].power.events[0];
  assert.deepEqual(event.request,{worker:'fixture'});
  assert.equal(event.result.state,'running');
  assert.equal(event.tool_call_id,'call-1');
  assert.doesNotMatch(JSON.stringify(result),/private reasoning/);
  assert.equal(result.history_complete,true);
  const pending=projectNativeConversation({id:'conversation',session:{...observed,busy:true},messages:rows.slice(0,3),pagination:{offset:0,limit:3,returned:3,total:4}});
  assert.equal(pending.messages[1].state,'working');assert.equal(pending.history_complete,false);assert.equal(pending.busy,true);
});

test('tool failures and truncated native answers retain uncertainty',()=>{
  const messages=structuredClone(rows);messages[2].content='{"error":"Inspection unavailable"}';messages[3].finish_reason='length';
  const result=projectNativeConversation({id:'conversation',session:observed,messages,pagination:{offset:1,limit:500,returned:4,total:4}});
  assert.equal(result.messages[1].power.events[0].state,'failed');
  assert.equal(result.messages[1].state,'failed');assert.equal(result.history_complete,false);
});

test('request identity is stable across retries and distinct across conversations',()=>{
  assert.equal(nativeRequestId('one','watcher-12345'),nativeRequestId('one','watcher-12345'));
  assert.notEqual(nativeRequestId('one','watcher-12345'),nativeRequestId('two','watcher-12345'));
  assert.match(nativeRequestId('one','watcher-12345'),/^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.throws(()=>nativeRequestId('one','bad/id'));
});

async function fixture(t){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'dsg-native-client-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const f={calls:[],api_key:'fixture-api-key-000000',control_token:'fixture-control-key-000000',changed:false,unavailable:false,reads:0};
  const server=http.createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;const body=raw?JSON.parse(raw):null;
    f.calls.push({route:req.url,body});res.setHeader('content-type','application/json');
    const control=req.url.includes('/platforms/');
    if(req.headers.authorization!=='Bearer '+f[control?'control_token':'api_key']){res.statusCode=401;return res.end('{}');}
    if(f.unavailable){res.statusCode=503;return res.end('{"secret":"must-not-leak"}');}
    if(body?.action==='session'){f.reads++;return res.end(JSON.stringify({...observed,session_id:f.changed&&f.reads>1?'changed-session':'native-session'}));}
    if(body?.action==='send')return res.end(JSON.stringify({state:f.dispatchState??'accepted_unverified',request_id:body.request_id}));
    if(body?.action==='status')return res.end(JSON.stringify({state:'unknown',request_id:body.request_id}));
    assert.equal(body?.action,'transcript');
    const data=rows.slice(body.offset,body.offset+body.limit);
    const page={state:'observed',session_key:observed.session_key,session_id:'native-session',revision:(f.historyChanged&&body.offset>0?'b':'a').repeat(64),data,pagination:{offset:body.offset,limit:body.limit,returned:data.length,total:rows.length,order:'oldest'}};
    if(f.badPage)page.pagination.returned=0;
    res.end(JSON.stringify(page));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();return new Promise(r=>server.close(r));});
  const descriptor=path.join(directory,'native.json');
  f.save=()=>fs.writeFileSync(descriptor,JSON.stringify({url:'http://127.0.0.1:'+server.address().port,api_key:f.api_key,control_token:f.control_token}),{mode:0o600});f.save();
  f.client=new NativeHermesChatClient({descriptor,bindings:[{id:'conversation',session_key:observed.session_key}]});f.descriptor=descriptor;return f;
}

test('native client reads actual HTTP messages and uses only the session injector for input',async t=>{
  const f=await fixture(t);const view=await f.client.read('conversation');assert.equal(view.messages[1].power.events[0].result.state,'running');
  const accepted=await f.client.submit('conversation','Inspect the service.','watcher-12345');assert.equal(accepted.state,'accepted_unverified');
  const sent=f.calls.find(c=>c.body?.action==='send');assert.equal(sent.body.session_key,observed.session_key);
  assert.ok(f.calls.every(c=>!c.route.endsWith('/chat')));
  f.api_key='rotated-fixture-api-key';f.control_token='rotated-fixture-control-key';f.save();
  assert.equal((await f.client.read('conversation')).native_session_id,'native-session');
  await assert.rejects(f.client.submit('other','Inspect','request-12345'),/not connected/);
});

test('routing changes and unavailable observations never become empty history or automatic replay',async t=>{
  const f=await fixture(t);f.changed=true;await assert.rejects(f.client.read('conversation'),/changed during observation/);
  f.unavailable=true;const before=f.calls.length;
  await assert.rejects(f.client.submit('conversation','Inspect','request-12345'),error=>/could not be confirmed/.test(error.message)&&!error.message.includes('must-not-leak'));
  assert.equal(f.calls.length,before+1,'Uncertain send is not retried by the client');
  await assert.rejects(f.client.read('conversation'),/could not be confirmed/);
});
test('native rejected and uncertain dispatch states cannot be counted as accepted follow-ups',async t=>{
  const f=await fixture(t);
  for(const state of ['rejected','not_accepted','unknown','dispatching']){
    f.dispatchState=state;
    await assert.rejects(f.client.submit('conversation','Inspect','request-12345'),/acceptance is unconfirmed/);
  }
  assert.equal(f.calls.length,4);
  assert.equal(new Set(f.calls.map(c=>c.body.request_id)).size,1);
});

test('native descriptor rejects shared files and nonlocal credential destinations',async t=>{
  const f=await fixture(t);fs.chmodSync(f.descriptor,0o644);assert.throws(()=>readNativeGatewayDescriptor(f.descriptor),/private/);
  fs.chmodSync(f.descriptor,0o600);fs.writeFileSync(f.descriptor,JSON.stringify({url:'https://example.invalid/',api_key:f.api_key,control_token:f.control_token}));
  assert.throws(()=>readNativeGatewayDescriptor(f.descriptor),/local/);
});

test('paged native display joins tool calls across pages and rejects shifting or malformed history',async t=>{
  const f=await fixture(t);
  const page=await f.client.read('conversation',{limit:2});assert.equal(page.history_complete,false);
  const full=await f.client.read('conversation',{limit:2,all:true});
  assert.equal(full.history_complete,true);assert.equal(full.messages.length,2);
  assert.deepEqual(full.messages[1].power.events[0].request,{worker:'fixture'});
  const continued=f.calls.filter(c=>c.body?.action==='transcript'&&c.body.offset===2);
  assert.equal(continued[0].body.revision,'a'.repeat(64));
  f.historyChanged=true;await assert.rejects(f.client.read('conversation',{limit:2,all:true}),/changed during observation/);
  f.historyChanged=false;f.badPage=true;await assert.rejects(f.client.read('conversation',{all:true}),/evidence is unavailable/);
});

test('native inspection and research receipts remain usable by existing study evidence',()=>{
  const messages=[{id:1,role:'user',content:'Study this setup.',timestamp:100}];
  const tool=(name,args,value)=>{
    const id='call-'+messages.length;
    messages.push({id:messages.length+1,role:'assistant',content:'',timestamp:101,tool_calls:[{id,function:{name,arguments:JSON.stringify(args)}}]},
      {id:messages.length+2,role:'tool',tool_call_id:id,content:JSON.stringify(value),timestamp:102});
  };
  tool('read_server_configuration',{worker_id:'fixture'},{worker_id:'fixture',read_at:'record-time'});
  tool('inspect_server',{worker_id:'fixture',selected_default:false},{observed_at:'live-time',sources:{status:'read',files:[{path:'runtime.py',status:'read',sha256:'fixture-sha'}]}});
  tool('stargate_web_extract',{url:'https://example.invalid/docs'},{url:'https://example.invalid/docs',content:'public source',content_sha256:'source-sha',truncated:false});
  const view=projectNativeConversation({id:'conversation',session:observed,messages,pagination:{offset:0,limit:500,returned:messages.length,total:messages.length}});
  const evidence=studyEvidence(view.messages.filter(m=>m.role==='assistant'));
  assert.equal(evidence.workers[0].record_read_at,'record-time');assert.equal(evidence.workers[0].live_read_at,'live-time');
  assert.equal(evidence.workers[0].source_files[0].sha256,'fixture-sha');assert.deepEqual(evidence.pages_read,['https://example.invalid/docs']);
});
