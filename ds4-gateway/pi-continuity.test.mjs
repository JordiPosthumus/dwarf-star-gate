import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createGateway} from './gateway.mjs';
import {createContinuityFetch,registerPiContinuity} from './continuity-client.mjs';

// Exercise the real installed Pi serializer AND agent/tool loop, isolated from
// operator settings, sessions and real DS4 devices. Set DSG_PI_ROOT explicitly.
test('real Pi agent survives a certified wait between tool execution and continuation',{skip:!process.env.DSG_PI_ROOT},async t=>{
  const root=process.env.DSG_PI_ROOT;
  const {streamSimple}=await import(pathToFileURL(path.join(root,'node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js')));
  const {Agent}=await import(pathToFileURL(path.join(root,'node_modules/@earendil-works/pi-agent-core/dist/agent.js')));
  const {composeModelProvider}=await import(pathToFileURL(path.join(root,'dist/core/provider-composer.js')));
  let requests=0,tools=0,waits=0,gateway;
  const backend=http.createServer((req,res)=>{
    if(req.url==='/v1/models')return res.end(JSON.stringify({data:[{id:'deepseek-v4-flash',context_length:262144}]}));
    let body='';req.on('data',c=>body+=c);req.on('end',()=>{
      const p=JSON.parse(body);assert.equal(p.model,'deepseek-v4-flash');assert.equal(p.reasoning_effort,'xhigh');++requests;
      assert.equal(req.headers['x-dsg-call-id'],undefined);
      res.writeHead(200,{'content-type':'text/event-stream'});
      const delta=requests===1?{tool_calls:[{index:0,id:'tool_1',type:'function',function:{name:'count_once',arguments:'{}'}}]}:{content:'DONE'};
      res.end(`data: ${JSON.stringify({id:'test',choices:[{index:0,delta,finish_reason:requests===1?'tool_calls':'stop'}],usage:{prompt_tokens:10,completion_tokens:2}})}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise(r=>backend.listen(0,'127.0.0.1',r));t.after(()=>{backend.closeAllConnections();backend.close();});
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dsg-pi-continuity-'));
  gateway=createGateway({host:'127.0.0.1',port:0,api_key:'fixture',model:'deepseek-v4-flash',context_length:262144,state_file:path.join(dir,'state.json'),nodes:[{id:'fixture',url:`http://127.0.0.1:${backend.address().port}`}],health_interval_ms:100000});
  t.after(()=>gateway.close());const address=await gateway.start(),baseUrl=`http://127.0.0.1:${address.port}/v1`;
  const model={id:'deepseek-v4-flash',name:'Fixture',api:'openai-completions',provider:'fixture-dsg',baseUrl,reasoning:true,thinkingLevelMap:{xhigh:'xhigh'},input:['text','image'],contextWindow:262144,maxTokens:262144,cost:{input:0,output:0,cacheRead:0,cacheWrite:0},compat:{supportsReasoningEffort:true,sendSessionAffinityHeaders:true}};
  let registered;registerPiContinuity({on(){},registerProvider(_id,c){registered=c;}},{provider:model.provider,baseUrl,streamSimple});
  const config={baseUrl,api:'openai-completions',apiKey:'fixture',models:[model]};
  const native=composeModelProvider(model.provider,null,{getProvider:()=>config},registered);
  assert.deepEqual(native.getModels(),composeModelProvider(model.provider,null,{getProvider:()=>config},undefined).getModels(),'provider wrapper must not alter model capabilities');
  const transport=createContinuityFetch({baseUrl,wait:async()=>{++waits;if(waits===4)gateway.nodes[0].drained=false;}});
  const agent=new Agent({initialState:{model,thinkingLevel:'xhigh',tools:[{name:'count_once',label:'Count',description:'Count once',parameters:{type:'object',properties:{}},execute:async()=>{++tools;gateway.nodes[0].drained=true;return {content:[{type:'text',text:'counted'}],details:{}};}}]},sessionId:'fixture-session',getApiKey:()=> 'fixture',streamFn:(m,c,o)=>streamSimple(m,c,{...o,fetch:transport})});
  await agent.prompt('Call count_once, then answer DONE.');
  assert.equal(waits,4);assert.equal(requests,2);assert.equal(tools,1);assert.equal(agent.state.errorMessage,undefined);
  assert.ok(agent.state.messages.at(-1).content.some(c=>c.type==='text'&&c.text==='DONE'));
});
