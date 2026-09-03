import {test} from 'node:test';
import assert from 'node:assert/strict';
import {deadlineTimer,queueTimeout,MAX_TIMER_MS,DEFAULT_QUEUE_TIMEOUT_MS} from './deadline.mjs';
function clock(){let time=0,next=0;const jobs=new Map(),delays=[];return {jobs,delays,now:()=>time,setTimer(fn,ms){assert.ok(ms>=1&&ms<=MAX_TIMER_MS);const id=++next;jobs.set(id,{fn,ms});delays.push(ms);return id;},clearTimer:id=>jobs.delete(id),fire(elapsed){const [id,j]=jobs.entries().next().value;jobs.delete(id);time+=elapsed??j.ms;j.fn();}};}
test('20000-hour default crosses repeated Node timer boundaries without firing early',()=>{
  const c=clock();let calls=0;deadlineTimer(()=>calls++,queueTimeout(),c);
  assert.equal(DEFAULT_QUEUE_TIMEOUT_MS,72000000000);assert.equal(c.delays[0],MAX_TIMER_MS);
  let elapsed=0;while(elapsed+MAX_TIMER_MS<DEFAULT_QUEUE_TIMEOUT_MS){c.fire();elapsed+=MAX_TIMER_MS;assert.equal(calls,0);}
  assert.equal(c.delays.at(-1),DEFAULT_QUEUE_TIMEOUT_MS-elapsed);
  c.fire(c.delays.at(-1)-1);assert.equal(calls,0);assert.equal(c.delays.at(-1),1);
  c.fire();assert.equal(calls,1);assert.equal(c.jobs.size,0);
});
test('cancellation removes the current chunk and a late callback cannot reschedule',()=>{
  const c=clock();let calls=0;const timer=deadlineTimer(()=>calls++,DEFAULT_QUEUE_TIMEOUT_MS,c);c.fire();const stale=[...c.jobs.values()][0].fn;
  timer.cancel();timer.cancel();stale();assert.equal(calls,0);assert.equal(c.jobs.size,0);
});
test('short overrides, late event loop wake and invalid configs remain explicit',()=>{
  const c=clock();let calls=0;deadlineTimer(()=>calls++,50,c);assert.equal(c.delays[0],50);c.fire(100);assert.equal(calls,1);assert.equal(c.jobs.size,0);
  for(const bad of [0,-1,1.5,Infinity,NaN,'3600000',Number.MAX_SAFE_INTEGER+1])assert.throws(()=>queueTimeout(bad),/positive safe integer/);
  assert.equal(queueTimeout(3600000),3600000,'existing explicit overrides remain supported');
});
