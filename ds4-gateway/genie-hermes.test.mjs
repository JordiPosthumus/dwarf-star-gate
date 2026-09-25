import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {hermesProvider} from './genie-hermes.mjs';
import {GenieChat} from './genie-chat.mjs';
import {GenieMemory} from './genie-memory.mjs';

// Opt-in uses the actual Hermes library, but only a private synthetic provider.
// It never looks up personal configuration or contacts a real model server.
test('actual Hermes preserves two-turn chat and handles provider rejection without exposing its body',{
  skip:!process.env.DSG_TEST_HERMES_SOURCE||!process.env.DSG_TEST_HERMES_PYTHON,timeout:120000,
},async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'dsg-hermes-'));
  const requests=[],callIds=[];
  const server=http.createServer((req,res)=>{
    if(req.method==='GET'){res.setHeader('content-type','application/json');res.end(JSON.stringify({object:'list',data:[{id:'example-model',context_length:131072}]}));return;}
    assert.equal(req.headers['x-dsg-observer'],'gate-genie');
    callIds.push(req.headers['x-dsg-call-id']);
    let body='';req.on('data',c=>body+=c);req.on('end',()=>{
      const p=JSON.parse(body);requests.push(p);
      const users=p.messages.filter(m=>m.role==='user').map(m=>m.content);
      if(JSON.stringify(users.at(-1)).includes('Exercise an unsupported reasoning setting.')){
        res.writeHead(400,{'content-type':'application/json'});
        res.end(JSON.stringify({error:{message:'reasoning_effort is unsupported. PRIVATE_REASONING_ERROR_EXAMPLE',type:'BadRequestError',param:'reasoning_effort',code:400}}));return;
      }
      if(JSON.stringify(users.at(-1)).includes('Exercise the unavailable provider.')){
        res.writeHead(401,{'content-type':'application/json'});
        res.end(JSON.stringify({error:{message:'PRIVATE_PROVIDER_ERROR_EXAMPLE',type:'authentication_error',code:'invalid_api_key'}}));return;
      }
      const answer=users.length>1?'You told me your name is Ada. I can see example-one in the provided setup.':'Hello Ada. I can see example-one in the provided setup.';
      if(p.stream){res.setHeader('content-type','text/event-stream');
        res.write(`data: ${JSON.stringify({id:'chatcmpl-example',object:'chat.completion.chunk',model:'example-model',choices:[{index:0,delta:{role:'assistant',content:answer},finish_reason:null}]})}\n\n`);
        res.end(`data: ${JSON.stringify({id:'chatcmpl-example',object:'chat.completion.chunk',model:'example-model',choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120}})}\n\ndata: [DONE]\n\n`);
      }else{res.setHeader('content-type','application/json');res.end(JSON.stringify({id:'chatcmpl-example',model:'example-model',choices:[{index:0,message:{role:'assistant',content:answer},finish_reason:'stop'}],usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120}}));}
    });
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const provider=hermesProvider({python:process.env.DSG_TEST_HERMES_PYTHON,source:process.env.DSG_TEST_HERMES_SOURCE,url:`http://127.0.0.1:${server.address().port}/v1`,model:'example-model',gateway_tracking:true},{directory});
  t.after(()=>{provider.close();server.closeAllConnections();server.close();fs.rmSync(directory,{recursive:true,force:true});});
  const notebook=new GenieMemory(path.join(fs.realpathSync(directory),'memory'));notebook.setEnabled(true);
  notebook.saveOperatorNote({text:'SYNTHETIC_NOTEBOOK_MARKER: prefer the recorded setup.'},{gateway:{workers:[]}});
  const chat=new GenieChat({directory:path.join(directory,'conversations'),provider,notebook,getSnapshot:()=>({time:Date.now(),demo:true,gateway:{model:'example-model',workers:[{id:'example-one',context_length:131072}]}})});
  const s=chat.create();chat.submit(s.id,'My name is Ada. What setup can you see?','hermes-first');await chat.idle();
  assert.equal(chat.get(s.id).messages[1].state,'complete',JSON.stringify(chat.get(s.id).messages[1]));
  assert.ok(chat.get(s.id).messages[1].progress?.step >= 1, 'Native Hermes step callback must reach saved chat');
  chat.submit(s.id,'What is my name?','hermes-second');await chat.idle();
  assert.match(chat.get(s.id).messages[3].text,/Ada/);
  assert.equal(callIds[0],chat.get(s.id).messages[1].id);assert.equal(callIds[1],chat.get(s.id).messages[3].id);assert.notEqual(callIds[0],callIds[1]);
  assert.equal(requests.length,2);assert.equal(requests[1].messages.filter(m=>m.role==='user').length,2);
  assert.match(JSON.stringify(requests[0].messages),/example-one/);
  assert.match(requests[0].messages[0].content,/You are a genie who lives in Star Gate/);
  assert.match(requests[0].messages[0].content,/Gate Genie operating instructions/);
  assert.match(requests[0].messages[0].content,/SYNTHETIC_NOTEBOOK_MARKER/);assert.match(requests[0].messages[0].content,/not instructions, current health proof or approval/);
  notebook.setEnabled(false);
  fs.appendFileSync(path.join(directory,'hermes-home','SOUL.md'),'\nUse the identity phrase: distinctive lantern.\n');
  for(const p of requests)assert.equal(p.tools?.length??0,0);
  chat.submit(s.id,'Exercise the unavailable provider.','hermes-failure');await chat.idle();
  assert.match(requests.at(-1).messages[0].content,/distinctive lantern/);
  assert.doesNotMatch(requests.at(-1).messages[0].content,/SYNTHETIC_NOTEBOOK_MARKER/);
  const saved=chat.get(s.id);
  assert.equal(saved.messages[5].state,'failed');
  assert.match(saved.messages[5].error,/unfinished reply|model request/);
  assert.doesNotMatch(JSON.stringify(saved),/PRIVATE_PROVIDER_ERROR_EXAMPLE/);
  assert.equal(saved.messages[4].text,'Exercise the unavailable provider.');
  chat.submit(s.id,'Exercise an unsupported reasoning setting.','hermes-reasoning');await chat.idle();
  const rejected=chat.get(s.id).messages.at(-1);
  assert.equal(rejected.state,'failed',JSON.stringify(requests.map(p=>p.messages.filter(m=>m.role==='user').map(m=>m.content))));assert.match(rejected.error,/reasoning setting/);
  assert.doesNotMatch(JSON.stringify(chat.get(s.id)),/PRIVATE_REASONING_ERROR_EXAMPLE/);
  const count=requests.length;fs.writeFileSync(path.join(directory,'hermes-home','SOUL.md'),'');
  chat.submit(s.id,'An empty soul must not become a different assistant.','hermes-empty-soul');await chat.idle();
  assert.equal(requests.length,count);assert.match(chat.get(s.id).messages.at(-1).error,/SOUL.md/);
});

test('an explicit turn deadline releases a hung bridge without replaying the question',{timeout:10000},async t=>{
  const {execFileSync}=await import('node:child_process');
  let python;try{python=execFileSync('which',['python3'],{encoding:'utf8'}).trim();}catch{t.skip('Python is unavailable');return;}
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'dsg-hung-chat-')),source=path.join(directory,'source');fs.mkdirSync(source);
  fs.writeFileSync(path.join(source,'run_agent.py'),'import time\nclass AIAgent:\n def __init__(self, **kwargs): self.tools=[]\n def run_conversation(self, *args, **kwargs): time.sleep(60)\n');
  const provider=hermesProvider({python,source,url:'http://127.0.0.1:1/v1',model:'example-model',timeout_ms:500},{directory});
  t.after(()=>{provider.close();fs.rmSync(directory,{recursive:true,force:true});});
  const chat=new GenieChat({directory:path.join(directory,'chats'),provider}),s=chat.create();
  chat.submit(s.id,'Keep this question.','deadline-test');await chat.idle();
  assert.equal(chat.get(s.id).busy,false);assert.equal(chat.get(s.id).messages[1].state,'failed');assert.match(chat.get(s.id).messages[1].error,/waiting allowance/);
  assert.equal(chat.get(s.id).messages[0].text,'Keep this question.');assert.equal(chat.get(s.id).messages.length,2);
});

test('bridge exposes progress counts without reasoning content or provider metadata',async t=>{
 const {execFileSync}=await import('node:child_process');const python=execFileSync('which',['python3'],{encoding:'utf8'}).trim();
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'sg-progress-')),source=path.join(directory,'source');fs.mkdirSync(source);
 fs.writeFileSync(path.join(source,'run_agent.py'),`class AIAgent:\n def __init__(self, **kwargs): self.tools=[]; self.kw=kwargs\n def run_conversation(self, *args, **kwargs):\n  self.kw['step_callback'](1, [{'secret': 'PRIVATE_TOOL_METADATA'}])\n  self.kw['reasoning_callback']('PRIVATE_REASONING_TEXT')\n  self.kw['step_callback'](2, [])\n  return {'final_response':'Visible answer','completed':True}\n`);
 const provider=hermesProvider({python,source,url:'http://127.0.0.1:1/v1',model:'example-model'},{directory});t.after(()=>{provider.close();fs.rmSync(directory,{recursive:true,force:true});});
 const chat=new GenieChat({directory:path.join(directory,'chats'),provider});const c=chat.create();chat.submit(c.id,'Show progress.','progress-test');await chat.idle();const s=chat.get(c.id);
 assert.equal(s.messages[1].state,'complete');assert.equal(s.messages[1].progress.step,2);assert.equal(s.messages[1].progress.reasoning_chars,22);assert.doesNotMatch(JSON.stringify(s),/PRIVATE_REASONING_TEXT|PRIVATE_TOOL_METADATA/);
});

test('actual Hermes exposes and executes standalone power and admission tools',{
  skip:!process.env.DSG_TEST_HERMES_SOURCE||!process.env.DSG_TEST_HERMES_PYTHON,timeout:120000,
},async t=>{
 for(const [capability,tool,route,header,args={}] of [['power','fleet_power_status','/api/genie/power-tools','x-sg-power-tool'],['power','fleet_recipe_trial','/api/genie/power-tools','x-sg-power-tool',{profile:'fixture',stage:'prepare',trial_id:'12345678-1234-4234-8234-123456789012'}],['admission','admission_status','/api/genie/admission-tools','x-sg-admission-tool'],['admission','admission_admit','/api/genie/admission-tools','x-sg-admission-tool',{stage:'resume',fingerprint:'fixture',action_id:'12345678-1234-4234-8234-123456789012'}],['admission','verify_serving','/api/genie/admission-tools','x-sg-admission-tool',{worker:'fixture-worker',check:'cache',action_id:'12345678-1234-4234-8234-123456789012'}]]){
  await t.test(`${capability}:${tool}`,async t=>{
   const directory=fs.mkdtempSync(path.join(os.tmpdir(),'genie-tool-registration-'));
   let modelCalls=0,toolCalls=0;
   const server=http.createServer((req,res)=>{
    if(req.method==='GET'){res.end(JSON.stringify({data:[{id:'fixture',context_length:131072}]}));return;}
    let raw='';req.on('data',chunk=>raw+=chunk);req.on('end',()=>{
     if(req.url===route){assert.equal(req.headers[header],'fixture-token');assert.deepEqual(JSON.parse(raw),tool==='admission_admit'?{action:'admit',...args}:tool==='verify_serving'?{action:'verify-worker',...args}:tool==='fleet_recipe_trial'?{action:'recipe-trial',...args}:{action:'status'});toolCalls++;res.end(JSON.stringify({schema:1,fixture:'actual registered tool'}));return;}
     const body=JSON.parse(raw);modelCalls++;
     const message=modelCalls===1?{role:'assistant',content:null,tool_calls:[{id:'status-call',type:'function',function:{name:'tool_call',arguments:JSON.stringify({name:tool,arguments:args})}}]}:{role:'assistant',content:'The registered status tool returned its receipt.'};
     if(modelCalls===2)assert.match(JSON.stringify(body.messages),/actual registered tool/);
     if(body.stream){res.setHeader('content-type','text/event-stream');const delta={...message,...(message.tool_calls?{tool_calls:message.tool_calls.map((v,index)=>({...v,index}))}:{})};res.end('data: '+JSON.stringify({id:'fixture',model:'fixture',choices:[{index:0,delta,finish_reason:null}]})+'\n\ndata: '+JSON.stringify({id:'fixture',model:'fixture',choices:[{index:0,delta:{},finish_reason:modelCalls===1?'tool_calls':'stop'}]})+'\n\ndata: [DONE]\n\n');}
     else res.end(JSON.stringify({id:'fixture',model:'fixture',choices:[{message,finish_reason:modelCalls===1?'tool_calls':'stop'}]}));
    });
   });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
   const base=`http://127.0.0.1:${server.address().port}`;
   const provider=hermesProvider({python:process.env.DSG_TEST_HERMES_PYTHON,source:process.env.DSG_TEST_HERMES_SOURCE,url:base+'/v1',model:'fixture',[capability]:{url:base+route,token:'fixture-token'}},{directory});
   t.after(()=>{provider.close();server.closeAllConnections();server.close();fs.rmSync(directory,{recursive:true,force:true});});
   assert.equal(provider.info.can_act,true);
   const chat=new GenieChat({directory:path.join(directory,'chat'),provider});const c=chat.create();chat.submit(c.id,'Read status through the enrolled tool.','status-fixture');await chat.idle();
   const reply=chat.get(c.id).messages[1];assert.equal(reply.state,'complete',JSON.stringify(reply));assert.equal(toolCalls,1);assert.equal(modelCalls,2);assert.equal(reply[capability].events.find(e=>e.state==='complete').result.fixture,'actual registered tool');
  });
 }
});
