import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {MediaStandardWatch,mediaStandardTargets} from './media-standard-watch.mjs';
function fixture(t){
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'media-standard-'));t.after(()=>fs.rmSync(folder,{recursive:true,force:true}));
 const targets=[{worker_id:'pair',member:0,engine:'ace-step'},{worker_id:'pair',member:1,engine:'h3'}];
 const config={machine_groups:{pair:['a','b'],spare:['c']},media_jobs:{standard:{enabled:true,targets}}};
 const s={enabled:true,jobs:[],fleet:[{id:'pair',is_healthy:true,load:0,queued:0},{id:'spare',is_healthy:true}],hosts:[{id:'pair',members:[0,1].map(member=>({member,engines:[{id:'ace-step',allowed:true,enrolled:false},{id:'h3',allowed:true,enrolled:false}]}))}],setup:{hosts:[{worker_id:'pair',available:true}],operations:[]}};
 let busy=false,enabled=true;const calls=[];
 const chat={status:()=>({available:true,conversations:[{busy}]}),create:()=>({id:'chat'}),submit:(...args)=>calls.push(args)};
 const options={filename:path.join(folder,'state.json'),config,chat,read:async()=>s,isEnabled:()=>enabled};
 return {s,calls,config,options,chat,busy:v=>busy=v,enabled:v=>enabled=v};
}
test('standard advances through actual Genie after saved native completion and reload',async t=>{
 const f=fixture(t),w=new MediaStandardWatch(f.options);await w.tick();assert.equal(f.calls.length,1);assert.match(f.calls[0][1],/"member":0/);
 f.s.setup.operations.push({worker_id:'pair',member:0,engine:'ace-step',operation_id:'first',phase:'preparing_media'});
 await new MediaStandardWatch(f.options).tick();assert.equal(f.calls.length,1);
 f.s.setup.operations[0].phase='enrolled';f.s.hosts[0].members[0].engines[0].enrolled=true;
 const reloaded=new MediaStandardWatch(f.options);await reloaded.tick();assert.equal(f.calls.length,2);assert.match(f.calls[1][1],/"member":1/);
 f.s.hosts[0].members[1].engines[1].enrolled=true;await reloaded.tick();assert.ok(reloaded.status().targets.every(t=>t.phase==='enrolled'));assert.equal(f.calls.length,2);
});
test('failure triggers read-only diagnosis once, never native retry, and other member proceeds',async t=>{
 const f=fixture(t);f.s.setup.operations=[{worker_id:'pair',member:0,engine:'ace-step',operation_id:'failed',phase:'failed_unchanged',at:'fixed',detail:'Container missing'}];
 const w=new MediaStandardWatch(f.options);await w.tick();assert.match(f.calls[0][1],/Do not repeat setup/);assert.equal(w.status().targets[0].phase,'needs_attention');
 const next=new MediaStandardWatch(f.options);await next.tick();assert.equal(f.calls.length,2);assert.match(f.calls[1][1],/"member":1/);await next.tick();assert.equal(f.calls.length,2);
});
test('busy chat, capability, placement, active setup, demand and shared hardware defer',async t=>{
 const f=fixture(t),w=new MediaStandardWatch(f.options);f.busy(true);await w.tick();f.busy(false);f.enabled(false);await w.tick();f.enabled(true);
 f.config.machine_groups.spare=['a'];await w.tick();assert.equal(f.calls.length,0);f.config.machine_groups.spare=['c'];
 f.s.fleet[0].load=1;await w.tick();assert.equal(f.calls.length,0);f.s.fleet[0].load=0;
 for(const m of f.s.hosts[0].members)for(const e of m.engines)e.allowed=false;await w.tick();assert.equal(f.calls.length,0);
 for(const m of f.s.hosts[0].members)for(const e of m.engines)e.allowed=true;w.close();await w.tick();assert.equal(f.calls.length,0);
});
test('uncertain chat submission preserves exact request across watcher reload',async t=>{
 const f=fixture(t);f.chat.submit=(...args)=>{f.calls.push(args);if(f.calls.length===1)throw Error('lost reply');};
 await new MediaStandardWatch(f.options).tick();await new MediaStandardWatch(f.options).tick();assert.equal(f.calls.length,2);assert.deepEqual(f.calls[0],f.calls[1]);
});
test('qualified return requests final enrollment without reinstall; malformed targets fail closed',async t=>{
 const f=fixture(t);f.s.setup.operations=[{worker_id:'pair',member:0,engine:'ace-step',phase:'qualified_returned',operation_id:'proof'}];
 await new MediaStandardWatch(f.options).tick();assert.match(f.calls[0][1],/finish pending enrollment/);
 f.config.media_jobs.standard.targets.push(f.config.media_jobs.standard.targets[0]);assert.throws(()=>mediaStandardTargets(f.config),/Duplicate/);
 assert.deepEqual(mediaStandardTargets({}),[]);
 assert.throws(()=>mediaStandardTargets({media_jobs:{standard:{enabled:true,targets:[{worker_id:'x',engine:'h3',member:3}]}}}));
});

test('a no-action Genie reply is visible and does not create a repeated setup loop',async t=>{
 const f=fixture(t);f.config.media_jobs.standard.targets.splice(1);const w=new MediaStandardWatch(f.options);
 await w.tick();await w.tick();assert.equal(f.calls.length,1);assert.equal(w.status().targets[0].phase,'needs_attention');
 await new MediaStandardWatch(f.options).tick();assert.equal(f.calls.length,1);
});

test('only a backend-verified corrected preflight gets one same-ID timestamped retry',async t=>{
 const f=fixture(t);f.config.media_jobs.standard.targets.splice(1);
 f.s.setup.operations=[{worker_id:'pair',member:0,engine:'ace-step',operation_id:'old',phase:'failed_unchanged',at:'2026-01-01T00:00:00Z',retry_ready:true}];
 const w=new MediaStandardWatch(f.options);await w.tick();assert.match(f.calls[0][1],/"expected_failed_at":"2026-01-01T00:00:00Z"/);assert.match(f.calls[0][1],/same operation ID/);
 await w.tick();assert.equal(f.calls.length,1);
});

test('native source repair progresses to exact retry without another owner prompt',async t=>{
 const f=fixture(t);f.config.media_jobs.standard.targets.splice(1);f.s.setup.source_repair_supported=true;
 f.s.setup.operations=[{worker_id:'pair',member:0,engine:'ace-step',operation_id:'old',phase:'failed_unchanged',at:'2026-01-01T00:00:00Z',failure_context:{stage:'read_only_preflight',selected_media_container:'missing'}}];
 await new MediaStandardWatch(f.options).tick();assert.match(f.calls[0][1],/repair_media_setup/);
 f.s.setup.operations[0].retry_ready=true;await new MediaStandardWatch(f.options).tick();assert.equal(f.calls.length,2);assert.match(f.calls[1][1],/Call setup_media_host/);
 f.s.setup.operations[0].phase='preparing_media';await new MediaStandardWatch(f.options).tick();assert.equal(f.calls.length,2);
});
