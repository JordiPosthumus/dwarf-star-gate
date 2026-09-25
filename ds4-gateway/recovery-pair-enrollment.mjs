// The core alone installs recovery authority from fixed, native capture evidence.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {mediaPair} from './media-pair.mjs';
import {machinesFor} from './fleet-machines.mjs';
import {recoveryConfig} from './recovery-transport.mjs';
import {requestCapacity} from './worker-activity.mjs';

const helper=fileURLToPath(new URL('./recovery-pair.py',import.meta.url));
const exporter=fileURLToPath(new URL('./recovery-pair-enrollment.py',import.meta.url));
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const require=(value,reason)=>{if(!value)throw Error(reason);};
const route=n=>Object.fromEntries(['id','url','backend','ssh','ssh_fallbacks','remote_port'].filter(k=>n[k]!==undefined).map(k=>[k,n[k]]));
const cleanEntry=entry=>Object.fromEntries(Object.entries(entry).filter(([k])=>k!=='telemetry_service'));
const publicRow=r=>Object.fromEntries(['action_id','capture_id','worker_id','state','created_at','finished_at','error','evidence_sha256'].filter(k=>r[k]!==undefined).map(k=>[k,r[k]]));

function rows(store){return Object.values(store.data.pair_recovery_enrollments??{});}
export function restorePairEnrollments(config,saved={},workers){
  require(saved&&typeof saved==='object'&&!Array.isArray(saved),'pair_enrollment_journal_invalid');
  for(const [id,row] of Object.entries(saved)){
    require(uuid(id)&&row?.action_id===id&&uuid(row.capture_id)&&typeof row.worker_id==='string'&&['queued','enrolled','failed'].includes(row.state),'pair_enrollment_journal_invalid');
    if(row.state!=='enrolled'||!workers.some(w=>w.id===row.worker_id))continue;
    require(row.entry?.id===row.worker_id&&row.entry.adapter==='docker-pair'&&digest(row.evidence_sha256),'pair_enrollment_journal_invalid');
    const entries=[...(config.recovery?.workers??[]).map(cleanEntry),cleanEntry(row.entry)];
    recoveryConfig({workers:entries}); // Preserve preexisting/static bindings; conflicting definitions refuse.
    config.recovery={workers:entries};
  }
}

function nativeExport({python,capture,destination,expected}){
  return new Promise((resolve,reject)=>{
    const child=execFile(python,['-I','-B',exporter,capture,destination],{timeout:120000,maxBuffer:65536},(error,stdout)=>{
      let result;try{result=JSON.parse(stdout);}catch{}
      if(error||result?.error)return reject(Error(/^pair_[a-z_]+$/.test(result?.error??'')?result.error:'pair_enrollment_inspection_unavailable'));
      resolve(result);
    });
    child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(expected));
  });
}

export function createPairEnrollment({config,store,recovery,isEnabled,materialize=nativeExport}){
  let closed=false;const running=new Map();
  const directory=path.join(path.dirname(config.state_file),'genie','recovery-pair-enrollment');
  const enabled=id=>!closed&&isEnabled()&&config.pair_recovery_setup?.workers?.[id]?.exclusive===true;
  function snapshot(id){
    const n=recovery.node(id),pair=mediaPair(config,n);
    require(enabled(id),'pair_enrollment_policy_disabled');
    require(n&&pair&&!n.removed&&!n.quarantine&&!n.recovering&&n.healthy,'pair_enrollment_requires_healthy_pair');
    require(!recovery.config(id),'pair_existing_recovery_binding_preserved');
    const reason=recovery.ownershipReason(n);require(!reason,reason??'pair_ownership_unverified');
    require(Number.isSafeInteger(n.contextLength)&&n.contextLength>0,'pair_capacity_unverified');
    const physical=machinesFor(id,config);require(physical.length===2&&new Set(physical).size===2,'pair_physical_mapping_unverified');
    const endpoint=new URL(n.url),port=n.ssh?(n.remote_port??8000):Number(endpoint.port||(endpoint.protocol==='https:'?443:80));
    return {worker:route(n),physical_machines:physical,route:pair.worker_binding,
      binding:{worker_id:id,model:pair.model,port,context_length:n.contextLength,concurrency:requestCapacity(n),
        members:pair.members.map(m=>({ssh:m.ssh,container:m.container,recipe_root:m.recipe_root??null}))}};
  }
  function save(row){store.save({...store.data,pair_recovery_enrollments:{...store.data.pair_recovery_enrollments,[row.action_id]:row}});}
  function backup(){
    if(store.filename&&fs.existsSync(store.filename)){
      const filename=store.filename+'.pair-enrollment-'+Date.now()+'-'+randomUUID()+'.bak';
      fs.copyFileSync(store.filename,filename,fs.constants.COPYFILE_EXCL);fs.chmodSync(filename,0o600);return filename;
    }
    return null;
  }
  async function execute(row){
    try{
      require(isDeepStrictEqual(snapshot(row.worker_id),row.snapshot),'pair_capture_binding_changed');
      fs.mkdirSync(directory,{recursive:true,mode:0o700});const info=fs.lstatSync(directory);
      require(info.isDirectory()&&!info.isSymbolicLink()&&info.uid===process.getuid()&&!(info.mode&0o077),'pair_enrollment_directory_unverified');
      const python=fs.realpathSync(config.genie_chat.python),destination=path.join(directory,row.capture_id);
      const result=await materialize({python,capture:path.join(path.dirname(config.state_file),'genie','recovery-pair-preparation',row.capture_id),destination,
        expected:{worker_id:row.worker_id,binding:row.snapshot.binding,route:row.snapshot.route,gateway_socket:config.control_socket}});
      require(isDeepStrictEqual(snapshot(row.worker_id),row.snapshot),'pair_capture_binding_changed');
      require(['machine','profile','evidence_sha256','epoch','pair_config_sha256'].every(k=>digest(result?.[k]))&&
        result.context_length===row.snapshot.binding.context_length&&result.concurrency===row.snapshot.binding.concurrency,'pair_enrollment_result_unverified');
      const raw={...row.snapshot.worker,adapter:'docker-pair',transport:'local',verification:'glm53_vllm',exclusive:true,
        python,helper,config:path.join(destination,'pair.json'),machine:result.machine,profile:result.profile,pair_config_sha256:result.pair_config_sha256};
      const entries=[...(config.recovery?.workers??[]).map(cleanEntry),raw];
      const checked=recoveryConfig({workers:entries}).get(row.worker_id);
      const retained=backup();
      save({...row,state:'enrolled',finished_at:new Date().toISOString(),entry:raw,evidence_sha256:result.evidence_sha256,epoch:result.epoch,backup:retained});
      // No await between durable enrollment and its in-memory installation.
      config.recovery={workers:entries};recovery.configs.set(row.worker_id,checked);
    }catch(error){
      const reason=/^[a-z_]+$/.test(error.message)?error.message:'pair_enrollment_unverified';
      save({...row,state:'failed',finished_at:new Date().toISOString(),error:reason});
    }
  }
  function launch(row){if(running.has(row.action_id))return;const task=execute(row).catch(()=>{/* Retain queued identity if persistence is unavailable. */}).finally(()=>running.delete(row.action_id));running.set(row.action_id,task);}
  function request(input){
    require(input&&Object.keys(input).sort().join(',')==='action_id,capture_id,worker_id'&&uuid(input.action_id)&&uuid(input.capture_id)&&typeof input.worker_id==='string','pair_enrollment_request_invalid');
    const previous=store.data.pair_recovery_enrollments?.[input.action_id];
    if(previous){require(previous.worker_id===input.worker_id&&previous.capture_id===input.capture_id,'pair_enrollment_action_conflict');return publicRow(previous);}
    require(!rows(store).some(r=>r.worker_id===input.worker_id&&['queued','enrolled'].includes(r.state)),'pair_enrollment_already_requested');
    const observed=snapshot(input.worker_id);backup();
    const row={...input,state:'queued',created_at:new Date().toISOString(),snapshot:observed};save(row);launch(row);return publicRow(row);
  }
  return {request,status:()=>({schema:1,operations:rows(store).map(publicRow),configured_workers:Object.keys(config.pair_recovery_setup?.workers??{}).filter(enabled),
    scope:'Enrollment pins an existing pair; native restart qualification is still required. No server settings, routing pause or restart is changed.'}),
    tick(){for(const row of rows(store)){
      const node=recovery.node(row.worker_id);
      // Startup probes and temporary ownership are not evidence of failed enrollment.
      if(row.state==='queued'&&enabled(row.worker_id)&&node?.healthy&&!node.quarantine&&!node.recovering&&!recovery.ownershipReason(node))launch(row);
    }},
    close(){closed=true;},async idle(){await Promise.all(running.values());}};
}
