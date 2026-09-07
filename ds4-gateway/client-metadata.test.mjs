import {test} from 'node:test';
import assert from 'node:assert/strict';
import {clientMetadata,safeClientMetadata} from './client-metadata.mjs';
import {evidence} from './dataset.mjs';

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
