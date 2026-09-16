// New-host service bindings travel with the existing atomic worker registration.
// Only the fixed setup bridge builds them; Genie still supplies just a target ID.
import assert from 'node:assert/strict';
import {recoveryConfig} from './recovery-transport.mjs';
import {workerConfig} from './worker-config.mjs';

const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const checks=['context_boundary','fault_counters','model_context','prefix_cache','reasoning_eos','text','tools','vision'];
export function sparkServiceBinding(worker,input){
  assert.ok(input&&Object.keys(input).sort().join(',')==='container,media,qualification,recovery,schema'&&input.schema===1,'Invalid new-Spark service binding');
  assert.ok(worker.ssh&&digest(input.container),'Use the qualified SSH container');
  const q=input.qualification;
  assert.ok(q&&Object.keys(q).sort().join(',')==='checks_passed,native_result_sha256,recovery_restart'&&q.recovery_restart==='passed'&&digest(q.native_result_sha256)&&Array.isArray(q.checks_passed)&&checks.every(c=>q.checks_passed.includes(c)),'Native serving and recovery-restart proof required');
  const r=input.recovery;
  assert.ok(r&&Object.keys(r).sort().join(',')==='config,helper,machine,profile','Use the dedicated qualified recovery helper');
  const route=Object.fromEntries(['id','url','backend','ssh','ssh_fallbacks','remote_port'].filter(k=>worker[k]!==undefined).map(k=>[k,worker[k]]));
  const recovery=recoveryConfig({workers:[{...r,...route,adapter:'docker',verification:'qwen_vllm',exclusive:true}]}).get(worker.id);
  assert.ok(input.media&&typeof input.media==='object'&&!Array.isArray(input.media)&&Object.keys(input.media).every(k=>['video','music'].includes(k)),'Unsupported new-host media kind');
  for(const [kind,e] of Object.entries(input.media)){
    assert.ok(e&&Object.keys(e).sort().join(',')==='container,image,kind,port'&&e.kind===(kind==='video'?'comfyui':'ace-step')&&digest(e.container)&&e.container!==input.container&&/^sha256:[a-f0-9]{64}$/.test(e.image)&&Number.isSafeInteger(e.port)&&e.port>=1&&e.port<=65535,'Use exact qualified media identities and ports');
  }
  assert.equal(new Set(Object.values(input.media).map(e=>e.container)).size,Object.keys(input.media).length,'Media engines must be distinct');
  return {schema:1,worker:workerConfig(worker),recovery,inspection:{ssh:[worker.ssh,...(worker.ssh_fallbacks??[])],container:input.container},media:{engines:structuredClone(input.media)},qualification:structuredClone(q)};
}

export function serviceInputFromProof(proof,media={}){
  if(!proof.recovery)return null; // Earlier LLM-only qualifications stay usable.
  const {helper,config,machine,profile}=proof.recovery;
  return {schema:1,container:proof.container,recovery:{helper,config,machine,profile},media,
    qualification:{recovery_restart:proof.recovery_restart,checks_passed:proof.checks_passed,native_result_sha256:proof.configuration_evidence?.native_result_sha256}};
}

export function validateServiceAddition(config,binding){
  const id=binding.worker.id;
  assert.ok(!(config.recovery?.workers??[]).some(w=>w.id===id)&&!Object.hasOwn(config.media_jobs?.workers??{},id)&&!Object.hasOwn(config.genie_chat?.inspection?.workers??{},id),'Existing service bindings are preserved; reconcile this worker ID first');
  // Retain the existing one-service-per-physical-machine recovery rule.
  recoveryConfig({workers:[...(config.recovery?.workers??[]),binding.recovery]});
}

export function applyServiceAddition(config,binding){
  config.recovery??={};config.recovery.workers??=[];config.recovery.workers.push(binding.recovery);
  config.media_jobs??={enabled:false};config.media_jobs.workers??={};config.media_jobs.workers[binding.worker.id]=binding.media;
  config.genie_chat??={};config.genie_chat.inspection??={};config.genie_chat.inspection.workers??={};config.genie_chat.inspection.workers[binding.worker.id]=binding.inspection;
}

export function restoreSparkServices(config,saved,workers){
  assert.ok(saved&&typeof saved==='object'&&!Array.isArray(saved),'Invalid saved new-Spark services');
  for(const [id,row] of Object.entries(saved)){
    if(!workers.some(w=>w.id===id))continue; // Removed workers retain their evidence.
    assert.equal(row.worker.id,id,'Saved service worker mismatch');
    const {helper,config:filename,machine,profile}=row.recovery;
    const checked=sparkServiceBinding(row.worker,{schema:1,container:row.inspection.container,media:row.media.engines,qualification:row.qualification,recovery:{helper,config:filename,machine,profile}});
    validateServiceAddition(config,checked);applyServiceAddition(config,checked);
  }
}
