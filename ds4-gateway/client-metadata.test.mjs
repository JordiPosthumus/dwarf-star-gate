import {test} from 'node:test';
import assert from 'node:assert/strict';
import {clientMetadata,safeClientMetadata} from './client-metadata.mjs';
import {evidence} from './dataset.mjs';
import {calibrationPreflight} from './calibration.mjs';

test('early metadata preserves missingness, client provenance and explicit zero',()=>{
  assert.equal(clientMetadata().status,'missing');
  const input={schema:1,prompt_tokens_estimate:262144,turn_index:0,compaction_count:0,reasoning_effort:'xhigh'};
  const hint=clientMetadata(JSON.stringify(input));
  assert.deepEqual(hint,{...input,status:'ready',source:'client_header'});
  assert.equal(clientMetadata('{"schema":1}').turn_index,null);
  assert.deepEqual(safeClientMetadata(hint),hint);
});
test('bad and private header content is discarded, never persisted in errors or evidence',()=>{
  for(const input of ['not json','null','[]','{"schema":2}','{"schema":1,"prompt":"PRIVATE_FIXTURE"}',
    '{"schema":1,"turn_index":-1}','{"schema":1,"compaction_count":0.5}',
    '{"schema":1,"reasoning_effort":"PRIVATE_FIXTURE"}','{"schema":1,"prompt_tokens_estimate":1e100}',
    '{"schema":1,"turn_index":true}','x'.repeat(513),['{"schema":1}','{"schema":1}']]) {
    const hint=clientMetadata(input);assert.equal(hint.status,'invalid');
    const row=evidence('decision',{request_id:'fixture',client_metadata:hint});
    assert.equal(row.client_metadata.turn_index,null);assert.ok(!JSON.stringify(row).includes('PRIVATE_FIXTURE'));
  }
  assert.equal(evidence('decision',{request_id:'fixture'}).client_metadata.status,'missing');
});

test('calibration fails closed even for idle workers or caller-claimed cache safety',()=>{
  const nodes=[{id:'idle',healthy:true,active:null,queue:[],warm_cache_safe:true},
    {id:'busy',healthy:true,active:{},queue:[]},
    {id:'paused',healthy:true,drained:true,queue:[]},
    {id:'broken',healthy:false,quarantine:{code:'fixture'},queue:[]}];
  const before=structuredClone(nodes),result=calibrationPreflight(nodes);
  assert.equal(result.state,'skipped');assert.equal(result.execution_available,false);
  assert.ok(result.workers.every(w=>!w.eligible&&w.reasons.includes('warm_cache_preservation_unverified')));
  assert.ok(result.workers[1].reasons.includes('gateway_work_present'));
  assert.ok(result.workers[2].reasons.includes('operator_paused'));
  assert.ok(result.workers[3].reasons.includes('quarantined'));
  assert.ok(calibrationPreflight(nodes,{draining:true}).workers.every(w=>w.reasons.includes('gateway_draining')));
  assert.equal(calibrationPreflight().execution_available,false);assert.deepEqual(nodes,before);
});
