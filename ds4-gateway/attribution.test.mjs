import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EngineAttribution} from './attribution.mjs';

const request='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const other='11111111-2222-4333-8444-555555555555';
const epoch='a'.repeat(64),sample='b'.repeat(64),iso=ms=>new Date(ms).toISOString();
const dispatch=(id=request,node='spark1',at=10000)=>({event:'request_dispatched',request_id:id,node,time:iso(at)});
const finish=(id=request,node='spark1',at=30000,usage={prompt_tokens:1000,cached_tokens:900})=>({event:'request_finished',request_id:id,node,time:iso(at),outcome:'complete',usage});
const start=(id=sample,node='spark1',at=12000,extra={})=>({kind:'start',sample_id:id,node,time:at,prompt:1000,cached:900,new_tokens:100,backend_epoch:epoch,backend_epoch_confidence:'strong',...extra});

test('contradictory lifecycle records abstain in either arrival order',()=>{
  const pairs=[
    [dispatch(),dispatch(request,'spark1',100000)],
    [finish(),finish(request,'spark1',31000)],
    [finish(),finish(request,'spark1',30000,{prompt_tokens:999,cached_tokens:899})],
    [finish(),{...finish(),outcome:'upstream_error'}],
    [finish(),{...finish(),usage:undefined}],
    [dispatch(),dispatch(request,'spark2')]
  ];
  for(const pair of pairs)for(const events of [pair,[...pair].reverse()]){
    const a=new EngineAttribution();if(pair[0].event==='request_finished')a.acceptGateway(dispatch());a.acceptEngine(start());
    for(const event of events)a.acceptGateway(event);
    a.acceptGateway(finish());
    const row=a.snapshot().recent[0];
    assert.equal(row.status,'abstained');assert.equal(row.reason,'gateway_evidence_conflict');
    assert.equal(row.request_id,null);assert.equal(row.confidence,'none');
    assert.equal(a.snapshot().quality.reason_counts.gateway_evidence_conflict,1);
  }
});

test('a conflict received before the engine start cannot hide a competing request',()=>{
  for(const events of [[dispatch(other),dispatch(other,'spark2')],[dispatch(other,'spark2'),dispatch(other)]]){
    const a=new EngineAttribution();for(const event of events)a.acceptGateway(event);
    a.acceptGateway(dispatch());a.acceptGateway(finish());a.acceptEngine(start());
    assert.equal(a.snapshot().recent[0].reason,'gateway_evidence_conflict');
    assert.equal(a.snapshot().recent[0].request_id,null);
  }
});

test('terminal-before-dispatch clocks are conflicting, but reverse arrival is valid',()=>{
  for(const events of [[dispatch(request,'spark1',14000),finish(request,'spark1',13000)],
    [finish(request,'spark1',13000),dispatch(request,'spark1',14000)]]){
    const a=new EngineAttribution();for(const event of events)a.acceptGateway(event);a.acceptEngine(start());
    assert.equal(a.snapshot().recent[0].reason,'gateway_evidence_conflict');
  }
  const a=new EngineAttribution();a.acceptGateway(finish());a.acceptEngine(start());a.acceptGateway(dispatch());
  assert.equal(a.snapshot().recent[0].reason,'usage_match');
});

test('identical normalized lifecycle duplicates are idempotent and contain no private guards',()=>{
  const saved=[],a=new EngineAttribution(row=>saved.push(row));
  a.acceptGateway(dispatch());a.acceptEngine(start());a.acceptGateway(finish());
  const before=a.snapshot(),writes=saved.length;
  a.acceptGateway({...dispatch(),time:10000,private_field:'PRIVATE_GUARD'});
  a.acceptGateway({...finish(),time:30000,usage:{cached_tokens:900,prompt_tokens:1000,output:'PRIVATE_GUARD'}});
  assert.deepEqual(a.snapshot(),before);assert.equal(saved.length,writes);
  assert.ok(!JSON.stringify({saved,snapshot:a.snapshot()}).includes('PRIVATE_GUARD'));
});

test('lifecycle conflict windows do not contaminate unrelated workers or distant starts',()=>{
  const a=new EngineAttribution();a.acceptGateway(dispatch(other));a.acceptGateway(dispatch(other,'spark1',11000));
  a.acceptGateway(finish(other,'spark1',13000));
  a.acceptGateway(dispatch(request,'spark2'));a.acceptGateway(finish(request,'spark2'));a.acceptEngine(start(sample,'spark2'));
  assert.equal(a.snapshot().recent[0].reason,'usage_match');
  const distant='33333333-3333-4333-8333-333333333333';
  a.acceptGateway(dispatch(distant,'spark1',700000));a.acceptGateway(finish(distant,'spark1',730000));
  a.acceptEngine(start('c'.repeat(64),'spark1',712000));
  assert.equal(a.snapshot().recent[0].reason,'usage_match');
});

test('conflicting clock ranges retain inclusive skew and lead edges without first-record bias',()=>{
  const cases=[[-5000,true],[-5001,false],[600000,true],[600001,false]];
  for(const [delta,affected] of cases)for(const reversed of [false,true]){
    const at=1000000,edge=at-delta;
    // The second revision is farther from this start: the nearest observed
    // dispatch determines the inclusive boundary, regardless of input order.
    const times=delta<0?[edge,edge+1]:[edge-1,edge];if(reversed)times.reverse();
    const a=new EngineAttribution();for(const time of times)a.acceptGateway(dispatch(other,'spark1',time));
    a.acceptGateway(dispatch(request,'spark1',at));a.acceptGateway(finish(request,'spark1',at+10000));
    a.acceptEngine(start(sample,'spark1',at));
    assert.equal(a.snapshot().recent[0].reason,affected?'gateway_evidence_conflict':'usage_match');
  }
});

test('node-identity overflow stays bounded and cannot hide an unrecorded competing worker',()=>{
  const a=new EngineAttribution();for(let i=0;i<70;i++)a.acceptGateway(dispatch(other,`worker-${i}`));
  const requestRow=a.requests.get(other);assert.equal(requestRow.lifecycle_nodes.size,64);assert.equal(requestRow.lifecycle_node_overflow,true);
  a.acceptGateway(dispatch(request,'worker-69'));a.acceptGateway(finish(request,'worker-69'));a.acceptEngine(start(sample,'worker-69'));
  assert.equal(a.snapshot().recent[0].reason,'gateway_evidence_conflict');
  assert.ok(!JSON.stringify(a.snapshot()).includes('lifecycle_nodes'));
});

test('observed conflict cannot disappear when a lifecycle row ages out or metadata is enriched',()=>{
  const a=new EngineAttribution();a.acceptGateway(dispatch());a.acceptGateway(dispatch(other));
  a.acceptGateway(finish(other,'spark1',13000));
  a.acceptGateway(finish(other,'spark1',14000));a.acceptEngine(start());
  a.acceptGateway(dispatch('33333333-3333-4333-8333-333333333333','spark2',2*3600000));
  assert.equal(a.requests.has(other),false);
  a.acceptEngine(start(sample,'spark1',12000,{backend_epoch_confidence:'bounded',lifecycle_conflict:false}));a.acceptGateway(finish(request,'spark1',2*3600000+1));
  const row=a.snapshot().recent.find(row=>row.sample_id===sample);
  assert.equal(row.reason,'gateway_evidence_conflict');assert.equal(row.request_id,null);
  for(const field of ['lifecycle_conflict','lifecycle_nodes','dispatch_latest','finish_latest'])assert.ok(!JSON.stringify(row).includes(field));
});

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

test('normalized engine updates preserve remembered overlap after a peer ages out',()=>{
  const saved=[],a=new EngineAttribution(row=>saved.push(row));
  const initial=start(sample,'spark1',12000,{backend_epoch_confidence:'bounded'});
  a.acceptGateway(dispatch());a.acceptGateway(dispatch(other,'spark1',11000));a.acceptEngine(initial);
  a.acceptGateway(finish(request,'spark1',13000));a.acceptGateway(finish(other,'spark1',2*3600000));
  a.acceptGateway(dispatch('33333333-3333-4333-8333-333333333333','spark2',2*3600000+1));
  assert.equal(a.requests.has(request),false);assert.equal(a.requests.has(other),true);
  const candidates=new Set(a.starts.get(sample).overlap_candidates);
  const variants=[start(),{...start(),backend_epoch:'c'.repeat(64)},
    {...start(),backend_epoch:null,backend_epoch_confidence:'unavailable'},start(),
    {...start(),prompt:1100,cached:900,new_tokens:200},start()];
  for(const update of variants){
    const raw={...update,overlap_candidates:[],overlap_overflow:false,message:'PRIVATE_UPDATE'};
    const before=structuredClone(raw);a.acceptEngine(raw);assert.deepEqual(raw,before);
    const row=a.snapshot().recent[0];assert.equal(row.status,'abstained');assert.equal(row.request_id,null);
    assert.deepEqual(a.starts.get(sample).overlap_candidates,candidates);
    assert.equal(row.reason,update.backend_epoch===null?'backend_epoch_unavailable':'overlapping_gateway_windows');
    assert.equal(row.backend_epoch,update.backend_epoch);assert.equal(row.backend_epoch_confidence,update.backend_epoch_confidence);
    const writes=saved.length;a.acceptEngine(raw);assert.equal(saved.length,writes,'identical updates add no revision');
  }
  const encoded=JSON.stringify({snapshot:a.snapshot(),saved});
  for(const field of ['PRIVATE_UPDATE','overlap_candidates','overlap_overflow','overlap_settled'])assert.ok(!encoded.includes(field));
});

test('epoch discovery retains unresolved peers and still permits later unique usage',()=>{
  const a=new EngineAttribution();a.acceptGateway(dispatch());a.acceptGateway(dispatch(other,'spark1',11000));
  a.acceptEngine(start(sample,'spark1',12000,{backend_epoch:null,backend_epoch_confidence:'unavailable'}));
  const peers=new Set(a.starts.get(sample).overlap_candidates);
  a.acceptGateway(finish(request,'spark1',13000));a.acceptEngine(start());
  assert.deepEqual(a.starts.get(sample).overlap_candidates,peers);
  assert.equal(a.snapshot().recent[0].reason,'overlapping_gateway_windows');
  a.acceptGateway(finish(other,'spark1',2*3600000,{prompt_tokens:700,cached_tokens:600}));
  const row=a.snapshot().recent[0];assert.equal(row.status,'corroborated');assert.equal(row.request_id,request);
  assert.equal(row.reason,'usage_disambiguated_overlap');
});

test('engine metadata cannot clear an overflow guard with raw private-field overrides',()=>{
  const a=new EngineAttribution(),ids=Array.from({length:65},(_,i)=>i.toString(16).padStart(8,'0')+'-0000-4000-8000-'+i.toString(16).padStart(12,'0'));
  for(const id of ids)a.acceptGateway(dispatch(id,'spark1',10000));
  a.acceptEngine(start());const peers=new Set(a.starts.get(sample).overlap_candidates);
  assert.equal(a.starts.get(sample).overlap_overflow,true);assert.equal(peers.size,64);
  // Contradictory later lifecycle records add a conflict reason without erasing
  // the evidence that more than 64 possible owners were originally observed.
  for(const id of ids.slice(0,64))a.acceptGateway(finish(id,'spark2',13000));
  a.acceptGateway(finish(ids.at(-1),'spark1',14000));
  a.acceptEngine({...start(),backend_epoch_confidence:'bounded',overlap_overflow:false,overlap_candidates:[]});
  assert.deepEqual(a.starts.get(sample).overlap_candidates,peers);
  assert.equal(a.starts.get(sample).overlap_overflow,true);assert.equal(a.snapshot().recent[0].reason,'gateway_evidence_conflict');
});
