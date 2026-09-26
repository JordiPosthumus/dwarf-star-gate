// Fixed native capture installs a local binding; it never starts or stops oMLX.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {recoveryConfig} from './recovery-transport.mjs';
import {requestCapacity} from './worker-activity.mjs';
import {machinesFor} from './fleet-machines.mjs';

const helper=fileURLToPath(new URL('./recovery-omlx.py',import.meta.url));
const exporter=fileURLToPath(new URL('./recovery-omlx-enrollment.py',import.meta.url));
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const require=(value,reason)=>{if(!value)throw Error(reason);};
const cleanEntry=entry=>Object.fromEntries(Object.entries(entry).filter(([k])=>k!=='telemetry_service'));
const route=n=>Object.fromEntries(['id','url','backend','ssh','ssh_fallbacks','remote_port'].filter(k=>n[k]!==undefined).map(k=>[k,n[k]]));
const publicRow=r=>Object.fromEntries(['action_id','worker_id','state','reason','created_at','finished_at','error','evidence_sha256'].filter(k=>r[k]!==undefined).map(k=>[k,r[k]]));
const rows=store=>Object.values(store.data.omlx_recovery_enrollments??{});
const waiting=new Set(['wait_for_admitted_work','shared_machine_has_admitted_work','shared_machine_recovery_in_progress','native_work_reserved','maintenance_hold_active']);

export function restoreOmlxEnrollments(config,saved={},workers){
  require(saved&&typeof saved==='object'&&!Array.isArray(saved),'omlx_enrollment_journal_invalid');
  for(const [id,row] of Object.entries(saved)){
    require(uuid(id)&&row?.action_id===id&&typeof row.worker_id==='string'&&['queued','enrolled','failed'].includes(row.state),'omlx_enrollment_journal_invalid');
    if(row.state!=='enrolled'||!workers.some(w=>w.id===row.worker_id))continue;
    require(row.entry?.id===row.worker_id&&row.entry.adapter==='omlx'&&row.entry.verification==='glm53_omlx'
      &&row.entry.start_stopped!==true&&digest(row.evidence_sha256)&&digest(row.config_sha256),'omlx_enrollment_journal_invalid');
    const entries=[...(config.recovery?.workers??[]).map(cleanEntry),cleanEntry(row.entry)];
    recoveryConfig({workers:entries});config.recovery={workers:entries};
  }
}

function nativeExport({python,destination,expected}){
  return new Promise((resolve,reject)=>{
    const child=execFile(python,['-I','-B',exporter,destination],{timeout:60000,maxBuffer:65536},(error,stdout)=>{
      let result;try{result=JSON.parse(stdout);}catch{}
      if(error||result?.error)return reject(Error(/^omlx_[a-z_]+$/.test(result?.error??'')?result.error:'omlx_enrollment_inspection_unavailable'));
      resolve(result);
    });
    child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(expected));
  });
}

export function createOmlxEnrollment({config,store,recovery,isEnabled,materialize=nativeExport}){
  let closed=false;const running=new Map();
  const directory=path.join(path.dirname(config.state_file),'genie','recovery-omlx-enrollment');
  const enabled=id=>!closed&&isEnabled()&&config.omlx_recovery_setup?.workers?.[id]?.exclusive===true;
  function snapshot(id){
    require(enabled(id),'omlx_enrollment_policy_disabled');
    const n=recovery.node(id),target=config.genie_chat?.inspection?.workers?.[id],policy=config.omlx_recovery_setup.workers[id];
    require(n&&!n.removed&&!n.quarantine&&!n.recovering&&n.healthy&&!n.drained,'omlx_enrollment_requires_healthy_worker');
    require(!recovery.config(id),'omlx_existing_recovery_binding_preserved');
    require(target?.kind==='omlx-local'&&target.url===n.url&&!n.ssh&&!n.ssh_fallbacks&&n.remote_port===undefined,'omlx_inspection_binding_unverified');
    const endpoint=new URL(n.url);
    require(endpoint.protocol==='http:'&&endpoint.hostname==='127.0.0.1'&&endpoint.port&&!endpoint.username&&!endpoint.password&&!endpoint.search&&!endpoint.hash,'omlx_endpoint_binding_unverified');
    require(Object.keys(policy).filter(k=>!['qualify_restart','start_on_demand'].includes(k)).sort().join(',')==='exclusive,launcher,profile_files'&&(policy.qualify_restart===undefined||typeof policy.qualify_restart==='boolean')&&(policy.start_on_demand===undefined||typeof policy.start_on_demand==='boolean')&&typeof policy.launcher==='string'
      &&path.isAbsolute(policy.launcher)&&!policy.launcher.includes('\0')&&Array.isArray(policy.profile_files)&&policy.profile_files.length<=32
      &&policy.profile_files.every(p=>typeof p==='string'&&path.isAbsolute(p)&&!p.includes('\0'))&&new Set(policy.profile_files).size===policy.profile_files.length,'omlx_launcher_policy_invalid');
    const reason=recovery.ownershipReason(n);require(!reason,reason??'omlx_ownership_unverified');
    const physical=machinesFor(id,config);require(physical.length===1,'omlx_physical_mapping_unverified');
    const model=n.model_aliases?.[config.model];
    require(typeof model==='string'&&model&&Number.isSafeInteger(n.contextLength)&&n.contextLength>0,'omlx_capacity_unverified');
    return {physical_machines:physical,endpoint_credential_file:n.api_key_file??null,expected:{worker_id:id,route:route(n),target:structuredClone(target),launcher:policy.launcher,
      profile_files:[...policy.profile_files],model,context_length:n.contextLength,concurrency:requestCapacity(n)}};
  }
  function save(row){store.save({...store.data,omlx_recovery_enrollments:{...store.data.omlx_recovery_enrollments,[row.action_id]:row}});}
  function backup(){
    require(store.filename&&fs.existsSync(store.filename),'omlx_metadata_backup_unavailable');
    const filename=store.filename+'.omlx-enrollment-'+Date.now()+'-'+randomUUID()+'.bak';
    fs.copyFileSync(store.filename,filename,fs.constants.COPYFILE_EXCL);fs.chmodSync(filename,0o600);return filename;
  }
  async function execute(row){
    try{
      require(isDeepStrictEqual(snapshot(row.worker_id),row.snapshot),'omlx_capture_binding_changed');
      fs.mkdirSync(directory,{recursive:true,mode:0o700});const info=fs.lstatSync(directory);
      require(info.isDirectory()&&!info.isSymbolicLink()&&info.uid===process.getuid()&&!(info.mode&0o077),'omlx_enrollment_directory_unverified');
      const python=fs.realpathSync(config.genie_chat.python),destination=path.join(directory,row.action_id);
      const result=await materialize({python,destination,expected:row.snapshot.expected});
      require(isDeepStrictEqual(snapshot(row.worker_id),row.snapshot),'omlx_capture_binding_changed');
      require(['machine','profile','evidence_sha256','config_sha256'].every(k=>digest(result?.[k]))&&/^[a-f0-9]{32}$/.test(result?.instance??'')
        &&result.context_length===row.snapshot.expected.context_length&&result.concurrency===row.snapshot.expected.concurrency,'omlx_enrollment_result_unverified');
      const raw={...row.snapshot.expected.route,adapter:'omlx',transport:'local',verification:'glm53_omlx',exclusive:true,
        python,helper,config:path.join(destination,'omlx.json'),machine:result.machine,profile:result.profile};
      const entries=[...(config.recovery?.workers??[]).map(cleanEntry),raw];
      const checked=recoveryConfig({workers:entries}).get(row.worker_id),retained=backup();
      save({...row,state:'enrolled',reason:undefined,finished_at:new Date().toISOString(),entry:raw,evidence_sha256:result.evidence_sha256,
        config_sha256:result.config_sha256,instance:result.instance,backup:retained});
      config.recovery={workers:entries};recovery.configs.set(row.worker_id,checked);
    }catch(error){
      if(closed)return;
      // Genie may resume inference on this very worker while native capture is
      // running. Keep the same read-only action pending until ownership is idle;
      // do not turn normal serving activity into a terminal setup failure.
      if(waiting.has(error.message)){save({...row,state:'queued',reason:error.message});return;}
      save({...row,state:'failed',reason:undefined,finished_at:new Date().toISOString(),error:/^[a-z_]+$/.test(error.message)?error.message:'omlx_enrollment_unverified'});
    }
  }
  function launch(row){if(running.has(row.action_id))return;const task=execute(row).catch(()=>{/* Queued identity survives a persistence failure. */}).finally(()=>running.delete(row.action_id));running.set(row.action_id,task);}
  function request(input){
    require(input&&Object.keys(input).sort().join(',')==='action_id,worker_id'&&uuid(input.action_id)&&typeof input.worker_id==='string','omlx_enrollment_request_invalid');
    const previous=store.data.omlx_recovery_enrollments?.[input.action_id];
    if(previous){require(previous.worker_id===input.worker_id,'omlx_enrollment_action_conflict');return publicRow(previous);}
    require(!rows(store).some(r=>r.worker_id===input.worker_id&&['queued','enrolled'].includes(r.state)),'omlx_enrollment_already_requested');
    const observed=snapshot(input.worker_id),retained=backup();
    const row={...input,state:'queued',created_at:new Date().toISOString(),snapshot:observed,intent_backup:retained};save(row);launch(row);return publicRow(row);
  }
  return {request,status:()=>({schema:1,operations:rows(store).map(publicRow),configured_workers:Object.keys(config.omlx_recovery_setup?.workers??{}).filter(enabled),
    scope:'Read-only native capture installs an existing local GLM/oMLX binding. No restart, stopped-start authority, routing or model setting change; native recovery qualification remains required.'}),
    tick(){for(const row of rows(store)){
      const n=recovery.node(row.worker_id);
      if(row.state==='queued'&&enabled(row.worker_id)&&n?.healthy&&!n.drained&&!n.quarantine&&!n.recovering&&!recovery.ownershipReason(n))launch(row);
    }},close(){closed=true;},async idle(){await Promise.all(running.values());}};
}
