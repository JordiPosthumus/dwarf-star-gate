import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {auditLaunchdRemoval,auditRemovalFiles,removalPredicate} from './launchd-removal-audit.mjs';

const identity={uid:501,label:'com.example.ds4',pid:1234,boot_uuid:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',since:'2026-09-04T10:00:00Z',until:'2026-09-04T10:01:00Z'};
const event=(patch={})=>({eventType:'logEvent',processID:1,processImagePath:'/sbin/launchd',senderImagePath:'/sbin/launchd',subsystem:'gui/501/com.example.ds4 [1234]',bootUUID:identity.boot_uuid,timestamp:'2026-09-04 07:00:10.147710-0300',eventMessage:'removing job: caller = loginwindow',...patch});
const archive=rows=>rows.map(JSON.stringify).concat(JSON.stringify({count:rows.length,finished:1})).join('\n')+'\n';

test('native removal is joined by exact subsystem identity, never a message substring',()=>{
  const source=archive([event(),event({subsystem:'gui/501/com.example.other [5678]',eventMessage:'removing job: caller = launchctl'}),event({subsystem:'',eventMessage:'  [3] => gui/501/com.example.ds4 [1234]'})]);
  const result=auditLaunchdRemoval(source,identity);
  assert.equal(result.status,'exact_removal_observed');assert.equal(result.source.complete,true);assert.equal(result.authority,'none');
  assert.deepEqual(result.observations,[{at:'2026-09-04T10:00:10.147Z',caller:'loginwindow'}]);
  assert.equal(result.native_stop_caller_observed,false);
  assert.equal(removalPredicate(identity),'processID == 1 AND processImagePath == "/sbin/launchd" AND subsystem == "gui/501/com.example.ds4 [1234]"');
  for(const privateText of ['com.example','1234','aaaaaaaa','/sbin/launchd','removing job:'])assert.ok(!JSON.stringify(result).includes(privateText));
});

test('wrong process, PID, domain, boot or window cannot become exact removal evidence',()=>{
  for(const patch of [
    {processID:42},{processID:'1'},{processImagePath:'/tmp/launchd'},{senderImagePath:'/tmp/launchd'},
    {subsystem:'gui/502/com.example.ds4 [1234]'},{subsystem:'gui/501/com.example.ds4 [12345]'},
    {subsystem:'gui/501/com.example.ds4.other [1234]'},{subsystem:'gui/501/com.example.ds4'},
    {bootUUID:'11111111-bbbb-cccc-dddd-eeeeeeeeeeee'},{bootUUID:null},
    {timestamp:'2026-09-04T09:59:59Z'},{timestamp:'2026-09-04T10:01:01Z'},
    {eventMessage:'user text removing job: caller = loginwindow'},{eventMessage:'removing job: caller = loginwindow\nPRIVATE'}
  ])assert.equal(auditLaunchdRemoval(archive([event(patch)]),identity).status,'no_exact_removal_record',JSON.stringify(patch));
  for(const timestamp of [identity.since,identity.until])assert.equal(auditLaunchdRemoval(archive([event({timestamp})]),identity).status,'exact_removal_observed');
});

test('native stop callers and conflicting records are retained without inventing a cause',()=>{
  const mixed=auditLaunchdRemoval(archive([event(),event({eventMessage:'removing job: caller = launchctl'}),event()]),identity);
  assert.equal(mixed.status,'conflicting_callers');assert.equal(mixed.native_stop_caller_observed,true);assert.equal(mixed.observations.length,2);
  const other=auditLaunchdRemoval(archive([event({eventMessage:'removing job: caller = PRIVATE_CALLER'})]),identity);
  assert.equal(other.observations[0].caller,'other');assert.ok(!JSON.stringify(other).includes('PRIVATE'));
});

test('native bootout initiation is bounded stop-request evidence, not completed removal',()=>{
  const message='bootout initiated by: launchctl[321]<-fixture-runner[300]<-fixture-ui[299]';
  const result=auditLaunchdRemoval(archive([event({eventMessage:message})]),identity);
  assert.equal(result.status,'exact_stop_request_observed');assert.equal(result.native_stop_caller_observed,true);
  assert.equal(result.authority,'none');assert.equal(result.observations[0].caller,'launchctl');
  assert.ok(!JSON.stringify(result).includes('fixture-runner'));
  for(const eventMessage of [message.replace('[321]','[1]'),message.replace('[321]','[2147483648]'),message+'\n',message+'\nextra',
    'bootout initiated by: launchctl[321]<-','bootout initiated by: launchctl[321]<-'+'x'.repeat(1025),'removing job: caller = loginwindow\n'])
    assert.equal(auditLaunchdRemoval(archive([event({eventMessage})]),identity).status,'no_exact_removal_record');
  for(const patch of [{processID:2},{senderImagePath:'/tmp/fake'},{bootUUID:null},{subsystem:'gui/501/com.example.ds4 [5678]'}, {timestamp:'2026-09-04T10:02:00Z'}])
    assert.equal(auditLaunchdRemoval(archive([event({eventMessage:message,...patch})]),identity).status,'no_exact_removal_record');
  const mixed=auditLaunchdRemoval(archive([event(),event({eventMessage:message})]),identity);
  assert.equal(mixed.status,'conflicting_callers');assert.equal(mixed.observations.length,2);
  const repeated=auditLaunchdRemoval(archive([event({eventMessage:message}),event({eventMessage:message,timestamp:'2026-09-04T10:00:20Z'})]),identity);
  assert.equal(repeated.status,'exact_stop_request_observed');assert.equal(repeated.observations.length,2);
});

test('partial, malformed or incomplete captures never expose positive evidence',()=>{
  const good=archive([event()]);
  for(const text of [good.trimEnd(),good.split('\n')[0]+'\n',good.replace('"count":1','"count":2'),good+'{}\n',good.replace('"finished":1','"finished":0'),'{broken}\n'+good,archive([event({timestamp:'not a timestamp'})])]){
    const result=auditLaunchdRemoval(text,identity);assert.equal(result.status,'source_incomplete');assert.deepEqual(result.observations,[]);assert.equal(result.native_stop_caller_observed,false);
  }
  assert.equal(auditLaunchdRemoval(archive([]),identity).status,'no_exact_removal_record');
});

test('scope and output are bounded and arbitrary query expressions are rejected',()=>{
  for(const patch of [{uid:0},{uid:'501'},{pid:1},{pid:2147483648},{label:'x" OR true'},{boot_uuid:'bad'},{since:'yesterday'},{since:'2026-02-30T10:00:00Z'},{since:'2026-09-04T24:00:00Z'},{until:'2026-09-05T10:00:00Z'},{extra:true}]){
    assert.throws(()=>auditLaunchdRemoval(archive([]),{...identity,...patch}),/Invalid private/);
    assert.throws(()=>removalPredicate({...identity,...patch}),/Invalid private/);
  }
  assert.throws(()=>auditLaunchdRemoval('x'.repeat(2*1024*1024+1),identity),/bound/);
  assert.throws(()=>auditLaunchdRemoval('\n'.repeat(10003),identity),/row bound/);
  const result=auditLaunchdRemoval(archive(Array.from({length:20},(_,i)=>event({timestamp:'2026-09-04T10:00:'+String(i).padStart(2,'0')+'Z'}))),identity);
  assert.equal(result.observations.length,16);assert.equal(result.observations_omitted,4);
});

test('file CLI is read-only, refuses symlinks/special/invalid inputs and redacts errors',t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'dsg-removal-audit-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const log=path.join(directory,'events.ndjson'),scope=path.join(directory,'identity.json');
  fs.writeFileSync(log,archive([event()]));fs.writeFileSync(scope,JSON.stringify(identity),{mode:0o600});
  const before=fs.readFileSync(log),configBefore=fs.readFileSync(scope);
  assert.equal(auditRemovalFiles(log,scope).status,'exact_removal_observed');
  const cli=spawnSync(process.execPath,['ds4-gateway/launchd-removal-audit.mjs','--log',log,'--identity',scope],{encoding:'utf8'});
  assert.equal(cli.status,0);assert.equal(JSON.parse(cli.stdout).authority,'none');assert.deepEqual(fs.readFileSync(log),before);assert.deepEqual(fs.readFileSync(scope),configBefore);
  const link=path.join(directory,'link');fs.symlinkSync(log,link);assert.throws(()=>auditRemovalFiles(link,scope));
  assert.throws(()=>auditRemovalFiles(directory,scope));fs.writeFileSync(log,Buffer.from([0xff]));assert.throws(()=>auditRemovalFiles(log,scope));
  const failed=spawnSync(process.execPath,['ds4-gateway/launchd-removal-audit.mjs','--log',link,'--identity',scope],{encoding:'utf8'});
  assert.equal(failed.status,1);assert.ok(!failed.stderr.includes(directory));assert.equal(failed.stdout,'');
});
