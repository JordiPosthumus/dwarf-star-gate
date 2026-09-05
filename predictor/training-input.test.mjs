import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {prepare} from './prepare.mjs';
import {trainingInputAudit,trainingInputArgs,TRAINING_INPUT_LIMIT} from './training-input.mjs';

function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dsg-training-input-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const data=path.join(root,'data');fs.mkdirSync(data);
  return {root,data,output:path.join(root,'candidate'),profiles:path.join(root,'inventory.json')};
}
function sparse(file,size){const fd=fs.openSync(file,'wx');try{fs.ftruncateSync(fd,size);}finally{fs.closeSync(fd);}}

test('preparation rejects aggregate oversize before reading any payload or creating output',t=>{
  const {data,output,profiles}=fixture(t);
  sparse(path.join(data,'routing-2026-01-01.jsonl'),64*1024**2);
  sparse(path.join(data,'routing-2026-01-02.jsonl'),64*1024**2+1);
  const reads=t.mock.method(fs,'readSync',()=>{throw new Error('Unexpected payload read');});
  assert.throws(()=>prepare(data,profiles,output),/Training snapshot exceeds 128 MiB; no input silently discarded/);
  assert.equal(reads.mock.callCount(),0);assert.equal(fs.existsSync(output),false);
  assert.equal(fs.statSync(path.join(data,'routing-2026-01-02.jsonl')).size,64*1024**2+1);
});

test('metadata audit reports exact inclusive boundary without opening or parsing evidence',t=>{
  const {data}=fixture(t),file=path.join(data,'routing-2026-01-01.jsonl');
  sparse(file,TRAINING_INPUT_LIMIT);
  fs.writeFileSync(path.join(data,'unrelated-private.txt'),'not included');
  const opens=t.mock.method(fs,'openSync',()=>{throw new Error('Unexpected open');});
  const audit=trainingInputAudit(data);
  assert.deepEqual(audit,{schema:1,metadata_only:true,state:'within_budget',file_count:1,
    bytes:TRAINING_INPUT_LIMIT,limit_bytes:TRAINING_INPUT_LIMIT,overage_bytes:0,
    files:[{name:'routing-2026-01-01.jsonl',bytes:TRAINING_INPUT_LIMIT}]});
  assert.equal(opens.mock.callCount(),0);
});

test('audit reports empty and over-budget inputs without truncation',t=>{
  const {data}=fixture(t);assert.equal(trainingInputAudit(data).state,'empty');
  sparse(path.join(data,'routing-2026-01-02.jsonl'),TRAINING_INPUT_LIMIT);
  fs.writeFileSync(path.join(data,'routing-2026-01-01.jsonl'),'not valid json');
  const audit=trainingInputAudit(data);
  assert.equal(audit.state,'over_budget');assert.equal(audit.overage_bytes,14);assert.equal(audit.file_count,2);
  assert.deepEqual(audit.files.map(f=>f.name),['routing-2026-01-01.jsonl','routing-2026-01-02.jsonl']);
});

test('preflight rejects symlink and nonregular evidence without candidate writes',t=>{
  const {data,root,profiles,output}=fixture(t),file=path.join(data,'routing-2026-01-01.jsonl');
  fs.symlinkSync(path.join(root,'missing'),file);
  assert.throws(()=>prepare(data,profiles,output),/regular file/);
  fs.unlinkSync(file);fs.mkdirSync(file);
  assert.throws(()=>trainingInputAudit(data),/regular file/);assert.equal(fs.existsSync(output),false);
});

test('growth after preflight is checked on the actual descriptor before payload read',t=>{
  const {data,profiles,output}=fixture(t),file=path.join(data,'routing-2026-01-01.jsonl');
  fs.writeFileSync(file,'');
  const open=fs.openSync;
  t.mock.method(fs,'openSync',function(target,...args){
    const fd=open.call(fs,target,...args);
    if(target===file){const writer=open.call(fs,file,'r+');try{fs.ftruncateSync(writer,TRAINING_INPUT_LIMIT+1);}finally{fs.closeSync(writer);}}
    return fd;
  });
  const reads=t.mock.method(fs,'readSync',()=>{throw new Error('Unexpected payload read');});
  assert.throws(()=>prepare(data,profiles,output),/exceeds 128 MiB/);
  assert.equal(reads.mock.callCount(),0);assert.equal(fs.existsSync(output),false);
});

test('opened sizes remain aggregate-bounded even when later files grow',t=>{
  const {data,profiles,output}=fixture(t),first=path.join(data,'routing-2026-01-01.jsonl'),last=path.join(data,'routing-2026-01-02.jsonl');
  fs.writeFileSync(first,'\n');fs.writeFileSync(last,'');
  const open=fs.openSync;
  t.mock.method(fs,'openSync',function(target,...args){
    if(target===last){const writer=open.call(fs,last,'r+');try{fs.ftruncateSync(writer,TRAINING_INPUT_LIMIT);}finally{fs.closeSync(writer);}}
    return open.call(fs,target,...args);
  });
  assert.throws(()=>prepare(data,profiles,output),/exceeds 128 MiB/);
  assert.equal(fs.existsSync(output),false);
});

test('replacement with a symlink after preflight is not followed',t=>{
  const {data,profiles,output,root}=fixture(t),file=path.join(data,'routing-2026-01-01.jsonl'),target=path.join(root,'other');
  fs.writeFileSync(file,'');fs.writeFileSync(target,'');
  const open=fs.openSync;
  t.mock.method(fs,'openSync',function(name,...args){
    if(name===file){fs.unlinkSync(file);fs.symlinkSync(target,file);}
    return open.call(fs,name,...args);
  });
  assert.throws(()=>prepare(data,profiles,output),e=>e.code==='ELOOP');
  assert.equal(fs.existsSync(output),false);
});

test('FIFO replacement is rejected without blocking on a writer',t=>{
  const {data,profiles,output}=fixture(t),file=path.join(data,'routing-2026-01-01.jsonl');fs.writeFileSync(file,'');
  // Isolate the race fixture so removal of O_NONBLOCK fails by a bounded timeout,
  // instead of hanging the test runner (both supported CI platforms are POSIX).
  const script=`import fs from 'node:fs';import {execFileSync} from 'node:child_process';
    import {prepare} from ${JSON.stringify(new URL('./prepare.mjs',import.meta.url).href)};
    const file=${JSON.stringify(file)},open=fs.openSync;
    fs.openSync=function(name,...args){if(name===file){fs.unlinkSync(file);execFileSync('mkfifo',[file]);}return open.call(fs,name,...args);};
    try{prepare(${JSON.stringify(data)},${JSON.stringify(profiles)},${JSON.stringify(output)});process.exitCode=2;}
    catch(e){if(e.message!=='Evidence must be a regular file')throw e;}`;
  const result=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',timeout:5000});
  assert.equal(result.error,undefined);assert.equal(result.status,0,result.stderr);assert.equal(fs.existsSync(output),false);
});

test('under-budget snapshots preserve exact bytes and incomplete-line behavior',t=>{
  const {data,profiles,output}=fixture(t),name='routing-2026-01-01.jsonl',raw='\n{"partial":';
  fs.writeFileSync(path.join(data,name),raw);fs.writeFileSync(profiles,JSON.stringify({schema:1,workers:{}}));
  const result=prepare(data,profiles,output);
  assert.equal(result.rows,0);assert.equal(result.snapshot.bytes,Buffer.byteLength(raw));
  assert.equal(fs.readFileSync(path.join(output,'snapshots',name),'utf8'),raw);
  assert.equal(fs.readFileSync(path.join(data,name),'utf8'),raw);
});

test('CLI emits only metadata, with explicit size-status exit codes and strict arguments',t=>{
  const {data}=fixture(t),cli=fileURLToPath(new URL('./training-input.mjs',import.meta.url));
  const run=()=>spawnSync(process.execPath,[cli,'--data',data],{encoding:'utf8',timeout:5000});
  let result=run();assert.equal(result.status,1);assert.equal(JSON.parse(result.stdout).state,'empty');
  const file=path.join(data,'routing-2026-01-01.jsonl');fs.writeFileSync(file,'PRIVATE_INVALID_PAYLOAD');
  result=run();assert.equal(result.status,0);assert.equal(JSON.parse(result.stdout).state,'within_budget');
  assert.ok(!result.stdout.includes('PRIVATE_INVALID_PAYLOAD'));assert.ok(!result.stdout.includes(data));
  fs.truncateSync(file,TRAINING_INPUT_LIMIT+1);
  result=run();assert.equal(result.status,1);assert.equal(JSON.parse(result.stdout).overage_bytes,1);
  assert.equal(result.stderr,'');
  for(const args of [[],['--data'],['--other',data],['--data',data,'--data',data],['--data','--output']])assert.throws(()=>trainingInputArgs(args),/Use --data/);
});
