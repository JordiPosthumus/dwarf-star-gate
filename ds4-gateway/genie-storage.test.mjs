// Invalid local journal objects must fail without waiting for another process.
// Each potentially blocking open runs in a disposable, deadline-bounded child.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

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
