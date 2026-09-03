import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {loadConfig} from './config.mjs';
import {workerControl} from './worker-client.mjs';
import {readAgentCredential,agentRequest} from './agent-client.mjs';

const args=process.argv.slice(2);
function option(name){const i=args.indexOf(name);if(i<0)return undefined;if(i===args.length-1||args[i+1].startsWith('--'))throw new Error('Missing '+name+' value');const value=args[i+1];args.splice(i,2);return value;}
let requestId;
try {
  const configFile=option('--config'),credentialFile=option('--credential-file')??process.env.DSG_AGENT_CREDENTIALS;
  const workers=option('--workers'),out=option('--out'),reason=option('--reason');requestId=option('--request-id');
  const [command='status',id,...extra]=args;if(extra.length)throw new Error('Unexpected arguments');
  let result;
  if(['grant','revoke','list','clear-hold'].includes(command)) {
    if(credentialFile||reason||requestId)throw new Error('Operator command does not accept agent credentials or request fields');
    const {config}=loadConfig(configFile);
    if(command==='grant') {
      if(!id||!workers||!out||!path.isAbsolute(out))throw new Error('grant AGENT --workers ID,ID --out ABSOLUTE_PRIVATE_FILE');
      // Reserve a new private file first. Never overwrite another agent's key.
      const fd=fs.openSync(out,'wx',0o600);let saved=false,issued=false;
      try {const grant=await workerControl(config.control_socket,'/grant-agent',{agent_id:id,workers:workers.split(',')});
        issued=true;
        fs.writeFileSync(fd,JSON.stringify({schema:1,agent_id:id,control_socket:config.control_socket,token:grant.token})+'\n');fs.fsyncSync(fd);saved=true;
        result={agent_id:id,workers:grant.workers,credential_file:out};
      }catch(error){throw new Error(`${error.message}. ${issued?'Grant committed but its credential could not be saved.':'Grant outcome may be uncertain.'} Check agents.sh list and revoke ${id} if present before issuing a new agent ID.`);}
      finally{fs.closeSync(fd);if(!saved)fs.unlinkSync(out);}
    }else {
      if(workers||out||((command==='list')?id:!id))throw new Error('Unexpected or missing operator arguments');
      result=await workerControl(config.control_socket,command==='list'?'/agents':command==='revoke'?'/revoke-agent':'/release-agent-hold',command==='list'?undefined:command==='revoke'?{agent_id:id}:{hold_id:id});
    }
  }else {
    if(configFile||workers||out)throw new Error('Scoped agent commands use a credential file, not operator configuration');
    const credential=readAgentCredential(credentialFile);
    if(command==='status'){if(id||reason||requestId)throw new Error('status takes no action fields');result=await agentRequest(credential,'status');}
    else if(command==='receipt'){if(!id||reason||requestId)throw new Error('receipt REQUEST_ID');result=await agentRequest(credential,'receipt',{request_id:id});}
    else if(['drain','resume'].includes(command)) {
      if(!id||(command==='drain'&&!reason)||(command==='resume'&&reason))throw new Error('Use drain WORKER --reason TEXT or resume HOLD_ID');
      requestId??=randomUUID();console.error(JSON.stringify({request_id:requestId,note:'Save this ID; on an uncertain reply, query receipt before retrying.'}));
      result=await agentRequest(credential,command,command==='drain'?{worker_id:id,reason,request_id:requestId}:{hold_id:id,request_id:requestId});
    }else throw new Error('Usage: agents.sh grant|revoke|list|clear-hold (operator), or status|drain|resume|receipt --credential-file FILE');
  }
  console.log(JSON.stringify(result,null,2));
}catch(error){console.error(JSON.stringify({error:error.message,...(error.code?{code:error.code}:{}),...(requestId?{request_id:requestId}:{})}));process.exitCode=1;}
