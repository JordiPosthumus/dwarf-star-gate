import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createProjectionArtifact,verifyProjectionArtifact,artifactArgs} from './projection-artifact.mjs';
import {projectReplayEvent} from './replay-projection.mjs';
import {prepare} from './prepare.mjs';

function fixture(t){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'dsg-projection-artifact-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const data=path.join(root,'data');fs.mkdirSync(data);
  const profiles=path.join(root,'inventory.json'),output=path.join(root,'artifact');
  fs.writeFileSync(profiles,JSON.stringify({schema:1,workers:{worker:{matching_profiles:['profile']}}}));
  const at=1700000000000,row=(kind,ms,extra={})=>({schema:1,run_id:'fixture',request_id:'request',event_id:kind,kind,node:'worker',
    time:new Date(at+ms).toISOString(),unused_audit_detail:'PRIVATE_SYNTHETIC_DETAIL'.repeat(100),...extra});
  const events=[row('decision',0,{session:'session',candidates:[{node:'worker',profile:'profile'}]}),row('dispatch',1),
    row('request_features',2,{status:'ready',available_at:at+2,max_output_tokens:40000,message_count:1}),
    row('progress',30001,{active_elapsed_ms:30000,thinking_characters:20,answer_characters:10}),
    row('finish',60001,{outcome:'complete',finish_reason:'stop',service_ms:60000,usage:{prompt_tokens:100,completion_tokens:20}})];
  const file=path.join(data,'routing-2026-01-01.jsonl'),raw=events.map(e=>JSON.stringify(e)+'\n').join('');fs.writeFileSync(file,raw);
  return {root,data,profiles,output,file,raw,events,args:[data,profiles,output]};
}
test('private artifact retains every ordered event and verifies complete replay across five schemas',t=>{
  const f=fixture(t),created=createProjectionArtifact(...f.args),verified=verifyProjectionArtifact(...f.args);
  assert.equal(created.state,'created');assert.equal(verified.state,'verified');assert.equal(created.manifest_sha256,verified.manifest_sha256);
  assert.equal(verified.schemas,5);assert.equal(verified.events,f.events.length);assert.equal(verified.authority,'none');assert.equal(verified.production_enabled,false);
  const manifest=JSON.parse(fs.readFileSync(path.join(f.output,'manifest.json')));
  assert.ok(manifest.checks.every(c=>c.parity&&c.metadata_equal&&c.changed_rows===0&&c.original_rows===c.projected_rows&&c.original_rows>0));
  const events=fs.readFileSync(path.join(f.output,'events.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(events,f.events.map(projectReplayEvent));assert.ok(!JSON.stringify(events).includes('PRIVATE_SYNTHETIC_DETAIL'));
  assert.ok(created.projected_bytes<Buffer.byteLength(f.raw));assert.equal(fs.readFileSync(f.file,'utf8'),f.raw);
  assert.equal(fs.statSync(f.output).mode&0o777,0o700);
  for(const name of fs.readdirSync(f.output))assert.equal(fs.statSync(path.join(f.output,name)).mode&0o777,0o600);
  assert.ok(!JSON.stringify(manifest).includes(f.root));assert.ok(!JSON.stringify(created).includes('session'));
  assert.throws(()=>prepare(f.output,f.profiles,path.join(f.root,'not-prepared')),/No evidence files/);
  assert.equal(fs.existsSync(path.join(f.root,'not-prepared')),false);
});
test('creation refuses existing output, dangling links, partial input and conflicting identity without overwriting',t=>{
  const f=fixture(t);fs.mkdirSync(f.output);fs.writeFileSync(path.join(f.output,'keep'),'original');
  assert.throws(()=>createProjectionArtifact(...f.args),/output_exists/);assert.equal(fs.readFileSync(path.join(f.output,'keep'),'utf8'),'original');
  const link=path.join(f.root,'dangling');fs.symlinkSync(path.join(f.root,'absent'),link);
  assert.throws(()=>createProjectionArtifact(f.data,f.profiles,link),/output_exists/);
  const alternate=path.join(f.root,'new');fs.appendFileSync(f.file,'{');
  assert.throws(()=>createProjectionArtifact(f.data,f.profiles,alternate),/incomplete_source_tail/);assert.equal(fs.existsSync(alternate),false);
  fs.writeFileSync(f.file,f.raw+JSON.stringify({...f.events[0],unused_audit_detail:'different'})+'\n');
  assert.throws(()=>createProjectionArtifact(f.data,f.profiles,alternate),/Conflicting evidence ID/);assert.equal(fs.existsSync(alternate),false);
});
test('cross-file lifecycle order and duplicate events survive artifact round trips',t=>{
  const f=fixture(t),later=path.join(f.data,'routing-2026-01-02.jsonl');
  fs.writeFileSync(f.file,f.events.slice(0,2).map(e=>JSON.stringify(e)+'\n').join(''));
  const tail=[f.events[0],...f.events.slice(2)];fs.writeFileSync(later,tail.map(e=>JSON.stringify(e)+'\n').join(''));
  const made=createProjectionArtifact(...f.args);assert.equal(made.events,6);assert.equal(verifyProjectionArtifact(...f.args).state,'verified');
  const actual=fs.readFileSync(path.join(f.output,'events.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(actual,[...f.events.slice(0,2),...tail].map(projectReplayEvent));
});
test('creation refuses raw budget overflow and symlinked output parents before writing output',t=>{
  const f=fixture(t);fs.truncateSync(f.file,128*1024**2+1);
  assert.throws(()=>createProjectionArtifact(...f.args),/input_over_budget/);assert.equal(fs.existsSync(f.output),false);
  fs.writeFileSync(f.file,f.raw);const link=path.join(f.root,'parent-link');fs.symlinkSync(f.root,link);
  assert.throws(()=>createProjectionArtifact(f.data,f.profiles,path.join(link,'artifact')),/symlinked_output_parent/);
  assert.equal(fs.existsSync(f.output),false);
});
test('verification rejects payload, inventory, source, and provenance changes rather than trusting a manifest',t=>{
  const f=fixture(t);createProjectionArtifact(...f.args);
  for(const name of ['events.jsonl','inventory.json']){
    const file=path.join(f.output,name),good=fs.readFileSync(file);fs.appendFileSync(file,' ');
    assert.throws(()=>verifyProjectionArtifact(...f.args),/payload_mismatch/);fs.writeFileSync(file,good);
  }
  const file=path.join(f.output,'manifest.json'),good=fs.readFileSync(file),manifest=JSON.parse(good);
  for(const change of [m=>m.checks[0].feature_builder_sha256='0'.repeat(64),m=>m.artifact_builder_sha256='0'.repeat(64),
    m=>m.source.hashes['routing-2026-01-01.jsonl']='0'.repeat(64),m=>m.files['../../PRIVATE']='escape',m=>m.checks.pop()]){
    const altered=structuredClone(manifest);change(altered);fs.writeFileSync(file,JSON.stringify(altered));
    assert.throws(()=>verifyProjectionArtifact(...f.args),/provenance_mismatch/);
  }
  fs.writeFileSync(file,good);fs.appendFileSync(f.file,'\n');assert.throws(()=>verifyProjectionArtifact(...f.args),/provenance_mismatch/);
  fs.writeFileSync(f.file,f.raw);fs.writeFileSync(f.profiles,JSON.stringify({schema:1,workers:{}}));
  assert.throws(()=>verifyProjectionArtifact(...f.args),/provenance_mismatch/);
});
test('private verifier rejects missing manifests, unexpected files, public permissions and symlinks',t=>{
  const f=fixture(t);createProjectionArtifact(...f.args);const m=path.join(f.output,'manifest.json'),good=fs.readFileSync(m);
  fs.unlinkSync(m);assert.throws(()=>verifyProjectionArtifact(...f.args),/unexpected_artifact_files/);fs.writeFileSync(m,good,{mode:0o600});
  fs.writeFileSync(path.join(f.output,'extra'),'x');assert.throws(()=>verifyProjectionArtifact(...f.args),/unexpected_artifact_files/);fs.unlinkSync(path.join(f.output,'extra'));
  fs.chmodSync(m,0o644);assert.throws(()=>verifyProjectionArtifact(...f.args),/private_file_required/);fs.chmodSync(m,0o600);
  const e=path.join(f.output,'events.jsonl');fs.unlinkSync(e);fs.symlinkSync(f.file,e);assert.throws(()=>verifyProjectionArtifact(...f.args));
  fs.chmodSync(f.output,0o755);assert.throws(()=>verifyProjectionArtifact(...f.args),/private_directory_required/);
});
test('CLI uses fixed arguments and private failure codes, never malformed source contents or paths',t=>{
  const f=fixture(t),cli=fileURLToPath(new URL('./projection-artifact.mjs',import.meta.url));
  const run=mode=>spawnSync(process.execPath,[cli,mode,'--data',f.data,'--profiles',f.profiles,'--output',f.output],{encoding:'utf8',timeout:10000});
  let result=run('create');assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).schemas,5);
  result=run('verify');assert.equal(result.status,0,result.stderr);
  fs.writeFileSync(f.file,'PRIVATE_MALFORMED\n');result=run('verify');assert.equal(result.status,1);
  assert.ok(!result.stderr.includes(f.root));assert.ok(!result.stderr.includes('PRIVATE_MALFORMED'));
  for(const args of [[],['create'],['create','--data',f.data,'--profiles',f.profiles,'--output',f.output,'--data',f.data],
    ['verify','--data',f.data,'--profiles',f.profiles,'--unknown',f.output]])assert.throws(()=>artifactArgs(args),/invalid_arguments/);
});
