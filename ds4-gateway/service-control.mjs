// macOS user services only. Never operates DS4 model-server services.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {loadConfig,projectRoot,dashboardPort,isDashboard,isMain} from './config.mjs';
export const labels={gateway:'local.dwarf-star-gate.gateway',dashboard:'local.dwarf-star-gate.dashboard'};
const xml=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'})[c]);
export function serviceSpec(kind,filename,config,{root=projectRoot,node=process.execPath,env=process.env}={}) {
  if(!labels[kind])throw new Error('Choose gateway or dashboard');
  const runtime=path.dirname(config.state_file),dir=kind==='gateway'?runtime:path.join(runtime,'dashboard');
  const stdout=path.join(dir,kind==='gateway'?'gateway.log':'ui.log'),stderr=path.join(dir,kind==='gateway'?'gateway.stderr.log':'ui.error.log');
  const args=[node,path.join(root,'ds4-gateway',`${kind}.mjs`),filename];
  const variables={PATH:[path.dirname(node),env.PATH||'/usr/bin:/bin:/usr/sbin:/sbin'].join(':'),GATEWAY_UI_PORT:String(dashboardPort(config,env))};
  // Let graceful shutdown retain the configured long-stream allowance. Only an
  // explicit --interrupt bypasses it; launchd's short default is not suitable.
  const exitSeconds=Math.ceil((config.request_timeout_ms??360000000)/1000);
  if(!Number.isSafeInteger(exitSeconds)||exitSeconds<1)throw new Error('Invalid request timeout');
  const text=`<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${labels[kind]}</string><key>ProgramArguments</key><array>${args.map(x=>`<string>${xml(x)}</string>`).join('')}</array><key>WorkingDirectory</key><string>${xml(root)}</string><key>EnvironmentVariables</key><dict>${Object.entries(variables).map(([k,v])=>`<key>${k}</key><string>${xml(v)}</string>`).join('')}</dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer><key>StandardOutPath</key><string>${xml(stdout)}</string><key>StandardErrorPath</key><string>${xml(stderr)}</string></dict></plist>\n`;
  const manifest=text.replace('<key>ThrottleInterval</key><integer>10</integer>',`<key>ThrottleInterval</key><integer>${kind==='gateway'?10:15}</integer>${kind==='gateway'?`<key>ExitTimeOut</key><integer>${exitSeconds}</integer>`:''}`);
  return {label:labels[kind],args,root,dir,stdout,stderr,variables,text:manifest};
}
export async function readService(kind,config) {
  const port=kind==='gateway'?config.port:dashboardPort(config),route=kind==='gateway'?'/gateway/status':'/api/status';
  const r=await fetch(`http://127.0.0.1:${port}${route}`,{headers:kind==='gateway'?{authorization:`Bearer ${config.api_key}`}:{},signal:AbortSignal.timeout(3000)});
  if(!r.ok)throw new Error(`${kind} HTTP ${r.status}`);
  const value=await r.json();
  if(kind==='dashboard'?!isDashboard(value):value.version!==1||!Array.isArray(value.workers)||typeof value.draining!=='boolean')throw new Error(`Unexpected service on ${kind} port`);
  return value;
}
export function assertIdle(status,interrupt=false) {
  if(!interrupt&&(!status||status.active!==0||status.queued!==0))throw new Error('Gateway is busy or its state is unknown. Wait for idle, or explicitly use --interrupt.');
}
export function assertRegistration(saved,spec) {
  // The operator CLI may use a newer Node than the registered service. Keep the
  // installed interpreter until explicit reinstall; never change it on restart.
  const args=saved.ProgramArguments;
  if(saved.Label!==spec.label||!Array.isArray(args)||typeof args[0]!=='string'||!path.isAbsolute(args[0])||JSON.stringify(args.slice(1))!==JSON.stringify(spec.args.slice(1))||saved.WorkingDirectory!==spec.root||saved.EnvironmentVariables?.GATEWAY_UI_PORT!==spec.variables.GATEWAY_UI_PORT)throw new Error('Service points to another checkout/config/port. Stop that installation before explicitly reinstalling.');
}
export async function unloadService(kind,{domain,launch,loaded,interrupt=false,wait=delay,now=Date.now,timeoutMs=10000}) {
  if(!labels[kind])throw new Error('Choose gateway or dashboard');
  if(!loaded(kind))return;
  if(interrupt)try{launch('kill','SIGKILL',`${domain}/${labels[kind]}`);}catch{/* Already exited; still remove the registration. */}
  launch('bootout',`${domain}/${labels[kind]}`);
  // Wait for launchd's removal acknowledgment before testing for a replacement.
  const deadline=now()+timeoutMs;
  while(loaded(kind)){
    if(now()>=deadline)throw new Error(`${kind} unload not confirmed; no replacement started. Inspect launchd before retrying.`);
    await wait(100);
  }
}
export async function serviceCommand(command,kinds=['gateway','dashboard'],{interrupt=false}={}) {
  const {config,filename}=loadConfig();
  if(command==='status'){
    const results={};for(const kind of kinds)results[kind]=await readService(kind,config);return results;
  }
  if(process.platform!=='darwin')throw new Error('Automatic login services currently support macOS. On Linux use npm start and npm run ui in your service manager.');
  if(!['install','start','stop','restart'].includes(command))throw new Error('Choose install, start, status, stop or restart');
  const domain=`gui/${process.getuid()}`,launch=(...args)=>execFileSync('/bin/launchctl',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']});
  const loaded=kind=>{try{launch('print',`${domain}/${labels[kind]}`);return true;}catch{return false;}};
  const directory=path.join(os.homedir(),'Library','LaunchAgents');
  const plist=kind=>path.join(directory,labels[kind]+'.plist');
  const expected=kind=>serviceSpec(kind,filename,config);
  const verifyRegistration=kind=>{
    let saved;try{saved=JSON.parse(execFileSync('/usr/bin/plutil',['-convert','json','-o','-',plist(kind)],{encoding:'utf8',stdio:['ignore','pipe','pipe']}));}catch{throw new Error('Missing/invalid DSG service registration; run npm run service -- install');}
    const spec=expected(kind);
    assertRegistration(saved,spec);
  };
  if(command==='install'){
    // Preflight the entire set before writing any registration.
    for(const kind of kinds){if(loaded(kind))throw new Error('Stop existing DSG login services before reinstalling; no registration changed.');
      if(fs.existsSync(plist(kind))){const saved=JSON.parse(execFileSync('/usr/bin/plutil',['-convert','json','-o','-',plist(kind)],{encoding:'utf8'}));if(saved.Label!==labels[kind]||!saved.ProgramArguments?.[1]?.endsWith(`/ds4-gateway/${kind}.mjs`))throw new Error('Refusing to replace an unrelated service registration');}}
    fs.mkdirSync(directory,{recursive:true});
    for(const kind of kinds){const spec=expected(kind);fs.mkdirSync(spec.dir,{recursive:true,mode:0o700});if(fs.existsSync(plist(kind)))fs.copyFileSync(plist(kind),plist(kind)+`.bak-${Date.now()}`,fs.constants.COPYFILE_EXCL);fs.writeFileSync(plist(kind),spec.text,{mode:0o600});fs.chmodSync(plist(kind),0o600);}
    return {installed:kinds,started:false};
  }
  for(const kind of kinds)verifyRegistration(kind);
  let genie;
  if(command==='stop'||command==='restart'){
    if(kinds.includes('gateway')&&loaded('gateway')){let status;try{status=await readService('gateway',config);}catch{}assertIdle(status,interrupt);}
    if(kinds.includes('dashboard')&&loaded('dashboard')){
      try{const response=await fetch(`http://127.0.0.1:${dashboardPort(config)}/api/genie`,{signal:AbortSignal.timeout(3000)});if(!response.ok)throw new Error();genie=await response.json();const archive=path.join(path.dirname(config.state_file),'dashboard','backups');fs.mkdirSync(archive,{recursive:true,mode:0o700});fs.writeFileSync(path.join(archive,`genie-${Date.now()}.json`),JSON.stringify(genie,null,2)+'\n',{mode:0o600,flag:'wx'});}catch{throw new Error('Could not preserve Genie reports; inspect before stopping the dashboard');}
    }
    // Fence admission before the final idle check: an idle snapshot alone races
    // with newly arriving work. On a refused stop, restore our temporary fence.
    if(!interrupt&&kinds.includes('gateway')&&loaded('gateway')){
      const before=await readService('gateway',config);let fenced=false;
      try{
        if(!before.draining){launch('kill','SIGUSR1',`${domain}/${labels.gateway}`);fenced=true;}
        let state;for(let i=0;i<20;i++){state=await readService('gateway',config);if(state.draining)break;await delay(50);}
        if(!state.draining)throw new Error('Admission fence was not acknowledged; service not stopped');assertIdle(state);
      }catch(error){if(fenced)launch('kill','SIGUSR2',`${domain}/${labels.gateway}`);throw error;}
    }
    for(const kind of [...kinds].reverse())await unloadService(kind,{domain,launch,loaded,interrupt});
    if(command==='stop')return {stopped:kinds,model_servers_unchanged:true};
  }
  for(const kind of kinds){
    if(!loaded(kind)){
      let responding=false;try{await readService(kind,config);responding=true;}catch{}
      if(responding)throw new Error(`${kind} is already running outside this service registration; not replaced`);
      launch('bootstrap',domain,plist(kind));
    }
    let ready=false;for(let i=0;i<40;i++){try{await readService(kind,config);ready=true;break;}catch{await delay(500);}}
    if(!ready)throw new Error(`${kind} did not become ready. Inspect ${expected(kind).stderr}. Other services were not rolled back automatically.`);
  }
  if(genie?.configured){const url=`http://127.0.0.1:${dashboardPort(config)}/api/genie`,fresh=await(await fetch(url,{signal:AbortSignal.timeout(3000)})).json();for(const body of [{action:'source',source:genie.source},{action:'enable',enabled:genie.enabled}]){
    const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json',origin:`http://127.0.0.1:${dashboardPort(config)}`,'x-dsg-csrf':fresh.csrf_token},body:JSON.stringify(body)});if(!r.ok)throw new Error('Services started, but Genie settings could not be restored');}}
  return {started:kinds,model_servers_unchanged:true};
}
if(isMain(import.meta.url)){
  try{const args=process.argv.slice(2),interrupt=args.includes('--interrupt');const rest=args.filter(x=>x!=='--interrupt');const [command='status',selected='all',...extra]=rest;
    if(extra.length||!['all','gateway','dashboard'].includes(selected))throw new Error('Usage: service-control.mjs install|start|status|stop|restart [all|gateway|dashboard] [--interrupt]');
    console.log(JSON.stringify(await serviceCommand(command,selected==='all'?['gateway','dashboard']:[selected],{interrupt}),null,2));
  }catch(error){console.error(error.message);process.exitCode=1;}
}
