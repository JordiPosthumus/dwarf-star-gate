// Full native channel test: isolated profile, fake Bot API/model/tools, no real secrets.
import {fileURLToPath} from 'node:url';
import {NativeHermesChatClient} from '../ds4-gateway/genie-native-chat.mjs';
import fs from 'node:fs';import path from 'node:path';import http from 'node:http';import net from 'node:net';import {spawn} from 'node:child_process';import assert from 'node:assert/strict';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),source=process.argv[2];
if(!source||!path.isAbsolute(source)||!fs.existsSync(path.join(source,'.venv/bin/python')))throw Error('Provide the absolute installed native Hermes source directory');
const home=fs.mkdtempSync('/tmp/dsg-hermes-fixture-');fs.chmodSync(home,0o700);let child,modelCalls=0,toolCalls=0;let holdNextModel=false,heldModel=false,releaseModel;const serverErrors=[],telegramCalls=[],fakeToken='999999:fixture-not-a-real-bot-token';let updates=[{update_id:100,message:{message_id:101,date:Math.floor(Date.now()/1000),chat:{id:12345,type:'private',first_name:'Fixture'},from:{id:12345,is_bot:false,first_name:'Fixture'},text:'Read the existing fixture action status.'}}];const key='native-fixture-key-0123456789abcdef',token='native-bridge-fixture-0123456789';
const server=http.createServer((req,res)=>{let raw='';req.on('data',x=>raw+=x);req.on('end',async()=>{try{const body=raw?(req.headers['content-type']?.includes('application/json')?JSON.parse(raw):Object.fromEntries(new URLSearchParams(raw))):{};
if(req.url.startsWith('/bot')){
 const method=req.url.split('/').at(-1);telegramCalls.push({method,body});let result=true;
 if(method==='getMe')result={id:999999,is_bot:true,first_name:'Fixture Genie',username:'FixtureGenieBot'};
 if(method==='getWebhookInfo')result={url:'',pending_update_count:updates.length};
 if(method==='deleteWebhook'&&(body.drop_pending_updates===true||body.drop_pending_updates==='true'))updates=[];
 if(method==='getUpdates'){const offset=Number(body.offset||0);updates=updates.filter(u=>u.update_id>=offset);result=[...updates];res.setHeader('content-type','application/json');setTimeout(()=>{if(!res.destroyed)res.end(JSON.stringify({ok:true,result}));},result.length?0:300);return;}
 if(['sendMessage','editMessageText'].includes(method))result={message_id:200+telegramCalls.length,date:Math.floor(Date.now()/1000),chat:{id:12345,type:'private'},text:body.text||''};
 res.setHeader('content-type','application/json');res.end(JSON.stringify({ok:true,result}));return;
}
if(req.url==='/api/genie/native-tools'){assert.equal(req.headers['x-sg-native-tool'],token);res.end(JSON.stringify({schema:1,context:{servers:[],genie_capabilities:{fleet_power:true}},enabled_sections:['power'],tools:{power:{url:origin+'/api/genie/power-tools',token}}}));return;}
if(req.url==='/api/genie/power-tools'){assert.equal(req.headers['x-sg-power-tool'],token);toolCalls++;res.end(JSON.stringify({state:'complete',fixture:'native-gateway-tool-receipt'}));return;}
if(req.method==='GET'){res.end(JSON.stringify({data:[{id:'fixture',context_length:131072}]}));return;}
assert.match(req.url,/chat\/completions/);modelCalls++;
if(holdNextModel){holdNextModel=false;heldModel=true;await new Promise(resolve=>{releaseModel=resolve;});}
fs.appendFileSync(home+'/model-requests.jsonl',JSON.stringify({roles:body.messages?.map(m=>m.role),tools:body.tools?.map(t=>t.function?.name),last:body.messages?.at(-1)})+'\n',{mode:0o600});
const hasReceipt=JSON.stringify(body.messages).includes('native-gateway-tool-receipt');const shouldCall=!hasReceipt&&body.tools?.length>0;
const message=shouldCall?{role:'assistant',content:null,tool_calls:[{id:'native-tool-1',type:'function',function:{name:'tool_call',arguments:JSON.stringify({name:'fleet_power_status',arguments:{action_id:'12345678-1234-4234-8234-123456789012'}})}}]}:{role:'assistant',content:'Native Hermes gateway executed the enrolled tool.'};

if(body.stream){res.setHeader('Content-Type','text/event-stream');res.end('data: '+JSON.stringify({id:'fixture',model:'fixture',choices:[{index:0,delta:{...message,...(message.tool_calls?{tool_calls:message.tool_calls.map((v,index)=>({...v,index}))}:{})},finish_reason:null}]})+'\n\ndata: '+JSON.stringify({id:'fixture',model:'fixture',choices:[{index:0,delta:{},finish_reason:shouldCall?'tool_calls':'stop'}]})+'\n\ndata: [DONE]\n\n');}else res.end(JSON.stringify({id:'fixture',model:'fixture',choices:[{message,finish_reason:shouldCall?'tool_calls':'stop'}]}));
}catch(error){serverErrors.push(error.message);res.statusCode=500;res.end(JSON.stringify({error:'Fixture protocol assertion failed'}));}});});await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
const portProbe=net.createServer();await new Promise(r=>portProbe.listen(0,'127.0.0.1',r));const port=portProbe.address().port;await new Promise(r=>portProbe.close(r));
const write=(file,value)=>fs.writeFileSync(path.join(home,file),typeof value==='string'?value:JSON.stringify(value,null,2),{mode:0o600});
fs.mkdirSync(home+'/plugins',{mode:0o700});fs.cpSync(repo+'/integrations/hermes-stargate',home+'/plugins/stargate',{recursive:true});
write('bridge.json',{url:origin+'/api/genie/native-tools',token});
const cfg={display:{busy_input_mode:'queue'},model:{default:'fixture',provider:'custom',base_url:origin+'/v1',context_length:131072},platform_toolsets:{api_server:['stargate_native'],telegram:['stargate_native'],stargate_control:['stargate_native']},plugins:{enabled:['stargate','telegram'],entries:{stargate:{allow_gateway_injection:true,settings:{enable_ui_bridge:true,module_directory:repo+'/ds4-gateway',bridge_descriptor:home+'/bridge.json'}}}},platforms:{stargate_control:{enabled:true,token:key,gateway_restart_notification:false,extra:{allowed_session_keys:['agent:main:telegram:dm:12345'],dashboard_owner_id:'12345'}},telegram:{enabled:true,token:fakeToken,extra:{preserve_pending_updates:true,base_url:origin+'/bot',base_file_url:origin+'/file/bot'}},api_server:{enabled:true,extra:{host:'127.0.0.1',port,key}}}};
write('native-gateway.json',{url:'http://127.0.0.1:'+port,api_key:key,control_token:key});
const nativeChat=new NativeHermesChatClient({descriptor:home+'/native-gateway.json',bindings:[{id:'fixture-conversation',session_key:'agent:main:telegram:dm:12345'}]});
write('config.yaml',cfg);write('SOUL.md','You are a native gateway integration fixture.');write('AGENTS.md','Use only fixture tools. No real servers or external channels are configured.');
const log=fs.openSync(home+'/gateway.log','w',0o600);
try{
const launch=()=>spawn(source+'/.venv/bin/python',['-B',repo+'/scripts/run-native-hermes.py','--config',home+'/config.yaml'],{cwd:home,env:{PATH:process.env.PATH,HOME:home,HERMES_HOME:home,PYTHONPATH:source,HERMES_DISABLE_LAZY_INSTALLS:'1',PYTHONDONTWRITEBYTECODE:'1',PYTHONUNBUFFERED:'1',OPENAI_BASE_URL:origin+'/v1',OPENAI_API_KEY:'fixture-local-key',API_SERVER_KEY:key,API_SERVER_PORT:String(port),API_SERVER_HOST:'127.0.0.1',TELEGRAM_BOT_TOKEN:fakeToken,TELEGRAM_ALLOWED_USERS:'12345',DSG_DASHBOARD_ALLOWED_USERS:'12345',HERMES_TELEGRAM_DISABLE_FALLBACK_IPS:'1',LANG:'en_US.UTF-8'},stdio:['ignore',log,log]});
child=launch();
let ready=false;for(let i=0;i<50;i++){if(child.exitCode!==null)throw Error('Native gateway exited; inspect '+home+'/gateway.log');try{const r=await fetch('http://127.0.0.1:'+port+'/v1/models',{headers:{authorization:'Bearer '+key},signal:AbortSignal.timeout(1000)});if(r.ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,500));}
assert.ok(ready,'Native gateway API readiness');
for(let i=0;i<100;i++){
 if(telegramCalls.some(c=>c.method==='deleteWebhook'&&(c.body.drop_pending_updates===true||c.body.drop_pending_updates==='true')))break;
 if(telegramCalls.some(c=>c.method==='sendMessage'&&c.body.text?.includes('executed the enrolled tool')))break;
 await new Promise(r=>setTimeout(r,300));
}
const nativeRequest={action:'send',request_id:'12345678-1234-4234-8234-123456789abc',session_key:'agent:main:telegram:dm:12345',message:'Dashboard follow-up: recall the existing tool receipt from our Telegram history.'};
const control=async(payload,auth=key)=>{const response=await fetch('http://127.0.0.1:'+port+'/api/platforms/stargate_control/events',{method:'POST',headers:{authorization:'Bearer '+auth,'content-type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(5000)});return {status:response.status,body:await response.json()};};
assert.equal((await control(nativeRequest,'wrong-owner-token')).status,401,'Unauthenticated UI input rejected');
assert.equal((await control({...nativeRequest,session_key:'agent:main:telegram:dm:54321'})).body.state,'rejected','Other sessions cannot receive UI input');
const submitted=await control(nativeRequest);assert.equal(submitted.status,200);assert.equal(submitted.body.state,'accepted_unverified',JSON.stringify(submitted));
assert.deepEqual((await control(nativeRequest)).body,submitted.body,'Duplicate UI submission is not injected twice');
assert.equal((await control({...nativeRequest,message:'Different instruction'})).body.state,'rejected','Request identity cannot change instructions');
for(let i=0;i<100;i++){if(telegramCalls.filter(c=>c.method==='sendMessage'&&c.body.text?.includes('executed the enrolled tool')).length>=2)break;await new Promise(r=>setTimeout(r,300));}
assert.equal(telegramCalls.filter(c=>c.method==='sendMessage'&&c.body.text?.includes('executed the enrolled tool')).length,2,'Dashboard follow-up replies through native Telegram');
assert.equal(toolCalls,1,'Dashboard input shares the native Telegram history');
const nativeBefore=await nativeChat.read('fixture-conversation');
assert.equal(nativeBefore.messages.filter(m=>m.role==='user').length,2,'Dashboard reads both native Telegram and dashboard inputs');
assert.equal(nativeBefore.messages.flatMap(m=>m.power?.events??[]).length,1,'Dashboard reads the native tool receipt');
assert.equal(nativeBefore.history_complete,true);
holdNextModel=true;
updates.push({update_id:101,message:{message_id:102,date:Math.floor(Date.now()/1000),chat:{id:12345,type:'private',first_name:'Fixture'},from:{id:12345,is_bot:false,first_name:'Fixture'},text:'Continue our history in this deliberately slow fixture turn.'}});
for(let i=0;i<100&&!heldModel;i++)await new Promise(r=>setTimeout(r,100));
assert.ok(heldModel,'Native Telegram turn reached the delayed provider');
const callsWhileHeld=modelCalls;
const queuedRequest={...nativeRequest,request_id:'12345678-1234-4234-8234-123456789abd',message:'Dashboard input queued while the Telegram turn is still running.'};
assert.equal((await nativeChat.session('fixture-conversation')).busy,true,'Native scheduler reports the held turn as busy');
assert.equal((await nativeChat.submit('fixture-conversation',queuedRequest.message,'watcher-follow-up-fixture')).state,'accepted_unverified');
assert.equal((await nativeChat.submit('fixture-conversation',queuedRequest.message,'watcher-follow-up-fixture')).state,'accepted_unverified');
await nativeChat.submit('fixture-conversation','A second distinct dashboard follow-up must run in order.','watcher-second-follow-up-fixture');
await new Promise(r=>setTimeout(r,1000));
assert.equal((await nativeChat.session('fixture-conversation')).queued,2,'Native FIFO depth includes both pending dashboard instructions');
assert.equal(modelCalls,callsWhileHeld,'Dashboard input must not start a competing agent turn or interrupt the active turn');
releaseModel();
for(let i=0;i<150;i++){if(telegramCalls.filter(c=>c.method==='sendMessage'&&c.body.text?.includes('executed the enrolled tool')).length>=5)break;await new Promise(r=>setTimeout(r,200));}
assert.equal(telegramCalls.filter(c=>c.method==='sendMessage'&&c.body.text?.includes('executed the enrolled tool')).length,5,'The held Telegram turn and both distinct queued dashboard turns complete');
assert.equal(toolCalls,1,'Queued native turn preserves tool history');
const beforeUnauthorized=modelCalls;
updates.push({update_id:102,message:{message_id:103,date:Math.floor(Date.now()/1000),chat:{id:54321,type:'private',first_name:'Untrusted'},from:{id:54321,is_bot:false,first_name:'Untrusted'},text:'Run the fleet power tool.'}});
await new Promise(r=>setTimeout(r,2000));
assert.equal(modelCalls,beforeUnauthorized,'Unauthorized Telegram sender must not reach the agent');
const created=await nativeChat.create({id:'22222222-2222-4222-8222-222222222222',title:'Dashboard research',purpose:'setup_research'});
assert.equal(created.history_complete,true);assert.equal(created.messages.length,0);
assert.equal((await nativeChat.create({id:created.id,title:'Dashboard research',purpose:'setup_research'})).native_session_id,created.native_session_id,'Creation retry keeps the same native session');
child.kill('SIGTERM');await Promise.race([new Promise(r=>child.once('exit',r)),new Promise(r=>setTimeout(r,5000))]);
assert.notEqual(child.exitCode,null,'Fixture gateway must stop before restart');
// Native Hermes deliberately disables SO_REUSEADDR on macOS to prevent two
// listeners sharing traffic. Wait for its same-port TIME_WAIT guard, not a
// different port that would hide restart behavior from the acceptance test.
let reusable=false;const reuseStarted=Date.now();
for(let i=0;i<80;i++){
 const probe=spawn(source+'/.venv/bin/python',['-c',`import socket; s=socket.socket(); s.bind(('127.0.0.1',${port})); s.close()`],{stdio:'ignore'});
 if(await new Promise(r=>probe.once('exit',code=>r(code===0)))){reusable=true;break;}
 await new Promise(r=>setTimeout(r,1000));
}
assert.ok(reusable,'Native API port must become reusable before restart');
const restartPortWaitMs=Date.now()-reuseStarted;
updates.push({update_id:103,message:{message_id:104,date:Math.floor(Date.now()/1000),chat:{id:12345,type:'private',first_name:'Fixture'},from:{id:12345,is_bot:false,first_name:'Fixture'},text:'What action outcome did you just read? Use our conversation history.'}});
child=launch();
for(let i=0;i<150;i++){
 if(child.exitCode!==null)throw Error('Restarted fixture exited');
 if(telegramCalls.filter(c=>c.method==='sendMessage'&&c.body.text?.includes('executed the enrolled tool')).length>=6)break;
 await new Promise(r=>setTimeout(r,300));
}
const replyCount=telegramCalls.filter(c=>c.method==='sendMessage'&&c.body.text?.includes('executed the enrolled tool')).length;
assert.equal(replyCount,6,'Native history survives restart and pending owner message gets a reply');
assert.equal(toolCalls,1,'Second turn retains the original tool result rather than losing history and repeating the tool');
assert.deepEqual((await control(nativeRequest)).body,submitted.body,'Restart preserves the UI dispatch receipt without replay');
const nativeAfter=await nativeChat.read('fixture-conversation',{all:true,limit:2});
assert.equal(nativeAfter.native_session_id,nativeBefore.native_session_id,'Restart retains the original native session');
assert.equal(nativeAfter.messages.filter(m=>m.role==='assistant'&&m.state==='complete').length,6,'Dashboard sees every completed native reply after restart');
assert.equal(nativeAfter.history_complete,true,'Every native display page was joined under the same revision');
const queuedFirst=nativeAfter.messages.findIndex(m=>m.role==='user'&&m.text===queuedRequest.message);
const queuedSecond=nativeAfter.messages.findIndex(m=>m.role==='user'&&m.text==='A second distinct dashboard follow-up must run in order.');
assert.ok(queuedFirst>=0&&queuedSecond>queuedFirst,'Separate native FIFO instructions retain arrival order');
assert.equal((await control({action:'transcript',session_key:'agent:main:telegram:dm:54321',session_id:nativeAfter.native_session_id,offset:0,limit:2,revision:null})).body.state,'rejected','Display history is limited to the explicitly bound owner session');
assert.equal((await nativeChat.receipt('fixture-conversation','watcher-follow-up-fixture')).state,'accepted_unverified','Dispatch state is not silently promoted to operational success');
write('native-transcript.json',nativeAfter);
await nativeChat.submit(created.id,'Inspect the fixture in this new dashboard conversation.','dashboard-create-fixture');
let dashboardConversation;
for(let i=0;i<100;i++){
 dashboardConversation=await nativeChat.read(created.id,{all:true});
 if(dashboardConversation.messages.some(m=>m.role==='assistant'&&m.state==='complete'))break;
 await new Promise(r=>setTimeout(r,200));
}
assert.equal(dashboardConversation.messages.filter(m=>m.role==='assistant'&&m.state==='complete').length,1,'Native scheduler answers the new dashboard conversation');
assert.equal(toolCalls,2,'New native session has its own original tool execution');
assert.equal(telegramCalls.filter(c=>c.method==='sendMessage'&&c.body.text?.includes('executed the enrolled tool')).length,6,'Dashboard-only replies do not leak into the owner Telegram conversation');
const reconstructed=new NativeHermesChatClient({descriptor:home+'/native-gateway.json',bindings:[]});
assert.equal((await reconstructed.discover())[0].id,created.id);
assert.equal((await reconstructed.session(created.id)).session_id,created.native_session_id,'Native dashboard routing and its binding survive the gateway process restart');
assert.equal((await reconstructed.read(created.id,{all:true})).messages.length,dashboardConversation.messages.length,'A new dashboard client discovers the retained native binding');
write('native-dashboard-transcript.json',dashboardConversation);
const dropped=telegramCalls.some(c=>c.method==='deleteWebhook'&&(c.body.drop_pending_updates===true||c.body.drop_pending_updates==='true'));
const replied=telegramCalls.some(c=>c.method==='sendMessage'&&c.body.text?.includes('executed the enrolled tool'));
const typing=telegramCalls.some(c=>c.method==='sendChatAction'&&c.body.action==='typing');
const result={at:new Date().toISOString(),state:!dropped&&replied&&toolCalls===2&&typing?'passed':'failed',dropped,replied,typing,modelCalls,toolCalls,replyCount,unauthorized_sender_rejected:true,restart_history_preserved:true,shared_dashboard_telegram_history:true,idempotent_ui_dispatch:true,shared_turn_serialization:true,dashboard_transcript_read:true,native_busy_observation:true,native_fifo_depth_verified:true,native_dashboard_creation:true,native_dashboard_binding_recovered:true,restartPortWaitMs,scope:'Actual pinned upstream Telegram adapter and gateway against local fake Bot API, model and fleet endpoints; fake credentials only.'};
write('telegram-calls.json',telegramCalls);write('acceptance.json',result);console.log(JSON.stringify({...result,home}));
assert.deepEqual(serverErrors,[]);assert.equal(result.state,'passed');
}finally{releaseModel?.();if(child&&child.exitCode===null){child.kill('SIGTERM');await Promise.race([new Promise(r=>child.once('exit',r)),new Promise(r=>setTimeout(r,5000))]);if(child.exitCode===null)child.kill('SIGKILL');}server.closeAllConnections();await new Promise(r=>server.close(r));fs.closeSync(log);}
