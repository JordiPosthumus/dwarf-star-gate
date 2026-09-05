import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createGateway} from './gateway.mjs';
import {registerPiContinuity} from './continuity-client.mjs';
import {VISUAL_TOOL} from './pi-visual-continuity.mjs';

test('real Pi loads standalone visual extension without replacing any provider',{skip:!process.env.DSG_PI_ROOT},async()=>{
  const {loadExtensions}=await import(pathToFileURL(path.join(process.env.DSG_PI_ROOT,'dist/core/extensions/loader.js')));
  const previousProvider=process.env.DSG_PI_PROVIDER,previousUrl=process.env.DSG_PI_BASE_URL;
  try{
    process.env.DSG_PI_PROVIDER='fixture-dsg';process.env.DSG_PI_BASE_URL='http://127.0.0.1:3210/v1';
    const loaded=await loadExtensions([path.resolve('examples/pi-dsg-visual-continuity.ts')],process.cwd());
    assert.deepEqual(loaded.errors,[]);assert.equal(loaded.extensions.length,1);
    assert.equal(loaded.extensions[0].tools.has(VISUAL_TOOL),true);
    assert.equal(loaded.extensions[0].handlers.has('context'),true);
    assert.equal(loaded.extensions[0].handlers.has('turn_end'),true);
    assert.deepEqual(loaded.runtime.pendingProviderRegistrations,[]);
    assert.deepEqual(loaded.runtime.pendingNativeProviderRegistrations,[]);
  }finally{
    if(previousProvider===undefined)delete process.env.DSG_PI_PROVIDER;else process.env.DSG_PI_PROVIDER=previousProvider;
    if(previousUrl===undefined)delete process.env.DSG_PI_BASE_URL;else process.env.DSG_PI_BASE_URL=previousUrl;
  }
});

// Real Pi serialization and tool loop, scripted backend (not a visual-quality
// evaluation of a real model). The success criterion is actual image delivery
// AFTER the recovery tool, with original history intact and no user restart.
for(const mode of ['overflow','premature-final','gif'])test(`real Pi visual recovery: ${mode} continues to a valid image request`,{skip:!process.env.DSG_PI_ROOT},async t=>{
  const root=process.env.DSG_PI_ROOT;
  const {streamSimple}=await import(pathToFileURL(path.join(root,'node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js')));
  const {Agent}=await import(pathToFileURL(path.join(root,'node_modules/@earendil-works/pi-agent-core/dist/agent.js')));
  const png=fs.readFileSync(new URL('./ui/favicon-v1.png',import.meta.url)).toString('base64');
  const newPng=fs.readFileSync(new URL('./ui/logo.png',import.meta.url)).toString('base64');
  const original=mode==='gif'?[{type:'image',mimeType:'image/gif',data:'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'}]:Array.from({length:18},()=>({type:'image',mimeType:'image/png',data:png}));
  let calls=0,selections=0,reads=0,nudges=0;const payloads=[];
  const server=http.createServer((req,res)=>{
    if(req.url==='/v1/models')return res.end(JSON.stringify({data:[{id:'deepseek-v4-flash',context_length:262144}]}));
    let body='';req.on('data',c=>body+=c);req.on('end',()=>{
      const payload=JSON.parse(body);payloads.push(payload);calls++;
      assert.equal(payload.reasoning_effort,'xhigh');
      const images=payload.messages.flatMap(m=>Array.isArray(m.content)?m.content:[]).filter(b=>b.type==='image_url');
      assert.ok(images.length<=16);assert.ok(images.every(i=>i.image_url.url.startsWith('data:image/png;base64,')));
      let delta,finish='tool_calls';
      if(!selections){
        assert.equal(images.length,0);assert.match(JSON.stringify(payload),/INCLUDING older turns/);
        if(mode==='premature-final'&&calls===1){delta={content:'Visual feedback was withheld.'};finish='stop';}
        else delta={tool_calls:[{index:0,id:`choose_${calls}`,type:'function',function:{name:VISUAL_TOOL,arguments:JSON.stringify({action:'select',ids:mode==='gif'?[]:['v18'],reason:mode==='gif'?'Prepare PNG frames with read_frame':'Inspect the latest screenshot'})}}]};
      }else if(!reads){
        assert.equal(images.length,mode==='gif'?0:1);
        if(images.length)assert.equal(images[0].image_url.url,`data:image/png;base64,${png}`);
        delta={tool_calls:[{index:0,id:`read_${calls}`,type:'function',function:{name:'read_frame',arguments:'{}'}}]};
      }else{
        assert.equal(images.length,mode==='gif'?1:2);assert.equal(images.at(-1).image_url.url,`data:image/png;base64,${newPng}`);
        delta={content:'VALID_VISUAL_REQUEST_RECEIVED'};finish='stop';
      }
      res.writeHead(200,{'content-type':'text/event-stream'});
      res.end(`data: ${JSON.stringify({id:'fixture',choices:[{index:0,delta,finish_reason:finish}],usage:{prompt_tokens:10,completion_tokens:2}})}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close();});
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'dsg-pi-visual-'));
  const gateway=createGateway({host:'127.0.0.1',port:0,api_key:'fixture',model:'deepseek-v4-flash',context_length:262144,state_file:path.join(directory,'state.json'),vision_compatibility:{enabled:true},nodes:[{id:'fixture',url:`http://127.0.0.1:${server.address().port}`}],health_interval_ms:100000});
  t.after(async()=>{await gateway.close();fs.rmSync(directory,{recursive:true,force:true});});const address=await gateway.start(),baseUrl=`http://127.0.0.1:${address.port}/v1`;
  const model={id:'deepseek-v4-flash',name:'Fixture',api:'openai-completions',provider:'fixture-dsg',baseUrl,reasoning:true,thinkingLevelMap:{xhigh:'xhigh'},input:['text','image'],contextWindow:262144,maxTokens:262144,cost:{input:0,output:0,cacheRead:0,cacheWrite:0},compat:{supportsReasoningEffort:true,sendSessionAffinityHeaders:true}};
  const handlers=new Map();let tool,registered,agent;
  registerPiContinuity({on:(name,fn)=>{const rows=handlers.get(name)??[];rows.push(fn);handlers.set(name,rows);},registerTool:t=>tool=t,registerProvider:(_p,c)=>registered=c,
    sendMessage:(message,options)=>{assert.equal(options.deliverAs,'followUp');assert.equal(message.display,true);nudges++;agent.followUp({role:'user',content:[{type:'text',text:message.content}],timestamp:Date.now()});}},
  {provider:model.provider,baseUrl,streamSimple,visualContinuity:true});
  agent=new Agent({initialState:{model,thinkingLevel:'xhigh',tools:[{...tool,execute:async(...args)=>{const r=await tool.execute(...args,{model});assert.equal(r.isError,undefined);selections++;return r;}},
    {name:'read_frame',label:'Read frame',description:'Fixture PNG frame already prepared by the test',parameters:{type:'object',properties:{}},execute:async()=>{reads++;return {content:[{type:'image',mimeType:'image/png',data:newPng}],details:{}};}}]},
    sessionId:'visual-fixture',getApiKey:()=> 'fixture',streamFn:(m,c,o)=>registered.streamSimple(m,c,o)});
  agent.subscribe(async event=>{for(const handler of handlers.get(event.type)??[])await handler(event,{model});});
  await agent.prompt('Inspect the relevant game image, then read_frame and continue checking visuals.',original);
  assert.equal(agent.state.messages.at(-1).stopReason,'stop');
  assert.equal(agent.state.messages.at(-1).content[0].text,'VALID_VISUAL_REQUEST_RECEIVED');
  assert.equal(calls,mode==='premature-final'?4:3);assert.equal(selections,1);assert.equal(reads,1);assert.equal(nudges,mode==='premature-final'?1:0);
  assert.deepEqual(agent.state.messages[0].content.filter(c=>c.type==='image'),original,'no saved-history pruning');
  assert.ok(!JSON.stringify(agent.state.messages).includes('DSG request preparation, not a visual answer'),'temporary projection is not appended to saved conversation');
  assert.equal(gateway.stats().workers[0].failed,0);
});
