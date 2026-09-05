// Optional real Pi contract test; disposable local core and in-memory sessions.
// It documents native retry authority, not a new extension or production policy.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createDoor} from './door.mjs';
import {registerPiContinuity} from './continuity-client.mjs';

for(const retryEnabled of [false,true])test(`real Pi ${retryEnabled?'can retry':'can stop on'} an explicitly unknown Door outcome`,{skip:!process.env.DSG_PI_ROOT,timeout:30000},async t=>{
  const root=process.env.DSG_PI_ROOT;
  assert.equal(JSON.parse(fs.readFileSync(path.join(root,'package.json'))).version,'0.84.4','Reinspect the native retry contract before updating this fixture');
  const load=relative=>import(pathToFileURL(path.join(root,relative)));
  const [{createAgentSession},{ModelRuntime},{SessionManager},{SettingsManager},{DefaultResourceLoader},{streamSimple}]=await Promise.all([
    load('dist/core/sdk.js'),load('dist/core/model-runtime.js'),load('dist/core/session-manager.js'),load('dist/core/settings-manager.js'),
    load('dist/core/resource-loader.js'),load('node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js')]);
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'dsg-pi-door-'))),payloads=[],callIds=[],responses=[],events=[],extensionErrors=[];
  let session,door,transportInvocations=0;
  const core=http.createServer((req,res)=>{
    if(req.url==='/health'){req.resume();return res.end('ok');}
    let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{
      payloads.push(JSON.parse(body));callIds.push(req.headers['x-dsg-call-id']);
      assert.equal(payloads.at(-1).reasoning_effort,'xhigh');
      // Simulate acceptance/work before the reply is lost. Door cannot know
      // whether this happened just because it has not received response headers.
      if(payloads.length===1)return res.destroy();
      res.writeHead(200,{'content-type':'text/event-stream'});
      res.end(`data: ${JSON.stringify({id:'fixture',choices:[{index:0,delta:{content:'DONE'},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:1}})}\n\ndata: [DONE]\n\n`);
    });
  });
  t.after(async()=>{session?.dispose();await door?.close();core.closeAllConnections();await new Promise(r=>core.close(r));fs.rmSync(dir,{recursive:true,force:true});});
  await new Promise(r=>core.listen(0,'127.0.0.1',r));
  door=createDoor({host:'127.0.0.1',port:0,api_key:'fixture',continuity_door:{enabled:true,core_port:core.address().port,control_socket:path.join(dir,'door.sock'),health_interval_ms:250}});
  await door.start();const baseUrl=`http://127.0.0.1:${door.server.address().port}/v1`,provider='fixture-door';
  const model={id:'deepseek-v4-flash',name:'Fixture',reasoning:true,thinkingLevelMap:{xhigh:'xhigh'},input:['text','image'],contextWindow:262144,maxTokens:262144,cost:{input:0,output:0,cacheRead:0,cacheWrite:0},compat:{supportsReasoningEffort:true}};
  const modelsPath=path.join(dir,'models.json');fs.writeFileSync(modelsPath,JSON.stringify({providers:{[provider]:{baseUrl,api:'openai-completions',apiKey:'fixture',models:[model]}}}),{mode:0o600});
  const runtime=await ModelRuntime.create({modelsPath,authPath:path.join(dir,'auth.json'),modelsStorePath:path.join(dir,'models-store.json'),allowModelNetwork:false,refreshOnCreate:false});
  const original=structuredClone(runtime.getModel(provider,model.id));
  // Test-local retry policy only. Never read or edit the owner's Pi settings.
  const settings=SettingsManager.inMemory({compaction:{enabled:false},retry:{enabled:retryEnabled,maxRetries:1,baseDelayMs:1}});
  const loader=new DefaultResourceLoader({cwd:dir,agentDir:dir,settingsManager:settings,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,
    systemPrompt:'Synthetic fixture. Answer DONE.',extensionFactories:[pi=>registerPiContinuity(pi,{provider,baseUrl,streamSimple:(model,context,options)=>{
      const transport=options.fetch;
      return streamSimple(model,context,{...options,fetch:async(input,init)=>{
        transportInvocations++;const response=await transport(input,init);
        if(response.status===503)responses.push({dispatch:response.headers.get('x-dsg-dispatch-state'),body:await response.clone().json()});
        return response;
      }});
    }})]});
  await loader.reload();
  ({session}=await createAgentSession({cwd:dir,agentDir:dir,modelRuntime:runtime,model:original,thinkingLevel:'xhigh',settingsManager:settings,
    sessionManager:SessionManager.inMemory(dir),resourceLoader:loader,noTools:'builtin',customTools:[]}));
  await session.bindExtensions({onError:e=>extensionErrors.push(e.message)});session.subscribe(e=>events.push(e.type));
  await session.prompt('Answer DONE.');await session.waitForIdle();
  assert.equal(payloads.length,retryEnabled?2:1);assert.equal(transportInvocations,payloads.length,'each core acceptance was a separate client transport invocation');
  assert.equal(door.status().failed,1);assert.equal(responses.length,1);assert.equal(responses[0].dispatch,'unknown');
  assert.equal(responses[0].body.error.continuity.retry_class,'inspect_before_retry');
  assert.equal(events.includes('auto_retry_start'),retryEnabled);assert.equal(events.at(-1),'agent_settled');assert.deepEqual(extensionErrors,[]);
  if(retryEnabled){assert.deepEqual(payloads[1].messages,payloads[0].messages);assert.equal(new Set(callIds).size,2);}
  for(const field of ['contextWindow','maxTokens','reasoning','input','thinkingLevelMap','compat','baseUrl'])assert.deepEqual(session.model[field],original[field]);
});
