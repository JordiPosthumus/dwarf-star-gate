// Repair only a missing local trust entry for an already configured connection.
// Fresh strict authentication and the retained hardware identity precede any
// trust write. Neither failed observations nor new scans authorize key replacement.
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {sparkIdentity,discoverySSHReason} from './spark-discovery.mjs';
import {inspectNewSpark} from './spark-enrollment.mjs';
import {promoteDiscoveryTrust} from './spark-discovery-trust.mjs';

const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const digest=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const scope='Connection verification only. No server keys, SSH configuration, models, containers or firmware are changed. This is not service recovery or serving proof.';

export function createSparkConnectionRepair({directory,discovery,inspect=inspectNewSpark,promote=promoteDiscoveryTrust,now=()=>new Date().toISOString()}){
  fs.mkdirSync(directory,{recursive:true,mode:0o700});
  const info=fs.lstatSync(directory);if(!info.isDirectory()||info.isSymbolicLink()||info.uid!==process.getuid()||(info.mode&0o077))throw Error('Connection receipts require a private owned directory.');
  const records=new Map(),active=new Map();
  const save=row=>{
    const file=path.join(directory,row.repair_id+'.json'),temp=file+'.'+randomUUID()+'.tmp',fd=fs.openSync(temp,'wx',0o600);
    try{fs.writeFileSync(fd,JSON.stringify(row)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    fs.renameSync(temp,file);const parent=fs.openSync(directory,'r');try{fs.fsyncSync(parent);}finally{fs.closeSync(parent);}
    records.set(row.repair_id,row);return row;
  };
  const publicRow=row=>row?{...row,scope}:null;
  for(const name of fs.readdirSync(directory).filter(n=>uuid(n.slice(0,-5))&&n.endsWith('.json'))){
    const file=path.join(directory,name),st=fs.lstatSync(file);
    if(!st.isFile()||st.isSymbolicLink()||(st.mode&0o077)||st.uid!==process.getuid())throw Error('Unsafe connection receipt; preserved unchanged.');
    let row=JSON.parse(fs.readFileSync(file));
    if(row.schema!==1||name!==row.repair_id+'.json'||typeof row.connection!=='string'||!/^[a-f0-9]{64}$/.test(row.identity??'')||typeof row.host!=='string'||typeof row.username!=='string'||typeof row.updated_at!=='string'||!['running','complete','failed','verification_pending','observation_lost'].includes(row.state))throw Error('Invalid connection receipt; preserved unchanged.');
    if(row.state==='running')row=save({...row,state:'observation_lost',updated_at:now(),error:'Earlier execution is no longer observed. The same repair ID may perform read-only reconciliation; no trust write will be replayed.'});
    records.set(row.repair_id,row);
  }
  const status=async({repair_id}={})=>{
    if(repair_id!==undefined){if(!uuid(repair_id)||!records.has(repair_id))throw Error('Connection repair ID is not recorded.');return publicRow(records.get(repair_id));}
    const connections=[];
    for(const connection of await discovery.configuredConnections()){
      try{const p=await discovery.connectionProof(connection);connections.push({connection,retained_identity_available:true,scan_id:p.scan_id,identity:p.identity,observed_at:p.observed_at});}
      catch(error){connections.push({connection,retained_identity_available:false,error:error.message});}
    }
    return {connections,operations:[...records.values()].sort((a,b)=>b.updated_at.localeCompare(a.updated_at)).slice(0,20).map(publicRow),scope};
  };
  const repair=async(input)=>{
    if(!input||Object.keys(input).sort().join(',')!=='connection,repair_id'||!uuid(input.repair_id)||typeof input.connection!=='string')throw Error('Use an existing configured connection and a canonical repair_id UUID. No address, key or command is accepted.');
    const {repair_id,connection}=input,prior=records.get(repair_id);
    if(prior&&prior.connection!==connection)throw Error('Repair ID belongs to another connection.');
    if(active.has(connection))return publicRow(records.get(active.get(connection))??{repair_id:active.get(connection),connection,state:'running',stage:'retained_identity'});
    if(prior&&['complete','failed'].includes(prior.state))return publicRow(prior);
    const unresolved=[...records.values()].find(r=>r.connection===connection&&r.repair_id!==repair_id&&['running','verification_pending','observation_lost'].includes(r.state));
    if(unresolved)throw Error('Reconcile the existing repair_id '+unresolved.repair_id+' before requesting another repair.');
    // Reserve before the first await, including local proof lookup.
    active.set(connection,repair_id);
    let row=prior,phase='retained_identity',mayHaveWritten=Boolean(prior);
    try{
      const proof=await discovery.connectionProof(connection);
      if(prior&&(prior.identity!==proof.identity||prior.host!==proof.host||prior.username!==proof.username))throw Error('Retained identity or configured destination changed; no reconciliation is allowed.');
      if(!prior)row=save({schema:1,repair_id,connection,state:'running',stage:phase,started_at:now(),updated_at:now(),identity:proof.identity,host:proof.host,username:proof.username,scan_id:proof.scan_id,scan_sha256:proof.scan_sha256,known_hosts_sha256:proof.known_hosts_sha256,normal_trust_changed:false});
      if(!prior){
        phase='pinned_identity';row=save({...row,stage:phase,updated_at:now()});
        if(digest(proof.knownHosts)!==proof.known_hosts_sha256)throw Error('Pinned host-key evidence changed before verification.');
        const observed=await inspect(connection,{knownHosts:proof.knownHosts,strict:true});
        if(sparkIdentity(observed)!==proof.identity)throw Error('Fresh hardware identity differs from the retained authenticated identity.');
        const rechecked=await discovery.connectionProof(connection);
        if(JSON.stringify(rechecked)!==JSON.stringify(proof)||digest(proof.knownHosts)!==proof.known_hosts_sha256)throw Error('Connection or retained evidence changed during verification.');
        phase='normal_trust';row=save({...row,stage:phase,normal_trust_changed:null,pinned_verified_at:now(),updated_at:now()});
        // The journal is durable before promotion. Any exception from here is
        // reconciled read-only, never repeated as an uncertain append.
        mayHaveWritten=true;
        const trust=await promote({ssh:connection,configuredAlias:true,host:proof.host,username:proof.username,knownHosts:proof.knownHosts,directory:path.join(directory,repair_id+'-backup')});
        row=save({...row,normal_trust_changed:trust.changed,trust_receipt:trust,updated_at:now()});
      }
      phase='normal_identity';row=save({...row,stage:phase,updated_at:now()});
      const observed=await inspect(connection,{strict:true});
      if(sparkIdentity(observed)!==row.identity)throw Error('Normal strict SSH returned a different hardware identity.');
      return publicRow(save({...row,state:'complete',stage:'verified_connection',error:null,diagnostic:null,verified_at:now(),finished_at:now(),updated_at:now(),reconciled_read_only:Boolean(prior)}));
    }catch(error){
      if(!row)throw error;
      const diagnostic={stage:phase,kind:error.discovery_reason??discoverySSHReason(error),scope:'Failed observation or guarded local operation; not proof of missing files, stopped containers or machine failure.'};
      return publicRow(save({...row,state:mayHaveWritten?'verification_pending':'failed',stage:phase,error:error.discovery_reason?'Strict SSH identity inspection failed; use the diagnostic to distinguish trust, authentication and network availability.':error.message,diagnostic,finished_at:now(),updated_at:now()}));
    }finally{active.delete(connection);}
  };
  return {status,repair,busy:()=>active.size>0};
}
