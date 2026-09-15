// Real Hermes and gateway child processes, actual Door/restart coordinator.
// The model and read-only tool endpoint are synthetic; no fleet is contacted.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {createDoor} from './door.mjs';
import {coordinatedCoreRestart,readService} from './service-control.mjs';
import {hermesProvider} from './genie-hermes.mjs';
import {GenieChat} from './genie-chat.mjs';

async function until(check){
  const end=Date.now()+15000;
  while(Date.now()<end){const value=await check();if(value)return value;await delay(20);}
  throw new Error('Disposable continuity observation timed out');
}
async function listen(server){await new Promise(r=>server.listen(0,'127.0.0.1',r));return server.address().port;}
async function freePort(){const server=http.createServer(),port=await listen(server);await new Promise(r=>server.close(r));return port;}

test('Hermes tool conversation and held arrivals survive an actual coordinated gateway replacement',{
  skip:!process.env.DSG_TEST_HERMES_SOURCE||!process.env.DSG_TEST_HERMES_PYTHON,timeout:120000,
},async t=>{
  const directory=fs.realpathSync(fs.mkdtempSync('/tmp/sg-hermes-continuity-'));
  const children=[],requests=[],timeline=[];
  let logs='',door,chat,toolCalls=0,firstResponse,firstComplete=false,core;
  const token='synthetic-operation-token';
  const operationServer=http.createServer((req,res)=>{
    assert.equal(req.headers['x-sg-operation-tool'],token);
    let body='';req.on('data',x=>body+=x);req.on('end',()=>{
      assert.equal(JSON.parse(body).action,'list');toolCalls++;
      res.setHeader('content-type','application/json');res.end(JSON.stringify({operations:[]}));
    });
  });
  function send(res,message,stream){
    if(stream){
      const delta={...message,...(message.tool_calls?{tool_calls:message.tool_calls.map((call,index)=>({index,...call}))}:{})};
      res.end('data: '+JSON.stringify({choices:[{index:0,delta,finish_reason:message.tool_calls?'tool_calls':'stop'}]})+'\n\ndata: [DONE]\n\n');
    }else res.end(JSON.stringify({choices:[{index:0,message,finish_reason:message.tool_calls?'tool_calls':'stop'}]}));
  }
  const backend=http.createServer((req,res)=>{
    if(req.method==='GET'){res.setHeader('content-type','application/json');return res.end(JSON.stringify({data:[{id:'example-model',context_length:262144}]}));}
    let raw='';req.on('data',x=>raw+=x);req.on('end',()=>{
      const body=JSON.parse(raw);requests.push(body);
      assert.equal(body.reasoning_effort,'xhigh');assert.equal(body.max_tokens,8192);
      res.setHeader('content-type',body.stream?'text/event-stream':'application/json');
      if(requests.length===1){
        firstResponse=res;res.flushHeaders();
        if(body.stream)res.write('data: '+JSON.stringify({choices:[{index:0,delta:{role:'assistant'},finish_reason:null}]})+'\n\n');
        return;
      }
      send(res,{role:'assistant',content:body.messages.some(m=>m.role==='tool')?'Tool checked once; conversation continued.':'Second conversation completed.'},body.stream);
    });
  });
  const stop=async child=>{
    if(!child||child.exitCode!==null||child.signalCode!==null)return;
    const ended=once(child,'exit');child.kill('SIGTERM');
    // Only these disposable test processes may be killed on failed cleanup.
    const timer=setTimeout(()=>child.kill('SIGKILL'),5000);
    try{await ended;}finally{clearTimeout(timer);}
  };
  t.after(async()=>{
    fs.writeFileSync(path.join(directory,'observed.json'),JSON.stringify({timeline,tool_calls:toolCalls,requests,door:door?.status(),logs},null,2));
    chat?.close();firstResponse?.destroy();await door?.close();
    for(const child of children)await stop(child);
    for(const server of [backend,operationServer]){server.closeAllConnections();await new Promise(r=>server.close(r));}
    if(process.env.SG_KEEP_CONTINUITY_TEST)console.log('Retained isolated continuity evidence: '+directory);
    else fs.rmSync(directory,{recursive:true,force:true});
  });
  const backendPort=await listen(backend),operationsPort=await listen(operationServer);
  const corePort=await freePort();
  const config={host:'127.0.0.1',port:0,api_key:'synthetic-gateway-key',model:'example-model',context_length:262144,
    state_file:path.join(directory,'affinity.json'),control_socket:path.join(directory,'core.sock'),health_interval_ms:100000,
    nodes:[{id:'fixture',url:`http://127.0.0.1:${backendPort}`}],
    continuity_door:{enabled:true,core_port:corePort,control_socket:path.join(directory,'door.sock'),health_interval_ms:60000}};
  const filename=path.join(directory,'config.json');fs.writeFileSync(filename,JSON.stringify(config),{mode:0o600});
  const start=async()=>{
    const child=spawn(process.execPath,[new URL('./gateway.mjs',import.meta.url).pathname,filename],{stdio:['ignore','pipe','pipe']});
    children.push(child);core=child;
    for(const stream of [child.stdout,child.stderr])stream.on('data',x=>{logs+=x;});
    await until(async()=>{
      assert.equal(child.exitCode,null,logs);
      try{return (await readService('gateway',config)).startup?.complete;}catch{return false;}
    });
    timeline.push({event:'core_started',pid:child.pid});
  };
  await start();const original=core;
  door=createDoor(config);await door.start();
  const base=`http://127.0.0.1:${door.server.address().port}`;
  const provider=hermesProvider({python:process.env.DSG_TEST_HERMES_PYTHON,source:process.env.DSG_TEST_HERMES_SOURCE,
    url:base+'/v1',api_key:config.api_key,model:config.model,reasoning_effort:'xhigh',max_tokens:8192,gateway_tracking:true,
    operations:{url:`http://127.0.0.1:${operationsPort}/api/genie/operation-tools`,token,workers:['fixture']}},{directory:path.join(directory,'genie')});
  chat=new GenieChat({directory:path.join(directory,'chats'),provider,getSnapshot:()=>({time:Date.now(),gateway:{workers:[{id:'fixture'}]}})});
  const a=chat.create();chat.submit(a.id,'Check server change status, then report the result.','continuity-first');
  await until(()=>{const answer=chat.get(a.id).messages.at(-1);assert.notEqual(answer.state,'failed',answer.error);return firstResponse;});
  assert.equal((await readService('gateway',config)).active,1);
  const replacement=coordinatedCoreRestart(config,{
    stop:async()=>{
      assert.equal(firstComplete,true,'Existing model response must finish before stopping the core');
      await until(()=>toolCalls===1&&door.status().held===3);
      timeline.push({event:'old_core_idle',held:door.status().held,tool_calls:toolCalls});
      assert.equal((await readService('gateway',config)).active,0);
      await stop(core);assert.equal(core.exitCode,0,logs);
      timeline.push({event:'old_core_exited',pid:core.pid});
    },start,timeoutMs:60000,
  });
  // Record rejection immediately while the same restart promise is still owned.
  replacement.catch(()=>{});
  await until(()=>door.status().holding);
  const b=chat.create();chat.submit(b.id,'Answer the second conversation.','continuity-second');
  const discovery=fetch(base+'/v1/models?fixture=held',{headers:{authorization:'Bearer '+config.api_key}});
  discovery.catch(()=>{});
  await until(()=>door.status().held===2);
  assert.equal(requests.length,1);assert.equal(original.exitCode,null);
  timeline.push({event:'active_response_and_held_arrivals',active:door.status().active,held:door.status().held});
  firstComplete=true;
  send(firstResponse,{role:'assistant',content:null,tool_calls:[{id:'fixture-status',type:'function',function:{name:'tool_call',
    arguments:JSON.stringify({name:'server_change_status',arguments:{}})}}]},requests[0].stream);
  const outcome=await replacement;await chat.idle();
  assert.equal((await discovery).status,200);
  assert.notEqual(core.pid,original.pid);assert.equal(toolCalls,1);assert.equal(requests.length,3);
  const answer=chat.get(a.id).messages.at(-1),second=chat.get(b.id).messages.at(-1);
  assert.equal(answer.state,'complete',answer.error);assert.match(answer.text,/Tool checked once/);
  assert.equal(second.state,'complete',second.error);assert.match(second.text,/Second conversation/);
  assert.deepEqual(answer.operations.events.filter(e=>e.state==='complete').map(e=>e.tool),['server_change_status']);
  assert.equal(requests.filter(p=>p.messages.some(m=>m.role==='tool')).length,1);
  assert.equal(door.status().failed,0);assert.equal(door.status().held,0);assert.equal(door.status().holding,false);
  assert.doesNotMatch(logs,new RegExp(config.api_key));
  fs.writeFileSync(path.join(directory,'verification.json'),JSON.stringify({outcome,timeline,tool_calls:toolCalls,model_requests:requests.length,
    first_reply:answer.state,second_reply:second.state,door:door.status(),scope:'Real Hermes and core replacement with synthetic model/tool endpoints. No live fleet or launchd migration proof.'},null,2));
});
