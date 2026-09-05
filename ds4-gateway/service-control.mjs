// macOS user services only. Never operates DS4 model-server services.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {loadConfig,projectRoot,dashboardPort,isDashboard,isMain,gatewayPort,continuityEnabled} from './config.mjs';
import {doorControl} from './door-client.mjs';
export const labels={gateway:'local.dwarf-star-gate.gateway',door:'local.dwarf-star-gate.continuity-door',dashboard:'local.dwarf-star-gate.dashboard'};
export const PARK_REASON='planned_gateway_core_park';
const xml=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'})[c]);
export function serviceSpec(kind,filename,config,{root=projectRoot,node=process.execPath,env=process.env}={}) {
  if(!labels[kind])throw new Error('Choose gateway, door or dashboard');
  const runtime=path.dirname(config.state_file),dir=kind==='dashboard'?path.join(runtime,'dashboard'):runtime;
  const stdout=path.join(dir,kind==='gateway'?'gateway.log':kind==='door'?'continuity-door.log':'ui.log'),stderr=path.join(dir,kind==='gateway'?'gateway.stderr.log':kind==='door'?'continuity-door.stderr.log':'ui.error.log');
  const args=[node,path.join(root,'ds4-gateway',`${kind}.mjs`),filename];
  const variables={PATH:[path.dirname(node),env.PATH||'/usr/bin:/bin:/usr/sbin:/sbin'].join(':'),GATEWAY_UI_PORT:String(dashboardPort(config,env))};
  // Let graceful shutdown retain the configured long-stream allowance. Only an
  // explicit --interrupt bypasses it; launchd's short default is not suitable.
  const exitSeconds=Math.ceil((config.request_timeout_ms??360000000)/1000);
  if(!Number.isSafeInteger(exitSeconds)||exitSeconds<1)throw new Error('Invalid request timeout');
  const text=`<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${labels[kind]}</string><key>ProgramArguments</key><array>${args.map(x=>`<string>${xml(x)}</string>`).join('')}</array><key>WorkingDirectory</key><string>${xml(root)}</string><key>EnvironmentVariables</key><dict>${Object.entries(variables).map(([k,v])=>`<key>${k}</key><string>${xml(v)}</string>`).join('')}</dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer><key>StandardOutPath</key><string>${xml(stdout)}</string><key>StandardErrorPath</key><string>${xml(stderr)}</string></dict></plist>\n`;
  const manifest=text.replace('<key>ThrottleInterval</key><integer>10</integer>',`<key>ThrottleInterval</key><integer>${kind==='gateway'?10:15}</integer>${kind!=='dashboard'?`<key>ExitTimeOut</key><integer>${exitSeconds}</integer>`:''}`);
  return {label:labels[kind],args,root,dir,stdout,stderr,variables,text:manifest};
}
export async function readService(kind,config) {
  const port=kind==='gateway'?gatewayPort(config):kind==='door'?config.port:dashboardPort(config),route=kind==='gateway'?'/gateway/status':kind==='door'?'/continuity/status':'/api/status';
  const r=await fetch(`http://127.0.0.1:${port}${route}`,{headers:kind!=='dashboard'?{authorization:`Bearer ${config.api_key}`}:{},signal:AbortSignal.timeout(3000)});
  if(!r.ok)throw new Error(`${kind} HTTP ${r.status}`);
  const value=await r.json();
  if(kind==='dashboard'?!isDashboard(value):kind==='door'?value.service!=='dwarf-star-gate-continuity-door'||value.version!==1:value.version!==1||!Array.isArray(value.workers)||typeof value.draining!=='boolean')throw new Error(`Unexpected service on ${kind} port`);
  return value;
}
export function assertIdle(status,interrupt=false) {
  if(!interrupt&&(!status||status.active!==0||status.queued!==0))throw new Error('Gateway is busy or its state is unknown. Wait for idle, or explicitly use --interrupt.');
}
export function assertDoorIdle(status,interrupt=false){
  if(!interrupt&&(!status||status.active!==0||status.held!==0||status.holding!==false))throw new Error('Continuity Door has a hold, active or held client streams, or its state is unknown. Keep it running; wait for an idle, explicitly unheld state, or explicitly use --interrupt.');
}
export function assertRegistration(saved,spec) {
  // The operator CLI may use a newer Node than the registered service. Keep the
  // installed interpreter until explicit reinstall; never change it on restart.
  const args=saved.ProgramArguments;
  if(saved.Label!==spec.label||!Array.isArray(args)||typeof args[0]!=='string'||!path.isAbsolute(args[0])||JSON.stringify(args.slice(1))!==JSON.stringify(spec.args.slice(1))||saved.WorkingDirectory!==spec.root||saved.EnvironmentVariables?.GATEWAY_UI_PORT!==spec.variables.GATEWAY_UI_PORT)throw new Error('Service points to another checkout/config/port. Stop that installation before explicitly reinstalling.');
}
export async function unloadService(kind,{domain,launch,loaded,interrupt=false,wait=delay,now=Date.now,timeoutMs=10000}) {
  if(!labels[kind])throw new Error('Choose gateway, door or dashboard');
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
function assertHoldOwnership(door){
  if(door?.hold_ownership!==1)throw new Error('Running Continuity Door lacks hold ownership fencing. Upgrade the Door at an idle, unheld window before automated core cutover/release; no automatic hold release was attempted.');
}
function holdReceipt(door){
  if(door?.hold_ownership!==1||door.holding!==true||door.hold_kind!=='manual'||typeof door.hold_id!=='string'||!door.hold_id)throw new Error('Continuity Door did not return a verified hold receipt; no automatic release is permitted.');
  return {if_hold_id:door.hold_id};
}
export async function coordinatedCoreRestart(config,{doorStatus=()=>doorControl(config.continuity_door.control_socket,'/status'),hold=body=>doorControl(config.continuity_door.control_socket,'/hold',body),release=body=>doorControl(config.continuity_door.control_socket,'/release',body),read=()=>readService('gateway',config),stop,start,wait=delay,now=Date.now,timeoutMs=config.continuity_door?.restart_wait_ms??config.request_timeout_ms??360000000}={}){
  if(!continuityEnabled(config))throw new Error('Continuity door is not enabled');
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1000)throw new Error('Invalid coordinated restart allowance');
  assertHoldOwnership(await doorStatus());
  const receipt=holdReceipt(await hold({reason:'planned_gateway_core_restart',if_unheld:true}));
  const deadline=now()+timeoutMs;
  try{
    let status;
    for(;;){
      status=await read();
      if(status.active===0&&status.queued===0)break;
      if(now()>=deadline)throw new Error('Coordinated restart allowance expired; continuity door remains holding new requests');
      await wait(Math.min(1000,Math.max(1,deadline-now())));
    }
    await stop(status);await start();
    status=await read();
    if(status.active!==0||status.queued!==0||status.startup?.complete!==true)throw new Error('Replacement core is not in a clean ready state; continuity door remains holding');
    await release(receipt);
    return {coordinated:true,held_new_requests:true,old_core_drained:true,replacement_ready:true};
  }catch(error){error.continuity_door_holding=true;throw error;}
}
export async function coordinatedCorePark(config,{doorStatus=()=>readService('door',config),hold=body=>doorControl(config.continuity_door.control_socket,'/hold',body),read=()=>readService('gateway',config),stop,wait=delay,now=Date.now,timeoutMs=config.continuity_door?.restart_wait_ms??config.request_timeout_ms??360000000}={}){
  if(!continuityEnabled(config))throw new Error('Continuity door is not enabled');
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1000)throw new Error('Invalid coordinated park allowance');
  const before=await doorStatus(),alreadyParked=before.holding===true&&before.hold_kind==='manual'&&before.reason===PARK_REASON;
  if(before.holding&&!alreadyParked)throw new Error('Continuity Door already has a different hold; it was preserved and the gateway core was not parked.');
  if(!before.holding)await hold({reason:PARK_REASON,if_unheld:true});
  const deadline=now()+timeoutMs;
  try{
    let status;
    for(;;){
      status=await read();
      if(status.active===0&&status.queued===0)break;
      if(now()>=deadline)throw new Error('Coordinated park allowance expired; continuity door remains holding new requests');
      await wait(Math.min(1000,Math.max(1,deadline-now())));
    }
    await stop(status);
    return {coordinated:true,held_new_requests:true,old_core_drained:true,core_parked:true,door_holding:true,already_holding:alreadyParked};
  }catch(error){error.continuity_door_holding=true;throw error;}
}
export async function releaseParkedCore(config,{doorStatus=()=>readService('door',config),coreStatus=()=>readService('gateway',config),release=body=>doorControl(config.continuity_door.control_socket,'/release',body)}={}){
  if(!continuityEnabled(config))return null;
  const door=await doorStatus();
  if(!(door.holding===true&&door.hold_kind==='manual'&&door.reason===PARK_REASON))return {released:false,preserved_hold:door.holding===true};
  assertHoldOwnership(door);const receipt=holdReceipt(door);
  const core=await coreStatus();
  if(core.startup?.complete!==true||core.active!==0||core.queued!==0)throw new Error('Gateway core started without a clean idle startup barrier; continuity door remains holding.');
  await release(receipt);
  return {released:true,reason:PARK_REASON};
}
export async function serviceCommand(command,kinds=['gateway','door','dashboard'],{interrupt=false}={}) {
  const {config,filename}=loadConfig();
  if(command==='park'&&!continuityEnabled(config))throw new Error('Continuity Door is not enabled; gateway core was not parked.');
  if(!continuityEnabled(config))kinds=kinds.filter(kind=>kind!=='door');
  if(!kinds.length)throw new Error('Continuity door is not enabled in this configuration');
  if(command==='status'){
    const results={};for(const kind of kinds)results[kind]=await readService(kind,config);return results;
  }
  if(process.platform!=='darwin')throw new Error('Automatic login services currently support macOS. On Linux use npm start, npm run door and npm run ui in your service manager.');
  if(!['install','start','stop','restart','park'].includes(command))throw new Error('Choose install, start, status, stop, restart or park');
  if(command==='park'&&(kinds.length!==1||kinds[0]!=='gateway'))throw new Error('Park operates on the gateway core only; the Continuity Door must remain running.');
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
  if(command==='park'||(command==='start'&&kinds.includes('gateway')&&continuityEnabled(config)&&loaded('door')))verifyRegistration('door');
  let coordinated=null;
  if(command==='restart'&&!interrupt&&continuityEnabled(config)&&kinds.includes('gateway')&&loaded('gateway')&&loaded('door')){
    coordinated=await coordinatedCoreRestart(config,{
      stop:async()=>{
        launch('kill','SIGUSR1',`${domain}/${labels.gateway}`);
        let state;for(let i=0;i<20;i++){state=await readService('gateway',config);if(state.draining)break;await delay(50);}
        if(!state?.draining)throw new Error('Gateway admission fence was not acknowledged; continuity door remains holding');
        assertIdle(state);await unloadService('gateway',{domain,launch,loaded});
      },
      start:async()=>{
        launch('bootstrap',domain,plist('gateway'));
        for(let i=0;i<80;i++){try{const state=await readService('gateway',config);if(state.startup?.complete)return;}catch{}await delay(500);}
        throw new Error(`Replacement core did not become ready. Inspect ${expected('gateway').stderr}; continuity door remains holding.`);
      }
    });
    // The door is intentionally stable across a core restart. A requested
    // dashboard restart still happens below; gateway has already been replaced.
    kinds=kinds.filter(kind=>kind!=='gateway'&&kind!=='door');
    if(!kinds.length)return {started:['gateway'],kept_running:['door'],model_servers_unchanged:true,continuity:coordinated};
  }
  if(command==='park'){
    if(!loaded('door'))throw new Error('Continuity Door is not running; gateway core was not parked. Start DSG first.');
    const door=await readService('door',config);
    if(!loaded('gateway')){
      if(door.holding===true&&door.hold_kind==='manual'&&door.reason===PARK_REASON)return {stopped:['gateway'],kept_running:['door'],already_parked:true,model_servers_unchanged:true,continuity:{core_parked:true,door_holding:true}};
      throw new Error('Gateway core is already stopped without a verified park hold; existing Continuity Door state was preserved.');
    }
    const continuity=await coordinatedCorePark(config,{doorStatus:async()=>door,stop:async()=>{
      launch('kill','SIGUSR1',`${domain}/${labels.gateway}`);
      let state;for(let i=0;i<20;i++){state=await readService('gateway',config);if(state.draining)break;await delay(50);}
      if(!state?.draining)throw new Error('Gateway admission fence was not acknowledged; continuity door remains holding');
      assertIdle(state);await unloadService('gateway',{domain,launch,loaded});
    }});
    return {stopped:['gateway'],kept_running:['door'],model_servers_unchanged:true,continuity};
  }
  let genie;
  if(command==='stop'||command==='restart'){
    if(kinds.includes('gateway')&&loaded('gateway')){let status;try{status=await readService('gateway',config);}catch{}assertIdle(status,interrupt);}
    if(kinds.includes('door')&&loaded('door')){let status;try{status=await readService('door',config);}catch{}assertDoorIdle(status,interrupt);}
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
    let ready=false;for(let i=0;i<40;i++){try{const state=await readService(kind,config);if(kind!=='gateway'||state.startup?.complete===true){ready=true;break;}}catch{}await delay(500);}
    if(!ready)throw new Error(`${kind} did not become ready. Inspect ${expected(kind).stderr}. Other services were not rolled back automatically.`);
  }
  const resumed=command==='start'&&kinds.includes('gateway')&&loaded('door')?await releaseParkedCore(config):null;
  if(genie?.configured){const url=`http://127.0.0.1:${dashboardPort(config)}/api/genie`,fresh=await(await fetch(url,{signal:AbortSignal.timeout(3000)})).json();for(const body of [{action:'source',source:genie.source},{action:'enable',enabled:genie.enabled}]){
    const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json',origin:`http://127.0.0.1:${dashboardPort(config)}`,'x-dsg-csrf':fresh.csrf_token},body:JSON.stringify(body)});if(!r.ok)throw new Error('Services started, but Genie settings could not be restored');}}
  return {started:[...(coordinated?['gateway']:[]),...kinds],...(coordinated?{kept_running:['door'],continuity:coordinated}:{}),...(resumed?.released?{continuity_resumed:resumed}:{}),model_servers_unchanged:true};
}
if(isMain(import.meta.url)){
  try{const args=process.argv.slice(2),interrupt=args.includes('--interrupt');const rest=args.filter(x=>x!=='--interrupt');const [command='status',selected='all',...extra]=rest;
    if(extra.length||!['all','gateway','door','dashboard'].includes(selected))throw new Error('Usage: service-control.mjs install|start|status|stop|restart [all|gateway|door|dashboard] [--interrupt], or park gateway');
    console.log(JSON.stringify(await serviceCommand(command,selected==='all'?['gateway','door','dashboard']:[selected],{interrupt}),null,2));
  }catch(error){console.error(error.message);process.exitCode=1;}
}
