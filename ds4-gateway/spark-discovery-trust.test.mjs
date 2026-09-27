import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {promoteDiscoveryTrust} from './spark-discovery-trust.mjs';
const execute=promisify(execFile),host='192.0.2.10';
function fixture(t){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'sg-host-key-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const home=path.join(directory,'home'),known=path.join(home,'.ssh/known_hosts'),scan=path.join(directory,'scan-known-hosts'),config=path.join(directory,'ssh-config');
  fs.mkdirSync(path.dirname(known),{recursive:true});
  const keys=[];for(let i=0;i<2;i++){const file=path.join(directory,'key'+i);execFileSync('ssh-keygen',['-q','-t','ed25519','-N','','-f',file]);keys.push(fs.readFileSync(file+'.pub','utf8').trim().split(' ').slice(0,2).join(' '));}
  const configure=(extra='')=>fs.writeFileSync(config,`Host *\n ${extra}\n HostName ${host}\n User owner\n Port 22\n UserKnownHostsFile ${known}\n StrictHostKeyChecking ask\n HashKnownHosts yes\n`);
  configure();fs.writeFileSync(scan,`${host} ${keys[0]}\n`);
  const calls=[],command=async(cmd,args,options)=>{calls.push({cmd,args});return execute(cmd,cmd==='ssh'?['-F',config,...args]:args,options);};
  const input={ssh:'owner@'+host,host,username:'owner',knownHosts:scan,directory:path.join(directory,'receipts')};
  return {directory,home,known,scan,config,keys,calls,input,configure,command,promote:()=>promoteDiscoveryTrust(input,{home,command})};
}
test('verified host trust is appended with real OpenSSH lookup/hash behavior, exact backup and idempotent reuse',async t=>{
  const f=fixture(t),before=Buffer.from('192.0.2.99 '+f.keys[1]+'\n# retained owner comment');fs.writeFileSync(f.known,before);
  const result=await f.promote();assert.equal(result.changed,true);assert.equal(result.keys,1);
  const after=fs.readFileSync(f.known);assert.ok(after.subarray(0,before.length).equals(before));
  assert.ok(after.toString().includes('|1|'));assert.ok(!after.toString().includes(host));
  assert.match(execFileSync('ssh-keygen',['-F',host,'-f',f.known],{encoding:'utf8'}),/ssh-ed25519/);
  const backup=fs.readdirSync(f.input.directory).find(n=>n.startsWith('known-hosts-before-'));assert.ok(fs.readFileSync(path.join(f.input.directory,backup)).equals(before));
  assert.equal(fs.statSync(path.join(f.input.directory,backup)).mode&0o777,0o600);
  assert.equal((await f.promote()).changed,false);assert.ok(fs.readFileSync(f.known).equals(after));
  assert.ok(f.calls.every(c=>c.cmd==='ssh-keygen'||c.args[0]==='-G'),'No network connection or SSH config mutation');
});
test('missing normal trust store is created privately and only this destination is trusted',async t=>{
  const f=fixture(t);fs.writeFileSync(f.scan,`${host},192.0.2.11 ${f.keys[0]}\n`);
  assert.equal((await f.promote()).changed,true);assert.equal(fs.statSync(f.known).mode&0o777,0o600);
  assert.throws(()=>execFileSync('ssh-keygen',['-F','192.0.2.11','-f',f.known],{stdio:'pipe'}));
});
test('a conflicting normal key, revoked record or missing scan pin never changes normal trust',async t=>{
  const f=fixture(t),before=`${host} ${f.keys[1]}\n`;fs.writeFileSync(f.known,before);
  await assert.rejects(f.promote(),/different key/);assert.equal(fs.readFileSync(f.known,'utf8'),before);
  fs.writeFileSync(f.scan,`@revoked ${host} ${f.keys[0]}\n`);await assert.rejects(f.promote(),/Unsupported/);
  fs.writeFileSync(f.scan,'');await assert.rejects(f.promote(),/no pinned/);assert.equal(fs.readFileSync(f.known,'utf8'),before);
});
test('changed SSH destination or disabled host checks and custom trust stores are preserved and refused',async t=>{
  const f=fixture(t);for(const setting of ['StrictHostKeyChecking no','HostName 192.0.2.11','Port 2222','HostKeyAlias another','UserKnownHostsFile /dev/null']){
    f.configure(setting);const before=fs.readFileSync(f.config);await assert.rejects(f.promote(),/Existing SSH configuration/);assert.ok(fs.readFileSync(f.config).equals(before));assert.equal(fs.existsSync(f.known),false);
  }
});
test('symlinked or writable normal trust is refused without replacement',async t=>{
  const f=fixture(t);fs.symlinkSync(f.scan,f.known);await assert.rejects(f.promote(),/owner-controlled/);assert.ok(fs.lstatSync(f.known).isSymbolicLink());
  fs.unlinkSync(f.known);fs.writeFileSync(f.known,'# retained\n',{mode:0o666});fs.chmodSync(f.known,0o666);
  await assert.rejects(f.promote(),/owner-controlled/);assert.equal(fs.readFileSync(f.known,'utf8'),'# retained\n');
});
test('concurrent owner edits to normal trust are preserved and stop promotion',async t=>{
  const f=fixture(t),before='# retained\n',addition='# owner edit during hashing\n';fs.writeFileSync(f.known,before);
  await assert.rejects(promoteDiscoveryTrust(f.input,{home:f.home,command:async(cmd,args,opts)=>{
    const result=await f.command(cmd,args,opts);if(args[0]==='-H')fs.appendFileSync(f.known,addition);return result;
  }}),/trust changed during enrollment/);
  assert.equal(fs.readFileSync(f.known,'utf8'),before+addition);
});
test('configured alias promotion retains alias-specific SSH settings and refuses destination drift',async t=>{
  const f=fixture(t);f.input.ssh='FixtureSpark';f.input.configuredAlias=true;
  const result=await f.promote();assert.equal(result.changed,true);
  assert.ok(f.calls.some(c=>c.cmd==='ssh'&&c.args.includes('FixtureSpark')));
  const before=fs.readFileSync(f.known);f.configure('HostName 192.0.2.11');await assert.rejects(f.promote(),/Existing SSH configuration/);assert.ok(fs.readFileSync(f.known).equals(before));
});
