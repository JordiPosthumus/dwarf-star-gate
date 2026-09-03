import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {CacheCosts,estimateCacheCost} from './cache-cost.mjs';
import {createDashboard} from './dashboard.mjs';
function observed(){const c=new CacheCosts();for(let i=0;i<3;i++){
  c.accept({kind:'disk_restore',time:1000+i*100,cached:1000,load_ms:10+i*10,private_path:'NEVER_EXPORT'});
  c.accept({kind:'start',time:1001+i*100,cached:1000,prompt:1100,new_tokens:100});
  c.accept({kind:'prefill_done',time:1002+i*100,cached:1000,prompt:1100,new_tokens:100,seconds:.1});
}return c;}
test('cost baseline uses measured load and matching prefix/new-token prompt buckets, not total service time',()=>{
 const c=observed(),r=estimateCacheCost(c.snapshot(2000),{tier:'local_disk',cached_tokens:1000,prompt_tokens:1100},2000);
 assert.equal(r.disk_load.estimated_ms,20);assert.equal(r.prefill.estimated_ms,100);assert.equal(r.measured_components_ms,120);
 assert.equal(r.total_acquisition_ms,null);assert.equal(r.cache_existence_verified,false);assert.equal(r.request_attribution,'unverified');
 assert.equal(r.backend_epoch,'unverified');assert.equal(r.backend_epoch_confidence,'unavailable');
 assert.ok(!JSON.stringify(c.snapshot(2000)).includes('NEVER_EXPORT'));
 assert.equal(estimateCacheCost(c.snapshot(2000),{tier:'local_disk',cached_tokens:100000,prompt_tokens:100100},2000).disk_load.estimated_ms,null);
});
test('absent, stale, sparse, hot and remote observations abstain rather than imply zero cost',()=>{
 const c=observed();
 for(const tier of ['hot','remote']){const r=estimateCacheCost(c.snapshot(2000),{tier,cached_tokens:1000,prompt_tokens:1100},2000);assert.equal(r.disk_load.estimated_ms,null);assert.equal(r.measured_components_ms,null);}
 assert.equal(estimateCacheCost(c.snapshot(2000),{tier:'cold',cached_tokens:0,prompt_tokens:1100},2000).prefill.estimated_ms,null,'warm observations are not cold labels');
 assert.equal(estimateCacheCost(c.snapshot(2000),{tier:'local_disk',cached_tokens:1000,prompt_tokens:1100},4000000).disk_load.estimated_ms,null);
 const sparse={schema:1,samples:c.snapshot(2000).samples.slice(0,2)};assert.equal(estimateCacheCost(sparse,{tier:'local_disk',cached_tokens:1000,prompt_tokens:1100},2000).disk_load.estimated_ms,null);
 for(const args of [{tier:'cold',cached_tokens:1,prompt_tokens:10},{tier:'other',cached_tokens:0,prompt_tokens:10},{tier:'hot',cached_tokens:20,prompt_tokens:10}])assert.throws(()=>estimateCacheCost(null,args));
});
test('prefill needs a matching observed start; no mismatched/stale joins, bounded memory',()=>{
 const c=new CacheCosts();c.accept({kind:'prefill_done',time:1000,cached:0,prompt:100,new_tokens:100,seconds:1});assert.equal(c.samples.length,0);
 c.accept({kind:'start',time:1000,cached:0,prompt:100,new_tokens:100});c.accept({kind:'prefill_done',time:1001,cached:0,prompt:200,new_tokens:200,seconds:1});assert.equal(c.samples.length,0);
 for(let i=0;i<1000;i++)c.accept({kind:'disk_restore',time:1000+i,cached:100,load_ms:1});assert.equal(c.samples.length,128);
});
test('cache calculator is same-origin read-only and rejects stale/unknown workers and bad scenarios',async t=>{
 const cost=observed().snapshot(2000);cost.samples=cost.samples.map(x=>({...x,time:Date.now()}));
 const s={devices:[{id:'one',connected:true,cache_cost:cost}],gateway:{workers:[{id:'one',is_healthy:true}]}};
 const server=createDashboard(()=>s);server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});
 const base=`http://127.0.0.1:${server.address().port}`,route='/api/cache-cost?worker=one&tier=local_disk&cached_tokens=1000&prompt_tokens=1100';
 const r=await fetch(base+route);assert.equal(r.status,200);assert.equal((await r.json()).disk_load.estimated_ms,20);
 assert.equal((await fetch(base+route,{method:'POST'})).status,405);assert.equal((await fetch(base+route,{headers:{origin:'https://example.invalid'}})).status,403);
 assert.equal((await fetch(base+route+'&worker=two')).status,400);assert.equal((await fetch(base+route.replace('one','unknown'))).status,404);
 s.gateway.workers[0].context_length=1024;assert.equal((await fetch(base+route)).status,400);
 s.gateway_error='stale';assert.equal((await fetch(base+route)).status,503);
});
