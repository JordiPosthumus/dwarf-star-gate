// Compatibility commands using the same config/readiness contract as all services.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {loadConfig,dashboardPort} from './config.mjs';
import {serviceCommand,readService,labels} from './service-control.mjs';
try {
  const {config}=loadConfig(),command=process.argv[2]||'status',url=`http://127.0.0.1:${dashboardPort(config)}`;
  if(command==='start'||command==='open'){
    let running=false;try{await readService('dashboard',config);running=true;}catch{}
    if(!running){
      if(process.platform==='darwin'&&!fs.existsSync(path.join(os.homedir(),'Library','LaunchAgents',labels.dashboard+'.plist')))await serviceCommand('install',['dashboard']);
      await serviceCommand('start',['dashboard']);
    }
    if(command==='open')execFileSync('/usr/bin/open',[url]);console.log(url);
  }else if(command==='stop')console.log(JSON.stringify(await serviceCommand('stop',['dashboard'])));
  else if(command==='status')console.log(JSON.stringify(await readService('dashboard',config),null,2));
  else if(command==='snapshot'){
    const snapshot=await readService('dashboard',config),runtime=path.join(path.dirname(config.state_file),'dashboard');fs.mkdirSync(runtime,{recursive:true,mode:0o700});
    const destination=path.join(runtime,`diagnostics-${Date.now()}.json`);fs.writeFileSync(destination,JSON.stringify(snapshot,null,2)+'\n',{mode:0o600,flag:'wx'});console.log(destination);
  }else throw new Error('Usage: dashboard-control.mjs start|open|stop|status|snapshot');
}catch(error){console.error(error.message);process.exitCode=1;}
