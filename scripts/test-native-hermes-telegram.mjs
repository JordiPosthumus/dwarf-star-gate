// Full native channel test: isolated profile, fake Bot API/model/tools, no real secrets.
import {fileURLToPath} from 'node:url';
import fs from 'node:fs';import path from 'node:path';import http from 'node:http';import net from 'node:net';import {spawn} from 'node:child_process';import assert from 'node:assert/strict';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),source=process.argv[2];
if(!source||!path.isAbsolute(source)||!fs.existsSync(path.join(source,'.venv/bin/python')))throw Error('Provide the absolute installed native Hermes source directory');
const home=fs.mkdtempSync('/tmp/dsg-hermes-fixture-');fs.chmodSync(home,0o700);let child,modelCalls=0,toolCalls=0;const serverErrors=[],telegramCalls=[],fakeToken='999999:fixture-not-a-real-bot-token';let updates=[{update_id:100,message:{message_id:101,date:Math.floor(Date.now()/1000),chat:{id:12345,type:'private',first_name:'Fixture'},from:{id:12345,is_bot:false,first_name:'Fixture'},text:'Read the existing fixture action status.'}}];const key='native-fixture-key-0123456789abcdef',token='native-bridge-fixture-0123456789';
const server=http.createServer((req,res)=>{let raw='';req.on('data',x=>raw+=x);req.on('end',()=>{try{const body=raw?(req.headers['content-type']?.includes('application/json')?JSON.parse(raw):Object.fromEntries(new URLSearchParams(raw))):{};
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
fs.appendFileSync(home+'/model-requests.jsonl',JSON.stringify({roles:body.messages?.map(m=>m.role),tools:body.tools?.map(t=>t.function?.name),last:body.messages?.at(-1)})+'\n',{mode:0o600});
const hasReceipt=JSON.stringify(body.messages).includes('native-gateway-tool-receipt');const shouldCall=!hasReceipt&&body.tools?.length>0;
const message=shouldCall?{role:'assistant',content:null,tool_calls:[{id:'native-tool-1',type:'function',function:{name:'tool_call',arguments:JSON.stringify({name:'fleet_power_status',arguments:{action_id:'12345678-1234-4234-8234-123456789012'}})}}]}:{role:'assistant',content:'Native Hermes gateway executed the enrolled tool.'};

if(body.stream){res.setHeader('Content-Type','text/event-stream');res.end('data: '+JSON.stringify({id:'fixture',model:'fixture',choices:[{index:0,delta:{...message,...(message.tool_calls?{tool_calls:message.tool_calls.map((v,index)=>({...v,index}))}:{})},finish_reason:null}]})+'\n\ndata: '+JSON.stringify({id:'fixture',model:'fixture',choices:[{index:0,delta:{},finish_reason:shouldCall?'tool_calls':'stop'}]})+'\n\ndata: [DONE]\n\n');}else res.end(JSON.stringify({id:'fixture',model:'fixture',choices:[{message,finish_reason:shouldCall?'tool_calls':'stop'}]}));
}catch(error){serverErrors.push(error.message);res.statusCode=500;res.end(JSON.stringify({error:'Fixture protocol assertion failed'}));}});});await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
const portProbe=net.createServer();await new Promise(r=>portProbe.listen(0,'127.0.0.1',r));const port=portProbe.address().port;await new Promise(r=>portProbe.close(r));
const write=(file,value)=>fs.writeFileSync(path.join(home,file),typeof value==='string'?value:JSON.stringify(value,null,2),{mode:0o600});
fs.mkdirSync(home+'/plugins',{mode:0o700});fs.cpSync(repo+'/integrations/hermes-stargate',home+'/plugins/stargate',{recursive:true});
write('bridge.json',{url:origin+'/api/genie/native-tools',token});
const cfg={model:{default:'fixture',provider:'custom',base_url:origin+'/v1',context_length:131072},platform_toolsets:{api_server:['stargate_native'],telegram:['stargate_native']},plugins:{enabled:['stargate','telegram'],entries:{stargate:{settings:{module_directory:repo+'/ds4-gateway',bridge_descriptor:home+'/bridge.json'}}}},platforms:{telegram:{enabled:true,token:fakeToken,extra:{preserve_pending_updates:true,base_url:origin+'/bot',base_file_url:origin+'/file/bot'}},api_server:{enabled:true,extra:{host:'127.0.0.1',port,key}}}};
write('config.yaml',cfg);write('SOUL.md','You are a native gateway integration fixture.');write('AGENTS.md','Use only fixture tools. No real servers or external channels are configured.');
const log=fs.openSync(home+'/gateway.log','w',0o600);
try{
const launch=()=>spawn(source+'/.venv/bin/python',['-B','-m','gateway.run','--config',home+'/config.yaml'],{cwd:home,env:{PATH:process.env.PATH,HOME:home,HERMES_HOME:home,PYTHONPATH:source,HERMES_DISABLE_LAZY_INSTALLS:'1',PYTHONDONTWRITEBYTECODE:'1',PYTHONUNBUFFERED:'1',OPENAI_BASE_URL:origin+'/v1',OPENAI_API_KEY:'fixture-local-key',API_SERVER_KEY:key,API_SERVER_PORT:String(port),API_SERVER_HOST:'127.0.0.1',TELEGRAM_BOT_TOKEN:fakeToken,TELEGRAM_ALLOWED_USERS:'12345',HERMES_TELEGRAM_DISABLE_FALLBACK_IPS:'1',LANG:'en_US.UTF-8'},stdio:['ignore',log,log]});
child=launch();
let ready=false;for(let i=0;i<50;i++){if(child.exitCode!==null)throw Error('Native gateway exited; inspect '+home+'/gateway.log');try{const r=await fetch('http://127.0.0.1:'+port+'/v1/models',{headers:{authorization:'Bearer '+key},signal:AbortSignal.timeout(1000)});if(r.ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,500));}
assert.ok(ready,'Native gateway API readiness');
for(let i=0;i<100;i++){
 if(telegramCalls.some(c=>c.method==='deleteWebhook'&&(c.body.drop_pending_updates===true||c.body.drop_pending_updates==='true')))break;
 if(telegramCalls.some(c=>c.method==='sendMessage'&&c.body.text?.includes('executed the enrolled tool')))break;
 await new Promise(r=>setTimeout(r,300));
}
const beforeUnauthorized=modelCalls;
updates.push({update_id:101,message:{message_id:102,date:Math.floor(Date.now()/1000),chat:{id:54321,type:'private',first_name:'Untrusted'},from:{id:54321,is_bot:false,first_name:'Untrusted'},text:'Run the fleet power tool.'}});
await new Promise(r=>setTimeout(r,2000));
assert.equal(modelCalls,beforeUnauthorized,'Unauthorized Telegram sender must not reach the agent');
child.kill('SIGTERM');await Promise.race([new Promise(r=>child.once('exit',r)),new Promise(r=>setTimeout(r,5000))]);
assert.notEqual(child.exitCode,null,'Fixture gateway must stop before restart');
updates.push({update_id:102,message:{message_id:103,date:Math.floor(Date.now()/1000),chat:{id:12345,type:'private',first_name:'Fixture'},from:{id:12345,is_bot:false,first_name:'Fixture'},text:'What action outcome did you just read? Use our conversation history.'}});
child=launch();
for(let i=0;i<150;i++){
 if(child.exitCode!==null)throw Error('Restarted fixture exited');
 if(telegramCalls.filter(c=>c.method==='sendMessage'&&c.body.text?.includes('executed the enrolled tool')).length>=2)break;
 await new Promise(r=>setTimeout(r,300));
}
const replyCount=telegramCalls.filter(c=>c.method==='sendMessage'&&c.body.text?.includes('executed the enrolled tool')).length;
assert.equal(replyCount,2,'Native history survives restart and pending owner message gets a reply');
assert.equal(toolCalls,1,'Second turn retains the original tool result rather than losing history and repeating the tool');
const dropped=telegramCalls.some(c=>c.method==='deleteWebhook'&&(c.body.drop_pending_updates===true||c.body.drop_pending_updates==='true'));
const replied=telegramCalls.some(c=>c.method==='sendMessage'&&c.body.text?.includes('executed the enrolled tool'));
const typing=telegramCalls.some(c=>c.method==='sendChatAction'&&c.body.action==='typing');
const result={at:new Date().toISOString(),state:!dropped&&replied&&toolCalls===1&&typing?'passed':'failed',dropped,replied,typing,modelCalls,toolCalls,replyCount,unauthorized_sender_rejected:true,restart_history_preserved:true,scope:'Actual pinned upstream Telegram adapter and gateway against local fake Bot API, model and fleet endpoints; fake credentials only.'};
write('telegram-calls.json',telegramCalls);write('acceptance.json',result);console.log(JSON.stringify({...result,home}));
assert.deepEqual(serverErrors,[]);assert.equal(result.state,'passed');
}finally{if(child&&child.exitCode===null){child.kill('SIGTERM');await Promise.race([new Promise(r=>child.once('exit',r)),new Promise(r=>setTimeout(r,5000))]);if(child.exitCode===null)child.kill('SIGKILL');}server.closeAllConnections();await new Promise(r=>server.close(r));fs.closeSync(log);}
