import test from 'node:test';
import assert from 'node:assert/strict';
import {mediaPair,pairedMediaReturn} from './media-pair.mjs';
const worker={id:'glm53f-sparks34',url:'http://127.0.0.1:1234',ssh:'host3',remote_port:8888};
const enrolled={kind:'glm53-docker-pair',model:'GLM',worker_binding:worker,members:[{ssh:'host3',container:'head'},{ssh:'host4',container:'rank'}]};
function fixture(){
 const containers=enrolled.members.map((m,i)=>({Id:(i?'b':'a').repeat(64),Image:'sha256:'+'c'.repeat(64),Config:{Env:['MAX_MODEL_LEN=400000','MAX_NUM_SEQS=2']},HostConfig:{},Mounts:[],State:{Running:true,StartedAt:'before'}}));const actions=[],receipts={};
 const pair=pairedMediaReturn(enrolled,{inspectRemote:async(host,id)=>{const c=containers[host==='host3'?0:1];assert.ok([c.Id,host==='host3'?'head':'rank'].includes(id));return structuredClone(c);},startRemote:async(host,id)=>{actions.push(['start',host,id]);containers[host==='host3'?0:1].State={Running:true,StartedAt:'after'};},stopRemote:async(host,id)=>{actions.push(['stop',host,id]);containers[host==='host3'?0:1].State.Running=false;},request:async path=>path==='/v1/models'?{data:[{id:'GLM',max_model_len:400000}]}:{choices:[{finish_reason:'stop',message:{content:'RESTORED_7319'}}]},save:(k,v)=>receipts[k]=structuredClone(v)});
 return {pair,containers,actions,receipts};
}
test('paired media enrollment rejects a retargeted worker and mismatched head',()=>{
 const config={media_jobs:{pairs:{[worker.id]:enrolled}},genie_chat:{inspection:{workers:{[worker.id]:{ssh:['host3'],container:'head'}}}}};
 assert.deepEqual(mediaPair(config,worker),enrolled);assert.equal(mediaPair(config,{...worker,url:'http://other'}),null);
 config.genie_chat.inspection.workers[worker.id].container='replacement';assert.equal(mediaPair(config,worker),null);
});
test('media stops and returns exact pair IDs in dependency order with full configuration proof',async()=>{
 const f=fixture();await f.pair.capture();await f.pair.stop('a'.repeat(64));assert.ok(f.containers.every(c=>!c.State.Running));
 await f.pair.restore('a'.repeat(64));assert.deepEqual(f.actions.map(a=>a.slice(0,2)),[['stop','host3'],['stop','host4'],['start','host4'],['start','host3']]);
 assert.equal((await f.pair.recoveryInspect()).listener,true);assert.equal((await f.pair.verify()).configuration_unchanged,true);assert.equal(f.receipts['llm-pair-before.json'].containers[1].State.StartedAt,'before');
});
test('changed rank settings prevent shutdown or return and cannot produce verified proof',async()=>{
 for(const phase of ['stop','restore','verify']){const f=fixture();await f.pair.capture();if(phase!=='stop')await f.pair.stop('a'.repeat(64));f.containers[1].Config.Env.push('LOWERED_CONTEXT=1');const n=f.actions.length;await assert.rejects(f.pair[phase]('a'.repeat(64)),/configuration changed/);assert.equal(f.actions.length,n);assert.equal(f.receipts['llm-pair-return.json'],undefined);}
});
test('partial stop returns both originals without restarting a still-running rank',async()=>{
 const f=fixture();await f.pair.capture();f.containers[0].State.Running=false;await f.pair.restore('a'.repeat(64));assert.deepEqual(f.actions.map(a=>a.slice(0,2)),[['start','host3']]);
});
test('replacement ID or different pair images fail before any shutdown',async()=>{
 const f=fixture();f.containers[1].Image='sha256:'+'d'.repeat(64);await assert.rejects(f.pair.capture(),/images differ/);assert.deepEqual(f.actions,[]);
 const g=fixture();await g.pair.capture();await assert.rejects(g.pair.stop('e'.repeat(64)),/exact captured member/);assert.deepEqual(g.actions,[]);
});


test('setup qualification failure still returns both originals before conditional readmission',async()=>{
 const {runMediaSetup}=await import('./media-setup-cycle.mjs');const f=fixture();let readmitted=false,prepared=false;
 const plan={llm_container:'a'.repeat(64),engines:['h3'],recovery:{profile:'glm53-docker-pair'},target:{ssh:'host3'}};
 await assert.rejects(runMediaSetup(plan,{pair:f.pair,save:()=>{},progress:()=>{},delay:async()=>{},hasMaintenanceIntent:()=>true,
  inspect:async()=>structuredClone(f.containers[0]),recoveryInspect:()=>f.pair.recoveryInspect(),verify:()=>f.pair.verify(),
  start:()=>assert.fail('single-member start'),stop:()=>assert.fail('single-member stop'),
  maintenance:async action=>{if(action==='finish'){assert.ok(f.containers.every(c=>c.State.Running));readmitted=true;return {state:'readmitted'};}return {owned:true};},
  prepare:async()=>{assert.ok(f.containers.every(c=>!c.State.Running));prepared=true;return {};},readPreparation:async()=>({process_running:false,state:'needs_attention',error:'fixture build failure'}),
 }),/fixture build failure/);
 assert.equal(prepared,true);assert.equal(readmitted,true);assert.ok(f.containers.every(c=>c.State.Running));
});
