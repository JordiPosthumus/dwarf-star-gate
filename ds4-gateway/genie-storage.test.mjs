// Invalid local journal objects must fail without waiting for another process.
// Each potentially blocking open runs in a disposable, deadline-bounded child.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {GenieMemory} from './genie-memory.mjs';

for(const kind of ['memory','ledger'])for(const phase of ['load','append'])test(`${kind} ${phase} refuses a FIFO journal without blocking`,{skip:process.platform==='win32',timeout:10000},t=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'dsg-storage-fifo-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const directory=path.join(root,'journal');fs.mkdirSync(directory,{mode:0o700});
  const file=path.join(directory,kind==='memory'?'notebook.jsonl':'pool-actions.jsonl');
  const module=new URL(kind==='memory'?'./genie-memory.mjs':'./genie-provider-ledger.mjs',import.meta.url).href;
  const name=kind==='memory'?'GenieMemory':'GenieProviderLedger';
  if(phase==='load')assert.equal(spawnSync('mkfifo',['-m','600',file]).status,0);
  const child=spawnSync(process.execPath,['--input-type=module','-e',`
    import {${name}} from ${JSON.stringify(module)};
    import fs from 'node:fs';import {spawnSync} from 'node:child_process';
    const directory=${JSON.stringify(directory)},file=${JSON.stringify(file)};
    const storage=new ${name}(directory);
    if(${JSON.stringify(phase)}==='append'){
      if(spawnSync('mkfifo',['-m','600',file]).status!==0)throw new Error('Fixture setup failed');
      try{${kind==='memory'?'storage.setEnabled(true);':"storage.append({id:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',time:1000,served_by:'pool_fallback',served_on:'worker'});"}}catch{}
    }
    console.log(JSON.stringify({available:storage.status().available,error:!!storage.error,fifo:fs.lstatSync(file).isFIFO(),lock:fs.existsSync(directory+'/writer.lock')}));
  `],{encoding:'utf8',timeout:3000,killSignal:'SIGKILL'});
  assert.equal(child.error,undefined,'journal open must return a diagnostic instead of waiting for a FIFO peer');
  assert.equal(child.status,0,child.stderr);
  assert.deepEqual(JSON.parse(child.stdout),{available:false,error:true,fifo:true,lock:false});
  assert.ok(fs.lstatSync(file).isFIFO(),'the invalid object was not overwritten or removed');
});

for(const mode of ['grow','shrink','short_reads'])test(`notebook load handles ${mode} against its pinned byte allowance`,{timeout:10000},t=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'dsg-storage-read-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const row=JSON.stringify({schema:1,kind:'settings',at:1000,enabled:true})+'\n',file=path.join(root,'notebook.jsonl');
  fs.writeFileSync(file,row,{mode:0o600});
  const module=new URL('./genie-memory.mjs',import.meta.url).href;
  const child=spawnSync(process.execPath,['--input-type=module','-e',`
    import fs from 'node:fs';import {GenieMemory} from ${JSON.stringify(module)};
    const file=${JSON.stringify(file)},mode=${JSON.stringify(mode)},row=${JSON.stringify(row)};
    const stat=fs.fstatSync,read=fs.readSync,ino=fs.statSync(file).ino;let checks=0,readBytes=0,readCalls=0;
    fs.fstatSync=(fd,...args)=>{const s=stat(fd,...args);
      if(s.ino===ino&&++checks===2){if(mode==='grow')fs.appendFileSync(file,row.repeat(40));if(mode==='shrink')fs.truncateSync(file,0);}return s;};
    fs.readSync=(fd,b,o,n,p)=>{const size=read(fd,b,o,mode==='short_reads'?Math.min(n,7):n,p);
      if(stat(fd).ino===ino){readBytes+=size;readCalls++;}return size;};
    const storage=new GenieMemory(${JSON.stringify(root)},{maxBytes:1024});
    console.log(JSON.stringify({available:storage.status().available,error:!!storage.error,enabled:storage.enabled,readBytes,readCalls}));
  `],{encoding:'utf8',timeout:3000,killSignal:'SIGKILL'});
  assert.equal(child.error,undefined);assert.equal(child.status,0,child.stderr);const result=JSON.parse(child.stdout);
  assert.equal(result.available,mode==='short_reads');assert.equal(result.error,mode!=='short_reads');
  assert.ok(result.readBytes<=Buffer.byteLength(row),'never read beyond the originally checked allowance');
  if(mode==='short_reads'){assert.equal(result.enabled,true);assert.ok(result.readCalls>1);assert.equal(result.readBytes,Buffer.byteLength(row));}
  assert.equal(fs.statSync(file).size,mode==='grow'?Buffer.byteLength(row)*41:mode==='shrink'?0:Buffer.byteLength(row));
});

for(const reload of [false,true])test(`notebook rejects equal-size replacement after ${reload?'load':'creation'}`,t=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'dsg-storage-identity-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const directory=path.join(root,'memory');
  let storage=new GenieMemory(directory,{now:()=>1000});storage.setEnabled(true);
  if(reload)storage=new GenieMemory(directory,{now:()=>1000});
  const before=fs.readFileSync(storage.file),old=path.join(root,'original.jsonl');fs.renameSync(storage.file,old);
  fs.writeFileSync(storage.file,before,{mode:0o600});assert.notEqual(fs.statSync(old).ino,fs.statSync(storage.file).ino);
  assert.throws(()=>storage.setEnabled(false),/Memory write failed/);
  assert.deepEqual(fs.readFileSync(storage.file),before);assert.deepEqual(fs.readFileSync(old),before);
  assert.equal(fs.existsSync(path.join(directory,'writer.lock')),false);assert.ok(storage.error);
});
