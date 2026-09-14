import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {GenieChat} from './genie-chat.mjs';
import {createDashboard} from './dashboard.mjs';
const DAY=86400000;
function rig(t,{generate}={}){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'sg-study-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  let now=1700000000000,calls=[],suspended=false;
  const provider={info:{research_available:true},generate:generate??(async x=>{calls.push(x);x.onResearch({kind:'search',state:'complete',at:new Date(now).toISOString(),sources:[{url:'https://example.com/docs',title:'Public docs'}]});return {text:'One supported suggestion.'};})};
  const options={directory,provider,now:()=>now,isSuspended:()=>suspended,getSnapshot:()=>({time:now,gateway:{workers:[]},server_records:{configured:true,records:[]}})};
  const chat=new GenieChat(options);t.after(()=>chat.close());
  return {chat,calls,options,advance:ms=>{now+=ms;},suspend:v=>{suspended=v;},change:(action,extra={})=>chat.study.change({action,expected_revision:chat.study.status().revision,...extra})};
}
test('reminders remain off until selected; due/skip/postpone/reload never call a model',t=>{
  const r=rig(t);assert.equal(r.chat.status().study.interval_days,0);r.advance(40*DAY);assert.equal(r.chat.study.status().due,false);
  r.change('study-schedule',{interval_days:7});r.advance(7*DAY);assert.equal(r.chat.study.status().due,true);
  const restored=new GenieChat(r.options);assert.equal(restored.study.status().due,true);restored.close();
  const stale=r.chat.study.status().revision;r.change('study-postpone');assert.equal(r.chat.study.status().due,false);r.advance(DAY);assert.equal(r.chat.study.status().due,true);
  assert.throws(()=>r.chat.study.change({action:'study-skip',expected_revision:stale}),/changed/);
  r.change('study-skip');r.advance(6*DAY);assert.equal(r.chat.study.status().due,false);r.advance(DAY);assert.equal(r.chat.study.status().due,true);
  r.change('study-schedule',{interval_days:0});assert.equal(r.chat.study.status().next_due_at,null);assert.equal(r.calls.length,0);
});
test('an explicitly started study uses native chat, keeps source evidence and is idempotent after reload',async t=>{
  const r=rig(t),id=randomUUID(),input={action:'study-start',expected_revision:0,request_id:id};
  const accepted=r.chat.study.change(input);assert.equal(accepted.last_run.state,'working');
  assert.deepEqual(r.chat.study.change(input),accepted);await r.chat.idle();assert.equal(r.calls.length,1);
  const call=r.calls[0];assert.equal(call.research,true);assert.match(call.message,/exact configuration revisions/);assert.match(call.message,/one short/);assert.match(call.message,/unapproved/);assert.match(call.message,/does not authorize benchmarks/);
  const conversation=r.chat.get(accepted.last_run.conversation_id);assert.equal(conversation.messages[1].research.events[0].sources[0].url,'https://example.com/docs');assert.ok(conversation.messages[1].context.configuration_records);
  const restored=new GenieChat(r.options);assert.equal(restored.study.change(input).last_run.state,'complete');await restored.idle();assert.equal(r.calls.length,1);restored.close();
  assert.equal(fs.statSync(r.chat.study.file).mode&0o777,0o600);
});
test('busy studies, testing mode and unavailable research cannot start another request',async t=>{
  let finish;const r=rig(t,{generate:()=>new Promise(resolve=>{finish=resolve;})});
  r.change('study-start',{request_id:randomUUID()});await new Promise(resolve=>setImmediate(resolve));
  assert.throws(()=>r.change('study-start',{request_id:randomUUID()}),/already running/);finish({text:'Done'});await r.chat.idle();
  r.suspend(true);assert.throws(()=>r.change('study-start',{request_id:randomUUID()}),/Connect Genie/);r.suspend(false);
  r.chat.provider.info.research_available=false;assert.throws(()=>r.change('study-start',{request_id:randomUUID()}),/Connect Genie/);
});
test('uncertain accepted intent survives a restart without replay',t=>{
  const r=rig(t),original=r.chat.submit.bind(r.chat);r.chat.submit=()=>{throw new Error('Simulated pre-submit interruption');};
  const request_id=randomUUID();assert.throws(()=>r.change('study-start',{request_id}),/interruption/);
  r.chat.submit=original;const restored=new GenieChat(r.options);assert.equal(restored.study.status().last_run.state,'not_started');
  assert.equal(restored.study.change({action:'study-start',expected_revision:0,request_id}).last_run.state,'not_started');assert.equal(r.calls.length,0);restored.close();
});
test('corrupt reminder state is preserved while ordinary chat remains usable',async t=>{
  const r=rig(t);fs.writeFileSync(r.chat.study.file,'invalid-json');const restored=new GenieChat(r.options);
  assert.match(restored.study.status().error,/preserved/);assert.throws(()=>restored.study.change({action:'study-schedule',expected_revision:0,interval_days:7}),/preserved/);
  const c=restored.create();restored.submit(c.id,'hello','ordinary-message');await restored.idle();assert.equal(restored.get(c.id).messages[1].state,'complete');assert.equal(fs.readFileSync(r.chat.study.file,'utf8'),'invalid-json');restored.close();
});
test('failed reminder persistence never starts model work',t=>{
  const r=rig(t);r.chat.study.save=()=>{throw new Error('Disk full');};assert.throws(()=>r.change('study-start',{request_id:randomUUID()}),/Disk full/);assert.equal(r.calls.length,0);assert.equal(r.chat.jobs.size,0);assert.equal(r.chat.study.status().last_run,null);
});
test('study controls use existing same-origin CSRF checks and reject extra authority fields',async t=>{
  const r=rig(t),server=createDashboard(()=>({}),undefined,null,null,null,null,null,null,r.chat);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  const base=`http://127.0.0.1:${server.address().port}`,status=await(await fetch(base+'/api/genie/chat')).json();
  const input={action:'study-start',expected_revision:0,request_id:randomUUID()};
  const post=(body,headers={})=>fetch(base+'/api/genie/chat',{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});
  assert.equal((await post(input)).status,403);assert.equal(r.calls.length,0);
  const headers={origin:base,'x-dsg-csrf':status.csrf_token};assert.equal((await post({...input,approve_server_changes:true},headers)).status,400);assert.equal(r.calls.length,0);
  assert.equal((await post(input,headers)).status,200);await r.chat.idle();assert.equal(r.calls.length,1);
});
