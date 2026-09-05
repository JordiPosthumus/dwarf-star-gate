import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {RatePeaks} from './rate-peaks.mjs';
const row=(kind,tps,time=100)=>({node:'worker-a',kind,tps,time});
function fixture(t,options={}){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'dsg-rate-peaks-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const file=path.join(directory,'metrics-2026-01-01.jsonl');
  const reader=new RatePeaks(directory,{now:()=>10000,...options});
  return {directory,file,reader};
}
test('rate peaks seed from every retained day and persist exact independent fleet maxima',t=>{
  const {directory,file,reader}=fixture(t);
  fs.writeFileSync(file,[row('prefill',1250.7),row('decode',35.2)].map(JSON.stringify).join('\n')+'\n');
  for(const day of ['02','03','04'])fs.writeFileSync(path.join(directory,`metrics-2026-01-${day}.jsonl`),JSON.stringify(row('prefill',400))+'\n');
  reader.poll();assert.equal(reader.snapshot().history_status,'ready');assert.equal(reader.snapshot().prefill.tps,1250.7);assert.equal(reader.snapshot().decode.tps,35.2);
  fs.unlinkSync(file);reader.poll();
  const fresh=new RatePeaks(directory,{now:()=>10000});fresh.poll();assert.equal(fresh.snapshot().prefill.tps,1250.7,'restart and retention do not shrink the ceiling');
  fresh.accept({...row('decode',42.125),node:'other-worker'});fresh.flush();assert.equal(fresh.snapshot().decode.tps,42.125);
  const saved=JSON.parse(fs.readFileSync(fresh.file));assert.deepEqual(Object.keys(saved).sort(),['decode','prefill','schema']);assert.ok(fs.statSync(fresh.file).size<256);assert.equal(fs.statSync(fresh.file).mode&0o777,0o600);
});
test('rate peak replay is bounded, handles partial and oversized lines, and resumes appends',t=>{
  const {file,reader}=fixture(t,{readBytes:1024});
  fs.writeFileSync(file,'x'.repeat(70000)+'\n'+JSON.stringify(row('prefill',999))+'\n'+JSON.stringify(row('decode',30)).slice(0,-1));
  reader.poll();assert.equal(reader.snapshot().history_status,'catching_up');assert.equal(reader.cursors.values().next().value.offset,1024);
  for(let i=0;i<100;i++)reader.poll();assert.equal(reader.snapshot().prefill.tps,999);assert.equal(reader.snapshot().decode,null);
  fs.appendFileSync(file,'}\n');reader.poll();assert.equal(reader.snapshot().decode.tps,30);
  fs.writeFileSync(file,JSON.stringify(row('decode',45))+'\n');reader.poll();assert.equal(reader.snapshot().decode.tps,45,'truncation replays without losing old peaks');
});
test('rate peaks ignore invalid, future and unrelated telemetry without adding a speed cap',t=>{
  const {reader}=fixture(t);
  for(const r of [row('prefill',-1),row('decode',Infinity),row('decode',NaN),row('prefill',1,10001),row('hardware',100),{...row('decode',20),node:null}])reader.accept(r);
  assert.equal(reader.snapshot().prefill,null);assert.equal(reader.snapshot().decode,null);
  reader.accept(row('prefill',123456.789));assert.equal(reader.snapshot().prefill.tps,123456.789);
  const snapshot=reader.snapshot();snapshot.prefill.tps=0;assert.equal(reader.snapshot().prefill.tps,123456.789);
});
test('rate peak files fail closed on symlinks and preserve an unreadable prior record',t=>{
  const {directory,file,reader}=fixture(t);
  const target=path.join(directory,'private');fs.writeFileSync(target,'private');fs.symlinkSync(target,file);reader.poll();assert.equal(reader.snapshot().history_status,'unavailable');
  fs.writeFileSync(reader.file,'broken prior record');const broken=new RatePeaks(directory);broken.accept(row('prefill',400));broken.flush();assert.equal(fs.readFileSync(reader.file,'utf8'),'broken prior record');assert.equal(broken.snapshot().persistence_error,'peak_record_unreadable');
  fs.unlinkSync(reader.file);fs.symlinkSync(target,reader.file);reader.accept(row('decode',30));reader.flush();assert.equal(fs.readFileSync(target,'utf8'),'private');assert.equal(reader.snapshot().persistence_error,'peak_record_write_failed');
});
