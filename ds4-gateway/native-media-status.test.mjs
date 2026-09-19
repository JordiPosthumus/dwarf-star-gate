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
