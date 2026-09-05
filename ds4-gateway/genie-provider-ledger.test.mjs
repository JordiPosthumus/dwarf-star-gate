import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {GenieProviderLedger} from './genie-provider-ledger.mjs';
import {Genie} from './genie.mjs';
const record=(time=1000)=>({id:randomUUID(),time,served_by:'pool_fallback',served_on:'worker-a'});
function fixture(t){const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'dsg-pool-ledger-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return path.join(root,'actions');}
test('pool receipts survive a fresh process, retain last 30 and never persist review content',t=>{
  const dir=fixture(t),ledger=new GenieProviderLedger(dir);assert.equal(fs.existsSync(dir),false);
  const rows=Array.from({length:40},(_,i)=>record(i));
  for(const row of rows)assert.equal(ledger.append({...row,text:'PRIVATE_REVIEW',url:'PRIVATE_ENDPOINT',actions_taken:['PRIVATE']}),true);
  const size=ledger.bytes;assert.equal(ledger.append(rows[0]),true);assert.equal(ledger.bytes,size);
  assert.equal(fs.statSync(dir).mode&0o777,0o700);assert.equal(fs.statSync(ledger.file).mode&0o777,0o600);
  assert.ok(!fs.readFileSync(ledger.file,'utf8').includes('PRIVATE'));
  const code=`import {GenieProviderLedger} from ${JSON.stringify(new URL('./genie-provider-ledger.mjs',import.meta.url).href)};console.log(JSON.stringify(new GenieProviderLedger(process.argv[1]).recent()));`;
  const loaded=JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',code,dir],{encoding:'utf8'}));
  assert.deepEqual(loaded,rows.slice(10).reverse());assert.equal(new GenieProviderLedger(dir).status().saved_receipts,40);
  const copy=ledger.recent();copy[0].time=0;assert.equal(ledger.recent()[0].time,39);
});
test('corrupt tails, extra fields, duplicate IDs and unsafe file modes are rejected without repair',t=>{
  for(const mutation of ['tail','field','duplicate','mode']){
    const dir=fixture(t),ledger=new GenieProviderLedger(dir);ledger.append(record());const good=fs.readFileSync(ledger.file,'utf8');
    if(mutation==='tail')fs.appendFileSync(ledger.file,'{');
    if(mutation==='field'){const row=JSON.parse(good);row.text='PRIVATE';fs.writeFileSync(ledger.file,JSON.stringify(row)+'\n');}
    if(mutation==='duplicate')fs.appendFileSync(ledger.file,good);
    if(mutation==='mode')fs.chmodSync(ledger.file,0o644);
    const bytes=fs.readFileSync(ledger.file),loaded=new GenieProviderLedger(dir);assert.ok(loaded.error);assert.deepEqual(loaded.recent(),[]);assert.equal(loaded.status().saved_receipts,null);
    assert.equal(loaded.append(record()),false);assert.deepEqual(fs.readFileSync(ledger.file),bytes);
  }
});
test('symlinks, hardlinks and stale writers cannot replace or append another ledger',t=>{
  for(const mutation of ['symlink','hardlink','directory','writer','replaced']){
    const dir=fixture(t),ledger=new GenieProviderLedger(dir);ledger.append(record());
    const other=new GenieProviderLedger(dir),target=path.join(path.dirname(dir),'target');
    if(mutation==='writer')ledger.append(record());
    if(mutation==='symlink'||mutation==='hardlink'||mutation==='replaced'){
      fs.renameSync(ledger.file,target);
      if(mutation==='symlink')fs.symlinkSync(target,ledger.file);
      if(mutation==='hardlink')fs.linkSync(target,ledger.file);
      if(mutation==='replaced')fs.copyFileSync(target,ledger.file);
    }
    if(mutation==='directory'){fs.renameSync(dir,target);fs.symlinkSync(target,dir);}
    const before=fs.readFileSync(ledger.file);assert.equal(other.append(record()),false);assert.ok(other.error);assert.deepEqual(fs.readFileSync(ledger.file),before);
  }
});
test('ceiling, locked writer, partial writes and fsync failure do not block review completion',async t=>{
  for(const failure of ['ceiling','lock','partial','fsync']){
    const dir=fixture(t),io={...fs};
    if(failure==='partial')io.writeSync=(fd,b,start,length)=>{fs.writeSync(fd,b,start,Math.min(2,length));throw new Error('PRIVATE_IO');};
    if(failure==='fsync')io.fsyncSync=()=>{throw new Error('PRIVATE_IO');};
    const ledger=new GenieProviderLedger(dir,{maxBytes:failure==='ceiling'?1:16384,io});
    if(failure==='lock'){fs.mkdirSync(dir,{mode:0o700});fs.writeFileSync(path.join(dir,'writer.lock'),'external',{mode:0o600});}
    const genie=new Genie({url:'http://127.0.0.1:9001/v1',fallback:{url:'http://127.0.0.1:9002/v1'}},()=>({time:Date.now(),gateway_at:Date.now(),gateway:{workers:[]},events:[],devices:[]}),{providerLedger:ledger});
    genie.modelAnswer=async(_endpoint,{servedBy})=>{if(servedBy!=='pool_fallback')throw new Error('unavailable');return {served_by:servedBy,served_on:null,answer:JSON.stringify({assessment:'No evidence.',ticker:[{severity:'info',text:'No evidence.',recommendation:null,evidence_refs:['fleet']}]})};};
    const state=await genie.ask();assert.equal(state.error,null);assert.equal(state.reports.length,1);assert.equal(state.provider_actions.length,1);
    assert.ok(state.provider_action_storage.error);assert.ok(!JSON.stringify(state.provider_action_storage).includes('PRIVATE_IO'));
    if(failure==='lock')assert.equal(fs.readFileSync(path.join(dir,'writer.lock'),'utf8'),'external');genie.close();
  }
});
test('Genie reload uses durable receipts, no fabricated reviews or action offers',t=>{
  const dir=fixture(t),ledger=new GenieProviderLedger(dir),row=record();ledger.append(row);
  const genie=new Genie(null,()=>({gateway:{workers:[]}}),{providerLedger:new GenieProviderLedger(dir)});
  const state=genie.status();assert.deepEqual(state.provider_actions,[row]);assert.deepEqual(state.reports,[]);assert.equal(state.enabled,false);
  assert.equal(state.provider_action_storage.saved_receipts,1);assert.equal(genie.recover,null);genie.close();
});
test('invalid receipt fields and changed duplicate identity cannot become durable history',t=>{
  for(const change of [{id:'request-secret'},{time:-1},{time:Infinity},{served_by:'dedicated'},{served_on:'http://private.invalid/'},{served_on:undefined}]){
    const ledger=new GenieProviderLedger(fixture(t));assert.equal(ledger.append({...record(),...change}),false);
    assert.deepEqual(ledger.recent(),[]);assert.equal(fs.existsSync(ledger.file),false);
  }
  const ledger=new GenieProviderLedger(fixture(t)),row=record();ledger.append(row);const bytes=fs.readFileSync(ledger.file);
  assert.equal(ledger.append({...row,served_on:'worker-b'}),false);assert.deepEqual(fs.readFileSync(ledger.file),bytes);
});
test('short writes complete exactly one receipt; oversized journals remain untouched',t=>{
  const io={...fs,writeSync:(fd,b,start,length)=>fs.writeSync(fd,b,start,Math.min(3,length))};
  const dir=fixture(t),ledger=new GenieProviderLedger(dir,{io}),row=record();assert.equal(ledger.append(row),true);
  assert.deepEqual(new GenieProviderLedger(dir).recent(),[row]);const bytes=fs.readFileSync(ledger.file);
  const bounded=new GenieProviderLedger(dir,{maxBytes:1});assert.ok(bounded.error);assert.equal(bounded.append(record()),false);
  assert.deepEqual(fs.readFileSync(ledger.file),bytes);
});
test('dangling directory/file links and nonprivate directories are not empty history',t=>{
  for(const kind of ['directory','file','mode']){
    const dir=fixture(t),target=path.join(path.dirname(dir),'missing');
    if(kind==='directory')fs.symlinkSync(target,dir);
    else{fs.mkdirSync(dir,{mode:kind==='mode'?0o755:0o700});if(kind==='file')fs.symlinkSync(target,path.join(dir,'pool-actions.jsonl'));}
    const ledger=new GenieProviderLedger(dir);assert.ok(ledger.error);assert.equal(ledger.status().saved_receipts,null);
    assert.equal(ledger.append(record()),false);assert.equal(fs.existsSync(target),false);
  }
});
