// Contract research only: no installed extension, controller or rescue authority.
// Uses real Pi APIs with disposable configuration and a scripted local backend.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

test('real Pi custom continuation preserves history/tools but is not an idempotent rescue protocol',{
  skip:!process.env.DSG_PI_ROOT,timeout:30000
},async t=>{
  const root=process.env.DSG_PI_ROOT,load=relative=>import(pathToFileURL(path.join(root,relative)));
  const version=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version;
  assert.equal(version,'0.84.4','New Pi versions need an explicit contract review, not an assumed rescue capability');
  const [{createAgentSession},{ModelRuntime},{SessionManager},{SettingsManager},{DefaultResourceLoader}]=await Promise.all([
    load('dist/core/sdk.js'),load('dist/core/model-runtime.js'),load('dist/core/session-manager.js'),load('dist/core/settings-manager.js'),load('dist/core/resource-loader.js')]);
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'dsg-pi-rescue-contract-')));
  let session,extension,inputBarrier=null,requests=0;const counts={first_once:0,next_once:0},events=[],payloads=[],errors=[];
  const backend=http.createServer((req,res)=>{
    let body='';req.on('data',c=>body+=c);req.on('end',()=>{
      assert.equal(req.url,'/v1/chat/completions');const p=JSON.parse(body);payloads.push(p);requests++;
      assert.equal(p.reasoning_effort,'xhigh');
      const name=requests===1?'first_once':requests===3?'next_once':null;
      const delta=name?{tool_calls:[{index:0,id:`call_${name}`,type:'function',function:{name,arguments:'{}'}}]}:
        {content:requests===2?'First step done. Should I keep going?':'DONE'};
      res.writeHead(200,{'content-type':'text/event-stream'});
      res.end(`data: ${JSON.stringify({id:'fixture',choices:[{index:0,delta,finish_reason:name?'tool_calls':'stop'}],usage:{prompt_tokens:10,completion_tokens:2}})}\n\ndata: [DONE]\n\n`);
    });
  });
  t.after(async()=>{session?.dispose();backend.closeAllConnections();await new Promise(resolve=>backend.close(resolve));fs.rmSync(dir,{recursive:true,force:true});});
  await new Promise(resolve=>backend.listen(0,'127.0.0.1',resolve));
  const provider='fixture-rescue',baseUrl=`http://127.0.0.1:${backend.address().port}/v1`;
  const model={id:'deepseek-v4-flash',name:'Fixture',reasoning:true,thinkingLevelMap:{xhigh:'xhigh'},input:['text','image'],contextWindow:262144,maxTokens:262144,cost:{input:0,output:0,cacheRead:0,cacheWrite:0},compat:{supportsReasoningEffort:true}};
  const modelsPath=path.join(dir,'models.json');fs.writeFileSync(modelsPath,JSON.stringify({providers:{[provider]:{baseUrl,api:'openai-completions',apiKey:'fixture',models:[model]}}}),{mode:0o600});
  const runtime=await ModelRuntime.create({modelsPath,authPath:path.join(dir,'auth.json'),modelsStorePath:path.join(dir,'models-store.json'),allowModelNetwork:false,refreshOnCreate:false});
  const original=structuredClone(runtime.getModel(provider,model.id));
  const settings=SettingsManager.inMemory({compaction:{enabled:false},retry:{enabled:false}});
  const loader=new DefaultResourceLoader({cwd:dir,agentDir:dir,settingsManager:settings,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,
    systemPrompt:'Disposable synthetic contract fixture.',extensionFactories:[pi=>{
      extension=pi;
      pi.on('input',async event=>{
        if(event.text==='New human input during review'&&inputBarrier){
          inputBarrier.entered();await inputBarrier.wait;
        }
        return {action:'continue'};
      });
    }]});
  await loader.reload();
  ({session}=await createAgentSession({cwd:dir,agentDir:dir,modelRuntime:runtime,model:runtime.getModel(provider,model.id),thinkingLevel:'xhigh',settingsManager:settings,
    sessionManager:SessionManager.inMemory(dir),resourceLoader:loader,noTools:'builtin',customTools:Object.keys(counts).map(name=>({name,label:name,description:'Count a synthetic step',parameters:{type:'object',properties:{}},
      execute:async()=>{assert.equal(session.isIdle,false,'a running tool is not settled');counts[name]++;return {content:[{type:'text',text:'counted'}],details:{}};}}))}));
  await session.bindExtensions({onError:error=>errors.push(error.message)});session.subscribe(event=>events.push(event.type));
  await session.prompt('Do the first synthetic step.');await session.waitForIdle();
  assert.equal(session.isIdle,true);assert.equal(events.at(-1),'agent_settled');assert.equal(session.pendingMessageCount,0);
  assert.deepEqual(counts,{first_once:1,next_once:0});assert.equal(requests,2);
  const history=structuredClone(session.messages),cue={customType:'dsg-rescue-contract-fixture',display:true,
    content:'Gate Genie: Continue the already-authorized task. This is not approval for a pending human decision or new scope.',details:{proposal:'synthetic-proposal'}};
  // A custom message, not sendUserMessage: attributed in Pi's session history.
  await session.sendCustomMessage(cue,{triggerTurn:true});await session.waitForIdle();
  assert.equal(session.isIdle,true);assert.equal(events.at(-1),'agent_settled');assert.equal(requests,4);
  assert.deepEqual(counts,{first_once:1,next_once:1});assert.deepEqual(session.messages.slice(0,history.length),history);
  let custom=session.messages.filter(m=>m.role==='custom');assert.equal(custom.length,1);assert.equal(custom[0].customType,cue.customType);assert.equal(custom[0].display,true);
  assert.equal(session.messages.filter(m=>m.role==='user').length,1,'no added human message in the Pi transcript');
  // Pi's LLM conversion does use a user-role wire message for custom context.
  // The explicit author/scope label therefore matters; this is not a system role.
  const text=content=>typeof content==='string'?content:Array.isArray(content)&&content.every(c=>c.type==='text')?content.map(c=>c.text).join(''):null;
  assert.ok(payloads[2].messages.some(m=>m.role==='user'&&text(m.content)===cue.content));
  assert.ok(!JSON.stringify(payloads).includes('synthetic-proposal'),'private custom details are not prompt text');
  for(const field of ['contextWindow','maxTokens','reasoning','input','thinkingLevelMap','compat','baseUrl'])assert.deepEqual(session.model[field],original[field]);
  assert.equal(session.thinkingLevel,'xhigh');assert.equal(session.sessionFile,undefined);
  // The extension facade is fire-and-forget. Identical custom details are NOT
  // a deduplication token; production rescue needs client-owned durable guards.
  const settled=new Promise(resolve=>{const unsubscribe=session.subscribe(event=>{if(event.type==='agent_settled'){unsubscribe();resolve();}});});
  assert.equal(extension.sendMessage(cue,{triggerTurn:true}),undefined);await settled;await session.waitForIdle();
  custom=session.messages.filter(m=>m.role==='custom');assert.equal(custom.length,2);assert.equal(requests,5);
  assert.deepEqual(counts,{first_once:1,next_once:1});assert.equal(session.messages.filter(m=>m.role==='user').length,1);
  // Input has already arrived, but an asynchronous input handler has not yet
  // allowed prompt preparation to finish. Public idle/queue state still looks
  // settled: a rescue fence must invalidate at ingress, before this await.
  let entered,release;
  const inputEntered=new Promise(resolve=>{entered=resolve;});
  const inputWait=new Promise(resolve=>{release=resolve;});
  inputBarrier={entered,wait:inputWait};
  const requestCountBeforeInput=requests;
  const humanPrompt=session.prompt('New human input during review');
  try {
    await inputEntered;
    assert.equal(session.isIdle,true,'idle does not include asynchronous input preparation');
    assert.equal(session.pendingMessageCount,0,'the human prompt is not represented in queued-message count');
    assert.equal(requests,requestCountBeforeInput,'the new human prompt has not reached the model');
    assert.ok(!session.messages.some(m=>m.role==='user'&&text(m.content)==='New human input during review'),
      'transcript polling also misses this admitted input');
  } finally { release();await humanPrompt;inputBarrier=null; }
  await session.waitForIdle();
  assert.equal(requests,requestCountBeforeInput+1,'the held human input resumes exactly once');
  assert.ok(session.messages.some(m=>m.role==='user'&&text(m.content)==='New human input during review'));
  assert.deepEqual(counts,{first_once:1,next_once:1},'input preparation never replays completed tools');
  // A deferred custom next-turn message is not visible in the public pending
  // count or transcript yet. Idle + zero count cannot certify an empty client.
  await session.sendCustomMessage({customType:'another-extension-fixture',display:true,content:'Deferred synthetic context'},
    {deliverAs:'nextTurn',triggerTurn:false});
  assert.equal(session.isIdle,true);assert.equal(session.pendingMessageCount,0);assert.equal(requests,6);
  assert.equal(session.messages.filter(m=>m.role==='custom').length,2);
  assert.deepEqual(errors,[]);
});
