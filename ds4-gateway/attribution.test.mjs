import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EngineAttribution} from './attribution.mjs';

const request='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const other='11111111-2222-4333-8444-555555555555';
const epoch='a'.repeat(64),sample='b'.repeat(64),iso=ms=>new Date(ms).toISOString();
const dispatch=(id=request,node='spark1',at=10000)=>({event:'request_dispatched',request_id:id,node,time:iso(at)});
const finish=(id=request,node='spark1',at=30000,usage={prompt_tokens:1000,cached_tokens:900})=>({event:'request_finished',request_id:id,node,time:iso(at),outcome:'complete',usage});
const start=(id=sample,node='spark1',at=12000,extra={})=>({kind:'start',sample_id:id,node,time:at,prompt:1000,cached:900,new_tokens:100,backend_epoch:epoch,backend_epoch_confidence:'strong',...extra});

test('one epoch-bound request window becomes a corroborated candidate only after matching usage',()=>{
  const saved=[],a=new EngineAttribution(row=>saved.push(row));
  a.acceptGateway(dispatch());a.acceptEngine(start());
  let row=a.snapshot().recent[0];assert.equal(row.status,'candidate');assert.equal(row.reason,'request_open');assert.equal(row.request_id,request);assert.equal(row.confidence,'heuristic');assert.equal(row.dispatch_delta_ms,2000);
  a.acceptGateway(finish());row=a.snapshot().recent[0];
  assert.equal(row.status,'corroborated');assert.equal(row.reason,'usage_match');assert.equal(row.confidence,'high_candidate');
  assert.equal(a.snapshot().request_identity,'heuristic_not_protocol_proof');assert.equal(saved.length,2);
  assert.match(saved[0].attribution_revision_id,/^[\da-f]{64}$/);assert.notEqual(saved[0].attribution_revision_id,saved[1].attribution_revision_id);
});

test('missing epochs, no request window, overlaps and duplicate engine starts all abstain',()=>{
  const a=new EngineAttribution();
  a.acceptEngine(start(sample,'spark1',12000,{backend_epoch:null,backend_epoch_confidence:'unavailable'}));
  assert.equal(a.snapshot().recent[0].reason,'backend_epoch_unavailable');
  const direct='c'.repeat(64);a.acceptEngine(start(direct,'spark2',13000));assert.equal(a.snapshot().recent[0].reason,'no_gateway_request_window');
  a.acceptGateway(dispatch(request));a.acceptGateway(dispatch(other));
  const overlap='d'.repeat(64);a.acceptEngine(start(overlap));assert.equal(a.snapshot().recent.find(r=>r.sample_id===overlap).reason,'overlapping_gateway_windows');
  const b=new EngineAttribution();b.acceptGateway(dispatch());b.acceptEngine(start());b.acceptEngine(start('e'.repeat(64),'spark1',13000));
  assert.ok(b.snapshot().recent.every(row=>row.reason==='multiple_engine_starts'&&row.status==='abstained'));
});

test('usage disagreement abstains and an out-of-order arrival can be reconciled without guessing',()=>{
  const saved=[],a=new EngineAttribution(row=>saved.push(row));
  a.acceptEngine(start());assert.equal(a.snapshot().recent[0].reason,'no_gateway_request_window');
  a.acceptGateway(dispatch());assert.equal(a.snapshot().recent[0].status,'candidate');
  a.acceptGateway(finish(request,'spark1',30000,{prompt_tokens:999,cached_tokens:899}));
  assert.equal(a.snapshot().recent[0].reason,'usage_conflict');assert.equal(a.snapshot().recent[0].request_id,request);
  assert.deepEqual(saved.map(row=>row.reason),['no_gateway_request_window','request_open','usage_conflict']);
});
test('boot and PID fallback can corroborate but never receives strong-epoch confidence',()=>{
  const a=new EngineAttribution();a.acceptGateway(dispatch());a.acceptEngine(start(sample,'spark1',12000,{backend_epoch_confidence:'bounded'}));a.acceptGateway(finish());
  assert.equal(a.snapshot().recent[0].status,'corroborated');assert.equal(a.snapshot().recent[0].confidence,'bounded_candidate');
});

test('attribution input and output are bounded and allowlisted',()=>{
  const saved=[],a=new EngineAttribution(row=>saved.push(row));
  assert.equal(a.acceptGateway({...dispatch(),request_id:'bad'}),null);assert.equal(a.acceptEngine({...start(),sample_id:'bad'}),null);
  a.acceptGateway({...dispatch(),prompt:'PRIVATE',headers:{authorization:'PRIVATE'}});
  a.acceptEngine({...start(),message:'PRIVATE',path:'/private/PRIVATE'});
  a.acceptGateway({...finish(),usage:{prompt_tokens:1000,cached_tokens:900,answer:'PRIVATE'},answer:'PRIVATE'});
  assert.ok(!JSON.stringify({saved,snapshot:a.snapshot()}).includes('PRIVATE'));
  assert.ok(a.snapshot().recent.length<=16);
});
test('long xhigh work keeps its open attribution span, then retires after completion history expires',()=>{
  const a=new EngineAttribution();a.acceptGateway(dispatch());a.acceptEngine(start());
  const twoHours=2*3600000;
  a.acceptGateway(dispatch(other,'spark2',twoHours));
  assert.equal(a.snapshot().recent.find(row=>row.sample_id===sample).status,'candidate');
  a.acceptGateway(finish(request,'spark1',twoHours+1000));
  assert.equal(a.snapshot().recent.find(row=>row.sample_id===sample).status,'corroborated');
  a.acceptGateway(finish(other,'spark2',twoHours+16*60000));
  assert.equal(a.snapshot().recent.find(row=>row.sample_id===sample),undefined);
});
