import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {auditReplayProjection,auditProjectionFiles,projectReplayEvent,projectionArgs} from './replay-projection.mjs';
import {featureContract} from '../ds4-gateway/prediction-feature-registry.mjs';
import {replayOccupancy} from './occupancy.mjs';
import {replayDeliveryOccupancy} from './occupancy-delivery.mjs';

const schemas=['dsg-latency-v2','dsg-latency-v3','dsg-latency-v4','dsg-occupancy-v1','dsg-occupancy-v2'];
const replay=s=>s==='dsg-occupancy-v1'?replayOccupancy:s==='dsg-occupancy-v2'?replayDeliveryOccupancy:featureContract(s).replay;

test('reference packing retains strict row and metadata comparison semantics',t=>{
  const contract=featureContract('dsg-latency-v3');
  const cases=[
    [{rows:[{value:undefined}],invalid:0},{rows:[{}],invalid:0}],
    [{rows:[{value:-0}],invalid:0},{rows:[{value:0}],invalid:0}],
    [{rows:[{value:NaN}],invalid:0},{rows:[{value:null}],invalid:0}],
    [{rows:[{value:NaN,optional:undefined}],invalid:0},{rows:[{optional:undefined,value:NaN}],invalid:0}],
    [{rows:[{value:Infinity}],invalid:0},{rows:[{value:Infinity}],invalid:0}],
    [{rows:[{value:1}],optional:undefined},{rows:[{value:1}]}],
    [{rows:[],invalid:0},{rows:[{value:1}],invalid:0}],
    [{rows:[{value:1}],invalid:0},{rows:[],invalid:0}],
    [{rows:[{value:1}],invalid:0},{rows:[{value:1}],invalid:1}]
  ];
  for(const [original,candidate] of cases){
    const mocked=t.mock.method(contract,'replay',events=>events[0].dsg_projection_source_sha256?candidate:original);
    const report=auditReplayProjection([{kind:'decision'}],{}, {schema:'dsg-latency-v3'});
    assert.equal(report.parity,isDeepStrictEqual(original,candidate));
    const {rows:a,...metaA}=original,{rows:b,...metaB}=candidate;
    assert.equal(report.metadata_equal,isDeepStrictEqual(metaA,metaB));
    let changed=0;for(let i=0;i<Math.max(a.length,b.length);i++)if(!isDeepStrictEqual(a[i],b[i]))changed++;
    assert.equal(report.changed_rows,changed);
    mocked.mock.restore();
  }
});

test('unsupported reference values and nonstandard row arrays cannot certify parity',t=>{
  const contract=featureContract('dsg-latency-v3'),symbol=Symbol('fixture');
  class Nonstandard {constructor(){this.value=1;}}
  for(const rows of [Array(1),Object.assign([{value:1}],{extra:true}),Object.assign([],{[symbol]:1})]){
    const mocked=t.mock.method(contract,'replay',()=>({rows}));
    assert.throws(()=>auditReplayProjection([{kind:'decision'}],{}, {schema:'dsg-latency-v3'}),/invalid_replay_rows/);
    mocked.mock.restore();
  }
  for(const row of [new Nonstandard(),{value:1,[symbol]:2}]){
    const mocked=t.mock.method(contract,'replay',()=>({rows:[row]}));
    assert.throws(()=>auditReplayProjection([{kind:'decision'}],{}, {schema:'dsg-latency-v3'}),/reference_roundtrip_mismatch/);
    mocked.mock.restore();
  }
});
const inventory={schema:1,workers:{worker:{matching_profiles:['profile'],hardware_family:'spark',accelerator_family:'cuda',ram_gib:128}}};
function fixture(request='first',offset=0){
  const at=1700000000000+offset;
  const hardware={node:'worker',time:at,observed_at:at,memory_total_bytes:128*2**30,memory_used_bytes:64*2**30,memory_scope:'host_unified',
    accelerator_activity_pct:75,accelerator_scope:'accelerator',power_watts:45,power_scope:'gpu_only',clock_mhz:2100,clock_scope:'sm'};
  const row=(kind,ms,extra={})=>({schema:1,run_id:'run',request_id:request,event_id:request+'-'+kind,kind,node:'worker',time:new Date(at+ms).toISOString(),
    unused_audit_detail:'SYNTHETIC_UNUSED_DETAIL'.repeat(100),...extra});
  const thinking={status:'specified',fields:{reasoning_effort:'xhigh'}};
  return [row('decision',0,{session:'session',affinity:'existing',traffic_class:'unclassified',admission_wait_ms:250,
    client_metadata:{status:'ready',prompt_tokens_estimate:900,turn_index:2,compaction_count:1,reasoning_effort:'xhigh'},
    candidates:[{node:'worker',profile:'profile',context_length:262144,queued:1,active:1,assigned_sessions:2,worker_idle_ms:500,
      active_elapsed_ms:200,upstream_byte_age_ms:10,session_last_used_ms:100,session_last_finished_ms:50,intervening_requests:1,
      prior_prompt_tokens:800,prior_cached_tokens:700,observation_epoch:1,cache_residence:'resident',hardware}]}),
  row('dispatch',1),row('request_features',2,{status:'ready',available_at:at+2,latest_characters:11,recent_characters:33,visible_messages_considered:3,
    requested_thinking:thinking,request_bytes:1234,message_count:5,user_messages:2,assistant_messages:1,system_messages:1,tool_messages:1,
    text_characters:45,image_parts:1,tool_definitions:2,max_output_tokens:30000,temperature:.5,top_p:.8,request_stream:true,request_route:'/v1/chat/completions',hardware}),
  row('embedding',3,{status:'ready',available_at:at+3,dimensions:384,vectors:{latest_user:{vector:Array(384).fill(1/Math.sqrt(384))},
    recent_conversation:{vector:Array(384).fill(1/Math.sqrt(384))}},hardware}),
  row('progress',30001,{active_elapsed_ms:30000,phase:'thinking',semantic_characters:200,semantic_age_ms:10,thinking_characters:120,answer_characters:60,tool_characters:20,hardware}),
  row('finish',60001,{outcome:'complete',finish_reason:'stop',service_ms:60000,usage:{completion_tokens:100,prompt_tokens:900,cached_tokens:800},
    generation:{first_semantic_ms:2000,thinking_characters:120,answer_characters:60,tool_characters:20},requested_thinking:thinking})];
}

for(const schema of schemas)test(schema+' projection preserves complete rows, causal priors, hardware and metadata',()=>{
  const events=[...fixture(),...fixture('second',90000)],before=structuredClone(events);
  const report=auditReplayProjection(events,inventory,{schema});
  assert.equal(report.parity,true);assert.equal(report.changed_rows,0);assert.equal(report.metadata_equal,true);
  assert.equal(report.original_rows,8);assert.ok(report.saved_bytes>0);assert.equal(report.authority,'none');assert.equal(report.production_enabled,false);
  const rows=replay(schema)(events,inventory).rows;
  const later=rows.find(r=>r.request_id==='second'&&r.stage==='admission');assert.equal(later.features.history_count,1);
  assert.ok(!JSON.stringify(report).includes('SYNTHETIC_UNUSED_DETAIL'));assert.ok(!JSON.stringify(report).includes('vectors'));
  assert.deepEqual(events,before);
});

test('removed-field differences still conflict, including key-order differences and a preexisting digest field',()=>{
  for(const schema of schemas){
    const events=fixture(),copy=structuredClone(events[0]);
    assert.equal(auditReplayProjection([...events,copy],inventory,{schema}).parity,true);
    for(const variant of [{...copy,unused_audit_detail:'DIFFERENT'},Object.fromEntries(Object.entries(copy).reverse()),{...copy,dsg_projection_source_sha256:'forged'}]){
      assert.throws(()=>replay(schema)([...events,variant],inventory),/Conflicting evidence ID/);
      assert.throws(()=>replay(schema)([...events,variant].map(projectReplayEvent),inventory),/Conflicting evidence ID/);
    }
  }
});

test('ambiguous finishes, output limits, relocation, missing and late features retain existing semantics',()=>{
  const cases=[e=>e.at(-1).finish_reason='length',e=>e.at(-1).outcome='incomplete_sse',
    e=>e.push({...e.at(-1),event_id:'different-finish',unused_audit_detail:'different'}),
    e=>e.splice(1,0,{...e[1],kind:'queue_relocation',event_id:'move',node:'destination'}),
    e=>{e[2].available_at+=999999;e[3].status='unavailable';},e=>{delete e[0].session;delete e[2].max_output_tokens;}];
  for(const schema of schemas)for(const change of cases){const events=fixture();change(events);assert.equal(auditReplayProjection(events,inventory,{schema}).parity,true);}
});

test('unknown event kinds are retained in ordering/identity but their private names are not reported',()=>{
  const events=fixture();events.splice(2,0,{...events[1],event_id:'other',kind:'PRIVATE_KIND',other:'private'});
  const report=auditReplayProjection(events,inventory);assert.equal(report.parity,true);assert.equal(report.events,7);
  assert.equal(report.kinds.other.events,1);assert.ok(!JSON.stringify(report).includes('PRIVATE_KIND'));
});

test('a used-field loss would change the rows, not be hidden by row-count equality',()=>{
  const events=fixture(),projected=events.map(projectReplayEvent);delete projected[2].max_output_tokens;
  const a=replay('dsg-latency-v3')(events,inventory),b=replay('dsg-latency-v3')(projected,inventory);
  assert.equal(a.rows.length,b.rows.length);assert.notDeepEqual(a.rows,b.rows);
});

test('projection retains every tied-time event and bounds events before replay',()=>{
  const events=fixture();events[2].time=events[1].time;events[2].available_at=Date.parse(events[1].time);
  for(const order of [events,[...events].reverse()])for(const schema of schemas)assert.equal(auditReplayProjection(order,inventory,{schema}).parity,true);
  assert.throws(()=>auditReplayProjection(Array(200001),inventory),/event_budget/);
  for(const row of [null,42,[],true])assert.throws(()=>projectReplayEvent(row),/invalid_event_object/);
  const a=auditReplayProjection([],inventory),b=auditReplayProjection([],{schema:1,workers:{}});
  assert.notEqual(a.inventory_canonical_sha256,b.inventory_canonical_sha256);
});

function directory(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'dsg-projection-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const data=path.join(root,'data');fs.mkdirSync(data);const profiles=path.join(root,'inventory.json');fs.writeFileSync(profiles,JSON.stringify(inventory));return {root,data,profiles};}
test('read-only file audit hashes exact bytes and reports incomplete tails without writing artifacts',t=>{
  const {root,data,profiles}=directory(t),file=path.join(data,'routing-2026-01-01.jsonl');
  const raw=fixture().map(r=>JSON.stringify(r)+'\n').join('')+'{"partial":';fs.writeFileSync(file,raw);
  const report=auditProjectionFiles(data,profiles,{schema:'dsg-latency-v4'});
  assert.equal(report.parity,true);assert.equal(report.source.incomplete_tails,1);assert.equal(report.source.bytes,Buffer.byteLength(raw));
  assert.equal(report.events,6);assert.equal(fs.readFileSync(file,'utf8'),raw);assert.deepEqual(fs.readdirSync(root).sort(),['data','inventory.json']);
});
test('CLI refuses oversize, symlink, malformed and unknown inputs without exposing content or paths',t=>{
  const {data,profiles}=directory(t),file=path.join(data,'routing-2026-01-01.jsonl');
  const cli=fileURLToPath(new URL('./replay-projection.mjs',import.meta.url));
  const run=()=>spawnSync(process.execPath,[cli,'--data',data,'--profiles',profiles],{encoding:'utf8',timeout:5000});
  fs.writeFileSync(file,'PRIVATE_MALFORMED_PAYLOAD\n');let result=run();assert.equal(result.status,1);
  assert.ok(!result.stderr.includes('PRIVATE_MALFORMED_PAYLOAD'));assert.ok(!result.stderr.includes(data));
  fs.truncateSync(file,128*1024**2+1);result=run();assert.equal(result.status,1);assert.match(result.stderr,/input_over_budget/);
  fs.unlinkSync(file);fs.symlinkSync(profiles,file);result=run();assert.equal(result.status,1);
  fs.unlinkSync(file);fs.writeFileSync(file,fixture().map(e=>JSON.stringify(e)+'\n').join(''));
  result=run();assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).parity,true);
  for(const args of [[],['--data',data],['--data',data,'--profiles',profiles,'--data',data],['--unknown',data]])assert.throws(()=>projectionArgs(args),/invalid_arguments/);
  assert.throws(()=>auditReplayProjection([],inventory,{schema:'private-unknown'}),/unsupported_schema/);
});
