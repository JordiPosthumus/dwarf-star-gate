import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {seedGenieHome} from '../ds4-gateway/genie-identity.mjs';
const exec=promisify(execFile),setup=fileURLToPath(new URL('./setup.mjs',import.meta.url));
function temporary(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'star-gate-setup-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
test('repeat setup preserves an existing Genie and private configuration byte for byte',async t=>{
  const root=temporary(t),config=path.join(root,'config.json');
  const content=JSON.stringify({genie_chat:{source:'existing-runtime',reasoning_effort:'xhigh'},unrelated:{retention:'keep'}});fs.writeFileSync(config,content);
  const result=await exec(process.execPath,[setup,'--controls'],{env:{PATH:process.env.PATH,DWARF_GATE_CONFIG:config,HOME:root}});
  assert.match(result.stdout,/preserved/);assert.equal(fs.readFileSync(config,'utf8'),content);assert.deepEqual(fs.readdirSync(root),['config.json']);
});
test('invalid connection input does not change existing gateway settings or claim success',async t=>{
  const root=temporary(t),config=path.join(root,'config.json');const content=JSON.stringify({port:19000,state_file:'runtime/affinity.json',context_length:262144});fs.writeFileSync(config,content);
  await assert.rejects(exec(process.execPath,[setup,'--model-url','file:///invalid','--model','example'],{env:{PATH:process.env.PATH,DWARF_GATE_CONFIG:config,HOME:root}}),/HTTP\(S\)/);
  assert.equal(fs.readFileSync(config,'utf8'),content);assert.deepEqual(fs.readdirSync(root),['config.json']);
});
test('Genie seeds its own identity and preserves owner edits and a separate personal home',t=>{
  const root=temporary(t),personal=path.join(root,'personal-hermes');fs.mkdirSync(personal);fs.writeFileSync(path.join(personal,'SOUL.md'),'Personal identity');
  const before=fs.readFileSync(path.join(personal,'SOUL.md'));const home=seedGenieHome(path.join(root,'chat'));
  assert.match(fs.readFileSync(path.join(home,'SOUL.md'),'utf8'),/loving prime directive/);
  fs.writeFileSync(path.join(home,'SOUL.md'),'My edited Genie');seedGenieHome(path.join(root,'chat'));
  assert.equal(fs.readFileSync(path.join(home,'SOUL.md'),'utf8'),'My edited Genie');assert.deepEqual(fs.readFileSync(path.join(personal,'SOUL.md')),before);
});

test('malformed private JSON is reported without echoing its contents',async t=>{
  const root=temporary(t),config=path.join(root,'config.json');fs.writeFileSync(config,'{"private": PRIVATE_SENTINEL_BROKEN_JSON');
  await assert.rejects(exec(process.execPath,[setup],{env:{PATH:process.env.PATH,DWARF_GATE_CONFIG:config,HOME:root}}),e=>{assert.doesNotMatch(e.stderr,/PRIVATE_SENTINEL/);assert.match(e.stderr,/Cannot read valid/);return true;});
});

test('fresh controls-enabled setup connects chat enrollment without changing existing installations',async t=>{
 for(const controls of [false,true]){
  const root=temporary(t),filename=path.join(root,'config.json');
  await exec(process.execPath,[setup,'--gateway-only',...(controls?['--controls']:[])],{env:{PATH:process.env.PATH,DWARF_GATE_CONFIG:filename,HOME:root}});
  const config=JSON.parse(fs.readFileSync(filename));
  assert.equal(config.ui_worker_management,controls);
  if(controls)assert.deepEqual(config.spark_setup,{enabled:true,targets:{}});else assert.notEqual(config.spark_setup?.enabled,true);
 }
});
