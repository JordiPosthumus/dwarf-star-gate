// Optional product connection for the existing approved-operation components.
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createHash,randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {ServerOperations} from './server-operations.mjs';
import {operationRunner} from './operation-runner.mjs';
import {HourglassConsole} from './hourglass-console.mjs';
import {hourglassForChat} from './hourglass-reports.mjs';

const prepareScript=fileURLToPath(new URL('./serving_prepare_cli.py',import.meta.url));
const ID=/^[a-zA-Z0-9][\w-]{0,63}$/;
const revision=value=>/^[a-f0-9]{64}$/.test(value??'')?value:null;
const recordedTime=value=>typeof value==='number'&&Number.isFinite(value)&&value>0?value:null;
function outcomeEvidence(result,qualification,trialReport){
  if(!result)return null;
  const publication=result.publication,admission=result.readmission;
  return {recorded_at:recordedTime(result.at),
    ...(result.trial?{trial:{state:['completed','stopped','error','cancelled','rejected_before_acceptance','qualification_failed'].includes(result.trial.state)?result.trial.state:'unknown',
      job_id:/^[a-f0-9]{32}$/.test(result.trial.job_id??'')?result.trial.job_id:null,
      candidate_signature_sha256:revision(result.trial.candidate_signature_sha256),
      report_state:trialReport?'available':'unavailable',
      report:trialReport?hourglassForChat({configured:true,reports:[trialReport]}).reports[0]??null:null,
      scope:'Candidate measurement followed by original restoration. This is not candidate adoption; the measured candidate has no newly approved configuration revision.'}}:{}),
    serving:['candidate','previous'].includes(result.serving)?result.serving:null,
    configuration:publication?.state==='recorded'?{
      record_revision:revision(publication.record_revision),
      previous_record_revision:revision(publication.previous_record_revision)}:null,
    qualification:qualification??null,
    readmission:admission?{state:['readmitted','left_to_operator'].includes(admission.state)?admission.state:'unknown',
      reason:['preexisting_operator_pause','pause_before_release','operator_decision_changed','other_maintenance_present'].includes(admission.reason)?admission.reason:null,
      observed_at:recordedTime(admission.observed_at)}:null,
    scope:'Saved execution evidence, not a fresh health check. Match configuration revisions to benchmark associations before attributing a measurement to this change. A successful native check is not a speed comparison or proof of current recovery enrollment.'};
}
function prepareProcess(python,input){
  return new Promise((resolve,reject)=>{
    const child=spawn(python,['-I','-B',prepareScript],{stdio:['pipe','pipe','pipe']});
    let output='',bytes=0,failed=false;
    const timer=setTimeout(()=>{failed=true;child.kill();},120000);timer.unref();
    child.stdout.setEncoding('utf8');child.stderr.resume();child.stdin.on('error',()=>{});
    child.stdout.on('data',chunk=>{bytes+=Buffer.byteLength(chunk);if(bytes>6*1024*1024){failed=true;child.kill();}else output+=chunk;});
    child.once('error',()=>{clearTimeout(timer);reject(new Error('Preparation process unavailable.'));});
    child.once('close',code=>{clearTimeout(timer);try{if(code!==0||failed)throw new Error();resolve(JSON.parse(output));}catch{reject(new Error('Preparation could not be confirmed. No serving operation was launched.'));}});
    child.stdin.end(JSON.stringify(input));
  });
}

export function operationToolView(row){
  const runner=row.runner;
  return {id:row.id,worker_id:row.worker_id,state:runner?.state??row.state,proposal_state:row.state,
    plan_revision:row.plan_revision??null,error:row.error??null,
    candidate_qualification:row.candidate_qualification??null,
    ...(runner?{process_alive:typeof runner.process_alive==='boolean'?runner.process_alive:null,progress:runner.progress?{
      phase:runner.progress.phase,detail:runner.progress.detail,changed_at:runner.progress.changed_at,heartbeat_at:runner.progress.heartbeat_at}:null,
      outcome:runner.result?.state??null,evidence:outcomeEvidence(runner.result,row.qualification,row.trial_report)}:{}),
    scope:'Saved proposal or observed operation state. Proposal is not approval; process heartbeat is not model progress. Only the owner can approve in the gateway UI.'};
}

export function createOperationService(config,{directory,isTesting=()=>false,isEnabled=()=>true,prepare=prepareProcess,runner=null,trialReview=null,readTrialReport=null}={}){
  if(config.server_operations?.enabled!==true)return null;
  if(config.ui_worker_management!==true||!config.control_socket||!config.server_records_directory||!config.genie_chat?.python)throw new Error('Serving operations need worker management, a private record library and the configured Genie interpreter.');
  const enrolled=config.server_operations.workers;
  if(!enrolled||typeof enrolled!=='object'||Array.isArray(enrolled)||!Object.keys(enrolled).length)throw new Error('Enroll serving-operation workers explicitly.');
  const targets={};
  for(const [id,value] of Object.entries(enrolled)){
    const inspection=config.genie_chat.inspection?.workers?.[id];
    if(!ID.test(id)||!inspection?.container||!Array.isArray(inspection.ssh)||!inspection.ssh.length||!value?.native_url||!value.qualification)throw new Error('Operation enrollment must reuse an existing inspected gateway worker and explicit native qualification.');
    targets[id]={worker_id:id,ssh:inspection.ssh[0],container:inspection.container,docker_socket:value.docker_socket??'/var/run/docker.sock',
      gateway_socket:config.control_socket,records_directory:config.server_records_directory,native_url:value.native_url,qualification:structuredClone(value.qualification),
      cache_capacity_policy:structuredClone(value.cache_capacity_policy??{max_loss_percent:0})};
  }
  const runtime=runner??operationRunner({python:config.genie_chat.python,directory});
  const store=new ServerOperations({directory,workers:Object.keys(targets),...runtime,
    recordRevision:async id=>{const file=path.join(config.server_records_directory,'approved',id+'.json');const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.size>2*1024*1024)throw new Error('Invalid record');return createHash('sha256').update(fs.readFileSync(fd)).digest('hex');}finally{fs.closeSync(fd);}},
    prepare:async(proposal,record_revision)=>{
      const enrollment=structuredClone(targets[proposal.worker_id]);
      if(proposal.trial===true){
        const target=config.hourglass_console?.targets?.find(t=>t.worker_id===proposal.worker_id&&t.route==='direct'&&t.maintenance?.native_url===enrollment.native_url
          &&(t.maintenance.docker_socket??'/var/run/docker.sock')===enrollment.docker_socket);
        if(!target)throw new Error('A measured trial requires this worker’s enrolled direct Hourglass target.');
        if(trialReview)enrollment.trial=await trialReview(target);
        else{
          const client=new HourglassConsole(config.hourglass_console.url);
          await client.prepare(target.model);
          enrollment.trial={...structuredClone(client.prepared),url:config.hourglass_console.url};
        }
      }
      return prepare(config.genie_chat.python,{proposal,record_revision,enrollment,directory:path.join(directory,proposal.id)});
    }});
  const reportReads=new Map();
  const collectTrialReport=async(row,result)=>{
    const cached=store.read(row.id,'trial-report.json');if(cached)return cached;
    if(reportReads.has(row.id))return reportReads.get(row.id);
    const task=(async()=>{
      const plan=store.read(row.id,'plan.json');
      if(!plan?.trial||result?.state!=='restored'||!['completed','stopped'].includes(result.trial?.state)||!/^[a-f0-9]{32}$/.test(result.trial.job_id??'')||!revision(result.trial.candidate_signature_sha256))return null;
      const report=readTrialReport?await readTrialReport(plan.trial.hourglass.url,result.trial.job_id):await new HourglassConsole(plan.trial.hourglass.url).report(result.trial.job_id);
      const value={...report,association:{worker_id:row.worker_id,route:'direct',contention:'owned-maintenance',approved_configuration_revision:null,
        source:'Recorded serving trial job and native candidate identity; original restored afterward.',
        trial:{operation_id:row.id,job_id:result.trial.job_id,candidate_signature_sha256:result.trial.candidate_signature_sha256}}};
      const safe=hourglassForChat({configured:true,reports:[value]}).reports[0];
      if(!safe?.summary?.score?.final||safe.summary.run_key!==createHash('sha256').update(result.trial.job_id).digest('hex').slice(0,24))return null;
      store.write(row.id,'trial-report.json',safe);return safe;
    })().finally(()=>reportReads.delete(row.id));reportReads.set(row.id,task);return task;
  };
  const present=async row=>{
    if(row.state==='unreadable')return row;
    let current;
    try{const result=store.read(row.id,'runner-result.json');if(['completed','restored','failed_unchanged'].includes(result?.state))current={...row,runner:{state:result.state,process_alive:null,result,scope:'Saved completed outcome. Process liveness and current server health were not rechecked.'}};}catch{/* Observe a preserved unreadable result through the existing runner. */}
    current??=await store.current(row.id);
    if(current.runner?.result?.trial){
      try{current.trial_report=await collectTrialReport(row,current.runner.result);}catch{current.trial_report=null;}
    }
    try{
      const proof=store.read(row.id,'qualified-candidate.json');
      if(proof){
        const cache=store.read(row.id,'cache-comparison-candidate.json'),acceptance=proof.cache_capacity_acceptance,native=store.read(row.id,'qualification-candidate/result.json');
        const number=v=>Number.isFinite(v)?v:null;
        current.candidate_qualification={state:['passed','failed'].includes(proof.state)?proof.state:'unknown',
          check_failure:native?.state==='failed'&&typeof native.check_failure==='string'?native.check_failure.slice(0,1000):null,
          cache_acceptance:['passed','failed'].includes(acceptance?.state)?acceptance.state:null,
          reason:['capacity_unavailable','within_reviewed_allowance','exceeds_reviewed_allowance'].includes(acceptance?.reason)?acceptance.reason:null,
          allowed_loss_percent:number(acceptance?.policy?.max_loss_percent),
          baseline_cache_tokens:number(cache?.baseline?.kv_cache_size_tokens),candidate_cache_tokens:number(cache?.current?.kv_cache_size_tokens),
          delta_percent:number(cache?.delta_percent),
          scope:'Saved candidate checks, separate from original restoration. Startup memory can affect reported cache capacity; this does not establish cause or speed.'};
      }
    }catch{current.candidate_qualification={state:'unreadable'};}
    const which=current.runner?.result?.serving;
    if(['candidate','previous'].includes(which)){
      try{
        const proof=store.read(row.id,'qualified-'+which+'.json');
        current.qualification=proof?{state:['passed','failed'].includes(proof.state)?proof.state:'unknown',
          version:which,recorded_at:recordedTime(proof.at),result_revision:revision(proof.result_sha256),
          missing_checks:Array.isArray(proof.missing_checks)?proof.missing_checks.filter(x=>typeof x==='string'&&/^[a-z][a-z0-9_]{0,63}$/.test(x)):null,
          cache_capacity_acceptance:['passed','failed','reported_only'].includes(proof.cache_capacity_acceptance?.state)?proof.cache_capacity_acceptance.state:null}: {state:'unavailable',version:which};
      }catch{current.qualification={state:'unreadable',version:which};}
    }
    return current;
  };
  const toolConfig={url:null,token:randomBytes(32).toString('base64url'),workers:Object.keys(targets)};
  return {store,toolConfig,
    trialReports:()=>({configured:true,reports:store.list().flatMap(row=>{try{const r=store.read(row.id,'trial-report.json');return r?[r]:[];}catch{return [];}})}),
    bind:port=>{toolConfig.url=`http://127.0.0.1:${port}/api/genie/operation-tools`;},
    status:async()=>({configured:true,suspended:isTesting(),operations:await Promise.all(store.list().map(present))}),
    change:async input=>{if(input.action==='approve'&&!isEnabled())throw new Error('Server changes are switched off. Existing operations continue.');if(input.action==='approve'&&isTesting())throw new Error('Server changes are paused while testing mode is active.');return store.change(input);},
    tool:async input=>{
      if(input?.action==='propose'&&['action,proposal','action,origin,proposal'].includes(Object.keys(input).sort().join(','))){
        if(!isEnabled())throw new Error('Server changes are switched off.');
        if(isTesting())throw new Error('Operation preparation is paused while testing mode is active.');
        try{return operationToolView(store.propose(input.proposal,input.origin??{}));}
        catch(error){
          // These validation errors occur before creating any proposal. Other
          // errors may follow a write and must keep their uncertain outcome.
          if(error.message==='Specify a configured worker, exact image, complete command and reason.')return {
            state:'rejected',error:'This request was not accepted. Supply id (UUID), worker_id (enrolled worker), image (sha256 plus 64 lowercase hex digits), command (complete array of strings, at most 65536 JSON bytes), and reason (1–2000 characters). Optional trial must be a boolean. This request did not start preparation or a serving operation. Check the same ID for any earlier submission before revising it.'};
          if(error.message==='Invalid originating conversation.')return {state:'rejected',error:'This request was not accepted because its originating conversation is invalid. Report the integration problem; this request did not start preparation or a serving operation. Earlier submissions must still be observed.'};
          throw error;
        }
      }
      if(input?.action==='status'&&Object.keys(input).sort().join(',')==='action,id'){
        try{return operationToolView(await present(store.status(input.id)));}
        catch(error){if(error.message==='Operation not found.')return {id:input.id,state:'not_found',scope:'No saved proposal exists for this ID in this operation store. This lookup did not submit or repeat anything.'};throw error;}
      }
      if(input?.action==='list'&&Object.keys(input).join(',')==='action')return {operations:await Promise.all(store.list().map(async row=>operationToolView(await present(row))))};
      throw new Error('This tool can only propose changes or inspect their status.');
    },
    close:()=>store.close(),
  };
}
