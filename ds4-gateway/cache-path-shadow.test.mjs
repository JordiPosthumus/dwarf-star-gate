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

test('a remote source cannot be the destination or win a shadow comparison',()=>{
  const input=evidence();input.remote_acquisition.source_worker=input.remote_acquisition.worker;
  for(const key of ['wait','transfer','import_restore','suffix_prefill','generation'])input.remote_acquisition[key]=measured(0);
  const before=structuredClone(input),result=compareCachePaths(input);
  assert.equal(result.paths.remote_acquisition.status,'unknown');
  assert.deepEqual(result.paths.remote_acquisition.reasons,['remote_source_equals_target']);
  assert.equal(result.would_prefer,null);assert.equal(result.best_known,'local_restore');
  assert.ok(!result.ranked.some(p=>p.id==='remote_acquisition'));assert.deepEqual(input,before);
});

test('snapshot presence never exports malformed token or byte metadata as evidence',()=>{
  const ref='a'.repeat(64),profile={model_id:2,weights_fp24:3,quant_bits:2,ctx_size:262144};
  const base={schema:1,source:'stock_ds4_kvstore_headers',privacy:'installation_keyed_hmac',status:'ready',observed_at:1000,capped:false,rejected:0};
  for(const patch of [{tokens:'PRIVATE_VALUE'},{tokens:{secret:'PRIVATE_VALUE'}},{tokens:0},{tokens:-1},{tokens:.5},{tokens:2**32},
    {tokens:NaN},{tokens:Infinity},{tokens:null},{tokens:undefined},{file_bytes:'PRIVATE_VALUE'},{file_bytes:51},
    {file_bytes:-1},{file_bytes:52.5},{file_bytes:Number.MAX_SAFE_INTEGER+1},{file_bytes:null},{file_bytes:undefined}]){
    const inventory={...base,entries:[{snapshot_ref:ref,tokens:1000,file_bytes:2000,compatibility:profile,...patch}]};
    const result=snapshotPresence(inventory,ref,profile,{now:2000});
    assert.equal(result.status,'unknown');assert.equal(result.reason,'snapshot_metadata_unverified');
    assert.ok(!JSON.stringify(result).includes('PRIVATE_VALUE'));assert.equal(result.tokens,undefined);assert.equal(result.file_bytes,undefined);
  }
});

test('negative inventory clocks cannot establish freshness, including apparent absence',()=>{
  const ref='a'.repeat(64),profile={model_id:2,weights_fp24:3,quant_bits:2,ctx_size:262144};
  const base={schema:1,source:'stock_ds4_kvstore_headers',privacy:'installation_keyed_hmac',status:'ready',observed_at:-1,capped:false,rejected:0,entries:[]};
  assert.equal(snapshotPresence(base,ref,profile,{now:1000}).status,'unknown');
  assert.equal(snapshotPresence(base,ref,profile,{now:-1}).reason,'invalid_inventory_query');
});

test('valid metadata boundaries and exact inventory freshness retain bounded observations',()=>{
  const ref='a'.repeat(64),profile={model_id:2,weights_fp24:3,quant_bits:2,ctx_size:262144};
  const base={schema:1,source:'stock_ds4_kvstore_headers',privacy:'installation_keyed_hmac',status:'ready',observed_at:0,capped:false,rejected:0};
  for(const tokens of [1,0xffffffff])for(const file_bytes of [52,Number.MAX_SAFE_INTEGER]){
    const inventory={...base,entries:[{snapshot_ref:ref,tokens,file_bytes,compatibility:profile}]},before=structuredClone(inventory);
    const result=snapshotPresence(inventory,ref,profile,{now:120000});
    assert.equal(result.status,'observed');assert.equal(result.tokens,tokens);assert.equal(result.file_bytes,file_bytes);
    assert.equal(snapshotPresence(inventory,ref,profile,{now:120001}).status,'unknown');
    assert.deepEqual(inventory,before);
  }
  assert.equal(snapshotPresence({...base,entries:[]},ref,profile,{now:0}).status,'absent');
  assert.equal(snapshotPresence({...base,observed_at:1001,entries:[]},ref,profile,{now:1000}).status,'unknown');
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

test('a matching snapshot reference cannot turn an impossible profile into observed compatibility',()=>{
  const ref='a'.repeat(64),valid={model_id:2,weights_fp24:3,quant_bits:2,ctx_size:262144};
  for(const bad of [{model_id:-1},{weights_fp24:0x1000000},{ctx_size:0}]){
    const invalid={...valid,...bad};
    for(const [source,target] of [[invalid,invalid],[invalid,valid],[valid,invalid]]){
      const inventory={schema:1,source:'stock_ds4_kvstore_headers',privacy:'installation_keyed_hmac',status:'ready',observed_at:1000,capped:false,rejected:0,
        entries:[{snapshot_ref:ref,tokens:1000,file_bytes:2000,compatibility:source}]};
      const before=structuredClone(inventory);
      assert.deepEqual(snapshotPresence(inventory,ref,target,{now:2000}),{status:'unknown',reason:'missing_profile_evidence',observed_at:1000});
      assert.deepEqual(inventory,before);
    }
  }
});
