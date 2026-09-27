import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {createNativeMediaStatus} from './native-media-status.mjs';
const config={media_jobs:{workers:{box:{engines:{video:{kind:'comfyui',port:8188}}}}},genie_chat:{inspection:{workers:{box:{ssh:['fixture-host']}}}}};
test('native reads are bounded, shared, display-only and retain observation age',async()=>{
 let calls=0,clock=100,resolve;
 const read=createNativeMediaStatus(config,{now:()=>clock,run:async(command,args,options)=>{calls++;assert.equal(command,'ssh');assert.equal(options.timeout,7000);assert.ok(args.at(-1).includes('/queue'));return await new Promise(r=>{resolve=r;});}});
 assert.equal(read()[0].state,'unknown');read();assert.equal(calls,1);
 resolve({stdout:JSON.stringify({queue_running:['external-job'],queue_pending:[]})});await setImmediate();
 assert.equal(read()[0].state,'busy');assert.deepEqual(read()[0].running,['external-job']);assert.equal(read()[0].observed_at,100);
 clock=30100;assert.equal(read()[0].observed_at,100);assert.equal(calls,2);
 resolve({stdout:'invalid'});await setImmediate();assert.equal(read()[0].state,'unknown');
});
test('unavailable native engine is never reported idle',async()=>{
 const read=createNativeMediaStatus(config,{run:async()=>{throw Error('refused');}});read();await setImmediate();assert.equal(read()[0].state,'unknown');
});

test('ACE stats count direct activity and reject incomplete observations',async()=>{
 const ace=structuredClone(config);ace.media_jobs.workers.box.engines={music:{kind:'ace-step',port:8002}};
 let value={running_count:1,waiting_count:0,queue_size:2},clock=1;
 const read=createNativeMediaStatus(ace,{now:()=>clock,run:async(_cmd,args)=>{assert.ok(args.at(-1).includes('/v1/stats'));return {stdout:JSON.stringify(value)};}});
 read();await setImmediate();assert.equal(read()[0].state,'busy');assert.equal(read()[0].waiting_count,2);
 clock+=10001;value={running_count:0,waiting_count:0,queue_size:0};read();await setImmediate();assert.equal(read()[0].state,'idle');
 clock+=10001;value={running_count:0};read();await setImmediate();assert.equal(read()[0].state,'unknown');
});

test('current paired enrollments observe each physical host once and include later additions',async()=>{
 const c={workers:[{id:'pair',url:'http://pair'}],genie_chat:{inspection:{workers:{pair:{ssh:['head'],container:'llm-head'}}}},media_jobs:{pairs:{pair:{kind:'glm53-docker-pair',model:'model',worker_binding:{id:'pair',url:'http://pair'},members:[{ssh:'head',container:'llm-head'},{ssh:'rank',container:'llm-rank'}]}},workers:{pair:{engines:{video:{kind:'comfyui',port:8188,member:1}},member_engines:{1:{video:{kind:'comfyui',port:8188,member:1}}}}}}};
 const {mediaNativeEnrollments}=await import('./media-enrollment.mjs');
 const inventory={native_targets:mediaNativeEnrollments(c)},hosts=[];
 const read=createNativeMediaStatus(c,{run:async(_cmd,args)=>{hosts.push(args.at(-2));return {stdout:JSON.stringify({queue_running:[],queue_pending:[]})};}});
 assert.equal(inventory.native_targets.length,1);read(inventory);await setImmediate();assert.deepEqual(hosts,['rank']);assert.equal(read(inventory)[0].member,1);
 // Gateway sees a new enrollment while the dashboard's original config is unchanged.
 inventory.native_targets.push({...inventory.native_targets[0],member:0});read(inventory);await setImmediate();
 assert.deepEqual(hosts,['rank','rank','head']);assert.equal(read(inventory).length,2);assert.ok(read(inventory).every(r=>r.state==='idle'));
 const unbound=structuredClone(c);unbound.media_jobs.pairs.pair.members[0].ssh='changed';let calls=0;
 const refused=createNativeMediaStatus(unbound,{run:async()=>{calls++;throw Error('must not probe');}});refused(inventory);await setImmediate();assert.equal(calls,0);assert.ok(refused(inventory).every(r=>r.state==='unknown'));
});

test('an enrollment change cannot inherit an in-flight old engine observation',async()=>{
 let resolve,calls=0;const read=createNativeMediaStatus(config,{run:async()=>{calls++;return await new Promise(r=>resolve=r);}});
 const inventory={native_targets:[{worker_id:'box',kind:'video',engine:'comfyui',port:8188,container:'old'}]};
 read(inventory);inventory.native_targets[0].container='new';assert.equal(read(inventory)[0].state,'unknown');
 resolve({stdout:JSON.stringify({queue_running:['old-job'],queue_pending:[]})});await setImmediate();
 assert.equal(read(inventory)[0].state,'unknown');assert.equal(calls,2);
 resolve({stdout:JSON.stringify({queue_running:[],queue_pending:[]})});await setImmediate();assert.equal(read(inventory)[0].state,'idle');
});
