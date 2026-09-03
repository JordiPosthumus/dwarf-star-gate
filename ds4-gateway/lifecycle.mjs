// Operator entry points. Reuse the fenced, ownership-checked service controller;
// never spawn a second daemon, infer a remote restart, or modify worker policy.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {execFileSync} from 'node:child_process';
import {loadConfig,projectRoot,dashboardPort,isMain,gatewayPort,continuityEnabled} from './config.mjs';
import {labels,serviceCommand} from './service-control.mjs';

export const help=`Usage:
  ./start-dsg.sh [--open] [--only gateway|door|dashboard] [--config FILE] [--json]
  ./park-dsg.sh [--config FILE] [--json]
  ./stop-dsg.sh [--only gateway|door|dashboard] [--config FILE] [--json]
  ./stop-dsg.sh --interrupt --confirm-interrupt

macOS login services; run as your normal logged-in user, not sudo.
Start checks Node, source syntax and local config, backs up control state,
installs missing DSG registrations, starts only stopped services, and verifies
readiness. Re-running start never restarts an already-running service.
Park holds new requests at the Continuity Door, drains and stops only the gateway
core, and leaves the Door/dashboard/model servers running. A normal start verifies
the replacement core and releases only that exact park hold.
Stop refuses active/queued or unknown gateway state and fences new admission
before stopping. --interrupt PLUS --confirm-interrupt permits abandoning client
requests; this is not seamless recovery. DS4 servers are never stopped.

  --open               Open the dashboard after a successful start.
  --only COMPONENT     Start/stop one component; park always targets the gateway core.
  --config FILE        Override DWARF_GATE_CONFIG / checkout config.local.json.
  --json               Machine-readable result on stdout; progress on stderr.
  --help               Show this help without loading config or changing state.

Worker pauses, holds, quarantines, model settings and caches are not changed.
Private config/affinity backups go beside the state file, under backups/.
Linux: use npm start, npm run door and npm run ui under your service manager.
`;

export function parseArgs(args) {
  const [command,...flags]=args;
  if(!['start','stop','park'].includes(command))throw new Error('Choose start, park or stop; use --help for options.');
  const result={command,kinds:command==='park'?['gateway']:['gateway','door','dashboard'],open:false,json:false,help:false,interrupt:false};
  const seen=new Set();let confirmed=false;
  for(let i=0;i<flags.length;i++){
    const flag=flags[i];
    if(seen.has(flag))throw new Error(`Repeated option: ${flag}`);seen.add(flag);
    if(flag==='--help')result.help=true;
    else if(flag==='--json')result.json=true;
    else if(flag==='--open'&&command==='start')result.open=true;
    else if(flag==='--interrupt'&&command==='stop')result.interrupt=true;
    else if(flag==='--confirm-interrupt'&&command==='stop')confirmed=true;
    else if(flag==='--only'||flag==='--config'){
      const value=flags[++i];
      if(!value||value.startsWith('--'))throw new Error(`${flag} requires a value.`);
      if(flag==='--config')result.config=value;
      else {if(command==='park')throw new Error('--only is not valid for park; park always operates on the gateway core.');if(!Object.hasOwn(labels,value))throw new Error('--only must be gateway, door or dashboard.');result.kinds=[value];}
    }else throw new Error(`Unknown option for ${command}: ${flag}`);
  }
  if(!result.help&&result.interrupt!==confirmed)throw new Error('Interrupting clients requires both --interrupt and --confirm-interrupt. Otherwise wait for idle and use ./stop-dsg.sh.');
  if(result.open&&!result.kinds.includes('dashboard'))throw new Error('--open requires starting the dashboard.');
  return result;
}

export function checkRuntime({platform=process.platform,version=process.versions.node,uid=process.getuid?.()}={}) {
  if(platform!=='darwin')throw new Error('These managed-service scripts support macOS. On Linux run npm start, npm run door and npm run ui under your own supervisor; no process changed.');
  if(uid===0)throw new Error('Run as your normal logged-in user, not sudo/root; DSG uses per-user login services.');
  const parts=version.split('.').map(Number);
  if(parts.length!==3||parts.some(n=>!Number.isInteger(n))||parts[0]<22||parts[0]===22&&(parts[1]<22||parts[1]===22&&parts[2]<2))throw new Error('Node.js 22.22.2 or newer is required; no service changed.');
}

export function backupControlState({filename,config},{now=new Date(),root=projectRoot}={}) {
  const sources=[['config.json',filename],...(fs.existsSync(config.state_file)?[['affinity.json',config.state_file]]:[])];
  // Refuse special files/symlinks. An atomic state-file rename still yields one
  // complete source inode; this is not a quiescent snapshot of the whole runtime.
  for(const [,file] of sources)if(!fs.lstatSync(file).isFile())throw new Error(`Cannot safely back up non-regular control file: ${file}`);
  const parent=path.join(path.dirname(config.state_file),'backups');
  fs.mkdirSync(parent,{recursive:true,mode:0o700});
  const directory=fs.mkdtempSync(path.join(parent,`lifecycle-${now.toISOString().replaceAll(':','-')}-`));
  fs.chmodSync(directory,0o700);
  for(const [name,file] of sources){const dest=path.join(directory,name);fs.copyFileSync(file,dest,fs.constants.COPYFILE_EXCL);fs.chmodSync(dest,0o600);}
  let revision=null;try{revision=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();}catch{/* Source archives need not have Git. */}
  fs.writeFileSync(path.join(directory,'manifest.json'),JSON.stringify({version:1,created_at:now.toISOString(),source_revision:revision,files:sources.map(([name,source])=>({name,source})),scope:'config and atomic affinity file only; not logs, datasets, DS4 or a full runtime snapshot'},null,2)+'\n',{mode:0o600,flag:'wx'});
  return directory;
}

export function fleetSummary(status) {
  const workers=Array.isArray(status?.workers)?status.workers:[];
  return {available:status?.available??null,total:status?.total??workers.length,active:status?.active??null,queued:status?.queued??null,draining:status?.draining??null,context_length:status?.context_length??null,
    workers:workers.map(w=>({id:w.id,healthy:w.is_healthy===true,drained:w.drained===true,operator_paused:w.operator_paused===true,agent_holds:w.holds?.length??0,quarantined:!!w.quarantine,available:w.is_healthy===true&&!w.drained}))};
}

// Testable orchestration; all mutation remains in the existing service controller.
export async function lifecycle(options,ops) {
  ops.preflight();
  const warnings=[];
  if(options.command==='start'){
    ops.progress('Checking source syntax and private configuration (no inference)...');
    warnings.push(...await ops.check());
  }
  const required=options.command==='park'?['gateway','door']:options.kinds;
  const missing=required.filter(kind=>!ops.registered(kind));
  // A missing plist does not prove a service is absent. Do not install over or
  // silently ignore an unmanaged process or a loaded service with a lost plist.
  for(const kind of missing)if(ops.managed(kind)||await ops.listening(kind))throw new Error(`${kind} has no saved DSG registration but is loaded or has a listener. Inspect ownership; no registration or process changed.`);
  const backup=ops.backup();
  if(options.command==='park'){
    if(missing.length)throw new Error(`Continuity park requires installed gateway and door services; missing: ${missing.join(', ')}. Nothing was stopped.`);
    ops.progress('Holding new requests, draining active work, and parking only the gateway core...');
    const parked=await ops.service('park',['gateway']);
    if(await ops.listening('gateway'))throw new Error('Gateway core park was reported, but its core port still has a listener. Inspect ownership; the Continuity Door remains holding.');
    if(!await ops.listening('door'))throw new Error('Gateway core parked, but the Continuity Door is not listening. Do not assume client continuity; inspect services.');
    return {action:'park',verified:true,components:['gateway'],model_servers_unchanged:true,backup,continuity:parked.continuity,warnings:['Continuity Door and dashboard remain running. A normal ./start-dsg.sh will verify the core and release this exact park hold.']};
  }
  ops.progress(`Private control-state backup: ${backup}`);
  if(options.command==='start'){
    if(missing.length){
      // Install ONLY absent registrations. Existing registrations are never
      // overwritten, even when one component is already running.
      ops.progress(`Installing missing login service(s): ${missing.join(', ')}...`);
      await ops.service('install',missing);
    }
    ops.progress('Starting DSG; already-running services will not be restarted...');
    const started=await ops.service('start',options.kinds);
    const status=await ops.service('status',options.kinds);
    const fleet=options.kinds.includes('gateway')?fleetSummary(status.gateway):null;
    if(fleet?.draining)warnings.push('Gateway is running but admission is draining. The existing drain was preserved; use the operator controls to review it.');
    if(fleet&&fleet.available===0)warnings.push('No DS4 servers are currently available for inference. Services are up; inspect worker health and pauses in the UI. No worker was resumed or restarted.');
    if(started?.continuity_resumed?.released)warnings.push('Verified gateway core startup and released the exact continuity-park hold; waiting calls may now proceed.');
    if(options.kinds.includes('dashboard'))warnings.push('A configured Genie starts enabled. Its dedicated provider and DSG-pool fallback are independently bounded; durable recovery policy is unchanged.');
    if(options.open)try{ops.open();}catch{warnings.push('Services are ready, but the browser could not be opened. Use the dashboard URL below.');}
    return {action:'start',verified:true,components:options.kinds,model_servers_unchanged:true,backup,fleet,continuity_resumed:started?.continuity_resumed??null,warnings};
  }
  if(options.interrupt)ops.progress('Explicit interruption: active/queued client requests may fail. Model servers stay running.');
  else ops.progress('Stopping only if idle; the controller will fence and recheck admission...');
  const registered=options.kinds.filter(kind=>!missing.includes(kind));
  if(registered.length)await ops.service('stop',registered,{interrupt:options.interrupt});
  // launchd removal is verified by serviceCommand; also check that no listener
  // survived or appeared on either local endpoint. Never kill that listener.
  for(const kind of options.kinds)if(await ops.listening(kind))throw new Error(`${kind} login service stopped, but its port still has a listener. Inspect it; no unrelated process was killed.`);
  return {action:'stop',verified:true,components:options.kinds,model_servers_unchanged:true,backup,warnings:[...warnings,'Logs, data, affinity, worker pauses/holds/quarantines and model caches were retained.']};
}

export function portListening(port,{timeoutMs=1500}={}) {
  return new Promise((resolve,reject)=>{
    const socket=net.connect({host:'127.0.0.1',port});let settled=false;
    const finish=(value,error)=>{if(settled)return;settled=true;socket.destroy();error?reject(error):resolve(value);};
    socket.once('connect',()=>finish(true));
    socket.once('error',e=>e.code==='ECONNREFUSED'?finish(false):finish(null,new Error('Could not verify local port closure; inspect before retrying.')));
    socket.setTimeout(timeoutMs,()=>finish(null,new Error('Local port closure check timed out; stop is not verified.')));
  });
}

export function formatResult(result) {
  const title=result.action==='park'?'DSG gateway core parked with continuity verified.':`DSG ${result.components.join(' + ')} ${result.action} verified.`;
  const lines=[title,...Object.entries(result.urls??{}).map(([kind,url])=>`${kind}${result.action==='stop'?' (stopped)':result.action==='park'&&kind==='gateway'?' (parked)':result.action==='park'&&kind==='door'?' (holding)':''}: ${url}`)];
  if(result.fleet){const f=result.fleet;lines.push(`Fleet: ${f.available??'?'} / ${f.total} available; ${f.active??'?'} active; ${f.queued??'?'} queued; pool context ${f.context_length??'?'} tokens.`);}
  for(const w of result.fleet?.workers??[])if(!w.available)lines.push(`${w.id}: ${[w.operator_paused?'operator paused':null,w.agent_holds?`${w.agent_holds} agent hold(s)`:null,w.drained?'drained':null,w.quarantined?'quarantined':null,!w.healthy?'not healthy':null].filter(Boolean).join('; ')} (unchanged).`);
  lines.push(`Private backup: ${result.backup}`,'DS4 model servers and their settings: untouched.',...result.warnings.map(w=>`Note: ${w}`));
  return lines.join('\n');
}

if(isMain(import.meta.url)){
  try{
      const options=parseArgs(process.argv.slice(2));
    if(options.help)console.log(help);
    else{
      checkRuntime();
      const loaded=loadConfig(options.config),{config,filename}=loaded;
      if(!continuityEnabled(config))options.kinds=options.kinds.filter(kind=>kind!=='door');
      if(!options.kinds.length)throw new Error('Continuity door is not enabled in this configuration.');
      process.env.DWARF_GATE_CONFIG=filename;
      const urls={gateway:`http://127.0.0.1:${gatewayPort(config)}`,door:`http://127.0.0.1:${config.port}`,dashboard:`http://127.0.0.1:${dashboardPort(config)}`};
      const result=await lifecycle(options,{
        preflight:()=>{},progress:s=>console.error(s),
        check:async()=>{
          execFileSync(process.execPath,['scripts/check.mjs'],{cwd:projectRoot,stdio:['ignore','ignore','inherit']});
          const report=JSON.parse(execFileSync(process.execPath,[path.join(projectRoot,'scripts/doctor.mjs')],{cwd:projectRoot,encoding:'utf8',stdio:['ignore','pipe','pipe']}));
          return report.warnings??[];
        },
        backup:()=>backupControlState(loaded),
        registered:kind=>fs.existsSync(path.join(os.homedir(),'Library','LaunchAgents',labels[kind]+'.plist')),
        managed:kind=>{try{execFileSync('/bin/launchctl',['print',`gui/${process.getuid()}/${labels[kind]}`],{stdio:'ignore'});return true;}catch{return false;}},
        service:serviceCommand,
        listening:kind=>portListening(kind==='gateway'?gatewayPort(config):kind==='door'?config.port:dashboardPort(config)),
        open:()=>execFileSync('/usr/bin/open',[urls.dashboard],{stdio:'ignore'})
      });
      result.urls=Object.fromEntries((options.command==='park'?['gateway','door']:options.kinds).map(kind=>[kind,urls[kind]]));
      console.log(options.json?JSON.stringify(result,null,2):formatResult(result));
    }
  }catch(error){
    // Errors from doctor may mention private paths, never echo config/key values.
    console.error(`DSG: ${error.stderr?.toString().trim()||error.message}`);
    if(error.message?.includes('Gateway is busy'))console.error('Wait for idle, or explicitly accept client failures with ./stop-dsg.sh --interrupt --confirm-interrupt.');
    console.error('No automatic rollback or model-server restart was attempted. Inspect ./gateway-status.sh and the private runtime logs.');
    process.exitCode=1;
  }
}
