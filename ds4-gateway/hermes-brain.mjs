import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile),here=path.dirname(fileURLToPath(import.meta.url));
export function createBrainStore(home,{root=path.resolve(here,'../vendor/hermes'),runtimeHome=home}={}) {
  const launcher=path.join(root,'.hermes/bin/hermes');
  let python;
  const runtime=()=>{
    try{
      const value=JSON.parse(fs.readFileSync(path.join(home,'gateway_state.json'),'utf8'));
      const fresh=Date.now()-Date.parse(value.updated_at)<60000;
      return {state:fresh?value.gateway_state:'status stale',telegram:fresh?value.platforms?.telegram?.state??'unknown':'unknown',active_agents:fresh?value.active_agents:null,updated_at:value.updated_at};
    }catch{return {state:'unavailable',telegram:'unknown',active_agents:null};}
  };
  async function run(input){
    if(!python){
      const {stdout}=await exec(launcher,['--print-runtime-command'],{env:{...process.env,HERMES_HOME:runtimeHome},timeout:15000,maxBuffer:256*1024});
      python=JSON.parse(stdout)[0];
    }
    const boot="import sys,os,runpy;from pathlib import Path;sys.path.insert(0,sys.argv[1]);from pm.environments import activate_dependencies;activate_dependencies(Path(sys.argv[1]));os.environ['HERMES_HOME']=sys.argv[3];runpy.run_path(sys.argv[2],run_name='__main__')";
    return new Promise((resolve,reject)=>{
      const child=spawn(python,['-I','-c',boot,root,path.join(here,'hermes-brain.py'),home],{env:{...process.env,HERMES_HOME:runtimeHome},stdio:['pipe','pipe','pipe']});
      let output='',size=0;const timer=setTimeout(()=>child.kill(),20000);
      child.stdout.on('data',b=>{size+=b.length;if(size>2*1024*1024)child.kill();else output+=b;});
      child.stderr.resume();child.on('error',error=>{clearTimeout(timer);reject(error);});
      child.on('close',()=>{clearTimeout(timer);try{const value=JSON.parse(output);if(value.error)reject(Object.assign(Error(value.error),{status:value.status??400}));else resolve(value);}catch(error){reject(error instanceof SyntaxError?Error('Native Hermes settings helper did not reply.'):error);}});
      child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(input));
    });
  }
  return {read:async()=>({...await run({action:'read'}),runtime:runtime()}),save:async input=>({...await run({...input,action:'save'}),runtime:runtime()}),test:input=>run({...input,action:'test'}),runtime};
}
