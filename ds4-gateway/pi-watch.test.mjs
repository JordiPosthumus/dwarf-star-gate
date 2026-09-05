// Optional installed-Pi session test. Only synthetic local providers, in-memory
// sessions and a fresh private configuration directory; never the user's settings.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {createGateway} from './gateway.mjs';
import {registerPiContinuity} from './continuity-client.mjs';

for(const recover of [false,true])test(`real Pi settled outcome reports ${recover?'successful retry as idle':'exhausted retries as needing attention'}`,{skip:!process.env.DSG_PI_ROOT,timeout:30000},async t=>{
  const root=process.env.DSG_PI_ROOT,load=relative=>import(pathToFileURL(path.join(root,relative)));
  const [{createAgentSession},{ModelRuntime},{SessionManager},{SettingsManager},{DefaultResourceLoader},{streamSimple}]=await Promise.all([
    load('dist/core/sdk.js'),load('dist/core/model-runtime.js'),load('dist/core/session-manager.js'),load('dist/core/settings-manager.js'),
    load('dist/core/resource-loader.js'),load('node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js')]);
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'dsg-pi-watch-')));let gateway,session,watch,requests=0,tools=0;const events=[],heartbeats=[],extensionErrors=[];
  const backend=http.createServer((req,res)=>{
    if(req.url==='/v1/models')return res.end(JSON.stringify({data:[{id:'deepseek-v4-flash',context_length:262144}]}));
    let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{
      const payload=JSON.parse(body);assert.equal(payload.reasoning_effort,'xhigh',JSON.stringify({route:req.url,keys:Object.keys(payload)}));++requests;assert.equal(req.headers['x-dsg-client-watch-id'],undefined);
      const good=requests===1||recover&&requests===3;
      const delta=requests===1?{tool_calls:[{index:0,id:'once',type:'function',function:{name:'count_once',arguments:'{}'}}]}:{content:good?'DONE':'Partial synthetic answer'};
      res.writeHead(200,{'content-type':'text/event-stream'});
      // Marker-complete transport can still fail Pi's stricter finish contract.
      res.end(`data: ${JSON.stringify({id:'fixture',choices:[{index:0,delta,finish_reason:good?(requests===1?'tool_calls':'stop'):null}],usage:{prompt_tokens:10,completion_tokens:2}})}\n\ndata: [DONE]\n\n`);
    });
  });
  t.after(async()=>{session?.dispose();await watch?.stop();await gateway?.close();backend.closeAllConnections();await new Promise(resolve=>backend.close(resolve));fs.rmSync(dir,{recursive:true,force:true});});
  await new Promise(resolve=>backend.listen(0,'127.0.0.1',resolve));
  gateway=createGateway({host:'127.0.0.1',port:0,api_key:'fixture',model:'deepseek-v4-flash',context_length:262144,state_file:path.join(dir,'gateway.json'),nodes:[{id:'fixture',url:`http://127.0.0.1:${backend.address().port}`}],health_interval_ms:100000});
  const address=await gateway.start(),baseUrl=`http://127.0.0.1:${address.port}/v1`,provider='fixture-dsg';
  const model={id:'deepseek-v4-flash',name:'Fixture',reasoning:true,thinkingLevelMap:{xhigh:'xhigh'},input:['text','image'],contextWindow:262144,maxTokens:262144,cost:{input:0,output:0,cacheRead:0,cacheWrite:0},compat:{supportsReasoningEffort:true}};
  const modelsPath=path.join(dir,'models.json');fs.writeFileSync(modelsPath,JSON.stringify({providers:{[provider]:{baseUrl,api:'openai-completions',apiKey:'fixture',models:[model]}}}),{mode:0o600});
  const runtime=await ModelRuntime.create({modelsPath,authPath:path.join(dir,'auth.json'),modelsStorePath:path.join(dir,'models-store.json'),allowModelNetwork:false,refreshOnCreate:false});
  const original=structuredClone(runtime.getModel(provider,model.id));
  const settings=SettingsManager.inMemory({compaction:{enabled:false},retry:{enabled:true,maxRetries:2,baseDelayMs:1}});
  const loader=new DefaultResourceLoader({cwd:dir,agentDir:dir,settingsManager:settings,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,systemPrompt:'Synthetic fixture. Call count_once once, then answer.',extensionFactories:[pi=>{
    watch=registerPiContinuity(pi,{provider,baseUrl,streamSimple,agentWatch:true,watchIntervalMs:1000,watchFetchImpl:async(url,init)=>{assert.equal(new URL(url).origin,new URL(baseUrl).origin);heartbeats.push(JSON.parse(init.body));return fetch(url,init);}}).agentWatch;
  }]});
  await loader.reload();
  ({session}=await createAgentSession({cwd:dir,agentDir:dir,modelRuntime:runtime,model:runtime.getModel(provider,model.id),thinkingLevel:'xhigh',settingsManager:settings,sessionManager:SessionManager.inMemory(dir),resourceLoader:loader,noTools:'builtin',customTools:[{name:'count_once',label:'Count',description:'Count once',parameters:{type:'object',properties:{}},execute:async()=>{tools++;return {content:[{type:'text',text:'counted'}],details:{}};}}]}));
  await session.bindExtensions({onError:error=>extensionErrors.push(error.message)});session.subscribe(event=>events.push(event.type));
  for(const field of ['contextWindow','maxTokens','reasoning','input','thinkingLevelMap','compat','baseUrl'])assert.deepEqual(session.model[field],original[field],`preserve ${field}`);
  await session.prompt('Call count_once, then answer DONE.');await session.waitForIdle();
  const expected=recover?'idle':'needs_attention';assert.equal(watch.state,expected);assert.equal(tools,1);assert.equal(requests,recover?3:4);
  assert.ok(events.includes('auto_retry_start'));assert.equal(events.at(-1),'agent_settled');assert.deepEqual(extensionErrors,[]);
  for(let i=0;i<30&&gateway.stats().client_watch.runs[0]?.state!==expected;i++)await delay(100);
  const run=gateway.stats().client_watch.runs[0];assert.equal(run.state,expected);assert.equal(run.diagnosis,recover?'idle':'client_reported_error');
  assert.equal(run.request.state,'complete','transport completion must not erase client failure');
  assert.ok(heartbeats.every(row=>Object.keys(row).sort().join(',')==='client,process_alive,schema,sequence,state,watch_id'));
  assert.equal(heartbeats.filter(row=>row.state==='needs_attention').length>0,!recover);
});
