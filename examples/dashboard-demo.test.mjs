import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemoServer } from './dashboard-demo.mjs';
async function demo(t) {
  const server=createDemoServer();
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});
  const url=`http://127.0.0.1:${server.address().port}`;
  const get=async route=>(await fetch(url+route)).json();
  const registry=await get('/api/workers');
  const post=(route,body)=>fetch(url+route,{method:'POST',headers:{origin:url,'content-type':'application/json','x-dsg-csrf':registry.csrf_token},body:JSON.stringify(body)});
  return {get,post,url};
}
test('public demo has synthetic mixed servers, current panels and no promoted models',async t=>{
  const {get,url}=await demo(t),s=await get('/api/status');
  assert.equal(s.demo,true);assert.equal(s.gateway.total,3);assert.equal(s.gateway.active,2);
  assert.deepEqual(s.gateway.workers.map(w=>w.id),['sparkA','sparkB','mac-ultra']);
  assert.ok(s.devices.every(d=>d.activity.length>0));
  assert.ok(s.devices.every(d=>d.hardware?.state==='connected'&&d.hardware.series.length===90));
  assert.deepEqual(s.devices.map(d=>d.hardware.power_scope??d.hardware.current.power_scope),['compute_module','compute_module','system']);
  assert.equal(s.gateway.dataset.embedding_collection.dimensions,384);
  assert.ok(s.gateway.predictor.models.every(m=>m.active_model_id===null));
  assert.equal(s.gateway.predictor.placement,false);
  const registry=await get('/api/workers');assert.equal(registry.queued_relocation.automatic,true);assert.equal(registry.queued_relocation.offers.length,1);
  const g=await get('/api/genie');assert.match(g.reports[0].text,/Synthetic demonstration/);
  assert.equal(g.last_served_by,'dedicated');
  assert.ok(g.ticker.entries.every(e=>e.text.startsWith('Demo:')));
  const a=await get('/api/analytics');assert.equal(a.demo,true);
  assert.deepEqual(a.model_series.map(s=>s.stage),['admission','upload','embedded','remaining']);
  const html=await (await fetch(url)).text();assert.match(html,/<h1>Dwarf Star Gate<\/h1>/);
});
test('demo controls affect only in-memory fixtures and refuse recovery/training',async t=>{
  const {get,post}=await demo(t);
  assert.equal((await post('/api/workers/drain',{workers:['mac-ultra']})).status,200);
  assert.equal((await get('/api/workers')).workers[2].drained,true);
  assert.equal((await post('/api/workers/resume',{workers:['mac-ultra']})).status,200);
  const registry=await get('/api/workers'),offer=registry.queued_relocation.offers[0];
  const moved=await post('/api/workers/relocate',{request_id:offer.request_id,source:offer.source,destination:offer.destination,evidence_id:offer.evidence_id});
  assert.equal(moved.status,200);assert.equal((await moved.json()).dispatch_state,'not_dispatched');assert.equal((await get('/api/workers')).queued_relocation.offers.length,0);
  assert.equal((await post('/api/workers/predictor',{action:'train'})).status,400);
  assert.equal((await post('/api/workers/recover',{worker_id:'sparkA'})).status,400);
  const fresh=await demo(t);assert.equal((await fresh.get('/api/workers')).workers[2].drained,false);
});
