import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {MediaWatch} from './media-watch.mjs';
test('native conversation creation and dispatch are awaited before media follow-up is recorded',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'sg-native-media-watch-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const status={enabled:true,jobs:[{id:'one',kind:'video',state:'queued'}],workers:[{id:'a',busy:false,kinds:['video']}],fleet:[{id:'a',is_healthy:true,drained:false},{id:'b',is_healthy:true,drained:false}]};
  let finish;const calls=[];
  const chat={status:()=>({available:true,conversations:[]}),create:async()=>({id:'native-conversation'}),submit:async(...args)=>{calls.push(args);await new Promise(r=>finish=r);}};
  const watch=new MediaWatch({filename:path.join(directory,'watch.json'),chat,read:async()=>status,isEnabled:()=>true,now:()=>100000});
  const tick=watch.tick();while(!finish)await new Promise(r=>setImmediate(r));
  assert.equal(calls[0][0],'native-conversation');assert.ok(watch.state.pending);assert.equal(watch.state.key,undefined);
  await watch.tick();assert.equal(calls.length,1);finish();await tick;
  assert.equal(watch.state.pending,undefined);assert.ok(watch.state.key);
});
test('a disabled media capability while native conversation creation waits prevents dispatch',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'sg-native-media-pause-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  let enabled=true,finish,submitted=0;
  const chat={status:()=>({available:true,conversations:[]}),create:()=>new Promise(r=>finish=r),submit:async()=>submitted++};
  const status={enabled:true,jobs:[{id:'one',kind:'video',state:'queued'}],workers:[{id:'a',busy:false,kinds:['video']}],fleet:[{id:'a',is_healthy:true,drained:false},{id:'b',is_healthy:true,drained:false}]};
  const watch=new MediaWatch({filename:path.join(directory,'watch.json'),chat,read:async()=>status,isEnabled:()=>enabled,now:()=>100000});
  const tick=watch.tick();while(!finish)await new Promise(r=>setImmediate(r));
  enabled=false;finish({id:'native'});await tick;assert.equal(submitted,0);assert.equal(watch.state.pending,undefined);
});
test('queue arrival wakes Genie once; busy chat, disabled switch and missing LLM capacity do not',async t=>{
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'sg-media-watch-'));t.after(()=>fs.rmSync(folder,{recursive:true,force:true}));
  let enabled=true,busy=false,now=100000;const calls=[],status={enabled:true,jobs:[{id:'one',kind:'video',state:'queued',priority:'normal'}],workers:[{id:'a',busy:false,kinds:['video']}],fleet:[{id:'a',is_healthy:true,drained:false,load:0,queued:0},{id:'b',is_healthy:true,drained:false,load:0,queued:0}]};
  const chat={status:()=>({available:true,conversations:[{busy}]}),create:()=>({id:'conversation'}),submit:(...args)=>calls.push(args)};
  const options={filename:path.join(folder,'watch.json'),chat,read:async()=>status,isEnabled:()=>enabled,now:()=>now};
  const w=new MediaWatch(options);busy=true;await w.tick();assert.equal(calls.length,0);busy=false;enabled=false;await w.tick();assert.equal(calls.length,0);enabled=true;
  status.fleet[1].drained=true;await w.tick();assert.equal(calls.length,0);status.fleet[1].drained=false;
  await w.tick();assert.equal(calls.length,1);await new MediaWatch(options).tick();assert.equal(calls.length,1);
  status.jobs[0].execution={phase:'generating'};now+=60001;await w.tick();assert.equal(calls.length,1);
  delete status.jobs[0].execution;status.fleet[1].load=1;await w.tick();assert.equal(calls.length,2);
  w.close();status.fleet[1].load=2;now+=60001;await w.tick();assert.equal(calls.length,2);
});
test('uncertain chat submission reuses the same message identity',async t=>{
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'sg-media-watch-'));t.after(()=>fs.rmSync(folder,{recursive:true,force:true}));const calls=[];
  const options={filename:path.join(folder,'watch.json'),isEnabled:()=>true,now:()=>100000,chat:{status:()=>({available:true,conversations:[]}),create:()=>({id:'conversation'}),submit:(...args)=>{calls.push(args);if(calls.length===1)throw new Error('reply lost');}},read:async()=>({enabled:true,jobs:[{id:'one',kind:'video',state:'queued'}],workers:[{id:'a',busy:false,kinds:['video']}],fleet:[{id:'a',is_healthy:true},{id:'b',is_healthy:true}]})};
  await new MediaWatch(options).tick();await new MediaWatch(options).tick();assert.equal(calls.length,2);assert.deepEqual(calls[0],calls[1]);
});

test('media host eligibility wakes Genie for a paused LLM without overriding placement or maintenance',async t=>{
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'sg-media-watch-paused-'));t.after(()=>fs.rmSync(folder,{recursive:true,force:true}));const calls=[];
 const status={enabled:true,jobs:[{id:'one',kind:'video',state:'queued'}],workers:[{id:'a',busy:false,kinds:['video']}],fleet:[{id:'a',is_healthy:true,drained:true},{id:'b',is_healthy:true,drained:false}],hosts:[{id:'a',engines:[{kind:'video',ready:false}]}]};
 const watch=new MediaWatch({filename:path.join(folder,'state.json'),isEnabled:()=>true,chat:{status:()=>({available:true,conversations:[]}),create:()=>({id:'chat'}),submit:(...args)=>calls.push(args)},read:async()=>status});
 await watch.tick();assert.equal(calls.length,0);status.hosts[0].engines[0].ready=true;await watch.tick();assert.equal(calls.length,1);assert.match(calls[0][1],/start_media_job/);
});
