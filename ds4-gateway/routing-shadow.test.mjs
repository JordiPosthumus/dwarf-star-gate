import {test} from 'node:test';
import assert from 'node:assert/strict';
import {RoutingShadow,conditionalRemaining} from './routing-shadow.mjs';
import {evidence} from './dataset.mjs';

const route='/v1/chat/completions';
const done=(service_ms=1000,extra={})=>({outcome:'complete',finish_reason:'stop',service_ms,usage:{prompt_tokens:9000,cached_tokens:8192},route,...extra});
const job=key=>({key,route,trafficClass:'unclassified'});
const candidate=(node,extra={})=>({node,healthy:true,paused:false,active:0,queued:0,active_elapsed_ms:null,active_job:null,ahead_jobs:[],...extra});
function setup(options={}){let time=0;const shadow=new RoutingShadow({enabled:true,now:()=>time,...options});return {shadow,advance:n=>{time+=n;}};}
function seed(s,node,duration=1000){for(let i=0;i<5;i++){s.started(node,'conversation');s.finished(node,'conversation',done(duration));}}

test('conditional remaining time uses only surviving completions and abstains beyond support',()=>{
  assert.equal(conditionalRemaining([10,20,110,120,130,140,150],100),30);
  assert.equal(conditionalRemaining([10,20,110,120,130,140,150],140),null);
  assert.equal(conditionalRemaining([10,20,30],0),null);
  assert.equal(conditionalRemaining([10,20,30,40,50],NaN),null);
});
test('idle duration, session recency and intervening requests are independent clocks',()=>{
  const {shadow:s,advance}=setup();assert.equal(s.timing('a','one',null).worker_idle_ms,null);
  s.started('a','one');advance(100);s.finished('a','one',done());advance(900);
  assert.equal(s.timing('a','one',null).worker_idle_ms,900);
  assert.equal(s.timing('a','one',null).session_last_used_ms,1000);
  s.started('a','two');advance(50);s.finished('a','two',done());
  const t=s.timing('a','one',null);assert.equal(t.worker_idle_ms,0);assert.equal(t.intervening_requests,1);
  assert.equal(t.prior_cached_tokens,8192);assert.equal(t.cache_residence,'unknown');assert.equal(t.backend_epoch,null);
  const active=s.timing('a','one',{dispatchedMono:1000,lastUpstreamByteMono:1040});
  assert.equal(active.active_elapsed_ms,50);assert.equal(active.upstream_byte_age_ms,10);assert.equal(active.worker_idle_ms,null);
});
test('observed health/profile reset discards recency and samples without claiming disk loss',()=>{
  const {shadow:s}=setup();seed(s,'a');s.reset('a');
  const t=s.timing('a','conversation',null);assert.equal(t.session_last_used_ms,null);assert.equal(t.observation_epoch,1);
  assert.equal(t.cache_residence,'unknown');assert.equal(s.service('a',job('conversation')),null);
  s.remove('a');assert.equal(s.workers.size,0);
});
test('unseen, stale, output-limited, failed, observer and different-route data never produce service estimates',()=>{
  const {shadow:s,advance}=setup();
  for(const extra of [{outcome:'client_cancelled'},{finish_reason:'length'},{outcome:'sse_observation_limited'},{traffic_class:'genie'}]) {
    for(let i=0;i<8;i++){s.started('a','conversation');s.finished('a','conversation',done(1000,extra));}
  }
  assert.equal(s.service('a',job('conversation')),null);seed(s,'a');
  assert.equal(s.service('a',job('unseen')),null);
  assert.equal(s.service('a',{...job('conversation'),route:'/v1/messages'}),null);
  assert.equal(s.service('a',job('conversation')),1000);advance(3600001);
  assert.equal(s.service('a',job('conversation')),null);
});
test('shadow baseline compares stay versus idle without modifying inputs; session work blocks handover',()=>{
  const {shadow:s}=setup();seed(s,'a',10000);seed(s,'b',1000);
  const input={job:job('conversation'),home:'a',reason:'admission',waiting_ms:0,session_busy:false,
    candidates:[candidate('a',{active:1,active_job:job('conversation'),active_elapsed_ms:1000}),candidate('b')]};
  const before=JSON.stringify(input),result=s.assess(input);
  assert.equal(result.verdict,'would_move');assert.equal(result.candidates[0].remaining_ms,9000);
  assert.equal(result.saving_ms,18000);assert.equal(result.confidence,'unvalidated');assert.equal(JSON.stringify(input),before);
  assert.equal(s.assess({...input,session_busy:true}).verdict,'handover_blocked');
  assert.equal(s.assess({...input,candidates:[input.candidates[0],candidate('b',{paused:true})]}).verdict,'no_idle_alternative');
  assert.equal(s.assess({...input,candidates:[input.candidates[0],candidate('b',{healthy:false})]}).verdict,'no_idle_alternative');
});
test('unknown queued jobs and out-of-support active work make the home estimate unknown',()=>{
  const {shadow:s}=setup();seed(s,'a');seed(s,'b');
  for(const extra of [{ahead_jobs:[job('unseen')],queued:1},{active:1,active_job:job('conversation'),active_elapsed_ms:2000}]) {
    const r=s.assess({job:job('conversation'),home:'a',reason:'worker_free',waiting_ms:10,session_busy:false,
      candidates:[candidate('a',extra),candidate('b')]});
    assert.equal(r.verdict,'insufficient_evidence');assert.equal(r.candidates[0].completion_ms,null);
  }
});
test('memory bounds and disabled state do not accumulate conversation history',()=>{
  const {shadow:s}=setup({maxWorkers:2,maxSessions:3,maxSamples:5});
  for(let i=0;i<100;i++){s.started('a',`s-${i}`);s.finished('a',`s-${i}`,done());}
  assert.equal(s.sessions.size,3);assert.equal(s.workers.get('a').samples.length,5);
  s.started('b','b');s.started('c','c');assert.equal(s.workers.size,2);
  const off=new RoutingShadow();off.started('a','secret');off.finished('a','secret',done());assert.equal(off.sessions.size,0);
  assert.equal(off.assess({}),null);
});
test('shadow evidence strips arbitrary payloads and cannot persist job objects or fake cache claims',()=>{
  const row=evidence('routing_shadow',{request_id:'test',node:'a',reason:'worker_free',verdict:'would_move',
    prompt:'PRIVATE',candidates:[{node:'b',worker_idle_ms:20,session_last_used_ms:Infinity,
      backend_epoch:'PRIVATE',cache_residence:'RAM',active_job:{prompt:'PRIVATE'},ahead_jobs:[{prompt:'PRIVATE'}]}]});
  assert.ok(!JSON.stringify(row).includes('PRIVATE'));assert.equal(row.candidates[0].session_last_used_ms,null);
  assert.equal(row.candidates[0].backend_epoch,null);assert.equal(row.candidates[0].cache_residence,'unknown');
});
