import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {spawn,execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {mediaEngine,mediaMemberInput} from './media-enrollment.mjs';
import {mediaPair} from './media-pair.mjs';
import {machinesFor} from './fleet-machines.mjs';
import {saveMediaReceipt} from './media-execution.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),runner=path.join(root,'ds4-gateway/media-candidate-runner.py');
const modules=['docker_profile','recovery_pair','recovery_pair_native','recovery_media_command','media_recipe_contract','media_ace_candidate'];
const sha=b=>createHash('sha256').update(b).digest('hex'),fingerprint=v=>sha(JSON.stringify(v));
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const publicRow=r=>Object.fromEntries(['operation_id','worker_id','member','phase','created_at','finished_at','candidate','reason'].filter(k=>r[k]!==undefined).map(k=>[k,r[k]]));
const readPrivate=p=>{const st=fs.lstatSync(p);assert.ok(st.isFile()&&!st.isSymbolicLink()&&(st.mode&0o077)===0&&(!process.getuid||st.uid===process.getuid())&&st.size<=4*1024*1024,'Candidate receipt is not private');return fs.readFileSync(p);};
const frozenBundle=()=>({modules:Object.fromEntries(modules.map(name=>[name,fs.readFileSync(path.join(root,'ds4-gateway',name+'.py'),'utf8')])),patch:Object.fromEntries(['apply-recipe-fields.py','verify-api-fields.py'].map(name=>[name,fs.readFileSync(path.join(root,'examples/spark-build/ace-step',name),'utf8')]))});
async function launch(folder,python){const log=fs.openSync(path.join(folder,'runner.log'),'ax',0o600);try{const child=spawn(python,['-I','-B',runner,folder,'run'],{detached:true,stdio:['ignore',log,log]});await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});child.unref();return {pid:child.pid};}finally{fs.closeSync(log);}}
const observe=(folder,python)=>new Promise((resolve,reject)=>{const child=execFile(python,['-I','-B',runner,folder,'status'],{timeout:300000,maxBuffer:1024*1024},(error,stdout)=>{if(error)return reject(Error('Candidate native observation unconfirmed; preparation was not repeated'));try{resolve(JSON.parse(stdout));}catch{reject(Error('Candidate status unreadable'));}});child.stdin.end();});
export function createMediaCandidates(config,store,{directory,workers,isEnabled,isAllowed,assertCapacity,hostAvailable=()=>true,launchRunner=launch,observeRunner=observe,bundle=frozenBundle}={}){
 const policy=config.media_jobs?.improvements;
 if(policy!==undefined)assert.ok(policy&&Object.keys(policy).every(k=>k==='enabled')&&typeof policy.enabled==='boolean','media_jobs.improvements accepts enabled boolean only');
 const enabled=()=>config.media_jobs?.improvements?.enabled===true&&isEnabled();
 const rows=()=>Object.values(store.data.media_candidates??{});
 const backup=()=>{if(fs.existsSync(store.filename))fs.copyFileSync(store.filename,`${store.filename}.media-candidate-${Date.now()}-${randomUUID()}.bak`,fs.constants.COPYFILE_EXCL);};
 const save=row=>{backup();store.save({...store.data,media_candidates:{...store.data.media_candidates,[row.operation_id]:row}});};
 const selection=(id,member)=>{
  const worker=workers().find(w=>w.id===id),pair=mediaPair(config,worker),engine=mediaEngine(config,id,'music',member),inspection=config.genie_chat?.inspection?.workers?.[id];
  assert.ok(worker&&engine&&engine.kind==='ace-step'&&/^[a-f0-9]{64}$/.test(engine.container)&&/^sha256:[a-f0-9]{64}$/.test(engine.image),'Exact enrolled ACE target required');
  assert.ok(!config.media_jobs?.pairs?.[id]||pair,'Current pair binding required');
  assert.ok(member===undefined||pair,'Explicit member needs a current pair binding');
  const selected=pair?(member??engine.member??0):undefined,host=pair?.members[selected]?.ssh??inspection?.ssh?.[0];
  assert.ok(typeof host==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.@-]*$/.test(host)&&path.isAbsolute(config.genie_chat?.python??'')&&path.isAbsolute(config.control_socket??''),'Candidate preparation needs enrolled SSH, Python and control socket');
  return {worker_id:id,...(selected!==undefined?{member:selected}:{}),engine:structuredClone(engine),host,python:config.genie_chat.python,control_socket:config.control_socket,physical_machines:machinesFor(id,config),binding:fingerprint({worker,pair,engine,inspection,python:config.genie_chat.python,socket:config.control_socket})};
 };
 function permitted(row){
  assert.ok(enabled()&&isAllowed(row.worker_id,'music'),'Media improvement policy or capabilities are off');
  const current=selection(row.worker_id,row.member);assert.equal(current.binding,row.binding,'Candidate target binding changed');
  assert.ok(config.media_jobs?.standard?.enabled===true&&config.media_jobs.standard.targets?.some(t=>t.worker_id===row.worker_id&&t.engine==='ace-step'&&(t.member??(current.member===undefined?undefined:mediaEngine(config,row.worker_id,'music')?.member??0))===current.member),'Candidate must belong to the enabled standard');
  assert.ok(hostAvailable(row.worker_id),'Another native operation owns this host');assertCapacity(row.worker_id,row.operation_id);
  return current;
 }
 const get=id=>{assert.ok(uuid(id)&&store.data.media_candidates?.[id],'Unknown candidate operation');return store.data.media_candidates[id];};
 const folder=id=>path.join(directory,id);
 const view=row=>{
  if(row.phase==='candidate_prepared')return publicRow(row);
  const attention=path.join(folder(row.operation_id),'attention.json'),native=path.join(directory,'native',row.operation_id,'candidate.json');
  let stage={};
  if(fs.existsSync(native))try{const receipt=JSON.parse(readPrivate(native));stage={recorded_stage:receipt.state,stage_at:receipt.at};}catch{return {...publicRow(row),phase:'requires_reconciliation',reason:'Native preparation receipt is unreadable; ownership retained.'};}
  if(fs.existsSync(attention))return {...publicRow(row),...stage,phase:'requires_reconciliation',reason:'Runner requires reconciliation; native preparation is not repeated.'};
  return {...publicRow(row),...stage};
 };
 async function finish(input){
  assert.deepEqual(Object.keys(input??{}),['operation_id']);const row=get(input.operation_id);
  if(row.phase==='candidate_prepared')return publicRow(row);
  const saved=JSON.parse(readPrivate(path.join(folder(row.operation_id),'result.json')));
  assert.equal(saved.state,'prepared_stopped');assert.equal(saved.operation_id,row.operation_id);
  const requestBytes=readPrivate(path.join(folder(row.operation_id),'request.json'));
  assert.equal(sha(requestBytes),row.request_file_sha256,'Captured request binding is missing or changed');assert.equal(saved.request_file_sha256,row.request_file_sha256);
  // Read-only verification may finish an already completed preparation after
  // policy withdrawal. This does not authorize any new command or promotion.
  const live=await observeRunner(folder(row.operation_id),row.python);
  assert.deepEqual(live,saved,'Candidate native preparation proof changed');
  const candidate={container:live.container,image:live.image,snapshot_image:live.snapshot_image};
  const updated={...row,phase:'candidate_prepared',candidate,finished_at:new Date().toISOString()};save(updated);return publicRow(updated);
 }
 return {
  operations:()=>rows().map(r=>({...view(r),physical_machines:r.physical_machines})),
  status:()=>({supported:true,enabled:enabled(),improvement:'ace-api-fields-v1',operations:rows().map(view),scope:'Separate stopped ACE candidate preparation only; no qualification, promotion or service restart.'}),
  finish,
  permit(input){
   assert.ok(input&&Object.keys(input).sort().join(',')==='operation_id,request_file_sha256'&&/^[a-f0-9]{64}$/.test(input.request_file_sha256),'Exact candidate request receipt required');
   const row=get(input.operation_id);assert.equal(row.phase,'candidate_preparing','This preparation no longer owns execution');permitted(row);assert.ok(!fs.existsSync(path.join(folder(row.operation_id),'attention.json')),'Candidate needs reconciliation');
   const bytes=readPrivate(path.join(folder(row.operation_id),'request.json'));assert.equal(sha(bytes),input.request_file_sha256);
   const request=JSON.parse(bytes),planBytes=readPrivate(path.join(folder(row.operation_id),'plan.json')),plan=JSON.parse(planBytes);assert.equal(sha(planBytes),row.plan_sha256,'Candidate plan changed');
   assert.equal(request.operation_id,row.operation_id);assert.equal(request.before.Id,row.engine.container);assert.equal(request.before.Image,row.engine.image);assert.equal(request.epoch.running,false);
   assert.match(request.machine,/^[a-f0-9]{64}$/);assert.deepEqual(request.source_sha256,plan.source_sha256);assert.equal(plan.binding,row.binding);
   if(row.request_file_sha256)assert.equal(row.request_file_sha256,input.request_file_sha256,'Candidate request changed');else save({...row,request_file_sha256:input.request_file_sha256});
   return {allowed:true,operation_id:row.operation_id,scope:'One current preparation-stage permit; no service lifecycle or promotion authority.'};
  },
  async start(input){
   assert.ok(input&&mediaMemberInput(input,'worker_id'),'Choose worker and optional physical member only');
   const selected=selection(input.worker_id,input.member);
   const prior=rows().find(r=>r.worker_id===selected.worker_id&&r.member===selected.member&&r.engine.container===selected.engine.container&&r.engine.image===selected.engine.image);
   if(prior){if(prior.phase!=='candidate_prepared'&&fs.existsSync(path.join(folder(prior.operation_id),'result.json')))return finish({operation_id:prior.operation_id});return view(prior);}
   const operation_id=randomUUID(),row={...selected,operation_id,phase:'candidate_preparing',created_at:new Date().toISOString()};permitted(row);
   fs.mkdirSync(directory,{recursive:true,mode:0o700});const parent=fs.lstatSync(directory);assert.ok(parent.isDirectory()&&!parent.isSymbolicLink()&&(parent.mode&0o077)===0&&(!process.getuid||parent.uid===process.getuid()),'Private candidate directory required');fs.mkdirSync(folder(operation_id),{mode:0o700});
   const frozen=bundle();saveMediaReceipt(folder(operation_id),'bundle.json',frozen);
   const plan={...row,runner_sha256:sha(fs.readFileSync(runner)),transport_sha256:sha(fs.readFileSync(path.join(root,'ds4-gateway/media_candidate_remote.py'))),bundle_sha256:sha(fs.readFileSync(path.join(folder(operation_id),'bundle.json'))),source_sha256:Object.fromEntries(Object.entries(frozen.patch).map(([k,v])=>[k,sha(v)]))};
   saveMediaReceipt(folder(operation_id),'plan.json',plan);row.plan_sha256=sha(readPrivate(path.join(folder(operation_id),'plan.json')));save(row);
   try{saveMediaReceipt(folder(operation_id),'launched.json',await launchRunner(folder(operation_id),row.python));}
   catch{saveMediaReceipt(folder(operation_id),'attention.json',{state:'launch_uncertain'});throw Error('Candidate launch unconfirmed; observe the saved operation instead of repeating it');}
   return publicRow(row);
  }
 };
}
