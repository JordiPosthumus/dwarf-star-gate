// Optional product connection for the existing approved-operation components.
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createHash,randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {ServerOperations} from './server-operations.mjs';
import {operationRunner} from './operation-runner.mjs';

const prepareScript=fileURLToPath(new URL('./serving_prepare_cli.py',import.meta.url));
const ID=/^[a-zA-Z0-9][\w-]{0,63}$/;
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
    ...(runner?{process_alive:typeof runner.process_alive==='boolean'?runner.process_alive:null,progress:runner.progress?{
      phase:runner.progress.phase,detail:runner.progress.detail,changed_at:runner.progress.changed_at,heartbeat_at:runner.progress.heartbeat_at}:null,
      outcome:runner.result?.state??null}:{}),
    scope:'Saved proposal or observed operation state. Proposal is not approval; process heartbeat is not model progress. Only the owner can approve in the gateway UI.'};
}

export function createOperationService(config,{directory,isTesting=()=>false,isEnabled=()=>true,prepare=prepareProcess,runner=null}={}){
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
    prepare:async(proposal,record_revision)=>prepare(config.genie_chat.python,{proposal,record_revision,enrollment:targets[proposal.worker_id],directory:path.join(directory,proposal.id)})});
  const present=async row=>{
    if(row.state==='unreadable')return row;
    try{const result=store.read(row.id,'runner-result.json');if(['completed','restored','failed_unchanged'].includes(result?.state))return {...row,runner:{state:result.state,process_alive:null,result,scope:'Saved completed outcome. Process liveness and current server health were not rechecked.'}};}catch{/* Observe a preserved unreadable result through the existing runner. */}
    return store.current(row.id);
  };
  const toolConfig={url:null,token:randomBytes(32).toString('base64url'),workers:Object.keys(targets)};
  return {store,toolConfig,
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
            state:'rejected',error:'This request was not accepted. Supply exactly id (UUID), worker_id (enrolled worker), image (sha256 plus 64 lowercase hex digits), command (complete array of strings, at most 65536 JSON bytes), and reason (1–2000 characters). This request did not start preparation or a serving operation. Check the same ID for any earlier submission before revising it.'};
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
