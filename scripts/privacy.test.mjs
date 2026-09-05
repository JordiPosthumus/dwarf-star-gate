import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {findings} from './privacy-policy.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dsg-publication-test-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const env={...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',
    GIT_AUTHOR_NAME:'Test Operator',GIT_AUTHOR_EMAIL:'test@example.invalid',
    GIT_COMMITTER_NAME:'Test Operator',GIT_COMMITTER_EMAIL:'test@example.invalid'};
  for(const key of ['GIT_DIR','GIT_WORK_TREE','GIT_INDEX_FILE','GIT_COMMON_DIR','GIT_OBJECT_DIRECTORY','GIT_ALTERNATE_OBJECT_DIRECTORIES'])delete env[key];
  const run=(exe,args)=>spawnSync(exe,args,{cwd:dir,env,encoding:'utf8'});
  const git=(...args)=>{const r=run('git',args);assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
  git('init','-q');git('config','commit.gpgsign','false');
  const write=(file,text)=>{fs.mkdirSync(path.dirname(path.join(dir,file)),{recursive:true});fs.writeFileSync(path.join(dir,file),text);};
  for(const file of ['scripts/privacy-check.mjs','scripts/privacy-policy.mjs','scripts/privacy-identity-check.mjs','scripts/install-hooks.mjs','.githooks/pre-commit']) {
    fs.mkdirSync(path.dirname(path.join(dir,file)),{recursive:true});fs.copyFileSync(path.join(root,file),path.join(dir,file));
  }
  write('README.md','# Generic gateway guide\n');git('add','.');
  return {dir,run,git,write,check:(...args)=>run(process.execPath,['scripts/privacy-check.mjs',...args]),install:()=>run(process.execPath,['scripts/install-hooks.mjs'])};
}
test('private files and common secrets are blocked without publishing real fixture secrets',()=>{
  for(const file of ['config.production.json','.pi/settings.json','private/notes.md','.env.production','a/model.gguf','a/report.jsonl','docs/recovery-canary-2000-01-01.md'])assert.ok(findings(file,Buffer.from('x')).length,file);
  const cases=[['192','168','12','34'].join('.'),['host','.local'].join(''),['/Users','/example','/private.txt'].join(''),['test','gmail.com'].join('@'),['-----BEGIN','PRIVATE KEY-----'].join(' '),'ghp'+'_'+'x'.repeat(30)];
  for(const value of cases)assert.ok(findings('example.txt',Buffer.from(value)).length);
});
test('deployment narratives and exact operational identifiers are flagged in docs and UI copy',()=>{
  for(const text of ['# Live recovery canaries','Our live deployment uses two servers.','## First real-data smoke result','First Spark | Warm A | 0.430 s','Completed at 12:34:56 UTC.','Action '+'a'.repeat(8)+'-'+['a'.repeat(4),'a'.repeat(4),'a'.repeat(4),'a'.repeat(12)].join('-')]){
    assert.ok(findings('docs/example.md',Buffer.from(text)).length,text);
    assert.ok(findings('ui/index.html',Buffer.from(text)).length,text);
  }
});
test('extended credential, email and temporary-path checks report labels only',()=>{
  const values=[['person','company.test'].join('@'),['https://','user:password','@','example.invalid'].join(''),'AK'+'IA'+'A'.repeat(16),'xox'+'b-'+'a'.repeat(24),'ey'+'J'+'a'.repeat(12)+'.'+'b'.repeat(12)+'.'+'c'.repeat(12),['/var','/folders','/private-fixture'].join('')];
  for(const value of values) {const result=findings('fixture.txt',Buffer.from(value));assert.ok(result.length);assert.ok(!result.join(' ').includes(value));}
  for(const email of [['reader','example.invalid'].join('@'),['123+reader','users.noreply.github.com'].join('@')])assert.deepEqual(findings('fixture.txt',Buffer.from(email)),[]);
});
test('PNG hidden metadata, malformed chunks and trailing data fail closed',()=>{
  const signature=Buffer.from([137,80,78,71,13,10,26,10]);
  const chunk=(type,data=Buffer.alloc(0))=>{const b=Buffer.alloc(data.length+12);b.writeUInt32BE(data.length);b.write(type,4,4,'ascii');data.copy(b,8);return b;};
  const end=chunk('IEND');
  assert.deepEqual(findings('image.png',Buffer.concat([signature,end])),[]);
  const pixelBytes=Buffer.from(['random','compressed.test'].join('@'));
  assert.deepEqual(findings('image.png',Buffer.concat([signature,chunk('IDAT',pixelBytes),end])),[]);
  for(const type of ['tEXt','iTXt','zTXt','eXIf'])assert.ok(findings('renamed.bin',Buffer.concat([signature,chunk(type,Buffer.from('private fixture')),end])).includes('PNG private-metadata risk'));
  for(const bytes of [signature,Buffer.concat([signature,end,Buffer.from('trailing')]),Buffer.concat([signature,Buffer.from([255,255,255,255,73,68,65,84,0,0,0,0])])])assert.ok(findings('image.png',bytes).includes('unreviewable PNG structure or trailing data'));
});
test('identity guard checks effective author and committer, with explicit local public-email consent',t=>{
  const f=fixture(t),privateEmail=['operator','company.test'].join('@');
  assert.equal(f.install().status,0);
  const commit=(author,committer)=>{
    const env={...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_AUTHOR_NAME:'Test Operator',GIT_COMMITTER_NAME:'Test Operator',GIT_AUTHOR_EMAIL:author,GIT_COMMITTER_EMAIL:committer};
    for(const key of ['GIT_DIR','GIT_WORK_TREE','GIT_INDEX_FILE','GIT_COMMON_DIR','GIT_OBJECT_DIRECTORY','GIT_ALTERNATE_OBJECT_DIRECTORIES'])delete env[key];
    return spawnSync('git',['commit','-qm','Identity fixture'],{cwd:f.dir,encoding:'utf8',env});
  };
  const safe=['123+operator','users.noreply.github.com'].join('@');
  for(const pair of [[privateEmail,safe],[safe,privateEmail]]){const r=commit(...pair);assert.notEqual(r.status,0);assert.match(r.stderr,/Publication blocked:/);assert.ok(!r.stderr.includes(privateEmail));}
  f.git('config','--local','dsg.publicEmail',privateEmail);
  assert.equal(commit(privateEmail,safe).status,0);
});
test('reusable profiles, public pins and synthetic source fixtures remain publishable',()=>{
  const text='# Recommended profile\nUse --ctx 262144 --batched-session 2.\nSource: https://github.com/antirez/ds4\nSHA-256: '+'a'.repeat(64)+'\nKeep private reports outside the checkout.\n';
  assert.deepEqual(findings('docs/profile.md',Buffer.from(text)),[]);
  assert.deepEqual(findings('examples/config.json',Buffer.from('{"url":"http://127.0.0.1:38101","config":"config.local.json"}')),[]);
  assert.deepEqual(findings('example.test.mjs',Buffer.from('const fixture="Our live deployment";')),[]);
});
test('staged private content cannot be hidden by cleaning only the working copy',t=>{
  const f=fixture(t),value=['192','168','12','34'].join('.');
  f.write('new file.txt',value);f.git('add','new file.txt');f.write('new file.txt','generic');
  const r=f.check('--staged');assert.equal(r.status,1);assert.match(r.stderr,/private network address/);assert.ok(!r.stderr.includes(value));
  f.git('add','new file.txt');assert.equal(f.check('--staged').status,0);
  f.write('new file.txt',value);assert.equal(f.check('--staged').status,0);assert.equal(f.check().status,1);
});
test('staged deletion removes a private document from the checked tree',t=>{
  const f=fixture(t);f.write('docs/notes.md','Our live deployment has extra workers.');f.git('add','docs/notes.md');assert.equal(f.check('--staged').status,1);
  f.git('rm','--cached','docs/notes.md');assert.equal(f.check('--staged').status,0);
});
test('index symlinks and working-copy symlinks fail closed without reading the target',t=>{
  const f=fixture(t);f.write('untracked-private.txt','do not export');fs.symlinkSync('untracked-private.txt',path.join(f.dir,'link.txt'));f.git('add','link.txt');
  fs.unlinkSync(path.join(f.dir,'link.txt'));f.write('link.txt','now regular');
  assert.match(f.check('--staged').stderr,/unsupported file mode/);
  f.git('add','link.txt');fs.unlinkSync(path.join(f.dir,'link.txt'));fs.symlinkSync('untracked-private.txt',path.join(f.dir,'link.txt'));
  assert.match(f.check().stderr,/not a regular file/);
});
test('installed pre-commit hook allows generic commits and blocks a deployment diary',t=>{
  const f=fixture(t);assert.equal(f.install().status,0);assert.equal(f.git('config','--get','core.hooksPath'),'.githooks');
  assert.ok(fs.statSync(path.join(f.dir,'.githooks/pre-commit')).mode&0o111);f.git('add','.githooks/pre-commit');
  f.git('commit','-qm','Generic guide');const before=f.git('rev-parse','HEAD');
  f.write('docs/notes.md','# Live recovery canaries\nCompleted at 12:34:56 UTC.');f.git('add','docs/notes.md');
  const r=f.run('git',['commit','-qm','Should be rejected']);assert.notEqual(r.status,0);assert.match(r.stderr,/deployment diary heading/);assert.equal(f.git('rev-parse','HEAD'),before);
  f.write('docs/notes.md','# Recovery validation\nUse synthetic checks and keep receipts private.');f.git('add','docs/notes.md');f.git('commit','-qm','Generic procedure');
});
test('installer is idempotent and refuses to replace existing hooks or configured hook paths',t=>{
  const f=fixture(t);f.write('.git/hooks/pre-commit','#!/bin/sh\nexit 0\n');
  assert.equal(f.install().status,1);assert.equal(fs.readFileSync(path.join(f.dir,'.git/hooks/pre-commit'),'utf8'),'#!/bin/sh\nexit 0\n');
  f.git('config','--local','core.hooksPath','custom-hooks');assert.equal(f.install().status,1);assert.equal(f.git('config','--get','core.hooksPath'),'custom-hooks');
  f.git('config','--local','--unset','core.hooksPath');fs.unlinkSync(path.join(f.dir,'.git/hooks/pre-commit'));
  assert.equal(f.install().status,0);assert.equal(f.install().status,0);
});
test('scanner fails closed on invalid arguments or absent repository metadata',t=>{
  const f=fixture(t);assert.equal(f.check('--unknown').status,1);
  fs.renameSync(path.join(f.dir,'.git'),path.join(f.dir,'saved-git'));assert.equal(f.check().status,1);
});
