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
  assert.equal(a.snapshot().quality.corroboration_rate_pct,100);assert.equal(a.snapshot().quality.resolved_starts,1);
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
test('completed usage can disambiguate a clock-tolerance overlap without guessing',()=>{
  const a=new EngineAttribution();
  a.acceptGateway(dispatch(request,'spark1',10000));a.acceptGateway(dispatch(other,'spark1',11000));a.acceptEngine(start(sample,'spark1',12000));
  assert.equal(a.snapshot().recent[0].reason,'overlapping_gateway_windows');
  a.acceptGateway(finish(request,'spark1',13000,{prompt_tokens:700,cached_tokens:600}));
  assert.equal(a.snapshot().recent[0].reason,'overlapping_gateway_windows');
  a.acceptGateway(finish(other,'spark1',14000,{prompt_tokens:1000,cached_tokens:900}));
  const row=a.snapshot().recent[0];
  assert.equal(row.request_id,other);assert.equal(row.status,'corroborated');assert.equal(row.reason,'usage_disambiguated_overlap');assert.equal(row.confidence,'high_candidate');
});
test('overlap disambiguation abstains when usage identifies zero or multiple requests',()=>{
  const conflict=new EngineAttribution();conflict.acceptGateway(dispatch(request));conflict.acceptGateway(dispatch(other));conflict.acceptEngine(start());
  conflict.acceptGateway(finish(request,'spark1',13000,{prompt_tokens:700,cached_tokens:600}));conflict.acceptGateway(finish(other,'spark1',14000,{prompt_tokens:800,cached_tokens:700}));
  assert.equal(conflict.snapshot().recent[0].reason,'usage_conflict');
  const duplicate=new EngineAttribution();duplicate.acceptGateway(dispatch(request));duplicate.acceptGateway(dispatch(other));duplicate.acceptEngine(start());
  duplicate.acceptGateway(finish(request,'spark1',13000));duplicate.acceptGateway(finish(other,'spark1',14000));
  assert.equal(duplicate.snapshot().recent[0].reason,'overlapping_usage_matches');assert.equal(duplicate.snapshot().recent[0].status,'abstained');
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

test('a completed overlap candidate survives the short history window until the long peer resolves',()=>{
  const a=new EngineAttribution();
  a.acceptGateway(dispatch(request,'spark1',10000));a.acceptGateway(dispatch(other,'spark1',11000));a.acceptEngine(start(sample,'spark1',12000));
  a.acceptGateway(finish(request,'spark1',13000,{prompt_tokens:1000,cached_tokens:900}));
  assert.equal(a.snapshot().recent[0].reason,'overlapping_gateway_windows');
  a.acceptGateway(finish(other,'spark1',2*3600000,{prompt_tokens:700,cached_tokens:600}));
  const row=a.snapshot().recent[0];assert.equal(row.request_id,request);assert.equal(row.status,'corroborated');assert.equal(row.reason,'usage_disambiguated_overlap');
  a.acceptGateway(dispatch('33333333-3333-4333-8333-333333333333','spark2',3*3600000));
  assert.equal(a.snapshot().recent.find(value=>value.sample_id===sample),undefined,'settled evidence returns to the ordinary bounded history');
});

test('the request cap preserves overlap evidence before unrelated windows and never fabricates uniqueness',()=>{
  const a=new EngineAttribution();
  a.acceptGateway(dispatch(request,'spark1',10000));a.acceptGateway(dispatch(other,'spark1',11000));a.acceptEngine(start(sample,'spark1',12000));
  for(let i=0;i<520;i++){
    const id=i.toString(16).padStart(8,'0')+'-0000-4000-8000-'+i.toString(16).padStart(12,'0');
    a.acceptGateway(dispatch(id,'spark2',13000+i));
  }
  assert.ok(a.requests.size<=512);const row=a.snapshot().recent.find(value=>value.sample_id===sample);
  assert.equal(row.status,'abstained');assert.equal(row.reason,'overlapping_gateway_windows');assert.equal(row.request_id,null);
});

test('identical engine replay cannot erase ambiguity after an overlap owner ages out',()=>{
  const saved=[],a=new EngineAttribution(row=>saved.push(row));
  a.acceptGateway(dispatch(request,'spark1',10000));a.acceptGateway(dispatch(other,'spark1',11000));a.acceptEngine(start());
  a.acceptGateway(finish(request,'spark1',13000));a.acceptGateway(finish(other,'spark1',2*3600000));
  assert.equal(a.snapshot().recent[0].reason,'overlapping_usage_matches');
  a.acceptGateway(dispatch('33333333-3333-4333-8333-333333333333','spark2',2*3600000+1));
  assert.equal(a.requests.has(request),false);assert.equal(a.requests.has(other),true);
  const before=a.snapshot(),writes=saved.length;
  assert.equal(before.recent[0].reason,'overlapping_gateway_windows');
  for(let i=0;i<3;i++)a.acceptEngine({...start(),message:'PRIVATE_REPLAY'});
  assert.deepEqual(a.snapshot(),before);assert.equal(saved.length,writes);
  assert.ok(!JSON.stringify({snapshot:a.snapshot(),saved}).includes('PRIVATE'));
});

test('identical engine replay preserves pending evidence and later valid completion',()=>{
  const saved=[],a=new EngineAttribution(row=>saved.push(row));a.acceptGateway(dispatch());a.acceptEngine(start());
  const before=a.snapshot(),writes=saved.length;a.acceptEngine(start());
  assert.deepEqual(a.snapshot(),before);assert.equal(saved.length,writes);
  a.acceptGateway(finish());assert.equal(a.snapshot().recent[0].reason,'usage_match');
  const settled=a.snapshot(),settledWrites=saved.length;a.acceptEngine(start());
  assert.deepEqual(a.snapshot(),settled);assert.equal(saved.length,settledWrites);
});

test('replay preservation does not suppress changed normalized process evidence',()=>{
  const a=new EngineAttribution();a.acceptGateway(dispatch());
  a.acceptEngine(start(sample,'spark1',12000,{backend_epoch:null,backend_epoch_confidence:'unavailable'}));
  assert.equal(a.snapshot().recent[0].reason,'backend_epoch_unavailable');
  a.acceptEngine(start());assert.equal(a.snapshot().recent[0].reason,'request_open');
  a.acceptGateway(finish());assert.equal(a.snapshot().recent[0].reason,'usage_match');
});
