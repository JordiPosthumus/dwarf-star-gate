// Retain shipped code, never source supplied by a request or a model. A media
// operation may outlive a checkout update and must return its LLM with the same
// implementation that borrowed it. This is version retention, not a sandbox.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const source=fileURLToPath(new URL('.',import.meta.url));
// Fixed dependency closure for the runner, preparation, qualification and
// promotion reader. Keep this list with their imports; the isolated-import
// regression catches missing dependencies. No arbitrary checkout files enter.
const shipped=`ace-generation-proof.mjs ace-qualification.mjs docker_profile.py endpoint.mjs
fleet-machines.mjs job-priority.mjs media-backend.mjs media-budget.mjs media-candidate-runner.py
media-command-bridge.mjs media-cycle.mjs media-enrollment.mjs media-errors.mjs media-execution.mjs
media-generation.mjs media-input-placement.mjs media-inputs.mjs media-jobs.mjs media-pair-return.mjs
media-pair.mjs media-parallel-cycle.mjs media-progress.mjs media-results.mjs media-runner.mjs
media-runtime-launch.mjs media-runtime.mjs media-validation.mjs media_ace_candidate.py
media_candidate_promotion.py media_candidate_remote.py media_input_placement.py media_maintenance.py
media_recipe_contract.py music-input.mjs operation_maintenance.py operation_runner.py recovery-docker.py
recovery-transport.mjs recovery-verify.mjs recovery_media_bridge.py recovery_media_command.py
recovery_pair.py recovery_pair_native.py serving_qualification.py spark-media-cycle.mjs video-prompt.mjs
worker-client.mjs worker-config.mjs`.split(/\s+/).sort();
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const validName=name=>/^[a-zA-Z0-9_-]+\.(mjs|py)$/.test(name)&&!name.endsWith('_test.py')&&!name.startsWith('test_');
function privatePath(filename,directory=false){
 const st=fs.lstatSync(filename);
 assert.ok((directory?st.isDirectory():st.isFile())&&!st.isSymbolicLink()&&(st.mode&0o077)===0&&(!process.getuid||st.uid===process.getuid()),'Media runtime must be private and owned');
 return st;
}
function read(filename){
 const st=privatePath(filename);assert.ok(st.size<=8*1024*1024,'Media runtime file too large');
 const fd=fs.openSync(filename,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 try{const before=fs.fstatSync(fd);assert.equal(before.ino,st.ino);assert.equal(before.dev,st.dev);const bytes=fs.readFileSync(fd),after=fs.fstatSync(fd);assert.equal(after.size,before.size);assert.equal(after.mtimeMs,before.mtimeMs);assert.equal(after.ctimeMs,before.ctimeMs);return bytes;}finally{fs.closeSync(fd);}
}
function write(filename,bytes){const fd=fs.openSync(filename,'wx',0o400);try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
function sync(directory){const fd=fs.openSync(directory,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}

export function retainMediaRuntime(folder){
 privatePath(folder,true);
 const directory=path.join(folder,'runtime');fs.mkdirSync(directory,{mode:0o700}); // Never recapture an existing operation.
 const names=shipped;
 const files={};
 for(const name of names){
  const filename=path.join(source,name),st=fs.lstatSync(filename);assert.ok(st.isFile()&&!st.isSymbolicLink(),'Shipped runtime source must be a regular file');
  const bytes=fs.readFileSync(filename);assert.ok(bytes.length<=8*1024*1024);files[name]=sha(bytes);write(path.join(directory,name),bytes);
 }
 // Detect a concurrent source deployment while this snapshot was being made.
 for(const name of names)assert.equal(sha(fs.readFileSync(path.join(source,name))),files[name],'Shipped runtime changed during capture');
 const manifest=Buffer.from(JSON.stringify({schema:1,files})+'\n');write(path.join(directory,'manifest.json'),manifest);sync(directory);sync(folder);
 return {schema:1,manifest_sha256:sha(manifest)};
}

export function verifyMediaRuntime(folder,pin){
 assert.ok(pin?.schema===1&&Object.keys(pin).sort().join(',')==='manifest_sha256,schema'&&/^[a-f0-9]{64}$/.test(pin.manifest_sha256),'Saved media runtime binding required');
 privatePath(folder,true);const directory=path.join(folder,'runtime');privatePath(directory,true);
 const bytes=read(path.join(directory,'manifest.json'));assert.equal(sha(bytes),pin.manifest_sha256,'Saved media runtime manifest changed');
 const manifest=JSON.parse(bytes);assert.ok(manifest.schema===1&&manifest.files&&typeof manifest.files==='object'&&!Array.isArray(manifest.files),'Invalid media runtime manifest');
 const names=Object.keys(manifest.files).sort();assert.ok(names.length>0&&names.length<=1000&&names.every(validName),'Invalid media runtime file list');
 assert.deepEqual(fs.readdirSync(directory).sort(),[...names,'manifest.json'].sort(),'Saved media runtime file set changed');
 for(const name of names){assert.match(manifest.files[name],/^[a-f0-9]{64}$/);assert.equal(sha(read(path.join(directory,name))),manifest.files[name],'Saved media runtime source changed: '+name);}
 return directory;
}

export function mediaRuntimeScript(folder,plan,name){
 assert.ok(validName(name),'Invalid fixed media runtime script');
 const directory=verifyMediaRuntime(folder,plan.runtime);
 const filename=path.join(directory,name);privatePath(filename);return filename;
}
