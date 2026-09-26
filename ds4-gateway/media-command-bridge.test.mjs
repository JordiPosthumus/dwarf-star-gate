import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFile,execFileSync} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {createMediaCommandBridge} from './media-command-bridge.mjs';
const plan={operation_id:'11111111-1111-4111-8111-111111111111',python:'/fixture/python'};
const step='media-start-1',container='a'.repeat(64);
function fixture(results){
  const calls=[],saved=[],limit=results.length+1;const bridge=createMediaCommandBridge(plan,'/fixture/operation',{wait:async()=>{assert.ok(calls.length<limit,'fixture observation limit');},save:(...args)=>saved.push(args),
    run:async(file,args)=>{calls.push({file,args});const next=results.shift();assert.ok(next,'unexpected extra bridge call');if(next instanceof Error)throw next;
      return {stdout:JSON.stringify({operation_id:plan.operation_id,step,...next})};}});
  return {bridge,calls,saved};
}
test('lost native command acknowledgement observes until the original receipt completes',async()=>{
  const f=fixture([new Error('lost'),{state:'missing'},{state:'intent',runner_active:true},{state:'intent',runner_active:false,outcome:'observed'},{state:'completed'}]);
  await f.bridge.command('start','media',1,container);
  assert.deepEqual(f.calls.map(c=>c.args[4]),['run','status','status','status','run']);
  assert.ok(f.calls.every(c=>c.file===plan.python&&c.args[5]===step&&c.args[6]===container));
});

test('actual Python bridge preserves a completed native command across lost process output and reconstruction',{timeout:15000},async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'sg-command-transport-')),folder=path.join(directory,plan.operation_id);
  fs.mkdirSync(folder,{mode:0o700});t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const python=execFileSync('python3',['-c','import sys;print(sys.executable)'],{encoding:'utf8'}).trim();
  const fixturePlan={...plan,python,command_journal_version:1,worker_id:'fixture',host:'fixture-host',llm_container:'b'.repeat(64),
    engine:{kind:'comfyui',container,image:'sha256:'+'c'.repeat(64),port:8188},control_socket:'/fixture.sock',recovery:{url:'http://127.0.0.1:1'}};
  const native={Id:container,Image:fixturePlan.engine.image,Config:{Env:['UNCHANGED=1']},HostConfig:{OomKillDisable:false},Mounts:[],State:{Running:false,StartedAt:'before',FinishedAt:'end-before'}};
  const save=(name,value)=>fs.writeFileSync(path.join(folder,name),JSON.stringify(value),{mode:0o600});
  save('plan.json',fixturePlan);save('containers-before.json',{llm:{...native,Id:fixturePlan.llm_container,State:{...native.State,Running:true}},media:native});save('native.json',native);
  const driver=path.join(directory,'driver.py');
  fs.writeFileSync(driver,`import os,sys\nfrom pathlib import Path\nsys.path.insert(0,${JSON.stringify(fileURLToPath(new URL('.',import.meta.url)))})\nimport recovery_media_bridge as b\nr=Path(sys.argv[1]);args=sys.argv[2:]\nclass Remote:\n def __init__(self,host):pass\n def machine(self):return 'd'*64\n def inspect(self,cid):return b.private_read(r/'native.json')\n def start(self,cid):\n  c=self.inspect(cid);c['State'].update(Running=True,StartedAt='after');b.private_save(r/'native.json',c)\n  with (r/'commands-count').open('a') as f:f.write('start\\n')\n def media_idle(self,*args):return True\nresult=b.prepare(r,Remote) if args==['prepare'] else b.invoke(r,*args,remote_factory=Remote,maintain=lambda *_:{'owned':True})\nif args[0]=='run' and not (r/'lost-output').exists():\n (r/'lost-output').write_text('lost');os._exit(77)\nprint(b.json.dumps(result))\n`,{mode:0o600});
  const execute=promisify(execFile),calls=[];let waits=0;
  const options={wait:async()=>{assert.ok(++waits<5,'fixture observation bound');},run:async(file,args,opts)=>{
    assert.equal(file,python);assert.ok(args[2].endsWith('recovery_media_bridge.py'));calls.push(args[4]);
    return execute(file,[...args.slice(0,2),driver,...args.slice(3)],opts);
  }};
  const bridge=createMediaCommandBridge(fixturePlan,folder,options);await bridge.prepare();
  assert.equal(JSON.parse(fs.readFileSync(path.join(folder,'native.json'))).State.Running,false);
  assert.equal((await bridge.command('start','media',0,container)).state,'completed');
  assert.deepEqual(calls,['prepare','run','status']);
  const restored=createMediaCommandBridge(fixturePlan,folder,options);await restored.command('start','media',0,container);
  assert.equal(fs.readFileSync(path.join(folder,'commands-count'),'utf8'),'start\n');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(folder,'containers-before.json'))).media,native);
});
test('a prepared journal only resumes the same request after its native runner releases the lease',async()=>{
  const f=fixture([new Error('lost'),{state:'prepared',runner_active:true},{state:'prepared',runner_active:false},{state:'completed'}]);
  await f.bridge.command('start','media',1,container);
  assert.deepEqual(f.calls.map(c=>c.args[4]),['run','status','status','run']);
});
test('an acknowledged start that exits is finalized and surfaced without another native submission',async()=>{
  const f=fixture([new Error('lost'),{state:'acknowledged',runner_active:false,outcome:'observed'},{state:'exited'}]);
  await assert.rejects(f.bridge.command('start','media',1,container),/acknowledged.*exited/);
  assert.deepEqual(f.calls.map(c=>c.args[4]),['run','status','run']);
});
test('explicit refusal before dispatch is surfaced, while mismatched receipts never prove completion',async()=>{
  const f=fixture([{state:'refused',command_issued:false}]);await assert.rejects(f.bridge.command('start','media',1,container),/refused before command dispatch/);
  const g=fixture([{state:'completed',operation_id:'wrong'},{state:'completed',step:'wrong'},{state:'completed'}]);
  await g.bridge.command('start','media',1,container);assert.deepEqual(g.calls.map(c=>c.args[4]),['run','status','status']);
});
test('preparation requires its exact operation and fixed commands reject extra targets',async()=>{
  const f=fixture([{state:'prepared'}]);await f.bridge.prepare();assert.equal(f.calls[0].args[4],'prepare');
  for(const args of [['kill','media',1,container],['start','arbitrary',1,container],['start','media',2,container],['start','media',1,'friendly-name']])
    await assert.rejects(f.bridge.command(...args));
  assert.equal(f.calls.length,1);
});
test('unverified explicit recipe fails preparation before any native lifecycle command',async()=>{
  const f=fixture([{state:'recipe_unverified',native_mutation:false}]);
  await assert.rejects(f.bridge.prepare(),/Qualify a compatible image; no LLM was drained/);
  assert.deepEqual(f.calls.map(c=>c.args[4]),['prepare']);
});
