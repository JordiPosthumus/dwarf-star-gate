import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {snapshotPresence} from './cache-path-shadow.mjs';
import {CacheInventoryReader,cacheCompatibility,cacheInventoryDirectories,cacheSnapshotReference,loadCacheInventoryKey,parseCacheHeader,scanCacheDirectory,summarizeCacheInventory} from './cache-inventory.mjs';

const secret=Buffer.alloc(32,7),stem='a'.repeat(40),name=stem+'.kv';
function header(change={}){
  const values={model_id:2,weights_fp24:0xa11ce,quant_bits:2,reason:2,ext_flags:3,tokens:1024,hits:5,ctx_size:262144,created_at:100,last_used:200,payload_bytes:16,text_bytes:12,...change};
  const b=Buffer.alloc(52);b.write('KVC',0,'ascii');b[3]=1;b[4]=values.quant_bits;b[5]=values.reason;b[6]=values.ext_flags;b[7]=values.model_id;b.writeUInt32LE(values.tokens,8);b.writeUInt32LE(values.hits,12);b.writeUInt32LE(values.ctx_size,16);b[20]=2;b[21]=values.weights_fp24&255;b[22]=values.weights_fp24>>8&255;b[23]=values.weights_fp24>>16&255;b.writeBigUInt64LE(BigInt(values.created_at),24);b.writeBigUInt64LE(BigInt(values.last_used),32);b.writeBigUInt64LE(BigInt(values.payload_bytes),40);b.writeUInt32LE(values.text_bytes,48);return b;
}
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dsg-cache-inventory-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
function cacheFile(dir,file=name,change={}){const b=header(change),text=Buffer.from('PRIVATE_TEXT'.slice(0,change.text_bytes??12).padEnd(change.text_bytes??12,'x')),payload=Buffer.alloc(change.payload_bytes??16,9);fs.writeFileSync(path.join(dir,file),Buffer.concat([b,text,payload]));}

test('stock DS4 header parser exports bounded metadata and a keyed pseudonym, never prompt-derived identifiers',()=>{
  const a=parseCacheHeader(header(),{filename:name,file_size:80,secret}),b=parseCacheHeader(header(),{filename:name,file_size:80,secret}),other=parseCacheHeader(header(),{filename:name,file_size:80,secret:Buffer.alloc(32,8)});
  assert.equal(a.snapshot_ref,b.snapshot_ref);assert.notEqual(a.snapshot_ref,other.snapshot_ref);assert.match(a.snapshot_ref,/^[\da-f]{64}$/);
  assert.deepEqual(a.compatibility,{model_id:2,weights_fp24:0xa11ce,quant_bits:2,ctx_size:262144,ext_flags:3,payload_abi:2});
  assert.equal(a.tokens,1024);assert.equal(a.text_bytes,12);assert.ok(!JSON.stringify(a).includes(name));assert.ok(!JSON.stringify(a).includes('PRIVATE'));
  assert.equal(cacheSnapshotReference(secret,name),cacheSnapshotReference(secret,stem));assert.throws(()=>cacheSnapshotReference(secret,stem+'.bin'),/stock/);
  for(const [bytes,opts] of [[header({tokens:0}),{}],[header({quant_bits:8}),{}],[Buffer.alloc(51),{}],[header(),{file_size:79}],[Buffer.from(header().fill(0,0,3)),{}]])assert.equal(parseCacheHeader(bytes,{filename:name,file_size:80,secret,...opts}),null);
});

test('inventory reads only regular stock 40-hex .kv files, rejects symlinks/truncation and returns path-free summaries',t=>{
  const dir=fixture(t);cacheFile(dir);cacheFile(dir,'b'.repeat(40)+'.kv',{weights_fp24:0,last_used:300});fs.writeFileSync(path.join(dir,'not-a-cache'),'PRIVATE');
  cacheFile(dir,'e'.repeat(40));
  fs.symlinkSync(path.join(dir,name),path.join(dir,'c'.repeat(40)+'.kv'));fs.writeFileSync(path.join(dir,'d'.repeat(40)+'.kv'),header());
  const inventory=scanCacheDirectory(dir,{worker:'studio',secret,now:1000});assert.equal(inventory.status,'ready');assert.equal(inventory.scanned,4);assert.equal(inventory.accepted,2);assert.equal(inventory.rejected,2);
  assert.equal(inventory.entries[0].compatibility_confidence,'legacy_unknown_weights');
  const summary=summarizeCacheInventory(inventory);assert.equal(summary.accepted,2);assert.equal(summary.cohorts.length,2);assert.ok(!JSON.stringify(summary).includes(dir));assert.ok(!JSON.stringify(summary).includes(name));assert.ok(!JSON.stringify(summary).includes('PRIVATE'));
});

test('directory and scan bounds fail closed without following an enclosing symlink',t=>{
  const dir=fixture(t),link=dir+'-link';cacheFile(dir);fs.symlinkSync(dir,link);t.after(()=>fs.rmSync(link,{force:true}));
  assert.equal(scanCacheDirectory(link,{worker:'studio',secret}).status,'unavailable');
  assert.throws(()=>cacheInventoryDirectories({bad:'relative'}));assert.throws(()=>scanCacheDirectory(dir,{worker:'bad id',secret}));assert.throws(()=>scanCacheDirectory(dir,{worker:'studio',secret,max_files:4097}));
  cacheFile(dir,'b'.repeat(40)+'.kv');const capped=scanCacheDirectory(dir,{worker:'studio',secret,max_files:1});assert.equal(capped.scanned,1);assert.equal(capped.capped,true);
});

test('the installation key is private and stable while reader polling is bounded',t=>{
  const root=fixture(t),runtime=path.join(root,'runtime'),directory=path.join(root,'cache');fs.mkdirSync(directory);cacheFile(directory);
  const first=loadCacheInventoryKey(runtime),second=loadCacheInventoryKey(runtime);assert.deepEqual(first,second);assert.equal(first.length,32);assert.equal(fs.statSync(path.join(runtime,'cache-inventory.key')).mode&0o077,0);
  const reader=new CacheInventoryReader('studio',directory,first,{interval_ms:10000});assert.equal(reader.poll(1000).accepted,1);
  fs.unlinkSync(path.join(directory,name));assert.equal(reader.poll(5000).accepted,1,'polls inside interval use the prior bounded snapshot');assert.equal(reader.poll(11001).accepted,0);
  fs.chmodSync(path.join(runtime,'cache-inventory.key'),0o644);assert.throws(()=>loadCacheInventoryKey(runtime),/private/);
});

test('unrelated directory entries consume the scan budget and cannot prove cache absence',t=>{
  const dir=fixture(t);
  for(let i=0;i<5;i++)fs.writeFileSync(path.join(dir,`unrelated-${i}`),'');
  const capped=scanCacheDirectory(dir,{worker:'studio',secret,now:1000,max_entries:4});
  assert.equal(capped.scanned,0);assert.equal(capped.capped,true);
  assert.equal(summarizeCacheInventory(capped).capped,true);
  const target=parseCacheHeader(header(),{filename:name,file_size:80,secret}).compatibility;
  assert.equal(snapshotPresence(capped,cacheSnapshotReference(secret,name),target,{now:1000}).status,'unknown');
  const complete=scanCacheDirectory(dir,{worker:'studio',secret,now:1000,max_entries:5});
  assert.equal(complete.capped,false);
  assert.equal(snapshotPresence(complete,cacheSnapshotReference(secret,name),target,{now:1000}).status,'absent');
  for(const max_entries of [0,-1,1.5,16385,NaN])assert.throws(()=>scanCacheDirectory(dir,{worker:'studio',secret,max_entries}));
});

test('compatibility mirrors stock DS4 header gates and abstains on legacy weight fingerprints',()=>{
  const entry=parseCacheHeader(header(),{filename:name,file_size:80,secret}),profile={...entry.compatibility};
  assert.deepEqual(cacheCompatibility(entry,profile),{status:'compatible',reasons:[],confidence:'bounded_header'});
  assert.equal(cacheCompatibility(entry,{...profile,ctx_size:131072}).status,'incompatible');
  assert.equal(cacheCompatibility(entry,{...profile,model_id:1}).status,'incompatible');
  assert.equal(cacheCompatibility(entry,{...profile,weights_fp24:1}).status,'incompatible');
  assert.equal(cacheCompatibility(entry,{...profile,quant_bits:4},{reject_different_quant:true}).status,'incompatible');
  assert.equal(cacheCompatibility(entry,{...profile,weights_fp24:0}).status,'unknown');
  assert.equal(cacheCompatibility(entry,null).status,'unknown');
});

test('impossible header profiles cannot become compatible or prove incompatibility',()=>{
  const valid={model_id:2,weights_fp24:0xa11ce,quant_bits:2,ctx_size:262144};
  const invalid={model_id:[-1,256,1.5,NaN,Infinity,'2',true],weights_fp24:[-1,0x1000000,1.5,NaN,Infinity,'3',true],ctx_size:[-1,0,0x100000000,1.5,NaN,Infinity,'262144',true]};
  for(const [field,values] of Object.entries(invalid))for(const value of values){
    const malformed={...valid,[field]:value};
    for(const [source,target] of [[malformed,malformed],[malformed,valid],[valid,malformed]]){
      const before=structuredClone({source,target});
      assert.deepEqual(cacheCompatibility({compatibility:source},target),{status:'unknown',reasons:['missing_profile_evidence']});
      assert.deepEqual({source,target},before);
    }
  }
  for(const model_id of [0,255])for(const ctx_size of [1,0xffffffff]){
    const profile={...valid,model_id,ctx_size,weights_fp24:0xffffff};
    assert.equal(cacheCompatibility({compatibility:profile},profile).status,'compatible');
  }
  // Zero remains the legacy/unknown fingerprint, not malformed or compatible.
  assert.deepEqual(cacheCompatibility({compatibility:valid},{...valid,weights_fp24:0}),{status:'unknown',reasons:['legacy_unknown_weights']});
  // Cross-quantization is still governed by DS4's explicit policy, not equality.
  const otherQuant={...valid,quant_bits:4,weights_fp24:123};
  assert.equal(cacheCompatibility({compatibility:valid},otherQuant).status,'compatible');
  assert.equal(cacheCompatibility({compatibility:valid},otherQuant,{reject_different_quant:true}).status,'incompatible');
});
