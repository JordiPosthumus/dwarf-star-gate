import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {prepare,occupancyFeatureHash} from './prepare.mjs';
import {summarizeCoverage,auditOccupancyCoverage} from './occupancy-coverage.mjs';

const base=Date.parse('2020-01-01T00:00:00Z'),iso=ms=>new Date(ms).toISOString();
const event=(id,kind,ms=0,extra={})=>({schema:1,run_id:'run',request_id:id,event_id:`${id}-${kind}-${ms}`,
  time:iso(base+ms),node:'a',kind,...extra});
const decision=(id,ms=0,extra={})=>event(id,'decision',ms,{session:'private-session',candidates:[{node:'a',profile:'p',context_length:262144}],...extra});
const finish=(id,ms=1000,extra={})=>event(id,'finish',ms,{outcome:'complete',finish_reason:'stop',service_ms:999,...extra});
const labeled=id=>({run_id:'run',request_id:id});
const options={since:iso(base),through:iso(base+4000000)};

test('coverage accounts for labels, unsuccessful terminals and unresolved admissions without inventing failure',()=>{
  const events=[decision('ok'),event('ok','dispatch',1),finish('ok'),decision('waiting'),
    decision('working',3800000),event('working','dispatch',3800001),decision('failed'),finish('failed',1000,{outcome:'client_cancelled'}),
    decision('moved'),event('moved','dispatch',1,{node:'b'}),finish('moved',1000,{node:'b'}),
    decision('cancel'),event('cancel','queued_cancel',1),decision('unverified'),finish('unverified',1000,{finish_reason:null}),
    decision('conflict'),event('conflict','dispatch',1),event('conflict','dispatch',2),
    decision('old',-1),decision('genie',0,{traffic_class:'genie'})];
  const original=structuredClone(events),rows=[labeled('ok'),labeled('ok')];
  const r=summarizeCoverage([...events,events[0],events[2]],rows,options);
  assert.deepEqual(r.dispositions,{labeled_complete:1,complete_without_label:2,noncomplete_terminal:2,no_terminal_evidence:2,conflicting_lifecycle:1});
  assert.equal(r.cohort.admitted,8);assert.equal(r.cohort.excluded_before_cutoff,1);assert.equal(r.cohort.excluded_genie,1);
  assert.equal(r.labeled_points,2);assert.equal(r.complete_without_label_reasons.worker_changed,1);
  assert.equal(r.complete_without_label_reasons.unsupported_finish_reason,1);
  assert.equal(r.noncomplete_terminal_reasons.queued_cancel,1);assert.equal(r.noncomplete_terminal_reasons.client_cancelled,1);
  assert.equal(r.no_terminal_evidence.dispatch_recorded,1);assert.equal(r.no_terminal_evidence.dispatch_not_observed,1);
  assert.equal(r.no_terminal_evidence.max_admission_age_s,4000);
  assert.deepEqual(r.no_terminal_evidence.admission_age,{under_5m:1,'5m_to_1h':0,'1h_plus':1});
  assert.deepEqual(events,original);assert.equal(JSON.stringify(r).includes('private-session'),false);
  assert.equal(JSON.stringify(r).includes('request_id'),false);
});

test('coverage isolates run identities and does not manufacture admission membership from conflicting decisions',()=>{
  const events=[decision('same'),finish('same'),decision('same',0,{run_id:'other'}),
    decision('ambiguous',-1),decision('ambiguous',1),finish('orphan')];
  const r=summarizeCoverage(events,[labeled('same')],options);
  assert.equal(r.cohort.admitted,2);assert.equal(r.cohort.ambiguous_admission,1);assert.equal(r.cohort.orphan_lifecycles,1);
  assert.equal(r.dispositions.labeled_complete,1);assert.equal(r.dispositions.no_terminal_evidence,1);
  assert.throws(()=>summarizeCoverage(events,[labeled('ambiguous')],options),/labels_outside/);
  assert.throws(()=>summarizeCoverage(events,[{run_id:'other',request_id:'same'}],options),/label_without/);
});

test('coverage rejects inconsistent identities and treats contradictory terminal evidence as unknown',()=>{
  assert.throws(()=>summarizeCoverage([decision('a'),{...decision('a'),node:'b'}],[],options),/conflicting_event/);
  assert.throws(()=>summarizeCoverage([decision('a',0,{request_id:'private path / token'})],[],options),/invalid_lifecycle/);
  assert.throws(()=>summarizeCoverage([decision('a',4000001)],[],options),/event_after_snapshot/);
  assert.throws(()=>summarizeCoverage([decision('a',0,{time:'invalid'})],[],options),/invalid_timestamp/);
  for(const time of ['2020-02-30T00:00:00Z','2020-01-01T00:00:00','0'])
    assert.throws(()=>summarizeCoverage([decision('a',0,{time})],[],options),/invalid_timestamp/);
  const events=[decision('a'),finish('a'),event('a','queued_cancel',2000)];
  assert.equal(summarizeCoverage(events,[],options).dispositions.conflicting_lifecycle,1);
  assert.throws(()=>summarizeCoverage(events,[labeled('a')],options),/labels_outside/);
  assert.equal(summarizeCoverage([decision('a'),event('a','dispatch',-1)],[],options).dispositions.conflicting_lifecycle,1);
});

test('unfinished ages are admission ages with exact boundaries and empty cohorts stay empty',()=>{
  const r=summarizeCoverage([decision('a',4000000-299999),decision('b',4000000-300000),decision('c',4000000-3600000)],[],options);
  assert.deepEqual(r.no_terminal_evidence.admission_age,{under_5m:1,'5m_to_1h':1,'1h_plus':1});
  const empty=summarizeCoverage([decision('old',-1)],[],options);
  assert.equal(empty.cohort.admitted,0);assert.equal(empty.no_terminal_evidence.max_admission_age_s,null);
  assert.ok(Object.values(empty.dispositions).every(v=>v===0));
});

test('every pre-dispatch terminal is counted and unrecognized outcome text stays private',()=>{
  const events=['queued_cancel','queue_timeout','unavailable_before_dispatch'].flatMap((kind,i)=>[decision(`t${i}`),event(`t${i}`,kind,1)]);
  events.push(decision('unknown'),finish('unknown',1000,{outcome:'private backend error / secret'}));
  const r=summarizeCoverage(events,[],options);
  assert.equal(r.dispositions.noncomplete_terminal,4);assert.equal(r.dispositions.no_terminal_evidence,0);
  assert.equal(r.noncomplete_terminal_reasons.other,1);
  for(const kind of ['queued_cancel','queue_timeout','unavailable_before_dispatch'])assert.equal(r.noncomplete_terminal_reasons[kind],1);
  assert.equal(JSON.stringify(r).includes('private backend'),false);
});

function snapshot(t,schema='dsg-occupancy-v1'){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dsg-coverage-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const data=path.join(root,'source');fs.mkdirSync(data);
  const raw=[decision('done'),event('done','dispatch',1),finish('done'),decision('waiting'),
    decision('moved'),event('moved','dispatch',1,{node:'b'}),finish('moved',1000,{node:'b'}),
    decision('cancel'),event('cancel','queued_cancel',1)].map(e=>JSON.stringify(e)+'\n').join('')+'{"partial":';
  const name='routing-2020-01-01.jsonl';fs.writeFileSync(path.join(data,name),raw);
  const profiles=path.join(root,'inventory.json');fs.writeFileSync(profiles,JSON.stringify({schema:1,workers:{a:{matching_profiles:['p']}}}));
  const output=path.join(root,'prepared');prepare(data,profiles,output,schema,{cohortSince:iso(base)});
  return {root,output,raw,name,file:path.join(output,'prepared.json')};
}

test('snapshot audit reuses hash-bound source bytes and exact V1/V2 labels without modifying artifacts',t=>{
  for(const schema of ['dsg-occupancy-v1','dsg-occupancy-v2']){
    const s=snapshot(t,schema),before=fs.readFileSync(s.file),oldHash=occupancyFeatureHash(schema);
    const report=auditOccupancyCoverage(s.file);
    assert.equal(report.authority,'none');assert.equal(report.routing_enabled,false);
    assert.equal(report.prepared_sha256,createHash('sha256').update(before).digest('hex'));
    assert.equal(report.cohort.admitted,4);assert.equal(report.dispositions.labeled_complete,1);
    assert.equal(report.dispositions.complete_without_label,1);assert.equal(report.dispositions.noncomplete_terminal,1);
    assert.equal(report.dispositions.no_terminal_evidence,1);assert.equal(report.source.unterminated_tail_files,1);
    assert.equal(report.source.routing_bytes,Buffer.byteLength(s.raw));
    assert.deepEqual(fs.readFileSync(s.file),before);assert.equal(occupancyFeatureHash(schema),oldHash);
    assert.equal(fs.readFileSync(path.join(s.output,'snapshots',s.name),'utf8'),s.raw);
    for(const privateText of [s.root,'private-session','request_id','event_id'])assert.equal(JSON.stringify(report).includes(privateText),false);
  }
});

test('snapshot audit refuses tampered labels, builder identity, inventory or raw evidence',t=>{
  const s=snapshot(t),original=JSON.parse(fs.readFileSync(s.file));
  for(const change of [d=>d.rows[0].target_s++,d=>d.snapshot.feature_builder_sha256='0'.repeat(64),d=>d.feature_schema='wrong']){
    const changed=structuredClone(original);change(changed);fs.writeFileSync(s.file,JSON.stringify(changed));
    assert.throws(()=>auditOccupancyCoverage(s.file),/changed/);
  }
  fs.writeFileSync(s.file,JSON.stringify(original));
  const raw=path.join(s.output,'snapshots',s.name);fs.appendFileSync(raw,' ');
  assert.throws(()=>auditOccupancyCoverage(s.file),/hash_mismatch/);fs.writeFileSync(raw,s.raw);
  fs.appendFileSync(path.join(s.output,'snapshots','worker-inventory.json'),' ');
  assert.throws(()=>auditOccupancyCoverage(s.file),/hash_mismatch/);
});

test('manifest paths, symlink inputs and malformed complete lines cannot escape snapshot verification',t=>{
  const s=snapshot(t),original=JSON.parse(fs.readFileSync(s.file));
  const changed=structuredClone(original);changed.snapshot.hashes['../outside']='0'.repeat(64);
  fs.writeFileSync(s.file,JSON.stringify(changed));assert.throws(()=>auditOccupancyCoverage(s.file),/invalid_snapshot_manifest/);
  fs.writeFileSync(s.file,JSON.stringify(original));
  const alias=path.join(s.root,'alias.json');fs.symlinkSync(s.file,alias);assert.throws(()=>auditOccupancyCoverage(alias));
  const raw=path.join(s.output,'snapshots',s.name);fs.unlinkSync(raw);fs.symlinkSync(path.join(s.root,'source',s.name),raw);
  assert.throws(()=>auditOccupancyCoverage(s.file));fs.unlinkSync(raw);
  fs.writeFileSync(raw,'not-json\n');original.snapshot.hashes[s.name]=createHash('sha256').update('not-json\n').digest('hex');
  fs.writeFileSync(s.file,JSON.stringify(original));assert.throws(()=>auditOccupancyCoverage(s.file),SyntaxError);
});

test('coverage CLI rejects unexpected options without echoing private paths or input',()=>{
  const cli=new URL('./occupancy-coverage.mjs',import.meta.url).pathname;
  for(const args of [[],['--prepared','/private/nonexistent-secret'],['--prepared','/private/token','--extra','secret']]){
    const r=spawnSync(process.execPath,[cli,...args],{encoding:'utf8'});
    assert.equal(r.status,1);assert.match(r.stderr,/Coverage audit rejected:/);
    assert.equal(r.stderr.includes('/private/'),false);assert.equal(r.stderr.includes('secret'),false);
  }
});

test('explicit audit budgets reject oversized input instead of silently shortening coverage',t=>{
  assert.throws(()=>summarizeCoverage(Array(200001),[],options),/event_budget/);
  assert.throws(()=>summarizeCoverage(Array.from({length:20001},(_,i)=>decision(`r${i}`)),[],options),/request_budget/);
  const s=snapshot(t),large=path.join(s.root,'large.json');
  const fd=fs.openSync(large,'wx');try{fs.ftruncateSync(fd,128*1024**2+1);}finally{fs.closeSync(fd);}
  assert.throws(()=>auditOccupancyCoverage(large),/input_byte_budget/);
  const inventory=path.join(s.output,'snapshots','worker-inventory.json');fs.truncateSync(inventory,1024**2+1);
  assert.throws(()=>auditOccupancyCoverage(s.file),/input_byte_budget/);
});
