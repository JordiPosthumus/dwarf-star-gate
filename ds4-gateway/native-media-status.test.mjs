import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {createNativeMediaStatus} from './native-media-status.mjs';
import {mediaNativeEnrollments} from './media-enrollment.mjs';
// Existing queue/identity tests exercise an active job on each fixture engine.
const activeReader=(config,options)=>{
 const read=createNativeMediaStatus(config,options);
 return inventory=>read({...inventory,jobs:(inventory?.native_targets??mediaNativeEnrollments(config)).map(t=>({
   kind:t.kind,execution:{worker_id:t.worker_id,member:t.member,phase:'generating'}
 }))});
};
const config={media_jobs:{workers:{box:{engines:{video:{kind:'comfyui',port:8188}}}}},genie_chat:{inspection:{workers:{box:{ssh:['fixture-host']}}}}};
test('native reads are bounded, shared, display-only and retain observation age',async()=>{
 let calls=0,clock=100,resolve;
 const read=activeReader(config,{now:()=>clock,run:async(command,args,options)=>{calls++;assert.equal(command,'ssh');assert.equal(options.timeout,7000);assert.ok(args.at(-1).includes('/queue'));return await new Promise(r=>{resolve=r;});}});
 assert.equal(read()[0].state,'unknown');read();assert.equal(calls,1);
 resolve({stdout:JSON.stringify({queue_running:['external-job'],queue_pending:[]})});await setImmediate();
 assert.equal(read()[0].state,'busy');assert.deepEqual(read()[0].running,['external-job']);assert.equal(read()[0].observed_at,100);
 clock=30100;assert.equal(read()[0].observed_at,100);assert.equal(calls,2);
 resolve({stdout:'invalid'});await setImmediate();assert.equal(read()[0].state,'unknown');
});
test('unavailable native engine is never reported idle',async()=>{
 const read=activeReader(config,{run:async()=>{throw Error('refused');}});read();await setImmediate();assert.equal(read()[0].state,'unknown');
});

test('ACE stats count direct activity and reject incomplete observations',async()=>{
 const ace=structuredClone(config);ace.media_jobs.workers.box.engines={music:{kind:'ace-step',port:8002}};
 let value={running_count:1,waiting_count:0,queue_size:2},clock=1;
 const read=activeReader(ace,{now:()=>clock,run:async(_cmd,args)=>{assert.ok(args.at(-1).includes('/v1/stats'));return {stdout:JSON.stringify(value)};}});
 read();await setImmediate();assert.equal(read()[0].state,'busy');assert.equal(read()[0].waiting_count,2);
 clock+=10001;value={running_count:0,waiting_count:0,queue_size:0};read();await setImmediate();assert.equal(read()[0].state,'idle');
 clock+=10001;value={running_count:0};read();await setImmediate();assert.equal(read()[0].state,'unknown');
});

test('current paired enrollments observe each physical host once and include later additions',async()=>{
 const c={workers:[{id:'pair',url:'http://pair'}],genie_chat:{inspection:{workers:{pair:{ssh:['head'],container:'llm-head'}}}},media_jobs:{pairs:{pair:{kind:'glm53-docker-pair',model:'model',worker_binding:{id:'pair',url:'http://pair'},members:[{ssh:'head',container:'llm-head'},{ssh:'rank',container:'llm-rank'}]}},workers:{pair:{engines:{video:{kind:'comfyui',port:8188,member:1}},member_engines:{1:{video:{kind:'comfyui',port:8188,member:1}}}}}}};
 const {mediaNativeEnrollments}=await import('./media-enrollment.mjs');
 const inventory={native_targets:mediaNativeEnrollments(c)},hosts=[];
 const read=activeReader(c,{run:async(_cmd,args)=>{hosts.push(args.at(-2));return {stdout:JSON.stringify({queue_running:[],queue_pending:[]})};}});
 assert.equal(inventory.native_targets.length,1);read(inventory);await setImmediate();assert.deepEqual(hosts,['rank']);assert.equal(read(inventory)[0].member,1);
 // Gateway sees a new enrollment while the dashboard's original config is unchanged.
 inventory.native_targets.push({...inventory.native_targets[0],member:0});read(inventory);await setImmediate();
 assert.deepEqual(hosts,['rank','rank','head']);assert.equal(read(inventory).length,2);assert.ok(read(inventory).every(r=>r.state==='idle'));
 const unbound=structuredClone(c);unbound.media_jobs.pairs.pair.members[0].ssh='changed';let calls=0;
 const refused=activeReader(unbound,{run:async()=>{calls++;throw Error('must not probe');}});refused(inventory);await setImmediate();assert.equal(calls,0);assert.ok(refused(inventory).every(r=>r.state==='unknown'));
});

test('an enrollment change cannot inherit an in-flight old engine observation',async()=>{
 let resolve,calls=0;const read=activeReader(config,{run:async()=>{calls++;return await new Promise(r=>resolve=r);}});
 const inventory={native_targets:[{worker_id:'box',kind:'video',engine:'comfyui',port:8188,container:'old'}]};
 read(inventory);inventory.native_targets[0].container='new';assert.equal(read(inventory)[0].state,'unknown');
 resolve({stdout:JSON.stringify({queue_running:['old-job'],queue_pending:[]})});await setImmediate();
 assert.equal(read(inventory)[0].state,'unknown');assert.equal(calls,2);
 resolve({stdout:JSON.stringify({queue_running:[],queue_pending:[]})});await setImmediate();assert.equal(read(inventory)[0].state,'idle');
});


test('idle status reads and inventory changes never trigger SSH',async()=>{
 let calls=0,clock=0;const read=createNativeMediaStatus(config,{now:()=>clock,run:async()=>{calls++;throw Error('must not run');}});
 for(let i=0;i<100;i++){clock+=10000;assert.equal(read({jobs:[]})[0].observed_at,null);}
 read({jobs:[],native_targets:[{worker_id:'box',kind:'video',engine:'comfyui',port:8189}]});assert.equal(calls,0);
});
test('explicit refresh is shared and returns its observation, then idle reads stay local',async()=>{
 let calls=0,clock=1,resolve;const read=createNativeMediaStatus(config,{now:()=>clock,run:async()=>{calls++;return new Promise(r=>resolve=r);}});
 const one=read.refresh({jobs:[]}),two=read.refresh({jobs:[]});assert.equal(calls,1);
 resolve({stdout:JSON.stringify({queue_running:[],queue_pending:[]})});
 assert.equal((await one)[0].state,'idle');assert.deepEqual(await two,await one);
 clock+=3600000;read({jobs:[]});assert.equal(calls,1);assert.equal(read()[0].observed_at,1);
});
test('active jobs poll only their engine and failed checks back off',async()=>{
 const c=structuredClone(config);c.media_jobs.workers.box.engines.music={kind:'ace-step',port:8002};
 let calls=0,clock=1;const read=createNativeMediaStatus(c,{now:()=>clock,run:async(_cmd,args)=>{calls++;assert.ok(args.at(-1).includes('/queue'));throw Error('offline');}});
 const inventory={jobs:[{kind:'video',execution:{worker_id:'box',phase:'generating'}}]};
 read(inventory);await setImmediate();assert.equal(calls,1);
 clock+=10001;read(inventory);assert.equal(calls,1);
 clock+=60000;read(inventory);await setImmediate();assert.equal(calls,2);
 inventory.jobs[0].execution.phase='returned';clock+=60000;read(inventory);assert.equal(calls,2);
});
test('a directly observed external job is tracked until its queue empties',async()=>{
 let calls=0,clock=1,busy=true;const read=createNativeMediaStatus(config,{now:()=>clock,run:async()=>{calls++;return {stdout:JSON.stringify({queue_running:busy?['external']:[],queue_pending:[]})};}});
 await read.refresh({jobs:[]});assert.equal(calls,1);
 clock+=10001;busy=false;read({jobs:[]});await setImmediate();assert.equal(calls,2);assert.equal(read()[0].state,'idle');
 clock+=10001;read();assert.equal(calls,2);
});
