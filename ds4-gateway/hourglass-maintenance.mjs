// Optional owned measurement windows, using the existing approval/runner store.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {ServerOperations} from './server-operations.mjs';
import {operationRunner} from './operation-runner.mjs';

const script=fileURLToPath(new URL('./hourglass_prepare_cli.py',import.meta.url));
function prepareProcess(python,input){
  return new Promise((resolve,reject)=>{
    const child=spawn(python,['-I','-B',script],{stdio:['pipe','pipe','pipe']});
    let output='',bytes=0,failed=false;
    // This bounds GET-only preparation, never an approved benchmark runner.
    const timer=setTimeout(()=>{failed=true;child.kill();},120000);timer.unref();
    child.stdout.setEncoding('utf8');child.stderr.resume();child.stdin.on('error',()=>{});
    child.stdout.on('data',chunk=>{bytes+=Buffer.byteLength(chunk);if(bytes>6*1024*1024){failed=true;child.kill();}else output+=chunk;});
    child.once('error',()=>{clearTimeout(timer);reject(new Error('Measurement preparation unavailable.'));});
    child.once('close',code=>{clearTimeout(timer);try{if(code!==0||failed)throw new Error();resolve(JSON.parse(output));}catch{reject(new Error('Measurement preparation could not be confirmed. No benchmark was started.'));}});
    child.stdin.end(JSON.stringify(input));
  });
}

export function createHourglassMaintenance(config,directory,{prepare=prepareProcess,runner}={}){
  const targets=config.hourglass_console?.targets?.filter(t=>t.maintenance);
  if(!targets?.length)return null;
  if(config.ui_worker_management!==true||!config.control_socket||!config.server_records_directory||!config.genie_chat?.python)throw new Error('Owned measurements need worker management, private records and the configured Genie interpreter.');
  const enrolled=new Map();
  for(const target of targets){
    const inspection=config.genie_chat.inspection?.workers?.[target.worker_id],m=target.maintenance;
    if(target.route!=='direct'||!inspection?.container||!inspection.ssh?.[0]||!m||typeof m.native_url!=='string'||Object.keys(m).some(k=>!['native_url','docker_socket'].includes(k)))throw new Error('Enroll an inspected Docker/vLLM worker and native URL for a direct measurement.');
    enrolled.set(target.model,{worker_id:target.worker_id,ssh:inspection.ssh[0],container:inspection.container,
      native_url:m.native_url,docker_socket:m.docker_socket??'/var/run/docker.sock',gateway_socket:config.control_socket,
      records_directory:config.server_records_directory});
  }
  const snapshots=new Map(),runtime=runner??operationRunner({python:config.genie_chat.python,directory});
  const recordRevision=async worker=>{
    const fd=fs.openSync(path.join(config.server_records_directory,'approved',worker+'.json'),fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
    try{const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.size>2*1024*1024)throw new Error('Invalid approved record');return createHash('sha256').update(fs.readFileSync(fd)).digest('hex');}finally{fs.closeSync(fd);}
  };
  const store=new ServerOperations({directory,workers:[...new Set(targets.map(t=>t.worker_id))],proposalKind:'hourglass',...runtime,recordRevision,
    prepare:async(proposal,record_revision)=>{
      const prepared=snapshots.get(proposal.id),target=enrolled.get(proposal.model);
      if(!prepared||!target||proposal.worker_id!==target.worker_id)throw new Error('Native review unavailable');
      return prepare(config.genie_chat.python,{proposal:{id:proposal.id,worker_id:proposal.worker_id},prepared,record_revision,
        enrollment:{...target,hourglass:{url:config.hourglass_console.url,model:proposal.model,endpoint:prepared.review.endpoint}},directory:store.folder(proposal.id)});
    }});
  return {store,
    prepare:async(target,prepared)=>{
      if(!prepared||prepared.review.model!==target.model||!enrolled.has(target.model))throw new Error('Use the saved native review for this enrolled target.');
      const id=prepared.review.id;snapshots.set(id,structuredClone(prepared));
      try{
        store.propose({id,worker_id:target.worker_id,model:target.model,reason:'Measure the reviewed unchanged server with Hourglass.'});
        await store.preparing.get(id);
        const row=store.status(id);if(row.state!=='awaiting_approval')throw new Error('Measurement preparation failed; no run was started.');
        return {plan_revision:row.plan_revision,record_revision:row.record_revision,review:row.review};
      }finally{snapshots.delete(id);}
    },
    start:async(id,plan_revision)=>{
      try{return await store.change({action:'approve',id,plan_revision});}
      catch(error){
        // The serialized approval call has finished. Without a launch intent,
        // this store provably never invoked its runner for this request.
        if(!store.read(id,'launch-intent.json'))return {state:'rejected_before_launch'};
        throw error;
      }
    },
    observe:async id=>{
      const row=await store.current(id),receipt=store.read(id,'native-acceptance.json'),result=store.read(id,'runner-result.json');
      return {proposal_state:row.state,runner:row.runner??null,job_id:receipt?.job_id??null,result};
    },
    close:()=>store.close(),
  };
}
