import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import {retainMediaRuntime,verifyMediaRuntime,mediaRuntimeScript} from './media-runtime.mjs';
import {launchMediaRunner,saveMediaReceipt} from './media-execution.mjs';
import {createMediaCommandBridge} from './media-command-bridge.mjs';
const execute=promisify(execFile),source=fileURLToPath(new URL('.',import.meta.url));
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'sg-runtime-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
async function deploymentFixture(t){
 const root=fixture(t),installed=path.join(root,'installed'),folder=path.join(root,'operation');fs.mkdirSync(installed,{mode:0o700});fs.mkdirSync(folder,{mode:0o700});
 for(const name of fs.readdirSync(source).filter(n=>/^[a-zA-Z0-9_-]+\.(mjs|py)$/.test(n)))fs.copyFileSync(path.join(source,name),path.join(installed,name));
 fs.writeFileSync(path.join(installed,'media-backend.mjs'),'export const version="original";');
 fs.writeFileSync(path.join(installed,'serving_qualification.py'),'VERSION="original"\n');
 fs.writeFileSync(path.join(installed,'recovery_media_bridge.py'),'import sys\nfrom pathlib import Path\nsys.path.insert(0,str(Path(__file__).parent))\nfrom serving_qualification import VERSION\nprint(VERSION)\n');
 fs.writeFileSync(path.join(installed,'media-runner.mjs'),'import fs from "node:fs";import path from "node:path";import {version} from "./media-backend.mjs";fs.writeFileSync(path.join(process.argv[2],"observed.tmp"),JSON.stringify({version,pid:process.pid}),{mode:0o600});fs.renameSync(path.join(process.argv[2],"observed.tmp"),path.join(process.argv[2],"observed.json"));');
 const copy=await import(pathToFileURL(path.join(installed,'media-runtime.mjs')).href),runtime=copy.retainMediaRuntime(folder);
 const plan={operation_id:'fixture',runtime,python:'/usr/bin/python3'};saveMediaReceipt(folder,'plan.json',plan);
 return {root,installed,folder,plan,copy};
}
test('a saved runner and Python dependencies survive an installed source update',async t=>{
 const f=await deploymentFixture(t);
 fs.writeFileSync(path.join(f.installed,'media-backend.mjs'),'throw Error("new deployment must not run");');
 fs.writeFileSync(path.join(f.installed,'serving_qualification.py'),'raise RuntimeError("new deployment must not run")\n');
 fs.writeFileSync(path.join(f.installed,'media-runner.mjs'),'throw Error("new runner must not run");');
 const launched=await launchMediaRunner(f.folder),receipt=path.join(f.folder,'observed.json');
 for(let i=0;!fs.existsSync(receipt)&&i<100;i++)await delay(20);
 const actual=JSON.parse(fs.readFileSync(receipt));assert.equal(actual.version,'original');assert.equal(actual.pid,launched.pid);
 const helper=mediaRuntimeScript(f.folder,f.plan,'recovery_media_bridge.py');
 assert.equal((await execute('/usr/bin/python3',['-I','-B',helper])).stdout.trim(),'original');
 assert.equal(verifyMediaRuntime(f.folder,f.plan.runtime),path.join(f.folder,'runtime'),'Python left no mutable cache in the retained source');
 assert.throws(()=>f.copy.retainMediaRuntime(f.folder),/EEXIST/,'a restart cannot silently adopt newer code');
});
test('shipped runner dependency graphs load entirely from the retained directory',async t=>{
 const folder=fixture(t),runtime=retainMediaRuntime(folder),saved=verifyMediaRuntime(folder,runtime);
 const script=`for(const name of ['media-execution.mjs','media-command-bridge.mjs','ace-qualification.mjs','media-parallel-cycle.mjs'])await import(new URL(name,${JSON.stringify(pathToFileURL(saved+'/').href)}));`;
 await execute(process.execPath,['--input-type=module','-e',script],{cwd:folder});
 await execute('/usr/bin/python3',['-I','-B','-c',`import sys;sys.path.insert(0,${JSON.stringify(saved)});import recovery_media_bridge,media_maintenance,media_candidate_promotion`],{cwd:folder});
 verifyMediaRuntime(folder,runtime);
});
test('changed, missing, added or symlinked code is refused before runner launch',async t=>{
 for(const change of ['changed','missing','added','symlink','public']){
  const f=await deploymentFixture(t),file=path.join(f.folder,'runtime','media-backend.mjs');
  if(change==='changed'){fs.chmodSync(file,0o600);fs.writeFileSync(file,'export const version="changed";');}
  if(change==='missing')fs.unlinkSync(file);
  if(change==='added')fs.writeFileSync(path.join(f.folder,'runtime','extra.py'),'');
  if(change==='symlink'){fs.unlinkSync(file);fs.symlinkSync(path.join(f.installed,'media-backend.mjs'),file);}
  if(change==='public')fs.chmodSync(file,0o644);
  await assert.rejects(launchMediaRunner(f.folder));assert.equal(fs.existsSync(path.join(f.folder,'runner.log')),false);
  assert.equal(fs.existsSync(path.join(f.folder,'observed.json')),false);
 }
});
test('a modified manifest cannot replace the source pinned in the original plan',async t=>{
 const f=await deploymentFixture(t),manifest=path.join(f.folder,'runtime','manifest.json');fs.chmodSync(manifest,0o600);fs.writeFileSync(manifest,JSON.stringify({schema:1,files:{}}));
 assert.throws(()=>verifyMediaRuntime(f.folder,f.plan.runtime),/manifest changed/);
 assert.throws(()=>mediaRuntimeScript(f.folder,f.plan,'../escape.py'),/fixed media runtime/);
});
test('each native command resolves the retained helper and validates before invoking it',async t=>{
 const f=await deploymentFixture(t);let calls=0;
 const bridge=createMediaCommandBridge(f.plan,f.folder,{run:async(python,args)=>{calls++;assert.equal(args[2],path.join(f.folder,'runtime','recovery_media_bridge.py'));return {stdout:JSON.stringify({operation_id:'fixture',state:'prepared'})};}});
 await bridge.prepare();assert.equal(calls,1);
 const file=path.join(f.folder,'runtime','serving_qualification.py');fs.chmodSync(file,0o600);fs.writeFileSync(file,'# changed');
 await assert.rejects(bridge.prepare(),/runtime source changed/);assert.equal(calls,1);
});
