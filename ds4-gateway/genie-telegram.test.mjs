import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {GenieChat} from './genie-chat.mjs';
import {GenieTelegram,telegramChunks,telegramAPI} from './genie-telegram.mjs';
import {createDashboard} from './dashboard.mjs';

const token='123456789:'+('test_only_').repeat(4);
function message(id,text,{user=42,type='private',...extra}={}){return {update_id:id,message:{message_id:id,chat:{id:user,type},from:{id:user,first_name:'Owner',is_bot:false},text,...extra}};}
function fixture(t,{answer=async()=>({text:'The actual saved Genie answer.'}),call:override}={}){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'sg-telegram-'));let generations=0;const sent=[];
  const chat=new GenieChat({directory:path.join(directory,'chat'),provider:{info:{mode:'fixture'},async generate(input){generations++;return answer(input);},close(){}}});
  const call=async(_token,method,body)=>{
    if(override)return override(method,body);
    if(method==='getMe')return {id:123456789,is_bot:true,username:'fixture_genie_bot'};
    if(method==='getWebhookInfo')return {url:''};
    if(method==='getUpdates')return [];
    if(method==='sendMessage'){sent.push(body);return {message_id:sent.length,chat:{id:body.chat_id}};}
    throw Error('Unexpected API method');
  };
  const options={directory:path.join(directory,'telegram'),chat,call,snapshot:()=>({gateway:{workers:[{is_healthy:true,drained:false}],active:1}})};
  const bridge=new GenieTelegram(options);
  t.after(()=>{bridge.close();chat.close();fs.rmSync(directory,{recursive:true,force:true});});
  return {directory,chat,bridge,options,sent,generations:()=>generations};
}
async function pair(f){await f.bridge.configure({bot_token:token});const code=new URL(f.bridge.status().pairing_url).searchParams.get('start');await f.bridge.accept(message(1,'/start '+code));await f.bridge.flush();}

test('local setup verifies bot and preserves an existing webhook, without exposing token in status',async t=>{
  const f=fixture(t);const status=await f.bridge.configure({bot_token:token});assert.ok(status.pairing_url.startsWith('https://t.me/fixture_genie_bot?start='));
  assert.doesNotMatch(JSON.stringify(status),new RegExp(token));assert.equal(fs.statSync(f.bridge.tokenFile).mode&0o777,0o600);assert.equal(fs.statSync(f.bridge.file).mode&0o777,0o600);
  await assert.rejects(f.bridge.configure({bot_token:token}),/Disconnect/);
  const g=fixture(t,{call:async method=>method==='getMe'?{id:123456789,is_bot:true,username:'fixture_genie_bot'}:{url:'https://existing.example.test/webhook'}});
  await assert.rejects(g.bridge.configure({bot_token:token}),/existing connection was preserved/);assert.equal(fs.existsSync(g.bridge.tokenFile),false);assert.equal(g.bridge.state.enabled,false);
});
test('pairing is one private user, rejects group and forwarded starts, and expires',async t=>{
  const f=fixture(t);await f.bridge.configure({bot_token:token});const code=f.bridge.state.pairing.code;
  await f.bridge.accept(message(1,'/start '+code,{type:'group'}));await f.bridge.accept(message(2,'/start '+code,{forward_origin:{type:'user'}}));
  await f.bridge.accept(message(3,'/start wrong'));assert.equal(f.bridge.state.owner,null);assert.equal(f.sent.length,0);
  await f.bridge.accept(message(4,'/start '+code));assert.equal(f.bridge.state.owner.user_id,42);assert.equal(f.bridge.state.pairing,null);
  await f.bridge.accept(message(5,'show private fleet',{user:99}));assert.equal(Object.keys(f.bridge.state.inbox).length,0);
  const g=fixture(t);await g.bridge.configure({bot_token:token});const expired=g.bridge.state.pairing.code;g.bridge.state.pairing.expires_at=0;
  await g.bridge.accept(message(1,'/start '+expired));assert.equal(g.bridge.state.owner,null);
});
test('Telegram and dashboard share the exact selected conversation and duplicate updates never rerun Genie',async t=>{
  const f=fixture(t);const existing=f.chat.create({title:'Fleet audit'});await pair(f);f.bridge.selectConversation(existing.id);
  await f.bridge.accept(message(2,'Inspect the fleet.'));await f.bridge.accept(message(2,'Inspect the fleet.'));await f.bridge.flush();await f.chat.idle();await f.bridge.flush();
  assert.equal(f.generations(),1);const conversation=f.chat.get(existing.id);assert.equal(conversation.messages[0].text,'Inspect the fleet.');assert.equal(conversation.messages[1].text,'The actual saved Genie answer.');
  assert.ok(f.sent.some(m=>m.text==='The actual saved Genie answer.'));
  const restored=new GenieTelegram(f.options);await restored.accept(message(2,'Inspect the fleet.'));await restored.flush();restored.close();assert.equal(f.generations(),1);
});
test('durable inbound intent survives a crash between chat submission and reply observation',async t=>{
  const f=fixture(t);await pair(f);await f.bridge.accept(message(2,'Run once.'));
  const row=Object.values(f.bridge.state.inbox)[0];f.chat.submit(row.conversation_id,row.text,row.request_id);await f.chat.idle();
  const restored=new GenieTelegram(f.options);await restored.flush();restored.close();assert.equal(f.generations(),1);assert.ok(f.sent.some(m=>m.text==='The actual saved Genie answer.'));
});
test('suspended Genie questions stay saved until available, without silent cancellation',async t=>{
  const f=fixture(t);await pair(f);let suspended=true;f.chat.isSuspended=()=>suspended;
  await f.bridge.accept(message(2,'Wait for testing to finish.'));await f.bridge.flush();assert.equal(f.generations(),0);assert.equal(f.bridge.status().pending,1);
  suspended=false;await f.bridge.flush();await f.chat.idle();await f.bridge.flush();assert.equal(f.generations(),1);assert.equal(f.bridge.status().pending,0);
});
test('unconfirmed outbound delivery never reruns Genie or automatically resends; /last explicitly retrieves saved answer',async t=>{
  const f=fixture(t);await pair(f);await f.bridge.accept(message(2,'One action.'));await f.bridge.flush();await f.chat.idle();
  const original=f.bridge.call;let attempts=0;
  f.bridge.call=async(_token,method)=>{assert.equal(method,'sendMessage');attempts++;throw Object.assign(Error('connection lost'),{uncertain:true});};
  await f.bridge.flush();await f.bridge.flush();assert.equal(attempts,1);assert.equal(f.bridge.status().uncertain_deliveries,1);assert.equal(f.generations(),1);
  f.bridge.call=original;await f.bridge.accept(message(3,'/last'));await f.bridge.flush();assert.equal(f.generations(),1);assert.ok(f.sent.some(m=>m.text==='The actual saved Genie answer.'));
});
test('sending intent found after restart becomes uncertain and is never automatically replayed',async t=>{
  const f=fixture(t);await pair(f);f.bridge.enqueue('crash-send','Retained answer');const row=Object.values(f.bridge.state.outbox).at(-1);row.state='sending';f.bridge.save();
  const before=f.sent.length,restored=new GenieTelegram(f.options);await restored.flush();assert.equal(f.sent.length,before);assert.equal(restored.status().uncertain_deliveries,1);restored.close();
});
test('old long-poll completion cannot pair or submit after disconnect and reconnect',async t=>{
  const f=fixture(t);await pair(f);let finish;
  f.bridge.call=async(_token,method)=>{assert.equal(method,'getUpdates');return await new Promise(r=>finish=r);};
  const pending=f.bridge.poll();f.bridge.disconnect();finish([message(9,'Do not run this old update.')]);await pending;assert.equal(Object.keys(f.bridge.state.inbox).length,0);assert.equal(f.generations(),0);
});
test('status uses observed fleet/conversation state and is not another model request',async t=>{
  const f=fixture(t);await pair(f);await f.bridge.accept(message(2,'/status'));await f.bridge.flush();assert.equal(f.generations(),0);
  assert.match(f.sent.at(-1).text,/1 eligible model servers; 1 active requests/);
});
test('new dashboard and automatic follow-up replies are mirrored, but selecting a chat does not export its old history',async t=>{
  const f=fixture(t),existing=f.chat.create({title:'Selected audit'});
  f.chat.submit(existing.id,'Old private history.','old-request-123');await f.chat.idle();await pair(f);f.bridge.selectConversation(existing.id);
  const before=f.sent.length;await f.bridge.flush();assert.equal(f.sent.length,before);
  f.chat.submit(existing.id,'A new dashboard question.','new-request-123');await f.chat.idle();await f.bridge.flush();
  assert.equal(f.sent.length,before+1);await f.bridge.flush();assert.equal(f.sent.length,before+1);
});
test('rate limit delays all later chunks without changing the Genie request',async t=>{
  const f=fixture(t);await pair(f);const original=f.bridge.call;let attempts=0,now=100000;f.bridge.now=()=>now;
  f.bridge.enqueue('rate-limited','A'.repeat(7000));
  f.bridge.call=async()=>{attempts++;throw Object.assign(Error('rate limit'),{code:429,retry_after:30});};
  await f.bridge.flush();await f.bridge.flush();assert.equal(attempts,1);
  now+=31000;f.bridge.call=original;await f.bridge.flush();assert.equal(f.sent.at(-1).text.length,3500);
});
test('long Unicode answers are retained and split without broken surrogate pairs',()=>{
  const text=('🙂'+String.raw`literal <tag> **not HTML** `).repeat(500),chunks=telegramChunks(text);
  assert.equal(chunks.join(''),text);assert.ok(chunks.length>1);for(const chunk of chunks){assert.ok(chunk.length<=3500);assert.ok(!/[\uD800-\uDBFF]$/.test(chunk));}
});
test('Telegram API errors do not expose bot credentials, and redirects cannot forward them',async t=>{
  const original=globalThis.fetch;t.after(()=>globalThis.fetch=original);
  globalThis.fetch=async(url,options)=>{assert.equal(options.redirect,'error');throw Error('raw secret '+url);};
  await assert.rejects(telegramAPI(token,'getMe'),e=>e.uncertain&&!e.message.includes(token)&&!e.message.includes('https:'));
  globalThis.fetch=async()=>({ok:false,status:401,json:async()=>({ok:false,error_code:401,description:'leaked '+token})});
  await assert.rejects(telegramAPI(token,'getMe'),e=>e.code===401&&!e.message.includes(token));
});
test('local setup HTTP endpoint requires same-origin CSRF, rejects unknown fields, and never returns token',async t=>{
  const f=fixture(t);const server=createDashboard(()=>({}),undefined,null,null,null,null,null,null,f.chat,null,null,null,null,null,null,null,null,f.bridge);
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close();});const base=`http://127.0.0.1:${server.address().port}`;
  const status=await(await fetch(base+'/api/genie/telegram')).json();assert.ok(status.csrf_token);assert.equal(status.available,true);
  const post=(body,headers={})=>fetch(base+'/api/genie/telegram',{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});
  assert.equal((await post({action:'connect',bot_token:token})).status,403);
  assert.equal((await post({action:'connect',bot_token:token},{origin:'http://other.example','x-dsg-csrf':status.csrf_token})).status,403);
  const headers={origin:base,'x-dsg-csrf':status.csrf_token};
  assert.equal((await post({action:'connect',bot_token:token,extra:'no'},headers)).status,400);
  const connected=await post({action:'connect',bot_token:token},headers);assert.equal(connected.status,200);assert.ok(!(await connected.text()).includes(token));
  const html=await(await fetch(base)).text();assert.match(html,/id="telegram-token" type="password"/);assert.match(html,/\/genie-telegram.js/);
  const script=await(await fetch(base+'/genie-telegram.js')).text();assert.doesNotMatch(script,/localStorage|sessionStorage|innerHTML/);
});
