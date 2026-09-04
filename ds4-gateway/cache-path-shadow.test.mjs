import {test} from 'node:test';
import assert from 'node:assert/strict';
import {compareCachePaths,snapshotPresence} from './cache-path-shadow.mjs';

const measured=ms=>({ms,status:'measured'}),forecast=ms=>({ms,status:'validated_forecast'}),estimated=ms=>({ms,status:'unvalidated_estimate'});
const evidence=()=>({
  wait_hot:{availability:'observed',worker:'home',wait:forecast(100),suffix_prefill:measured(0),generation:forecast(200)},
  local_restore:{availability:'observed',compatibility:'compatible',worker:'local',wait:forecast(20),restore:measured(50),suffix_prefill:measured(20),generation:forecast(200)},
  remote_acquisition:{availability:'observed',compatibility:'compatible',protocol:'validated',worker:'remote',source_worker:'home',wait:forecast(100),transfer:measured(60),import_restore:measured(20),suffix_prefill:measured(20),generation:forecast(200),parallel_staging_verified:true},
  cold_prefill:{availability:'observed',worker:'cold',wait:forecast(0),prefill:measured(500),generation:forecast(200)}
});

test('four-path shadow uses critical-path math and ranks only complete evidence without routing authority',()=>{
  const result=compareCachePaths(evidence());assert.equal(result.complete,true);assert.equal(result.would_prefer,'local_restore');assert.equal(result.paths.wait_hot.estimated_ms,300);assert.equal(result.paths.local_restore.estimated_ms,290);assert.equal(result.paths.remote_acquisition.estimated_ms,340);assert.equal(result.paths.cold_prefill.estimated_ms,700);assert.equal(result.authority,'none');assert.equal(result.mode,'shadow_only');
  const serial=evidence();serial.remote_acquisition.parallel_staging_verified=false;assert.equal(compareCachePaths(serial).paths.remote_acquisition.estimated_ms,400);
});

test('hot cache still pays for the new suffix and cannot win on missing prefill evidence',()=>{
  const input=evidence();input.wait_hot.wait=forecast(0);
  assert.equal(compareCachePaths(input).would_prefer,'wait_hot');
  input.wait_hot.suffix_prefill=measured(150);
  const result=compareCachePaths(input);assert.equal(result.paths.wait_hot.estimated_ms,350);assert.equal(result.would_prefer,'local_restore');
  delete input.wait_hot.suffix_prefill;
  assert.equal(compareCachePaths(input).would_prefer,null);
  assert.deepEqual(compareCachePaths(input).paths.wait_hot.reasons,['suffix_prefill_unavailable']);
});
test('unknown evidence blocks a winner while proven absence safely excludes a path',()=>{
  const input=evidence();input.wait_hot.availability='unknown';input.remote_acquisition.availability='absent';const result=compareCachePaths(input);
  assert.equal(result.complete,false);assert.equal(result.would_prefer,null);assert.equal(result.best_known,'local_restore');assert.equal(result.paths.wait_hot.status,'unknown');assert.equal(result.paths.remote_acquisition.status,'excluded');
  delete input.cold_prefill.prefill;assert.ok(compareCachePaths(input).paths.cold_prefill.reasons.includes('prefill_unavailable'));
  const unavailable=evidence();unavailable.remote_acquisition.protocol='unavailable';delete unavailable.remote_acquisition.source_worker;assert.equal(compareCachePaths(unavailable).paths.remote_acquisition.status,'excluded');
});

test('unvalidated components remain labelled and malformed/private-shaped evidence is rejected or discarded',()=>{
  const input=evidence();input.local_restore.restore=estimated(40);const result=compareCachePaths(input);assert.equal(result.paths.local_restore.validation,'unvalidated_components');
  assert.throws(()=>compareCachePaths({...input,private_prompt:'NEVER_EXPORT'}));
  input.local_restore.private_prompt='NEVER_EXPORT';assert.throws(()=>compareCachePaths(input),/unsupported evidence fields/);delete input.local_restore.private_prompt;
  input.remote_acquisition.parallel_staging_verified='yes';assert.equal(compareCachePaths(input).paths.remote_acquisition.status,'unknown');assert.ok(!JSON.stringify(compareCachePaths(input)).includes('yes'));
});

test('fresh complete inventory proves bounded presence/absence; stale, capped and legacy profiles abstain',()=>{
  const ref='a'.repeat(64),profile={model_id:2,weights_fp24:3,quant_bits:2,ctx_size:262144},entry={snapshot_ref:ref,tokens:1000,file_bytes:2000,compatibility:{...profile,ext_flags:0,payload_abi:2}},base={schema:1,source:'stock_ds4_kvstore_headers',privacy:'installation_keyed_hmac',status:'ready',observed_at:1000,capped:false,rejected:0,entries:[entry]};
  assert.equal(snapshotPresence(base,ref,profile,{now:2000}).status,'observed');assert.equal(snapshotPresence(base,'b'.repeat(64),profile,{now:2000}).status,'absent');
  assert.equal(snapshotPresence({...base,capped:true},'b'.repeat(64),profile,{now:2000}).status,'unknown');assert.equal(snapshotPresence(base,ref,profile,{now:200000}).status,'unknown');
  assert.equal(snapshotPresence({...base,rejected:1},'b'.repeat(64),profile,{now:2000}).reason,'inventory_incomplete');
  assert.equal(snapshotPresence(base,ref,{...profile,weights_fp24:4},{now:2000}).status,'incompatible');assert.equal(snapshotPresence(base,ref,{...profile,weights_fp24:0},{now:2000}).status,'unknown');
  assert.ok(!JSON.stringify(snapshotPresence(base,ref,profile,{now:2000})).includes(ref));
});

test('ambiguous snapshot references and unspecified completeness cannot establish presence or absence',()=>{
  const ref='a'.repeat(64),profile={model_id:2,weights_fp24:3,quant_bits:2,ctx_size:262144};
  const entry={snapshot_ref:ref,tokens:1000,file_bytes:2000,compatibility:profile};
  const base={schema:1,source:'stock_ds4_kvstore_headers',privacy:'installation_keyed_hmac',status:'ready',observed_at:1000,capped:false,rejected:0,entries:[entry]};
  const conflicting={...entry,compatibility:{...profile,weights_fp24:4}};
  for(const entries of [[entry,conflicting],[conflicting,entry],[entry,entry]]){
    const result=snapshotPresence({...base,entries},ref,profile,{now:2000});
    assert.deepEqual(result,{status:'unknown',reason:'ambiguous_snapshot_reference'});
    assert.ok(!JSON.stringify(result).includes(ref));
  }
  for(const capped of [undefined,null,0,'false']){
    assert.equal(snapshotPresence({...base,capped,entries:[]},ref,profile,{now:2000}).status,'unknown');
  }
  assert.equal(snapshotPresence({...base,entries:[]},ref,profile,{now:2000}).status,'absent');
  // An incomplete scan may still provide one unambiguous compatible match.
  assert.equal(snapshotPresence({...base,capped:true},ref,profile,{now:2000}).status,'observed');
});
