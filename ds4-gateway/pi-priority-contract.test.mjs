// Installed Pi contract; entirely synthetic endpoints, models and in-memory
// sessions. Never read or edit the owner's Pi provider/settings files.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createGateway} from './gateway.mjs';
import {registerPiContinuity} from './continuity-client.mjs';
import {registerPiPriorityLens} from './pi-priority-client.mjs';
import {workerControl} from './worker-client.mjs';

for(const affinity of [true,false])for(const adapter of ['continuity','title-only'])test('installed Pi serializer supplies exact affinity for '+adapter+' priority intent with affinity '+affinity+' without changing model capabilities',{skip:!process.env.DSG_PI_ROOT,timeout:30000},async t=>{
  const root=process.env.DSG_PI_ROOT,load=relative=>import(pathToFileURL(path.join(root,relative)));
  const [{createAgentSession},{ModelRuntime},{SessionManager},{SettingsManager},{DefaultResourceLoader},{streamSimple}]=await Promise.all([
    load('dist/core/sdk.js'),load('dist/core/model-runtime.js'),load('dist/core/session-manager.js'),load('dist/core/settings-manager.js'),load('dist/core/resource-loader.js'),load('node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js')]);
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'dsg-pi-priority-'))),requests=[],envelopes=[],errors=[],visibleTitles=[];let session,gateway,tools=0;
  const backend=http.createServer((req,res)=>{
    if(req.url==='/v1/models')return res.end(JSON.stringify({data:[{id:'deepseek-v4-flash',context_length:262144}]}));
    const chunks=[];req.on('data',chunk=>chunks.push(chunk));req.on('end',async()=>{
      const body=Buffer.concat(chunks).toString(),payload=JSON.parse(body);requests.push({headers:req.headers,payload});
      for(let i=0;i<20;i++){const title=gateway.priorityStatus(true).jobs?.find(job=>job.title)?.title;if(title){visibleTitles.push(title);break;}await new Promise(resolve=>setTimeout(resolve,5));}
      const first=requests.length===1,delta=first?{tool_calls:[{index:0,id:'once',type:'function',function:{name:'count_once',arguments:'{}'}}]}:{content:'DONE'};
      res.writeHead(200,{'content-type':'text/event-stream'});res.end(`data: ${JSON.stringify({id:'fixture',choices:[{index:0,delta,finish_reason:first?'tool_calls':'stop'}],usage:{prompt_tokens:10,completion_tokens:2}})}\n\ndata: [DONE]\n\n`);
    });
  });
  t.after(async()=>{session?.dispose();await gateway?.close();backend.closeAllConnections();await new Promise(resolve=>backend.close(resolve));fs.rmSync(dir,{recursive:true,force:true});});
  await new Promise(resolve=>backend.listen(0,'127.0.0.1',resolve));
  const control=path.join(dir,'control.sock');gateway=createGateway({host:'127.0.0.1',port:0,api_key:'fixture',model:'deepseek-v4-flash',context_length:262144,state_file:path.join(dir,'gateway.json'),control_socket:control,nodes:[{id:'fixture',url:`http://127.0.0.1:${backend.address().port}`}],health_interval_ms:100000});
  const address=await gateway.start(),baseUrl=`http://127.0.0.1:${address.port}/v1`,provider='fixture-priority';
  const model={id:'deepseek-v4-flash',name:'Fixture',reasoning:true,thinkingLevelMap:{xhigh:'xhigh'},input:['text','image'],contextWindow:262144,maxTokens:262144,cost:{input:0,output:0,cacheRead:0,cacheWrite:0},compat:{supportsReasoningEffort:true,...(affinity?{sendSessionAffinityHeaders:true}:{})}};
  const modelsPath=path.join(dir,'models.json');fs.writeFileSync(modelsPath,JSON.stringify({providers:{[provider]:{baseUrl,api:'openai-completions',apiKey:'fixture',models:[model]}}}),{mode:0o600});
  const runtime=await ModelRuntime.create({modelsPath,authPath:path.join(dir,'auth.json'),modelsStorePath:path.join(dir,'models-store.json'),allowModelNetwork:false,refreshOnCreate:false});
  const original=structuredClone(runtime.getModel(provider,model.id)),settings=SettingsManager.inMemory({});
  const loader=new DefaultResourceLoader({cwd:dir,agentDir:dir,settingsManager:settings,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,systemPrompt:'PRIVATE_SYSTEM_NOT_FOR_CLASSIFIER',extensionFactories:[pi=>{
    const handoff=async(url,init)=>{envelopes.push(JSON.parse(init.body));return fetch(url,init);};
    if(adapter==='continuity')registerPiContinuity(pi,{provider,baseUrl,streamSimple,priorityLens:true,priorityFetchImpl:handoff});
    else registerPiPriorityLens(pi,{provider,baseUrl,streamSimple,fetchImpl:handoff});
  }]});await loader.reload();
  ({session}=await createAgentSession({cwd:dir,agentDir:dir,modelRuntime:runtime,model:runtime.getModel(provider,model.id),thinkingLevel:'xhigh',settingsManager:settings,sessionManager:SessionManager.inMemory(dir),resourceLoader:loader,noTools:'builtin',customTools:[{name:'count_once',label:'Count',description:'Count once',parameters:{type:'object',properties:{}},execute:async()=>{tools++;return {content:[{type:'text',text:'PRIVATE_TOOL_RESULT'}],details:{}};}}]}));
  await session.bindExtensions({onError:error=>errors.push(error.message)});
  for(const field of ['contextWindow','maxTokens','reasoning','input','thinkingLevelMap','compat','baseUrl'])assert.deepEqual(session.model[field],original[field],`preserve ${field}`);
  await session.prompt('Urgent real user request. Call count_once then finish.');await session.waitForIdle();
  assert.equal(tools,1);assert.equal(requests.length,2);assert.equal(envelopes.length,1);assert.equal(envelopes[0].excerpt,'Urgent real user request. Call count_once then finish.');
  for(const request of requests){assert.equal(request.headers['x-session-affinity'],affinity?envelopes[0].session:undefined);assert.equal(request.headers['x-dsg-priority-intent'],undefined);assert.equal(request.payload.reasoning_effort,'xhigh');}
  assert.ok(!JSON.stringify(envelopes).includes('PRIVATE_'));assert.deepEqual(errors,[]);
  assert.deepEqual(visibleTitles,[envelopes[0].title,envelopes[0].title]);
  let review;for(let i=0;i<(affinity?20:1)&&!review;i++){review=(await workerControl(control,'/priority-review-next',{})).review;if(!review)await new Promise(resolve=>setTimeout(resolve,10));}
  if(affinity){assert.equal(review.excerpt,envelopes[0].excerpt);assert.equal(review.title,envelopes[0].title);}
  else assert.equal(review,null,'unkeyed requests do not invent conversation priority');
  await session.prompt('Next user task.');await session.waitForIdle();assert.equal(envelopes.length,2);assert.notEqual(envelopes[0].id,envelopes[1].id);
  if(affinity)assert.equal((await workerControl(control,'/priority-review-result',{lease:review.lease,intent_id:review.intent_id,advice:{priority:'High',reason:'urgent'}})).accepted,false,'new user input rejects old in-flight classification');
  if(adapter==='title-only'){
    await session.prompt('/priority-lens off');
    await session.prompt('A task after opting out.');await session.waitForIdle();
    assert.equal(envelopes.length,2,'client opt-out stops title and excerpt handoff');
    assert.equal(requests.at(-1).payload.reasoning_effort,'xhigh');
  }
});
