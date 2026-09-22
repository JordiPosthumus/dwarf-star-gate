import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {AffinityStore} from './gateway.mjs';

function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sg-lock-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  return path.join(dir,'affinity.json');
}
test('state lock records birth identity and rejects a second live owner',t=>{
  const file=fixture(t),store=new AffinityStore(file);
  const receipt=JSON.parse(fs.readFileSync(file+'.lock','utf8'));
  assert.equal(receipt.pid,process.pid);
  assert.ok(receipt.process_started_at.length>10);
  assert.throws(()=>new AffinityStore(file),/already locked/);
  assert.deepEqual(JSON.parse(fs.readFileSync(file+'.lock','utf8')),receipt);
  store.close();
});
test('reused live PID with different birth identity recovers without losing affinity',t=>{
  const file=fixture(t),key='a'.repeat(64);
  const data={version:1,sessions:{[key]:{node:'retained-worker'}},drained:{'retained-worker':true}};
  const bytes=JSON.stringify(data);fs.writeFileSync(file,bytes);
  fs.writeFileSync(file+'.lock',JSON.stringify({pid:process.pid,process_started_at:'Mon Jan  1 00:00:00 2001'}));
  const store=new AffinityStore(file);
  assert.deepEqual(store.data,data);
  assert.equal(fs.readFileSync(file,'utf8'),bytes);
  assert.notEqual(JSON.parse(fs.readFileSync(file+'.lock','utf8')).process_started_at,'Mon Jan  1 00:00:00 2001');
  store.close();
});
test('legacy live PID and invalid identities are never silently stolen',t=>{
  const file=fixture(t);
  for(const receipt of [{pid:process.pid},{pid:process.pid,process_started_at:''},{pid:process.pid,process_started_at:42}]) {
    const bytes=JSON.stringify(receipt);fs.writeFileSync(file+'.lock',bytes);
    assert.throws(()=>new AffinityStore(file),/locked|Invalid state lock identity/);
    assert.equal(fs.readFileSync(file+'.lock','utf8'),bytes);
  }
});
