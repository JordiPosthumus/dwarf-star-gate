import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {sparkIdentityProbe} from './spark-discovery.mjs';
import {inspectNewSpark} from './spark-enrollment.mjs';
const execute=promisify(execFile);
const helper=fileURLToPath(new URL('./spark_access_ssh.py',import.meta.url));
const installer=fs.readFileSync(new URL('./spark_access_key.py',import.meta.url),'utf8');
const probe=sparkIdentityProbe.replace('print(json.dumps(',"print('DSG_ACCESS_RESULT='+json.dumps(");
const keyPattern=/^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)|sk-[\w@.-]+) [A-Za-z0-9+/]+={0,3}$/;
const parseKey=text=>{const key=text.trim().split(/\s+/).slice(0,2).join(' ');return key.length<=16384&&keyPattern.test(key)?key:null;};
const fingerprint=key=>'SHA256:'+createHash('sha256').update(Buffer.from(key.split(' ')[1],'base64')).digest('base64').replace(/=+$/,'');

export async function gatewayPublicKey(ssh,{home=os.homedir(),command=execute}={}){
  const {stdout}=await command('ssh',['-G','--',ssh],{timeout:10000,maxBuffer:131072});
  const values=key=>stdout.split('\n').filter(line=>line.startsWith(key+' ')).map(line=>line.slice(key.length+1));
  for(const name of values('identityfile')){
    const file=name.startsWith('~/')?path.join(home,name.slice(2)):name;
    if(!path.isAbsolute(file)||!fs.existsSync(file)||!fs.existsSync(file+'.pub'))continue;
    const key=parseKey(fs.readFileSync(file+'.pub','utf8'));if(key)return {public_key:key,fingerprint:fingerprint(key),source:'configured_ssh_key'};
  }
  const agent=values('identityagent')[0];
  if(agent!=='none'){
    try{
      const env={...process.env,...(agent&&agent!=='SSH_AUTH_SOCK'?{SSH_AUTH_SOCK:agent}:{})};
      const result=await command('ssh-add',['-L'],{env,timeout:5000,maxBuffer:131072});
      const key=result.stdout.split('\n').map(parseKey).find(Boolean);if(key)return {public_key:key,fingerprint:fingerprint(key),source:'ssh_agent'};
    }catch{/* No private key is created, replaced or unlocked by this path. */}
  }
  throw Error('No public key is available through the gateway SSH configuration or agent. Connect a usable gateway SSH key before initial Spark access. Existing keys were preserved.');
}

export function createSparkAccessTransport({python,directory,spawnImpl=spawn}){
  const passwordRequest=(target,password,code)=>new Promise((resolve,reject)=>{
    const child=spawnImpl(python,['-I','-B',helper],{stdio:['pipe','pipe','pipe']});let output='',oversized=false;
    const timer=setTimeout(()=>child.kill('SIGTERM'),50000);timer.unref();
    child.stdout.setEncoding('utf8');child.stderr.resume();child.stdin.on('error',()=>{});
    child.stdout.on('data',chunk=>{output+=chunk;if(Buffer.byteLength(output)>524288){oversized=true;child.kill('SIGTERM');}});
    child.once('error',()=>{clearTimeout(timer);reject(Error('Private Spark access transport is unavailable.'));});
    child.once('close',status=>{clearTimeout(timer);try{
      if(status!==0||oversized)throw Error();const result=JSON.parse(output);if(result.ok!==true)throw Error();resolve(result.result);
    }catch{reject(Error('Spark access was not confirmed. The password and terminal output were not retained. Verify this same access request before retrying.'));}});
    // Never pass the password in argv, environment, source files or tool data.
    child.stdin.end(JSON.stringify({ssh:target.ssh,known_hosts:target.knownHosts,password,code}));
  });
  return {
    key:target=>gatewayPublicKey(target.ssh),
    inspect:(target,password)=>passwordRequest(target,password,probe),
    install:(target,password,{operation_id,identity,public_key})=>{
      const data=Buffer.from(JSON.stringify({operation_id,identity,public_key})).toString('base64');
      const code=`import json,base64\nnamespace={'__name__':'dsg_spark_access'}\nexec(${JSON.stringify(installer)},namespace)\nprint('DSG_ACCESS_RESULT='+json.dumps(namespace['install'](json.loads(base64.b64decode('${data}')))))`;
      return passwordRequest(target,password,code);
    },
    verify:target=>inspectNewSpark(target.ssh,{directory,knownHosts:target.knownHosts,strict:true}),
  };
}
