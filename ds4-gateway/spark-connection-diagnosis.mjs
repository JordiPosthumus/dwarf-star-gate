// Read-only SSH evidence from the gateway process, with retained authenticated
// host identity. Raw SSH logs, key paths and credentials never leave this module.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash,randomUUID} from 'node:crypto';
import {inspectNewSpark} from './spark-enrollment.mjs';
import {sparkIdentity,discoverySSHReason} from './spark-discovery.mjs';

const execute=promisify(execFile);
const sha=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const scope='Read-only connection observation from the gateway process. No trust, credentials, remote keys, services or settings changed. Authentication failure alone does not locate its cause or prove that physical access or a reboot is necessary. Model serving and cache state are not inspected.';

export function sshAuthenticationEvidence(stderr=''){
  const methods=[...stderr.matchAll(/Authentications that can continue: ([a-z,-]+)/g)].at(-1)?.[1]?.split(',')??[];
  const agentCount=[...stderr.matchAll(/agent returned (\d+) keys/g)].at(-1)?.[1];
  return {
    host_key_verified:/is known and matches the .* host key/.test(stderr),
    keys_offered:(stderr.match(/Offering public key:/g)??[]).length,
    server_accepted_key:/Server accepts key:/.test(stderr),
    authenticated:/Authenticated to .* using /.test(stderr),
    agent_identity_count:agentCount===undefined?null:Number(agentCount),
    signing_failed:/sign_and_send_pubkey: signing failed|agent refused operation|Load key .*: (?:incorrect passphrase|invalid format|error)/i.test(stderr),
    authentication_rejected:/Permission denied \([^\n]*(?:publickey|password|keyboard-interactive)/i.test(stderr),
    server_authentication_methods:methods.filter(m=>['publickey','password','keyboard-interactive','gssapi-with-mic','hostbased'].includes(m)),
  };
}

function configuredKey(file,home){
  if(file==='none')return {state:'disabled'};
  if(file.startsWith('~/'))file=path.join(home,file.slice(2));
  if(!path.isAbsolute(file)||file.includes('%')||file.includes('${'))return {state:'unresolved'};
  try{
    const stat=fs.statSync(file);
    if(!stat.isFile())return {state:'not_a_file'};
    fs.accessSync(file,fs.constants.R_OK);
    return {state:'readable',permissions:(stat.mode&0o777).toString(8)};
  }catch(error){return {state:error.code==='ENOENT'?'missing':'unavailable'};}
}

export async function diagnoseSparkConnection(input,{discovery,command=execute,env=process.env,home=os.homedir(),now=()=>new Date().toISOString()}={}){
  if(!input||Object.keys(input).join(',')!=='connection'||typeof input.connection!=='string')throw Error('Select one existing configured connection; no credentials, addresses or commands.');
  const {connection}=input,proof=await discovery.connectionProof(connection);
  if(sha(proof.knownHosts)!==proof.known_hosts_sha256)throw Error('Retained host identity changed; no connection attempted.');
  const base={observation_id:randomUUID(),connection,observed_at:now(),retained_identity:{scan_id:proof.scan_id,identity:proof.identity,observed_at:proof.observed_at},scope,
    cause:'undetermined',physical_access_required:null,service_state:'not_observed'};
  let config;
  try{config=(await command('ssh',['-G','--',connection],{timeout:10000,maxBuffer:131072})).stdout;}
  catch{return {...base,state:'unavailable',connection_state:'local_configuration_unavailable'};}
  const values=name=>config.split('\n').filter(line=>line.startsWith(name+' ')).map(line=>line.slice(name.length+1).trim());
  if(values('hostname')[0]!==proof.host||values('user')[0]!==proof.username)throw Error('Configured destination differs from retained identity; no connection attempted.');
  const agent=values('identityagent')[0];
  const local={configured_keys:values('identityfile').map((file,index)=>({index,...configuredKey(file,home)})),
    identities_only:values('identitiesonly')[0]??'unknown',
    agent:{selection:agent==='none'?'disabled':agent?'configured':'environment',environment_socket_present:Boolean(env.SSH_AUTH_SOCK)}};
  let stderr='',facts,error;
  try{
    facts=await inspectNewSpark(connection,{knownHosts:proof.knownHosts,strict:true,command:async(executable,args,options)=>{
      try{const result=await command(executable,['-vv',...args],options);stderr=result.stderr??'';return result;}
      catch(failure){stderr=typeof failure.stderr==='string'?failure.stderr:'';throw failure;}
    }});
  }catch(failure){error=failure;}
  const rechecked=await discovery.connectionProof(connection);
  if(JSON.stringify(rechecked)!==JSON.stringify(proof)||sha(proof.knownHosts)!==proof.known_hosts_sha256)throw Error('Connection evidence changed during observation; no verified conclusion.');
  const evidence=sshAuthenticationEvidence(stderr),identity=facts?sparkIdentity(facts):null;
  return {...base,observed_at:now(),state:'observed',local,ssh:evidence,
    connection_state:error?discoverySSHReason(error):identity===proof.identity?'verified_connection':'hardware_identity_mismatch',
    hardware_identity_verified:!error&&identity===proof.identity,
    cause:!error&&identity===proof.identity?'no_connection_failure_observed':'undetermined'};
}
