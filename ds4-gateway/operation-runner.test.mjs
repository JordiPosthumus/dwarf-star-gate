import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {ServerOperations} from './server-operations.mjs';
import {operationRunner} from './operation-runner.mjs';

const exec=promisify(execFile),hash=value=>createHash('sha256').update(value).digest('hex');
const python=(await exec('python3',['-c','import sys; print(sys.executable)'])).stdout.trim();
const script=fileURLToPath(new URL('./operation_runner.py',import.meta.url));
const fixture=`import json, time
def execute(plan, folder, progress):
    with (folder / 'effect.txt').open('x') as stream: stream.write('one fixture action')
    progress('waiting_fixture', 'Waiting for the fixture release; no model server is involved.')
    while not (folder / 'continue.fixture').exists(): time.sleep(0.02)
    if plan.get('fixture_failure'): raise RuntimeError('PRIVATE_FAILURE_MUST_NOT_LEAK')
    return {'state': 'completed', 'evidence': 'Synthetic executor completion only, not model qualification.'}
`;

async function waitFor(check,label='condition'){
  const until=Date.now()+7000;
  while(Date.now()<until){const result=await check();if(result)return result;await new Promise(r=>setTimeout(r,25));}
  throw new Error('Timed out waiting for '+label);
}
async function rig(t,{failure=false}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'sg-operation-runner-')),directory=path.join(root,'operations');fs.mkdirSync(directory);
  const record=path.join(root,'approved.json'),executor=path.join(root,'fixture.py');
  fs.writeFileSync(record,JSON.stringify({kind:'approved',worker_id:'fixture'}));fs.writeFileSync(executor,fixture);
  const revision=hash(fs.readFileSync(record)),transport=operationRunner({python,directory});
  const options={directory,workers:['fixture'],recordRevision:async()=>hash(fs.readFileSync(record)),...transport,
    prepare:async(p,r)=>({plan:{worker_id:p.worker_id,record_file:record,record_revision:r,
      execution:{path:executor,sha256:hash(fs.readFileSync(executor))},fixture_failure:failure},
      review:{before:['fixture only'],after:p.command}})};
  const store=new ServerOperations(options);
  const input={id:randomUUID(),worker_id:'fixture',image:'sha256:'+'a'.repeat(64),command:['fixture only'],reason:'Test the independent runner without a server.'};
  store.propose(input);await store.idle();const row=store.status(input.id),folder=path.join(directory,input.id);
  const target={id:input.id,directory:folder};
  async function approve(){await store.change({action:'approve',id:row.id,plan_revision:row.plan_revision});await store.idle();}
  const release=()=>fs.writeFileSync(path.join(folder,'continue.fixture'),'proceed');
  t.after(async()=>{
    store.close();release();
    // Finish only our fixture rather than cancelling a process on a test timeout.
    await waitFor(async()=>!(await transport.observe(target)).process_alive,'fixture process exit');
    fs.rmSync(root,{recursive:true,force:true});
  });
  return {root,folder,record,executor,revision,options,store,input,row,target,transport,approve,release};
}

test('proposal alone never creates an independent process or action',async t=>{
  const r=await rig(t),state=await r.transport.observe(r.target);
  assert.equal(state.process_alive,false);assert.equal(state.state,'requires_reconciliation');
  assert.equal(fs.existsSync(path.join(r.folder,'effect.txt')),false);
  assert.equal(fs.existsSync(path.join(r.folder,'runner-started.json')),false);
});

test('later return evidence updates status without rewriting or rerunning the failed attempt',async t=>{
  const r=await rig(t,{failure:true});await r.approve();r.release();
  await waitFor(async()=>{const s=await r.transport.observe(r.target);return !s.process_alive&&s.result?.state==='requires_reconciliation';});
  const original=fs.readFileSync(path.join(r.folder,'runner-result.json'));
  const binding=hash(fs.readFileSync(path.join(r.folder,'plan.json')));
  fs.writeFileSync(path.join(r.folder,'reconcile-started.json'),JSON.stringify({plan_revision:binding,pid:999999}));
  const outcome={state:'restored',plan_revision:'f'.repeat(64),serving:'previous',readmission:{state:'readmitted'}};
  const file=path.join(r.folder,'reconcile-result.json');fs.writeFileSync(file,JSON.stringify(outcome));
  assert.equal((await r.transport.observe(r.target)).state,'requires_reconciliation');
  outcome.plan_revision=binding;fs.writeFileSync(file,JSON.stringify(outcome));
  const observed=await r.transport.observe(r.target);
  assert.equal(observed.state,'restored');assert.equal(observed.process_alive,false);
  assert.equal(observed.original_result.state,'requires_reconciliation');assert.deepEqual(observed.result,outcome);
  assert.deepEqual(fs.readFileSync(path.join(r.folder,'runner-result.json')),original);
  assert.equal(fs.readFileSync(path.join(r.folder,'effect.txt'),'utf8'),'one fixture action');
});

test('approved operation keeps running after its dashboard process exits',async t=>{
  const r=await rig(t);
  // A separate real Node process acts as the dashboard. It launches once, exits,
  // then this test observes the kernel-held runner lock and releases the fixture.
  const code=`import {ServerOperations} from ${JSON.stringify(new URL('./server-operations.mjs',import.meta.url).href)};
import {operationRunner} from ${JSON.stringify(new URL('./operation-runner.mjs',import.meta.url).href)};
const transport=operationRunner(${JSON.stringify({python,directory:r.options.directory})});
const store=new ServerOperations({directory:${JSON.stringify(r.options.directory)},workers:['fixture'],prepare:async()=>{},recordRevision:async()=>${JSON.stringify(r.revision)},...transport});
await store.change(${JSON.stringify({action:'approve',id:r.row.id,plan_revision:r.row.plan_revision})});await store.idle();store.close();`;
  const parent=await exec(process.execPath,['--input-type=module','-e',code],{timeout:7000});assert.equal(parent.stderr,'');
  const running=await waitFor(async()=>{const x=await r.transport.observe(r.target);return x.progress?.phase==='waiting_fixture'&&x;});
  assert.equal(running.process_alive,true);assert.equal(running.state,'running');assert.ok(running.runner.pid>0);
  const restarted=new ServerOperations(r.options);await restarted.resumeApproved();
  const again=await restarted.current(r.row.id);assert.equal(again.runner.runner.pid,running.runner.pid);
  assert.equal(fs.readFileSync(path.join(r.folder,'effect.txt'),'utf8'),'one fixture action');
  r.release();const result=await waitFor(async()=>{const x=await r.transport.observe(r.target);return !x.process_alive&&x.result&&x;});
  assert.equal(result.state,'completed');assert.match(result.result.evidence,/Synthetic/);
  assert.equal(result.result.plan_revision,r.row.plan_revision);
  const startBytes=fs.readFileSync(path.join(r.folder,'runner-started.json'),'utf8');
  const duplicate=JSON.parse((await exec(python,['-I',script,'run',r.folder])).stdout);
  assert.equal(duplicate.process_alive,false);assert.equal(duplicate.state,'completed');
  assert.equal(fs.readFileSync(path.join(r.folder,'runner-started.json'),'utf8'),startBytes);
});

test('duplicate process submission observes the same live attempt',async t=>{
  const r=await rig(t);await r.approve();
  const started=await waitFor(async()=>{const x=await r.transport.observe(r.target);return x.progress?.phase==='waiting_fixture'&&x;});
  const duplicate=JSON.parse((await exec(python,['-I',script,'run',r.folder])).stdout);
  assert.equal(duplicate.process_alive,true);assert.equal(duplicate.runner.pid,started.runner.pid);
  r.release();await waitFor(async()=>(await r.transport.observe(r.target)).state==='completed');
});

test('an executor exception preserves the attempt and never claims unchanged or completed',async t=>{
  const r=await rig(t,{failure:true});await r.approve();await waitFor(()=>fs.existsSync(path.join(r.folder,'effect.txt')));r.release();
  const result=await waitFor(async()=>{const x=await r.transport.observe(r.target);return !x.process_alive&&x.result&&x;});
  assert.equal(result.state,'requires_reconciliation');assert.doesNotMatch(JSON.stringify(result),/PRIVATE_FAILURE/);
  const again=JSON.parse((await exec(python,['-I',script,'run',r.folder])).stdout);
  assert.equal(again.state,'requires_reconciliation');assert.equal(fs.readFileSync(path.join(r.folder,'effect.txt'),'utf8'),'one fixture action');
});

for(const mutation of ['missing_approval','plan_bytes','record_bytes','executor_bytes','declined']){
  test('independent runner rejects '+mutation+' before any fixture action',async t=>{
    const r=await rig(t);
    r.store.write(r.row.id,'approved.json',{at:Date.now(),actor:'owner',plan_revision:r.row.plan_revision,record_revision:r.revision});
    r.store.write(r.row.id,'launch-intent.json',{at:Date.now(),plan_revision:r.row.plan_revision});
    if(mutation==='missing_approval')fs.unlinkSync(path.join(r.folder,'approved.json'));
    if(mutation==='plan_bytes')fs.appendFileSync(path.join(r.folder,'plan.json'),' ');
    if(mutation==='record_bytes')fs.appendFileSync(r.record,' ');
    if(mutation==='executor_bytes')fs.appendFileSync(r.executor,'\n# changed\n');
    if(mutation==='declined')r.store.write(r.row.id,'declined.json',{at:Date.now()});
    await assert.rejects(exec(python,['-I',script,'run',r.folder]));
    assert.equal(fs.existsSync(path.join(r.folder,'runner-started.json')),false);
    assert.equal(fs.existsSync(path.join(r.folder,'effect.txt')),false);
  });
}

test('a saved dead attempt is reconciliation, even if its PID belongs to a live process',async t=>{
  const r=await rig(t);r.store.write(r.row.id,'runner-started.json',{pid:process.pid,at:Date.now()});
  const observed=await r.transport.observe(r.target);assert.equal(observed.process_alive,false);assert.equal(observed.state,'requires_reconciliation');
  const repeated=JSON.parse((await exec(python,['-I',script,'run',r.folder])).stdout);
  assert.equal(repeated.process_alive,false);assert.equal(repeated.state,'requires_reconciliation');assert.equal(fs.existsSync(path.join(r.folder,'effect.txt')),false);
});

test('runner rejects a directory outside its configured private store',async t=>{
  const r=await rig(t);await assert.rejects(r.transport.launch({...r.target,directory:r.root}),/identity/);
});

test('abrupt loss of the exact fixture runner is observed without repeating its action',async t=>{
  const r=await rig(t);await r.approve();
  const active=await waitFor(async()=>{const x=await r.transport.observe(r.target);return x.progress?.phase==='waiting_fixture'&&x;});
  assert.equal(active.runner.id,r.input.id);assert.equal(active.runner.plan_revision,r.row.plan_revision);
  // This PID came from our private fixture receipt and owns its live kernel lock.
  // No model, fleet job, or remotely discovered process is signalled by this test.
  process.kill(active.runner.pid,'SIGKILL');
  const stopped=await waitFor(async()=>{const x=await r.transport.observe(r.target);return !x.process_alive&&x;});
  assert.equal(stopped.state,'requires_reconciliation');assert.equal(stopped.result,null);
  const reloaded=new ServerOperations(r.options);await reloaded.resumeApproved();
  const repeated=JSON.parse((await exec(python,['-I',script,'run',r.folder])).stdout);
  assert.equal(repeated.process_alive,false);assert.equal(repeated.runner.pid,active.runner.pid);
  assert.equal(fs.readFileSync(path.join(r.folder,'effect.txt'),'utf8'),'one fixture action');
});

test('heartbeat does not pretend the executor advanced to a new phase',async t=>{
  const r=await rig(t);
  r.store.write(r.row.id,'approved.json',{at:Date.now(),actor:'owner',plan_revision:r.row.plan_revision,record_revision:r.revision});
  r.store.write(r.row.id,'launch-intent.json',{at:Date.now(),plan_revision:r.row.plan_revision});
  const code=`import sys; sys.path.insert(0, ${JSON.stringify(path.dirname(script))}); from operation_runner import run; run(sys.argv[1], heartbeat_seconds=0.025)`;
  const child=spawn(python,['-I','-c',code,r.folder],{stdio:'ignore'});
  const exit=new Promise((resolve,reject)=>{child.once('exit',code=>code===0?resolve():reject(new Error('Fixture heartbeat process failed')));child.once('error',reject);});
  const first=await waitFor(async()=>{const x=await r.transport.observe(r.target);return x.progress?.phase==='waiting_fixture'&&x;});
  const later=await waitFor(async()=>{const x=await r.transport.observe(r.target);return x.progress?.heartbeat_at>first.progress.heartbeat_at&&x;});
  assert.equal(later.progress.changed_at,first.progress.changed_at);assert.equal(later.progress.phase,first.progress.phase);assert.equal(later.process_alive,true);
  r.release();await exit;
});

test('an observer holding the lock briefly cannot discard the approved launch',async t=>{
  const r=await rig(t),ready=path.join(r.folder,'observer-ready.fixture'),release=path.join(r.folder,'observer-release.fixture');
  const code=`import fcntl,sys,time,pathlib
folder=pathlib.Path(sys.argv[1])
with (folder/'runner.lock').open('a') as stream:
 fcntl.flock(stream,fcntl.LOCK_EX)
 (folder/'observer-ready.fixture').write_text('ready')
 while not (folder/'observer-release.fixture').exists(): time.sleep(0.01)
`;
  const observer=spawn(python,['-I','-c',code,r.folder],{stdio:'ignore'});
  const exit=new Promise((resolve,reject)=>{observer.once('exit',code=>code===0?resolve():reject(new Error('Fixture observer failed')));observer.once('error',reject);});
  try{
    await waitFor(()=>fs.existsSync(ready));await r.approve();
    await waitFor(()=>fs.existsSync(path.join(r.folder,'runner-started.json')));
    assert.equal(fs.existsSync(path.join(r.folder,'effect.txt')),false);
    fs.writeFileSync(release,'release');await exit;
    await waitFor(()=>fs.existsSync(path.join(r.folder,'effect.txt')));r.release();
    await waitFor(async()=>(await r.transport.observe(r.target)).state==='completed');
  }finally{fs.writeFileSync(release,'release');r.release();await exit;}
});
