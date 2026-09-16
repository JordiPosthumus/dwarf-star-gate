// Reuse the gateway's existing add/probe/resume controls. Never edit an existing worker.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {createHash} from 'node:crypto';
import {workerConfig} from './worker-config.mjs';

const freePort=()=>new Promise((resolve,reject)=>{
  const server=net.createServer();server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});
});
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function save(file,value){const temp=file+'.tmp';fs.writeFileSync(temp,JSON.stringify(value,null,2)+'\n',{mode:0o600});fs.renameSync(temp,file);}

export function createSparkRegistration({directory,recordsDirectory,control,port=freePort}){
  fs.mkdirSync(directory,{recursive:true,mode:0o700});
  const read=id=>{try{return JSON.parse(fs.readFileSync(path.join(directory,id+'.json'),'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw error;}};
  return {read,async register(id,target,proof){
    const file=path.join(directory,id+'.json');
    const previous=read(id);
    if(previous)return {...previous,scope:'Saved registration attempt. Inspect current gateway state; this call did not repeat or resume it.'};
    if(proof.state!=='qualified_serving'||!proof.configuration_evidence)throw new Error('Fresh native serving proof is required.');
    const fleet=await control('/workers');
    if(fleet.workers.some(w=>w.id===id))throw new Error('This worker ID already exists; it was not changed.');
    if(!recordsDirectory)throw new Error('Connect the private configuration library before registering new Sparks.');
    const observedDirectory=path.join(recordsDirectory,'observed');fs.mkdirSync(observedDirectory,{recursive:true,mode:0o700});
    const observedFile=path.join(observedDirectory,id+'.json');
    if(fs.existsSync(observedFile))throw new Error('A configuration record already exists for this ID; preserved for reconciliation.');
    const worker=workerConfig({id,url:`http://127.0.0.1:${await port()}`,ssh:target.ssh,remote_port:proof.port,context_length:proof.contract.context_length,max_concurrent_requests:1},{registration:true});
    const row={target_id:id,state:'registering',at:new Date().toISOString(),worker,proof_revision:hash(proof)};
    save(file,row);
    try{
      // Store the actual qualified configuration before admitting any work.
      const record={...proof.configuration_evidence,schema:1,worker_id:id,kind:'observed',recorded_at:proof.verified_at,
        gateway_route:worker,qualification:{state:'passed',checks:proof.checks_passed,proof_revision:row.proof_revision},
        restoration:{retention:'unverified',drill:{status:'unproven'}},scope:'Observed new-host qualification. Does not grant automatic recovery or prove media engines.'};
      const bytes=JSON.stringify(record,null,2)+'\n';
      const revision=createHash('sha256').update(bytes).digest('hex');
      const history=path.join(recordsDirectory,'history',id);fs.mkdirSync(history,{recursive:true,mode:0o700});
      fs.writeFileSync(path.join(history,revision+'.json'),bytes,{flag:'wx',mode:0o600});
      fs.writeFileSync(observedFile,bytes,{flag:'wx',mode:0o600});
      row.configuration_revision=revision;save(file,row);
      const added=await control('/add-worker',{worker});
      const registered=added.workers.find(w=>w.id===id);
      if(!registered?.drained)throw new Error('New registration did not return a paused worker.');
      row.state='registered_paused';save(file,row);
      const resumed=await control('/resume-workers',{workers:[id],expected_operator_actions:{[id]:registered.last_operator_action?.id??null},expected_maintenance_actions:{[id]:registered.last_maintenance_action?.request_id??null}});
      const current=resumed.workers.find(w=>w.id===id);
      if(!current?.is_healthy||current.drained||current.quarantine||current.recovering)throw new Error('Worker admission is not confirmed; inspect its current status.');
      row.state='registered_serving';row.finished_at=new Date().toISOString();save(file,row);
      return row;
    }catch(error){row.state='needs_attention';row.error=error.message;save(file,row);throw error;}
  }};
}
