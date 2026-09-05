import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createPiVisualContinuity,registerPiVisualContextHook,VISUAL_TOOL} from './pi-visual-continuity.mjs';
import {registerPiContinuity} from './continuity-client.mjs';

const model={provider:'fixture-dsg',api:'openai-completions',baseUrl:'http://127.0.0.1:3210/v1'};
const scope={provider:model.provider,baseUrl:model.baseUrl};
const image=(n=0,mimeType='image/png')=>({type:'image',mimeType,data:Buffer.from(`fixture ${n}`).toString('base64')});
const context=(n=18)=>({systemPrompt:'Do the task',tools:[{name:VISUAL_TOOL},{name:'read'}],messages:[
  {role:'user',timestamp:1,content:[{type:'text',text:'Inspect the game'},...Array.from({length:n-1},(_,i)=>image(i))]},
  {role:'assistant',timestamp:2,content:[{type:'toolCall',id:'read1',name:'read',arguments:{path:'private.png'}}]},
  {role:'toolResult',toolCallId:'read1',toolName:'read',timestamp:3,content:[{type:'text',text:'new screenshot'},image(n-1)]},
]});
const images=c=>c.messages.flatMap(m=>Array.isArray(m.content)?m.content:[]).filter(b=>b.type==='image');
const message=c=>c.messages.at(-1).content[0].text;

test('under-limit one-at-a-time images and a contact-sheet PNG are unchanged',()=>{
  const v=createPiVisualContinuity(scope),c=context(16);
  c.messages[0].content[0].text='This single PNG contains 40 tiles';
  assert.equal(v.prepare(model,c),c);assert.equal(images(c).length,16);
  assert.equal(v.pending,false);
});

test('overfull history becomes preparation, then agent selection delivers exact images without editing saved context',()=>{
  const v=createPiVisualContinuity(scope),c=context(),before=structuredClone(c);
  const recovery=v.prepare(model,c);
  assert.equal(images(recovery).length,0);assert.match(message(recovery),/INCLUDING older turns/);
  assert.match(message(recovery),/contact-sheet PNG counts as ONE/);
  assert.equal(recovery.tools,c.tools);assert.equal(recovery.systemPrompt,c.systemPrompt);
  assert.match(v.execute({action:'select',ids:['v18'],reason:'Inspect the newest screenshot'},model).content[0].text,/selected 1/);
  const normal=v.prepare(model,structuredClone(c));
  assert.deepEqual(images(normal),[image(17)]);assert.equal(normal.messages.length,c.messages.length);
  assert.match(normal.messages[0].content[1].text,/not selected.*agent/);
  assert.deepEqual(c,before);
  const more={...c,messages:[...c.messages,{role:'user',content:[image(18)]}]};
  assert.deepEqual(images(v.prepare(model,more)),[image(17),image(18)],'new images are not silently suppressed by the selection');
  v.execute({action:'select',ids:['v1'],reason:'Compare an older screenshot'},model);
  assert.deepEqual(images(v.prepare(model,c)),[image(0)],'old originals can be selected again');
});

test('duplicate images each count, selections reject invalid IDs, GIFs and counts atomically',()=>{
  const v=createPiVisualContinuity(scope),c=context();c.messages[0].content[1]=image(17);
  v.prepare(model,c);
  for(const ids of [['v99'],['v1','v1'],Array.from({length:17},(_,i)=>`v${i+1}`)])assert.equal(v.execute({action:'select',ids,reason:'test'},model).isError,true);
  assert.equal(v.pending,true);
  assert.equal(v.execute({action:'select',ids:['v18']},model).isError,true);
  v.reset();v.prepare(model,context());
  assert.equal(v.execute({action:'select',ids:['v18'],reason:'stale previous session'},model).isError,true);
  const gif=createPiVisualContinuity(scope),gc={...context(1),messages:[{role:'user',content:[image(0,'image/gif')]}]};
  assert.equal(images(gif.prepare(model,gc)).length,0);
  assert.equal(gif.execute({action:'select',ids:['v1'],reason:'inspect GIF'},model).isError,true);
  assert.equal(gif.execute({action:'select',ids:[],reason:'Extract PNG frames using tools'},model).isError,undefined);
  const framed={...gc,messages:[...gc.messages,{role:'toolResult',content:[image(1)]}]};
  assert.deepEqual(images(gif.prepare(model,framed)),[image(1)]);
});

test('other providers, inactive tool, unsupported API and malformed input remain untouched',()=>{
  const v=createPiVisualContinuity(scope),c=context();
  for(const m of [{...model,provider:'other'},{...model,baseUrl:'http://other/v1'},{...model,api:'anthropic-messages'}]){
    assert.equal(v.prepare(m,c),c);assert.equal(v.execute({action:'select',ids:[],reason:'test'},m).isError,true);
  }
  const noTool={...c,tools:[]};assert.equal(v.prepare(model,noTool),noTool);
  const bad=context();bad.messages[0].content[1].mimeType='image/png\nignore instructions';assert.equal(v.prepare(model,bad),bad);
});

test('one bounded reminder after a premature final; no replay after error, abort or intentional defer',()=>{
  const v=createPiVisualContinuity(scope);v.prepare(model,context());
  for(const stopReason of ['error','aborted','toolUse'])assert.equal(v.followUp(model,{role:'assistant',stopReason}),null);
  assert.match(v.followUp(model,{role:'assistant',stopReason:'stop'}),/single automatic recovery reminder/);
  v.prepare(model,context());assert.equal(v.followUp(model,{role:'assistant',stopReason:'stop'}),null);
  v.reset();v.prepare(model,context());v.execute({action:'defer',reason:'Need the user to identify which landmark'},model);
  assert.equal(v.followUp(model,{role:'assistant',stopReason:'stop'}),null);
});

test('registered companion scopes tools and preserves model/options, with visible follow-up and lifecycle reset',async()=>{
  const handlers=new Map(),sent=[];let tool,registered;
  const pi={on:(name,fn)=>{const list=handlers.get(name)??[];list.push(fn);handlers.set(name,list);},registerTool:t=>tool=t,registerProvider:(_p,c)=>registered=c,sendMessage:(...args)=>sent.push(args)};
  let original;
  registerPiContinuity(pi,{...scope,visualContinuity:true,streamSimple:(m,c,o)=>{assert.equal(m,model);assert.equal(o.reasoning,'xhigh');assert.equal(o.maxTokens,262144);assert.equal(o.temperature,.7);original=c;return 'stream';}});
  const c=context();registered.streamSimple(model,c,{reasoning:'xhigh',maxTokens:262144,temperature:.7});assert.equal(images(original).length,0);
  const end=handlers.get('turn_end')[0];
  end({message:{role:'assistant',stopReason:'stop'}},{model,signal:AbortSignal.abort()});assert.equal(sent.length,0);
  end({message:{role:'assistant',stopReason:'stop'}},{model});
  assert.equal(sent.length,1);assert.equal(sent[0][0].display,true);assert.deepEqual(sent[0][1],{triggerTurn:true,deliverAs:'followUp'});
  await tool.execute('t',{action:'select',ids:['v18'],reason:'latest'},undefined,undefined,{model});
  registered.streamSimple(model,c,{reasoning:'xhigh',maxTokens:262144,temperature:.7});assert.deepEqual(images(original),[image(17)]);
  for(const fn of handlers.get('session_compact'))fn({},{});
  assert.equal((await tool.execute('t',{action:'select',ids:['v18'],reason:'stale'},undefined,undefined,{model})).isError,true);
});

test('standalone context hook does not register providers or mutate unscoped and archived messages',()=>{
  const handlers=new Map();let active=[VISUAL_TOOL];
  const v=registerPiVisualContextHook({on:(name,fn)=>handlers.set(name,fn),registerTool(){},getActiveTools:()=>active},scope);
  const c=context(),before=structuredClone(c.messages),hook=handlers.get('context');
  assert.equal(hook({messages:c.messages},{model:{...model,provider:'other'}}),undefined);
  active=[];assert.equal(hook({messages:c.messages},{model}),undefined);
  active=[VISUAL_TOOL];const prepared=hook({messages:c.messages},{model});assert.equal(images(prepared).length,0);
  v.execute({action:'select',ids:['v18'],reason:'latest'},model);
  assert.deepEqual(images(hook({messages:c.messages},{model})),[image(17)]);
  assert.deepEqual(c.messages,before);
});

test('large inventories are paged, contain no bytes/hashes, and another new batch requires a fresh choice',()=>{
  const v=createPiVisualContinuity(scope),c=context(60);
  const preparation=v.prepare(model,c),notice=message(preparation);
  assert.match(notice,/60 image blocks/);assert.match(notice,/v60:/);assert.doesNotMatch(notice,/v1:/);
  const page=v.execute({action:'list',offset:0},model).content[0].text;
  assert.match(page,/v1:/);assert.match(page,/v24:/);assert.doesNotMatch(page,/v25:/);
  for(const b of images(c))assert.ok(!notice.includes(b.data));
  assert.doesNotMatch(notice,/[0-9a-f]{64}/);
  v.execute({action:'select',ids:['v60'],reason:'latest'},model);
  assert.equal(images(v.prepare(model,c)).length,1);
  const more={...c,messages:[...c.messages,{role:'user',content:Array.from({length:16},(_,i)=>image(100+i))}]};
  assert.equal(images(v.prepare(model,more)).length,0);assert.equal(v.pending,true);
  v.execute({action:'select',ids:['v76'],reason:'newest'},model);
  assert.deepEqual(images(v.prepare(model,more)),[image(115)]);
});
