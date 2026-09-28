// Read-only network discovery. A discovered address is not an enrolled worker.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash,randomUUID} from 'node:crypto';
const execute=promisify(execFile);
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
const userPattern=/^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/;
const aliasPattern=/^[a-zA-Z0-9][\w.@-]{0,252}$/;
const interfacePattern=/^[a-zA-Z0-9][\w.-]{0,31}$/;
const attachedInterface=name=>interfacePattern.test(name)&&!/^(lo\d*|utun\d*|tun\d*|tap\d*|docker\d*|veth.*|tailscale\d*)$/.test(name);
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const scanIdPattern=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

export const sparkIdentityProbe=`import hashlib,json,platform,subprocess
from pathlib import Path
def read(p):
 try:return Path(p).read_text().strip()[:512]
 except OSError:return None
def command(args):
 try:
  p=subprocess.run(args,capture_output=True,text=True,timeout=8)
  return p.stdout[:65536] if p.returncode==0 else None
 except (OSError,subprocess.TimeoutExpired):return None
def parsed(args):
 try:return json.loads(command(args) or 'null')
 except ValueError:return None
machine=read('/etc/machine-id')
gpu=command(['nvidia-smi','--query-gpu=name,uuid','--format=csv,noheader'])
print(json.dumps({'system':platform.system(),'architecture':platform.machine(),'hostname':platform.node(),
 'machine_id':hashlib.sha256(machine.encode()).hexdigest() if machine else None,
 'gpus':[{'name':r.split(',')[0].strip(),'uuid':r.split(',')[1].strip()} for r in (gpu or '').splitlines() if len(r.split(','))==2],
 'manufacturer':read('/sys/class/dmi/id/sys_vendor'),'product':read('/sys/class/dmi/id/product_name'),
 'bios_version':read('/sys/class/dmi/id/bios_version'),'device_tree_model':read('/proc/device-tree/model'),
 'interfaces':parsed(['ip','-j','address','show']),'neighbors':parsed(['ip','-j','neighbor','show'])}))`;

export function sparkIdentity(facts){
  if(facts?.system!=='Linux'||!['aarch64','arm64'].includes(facts.architecture)||!/^([a-f0-9]{64})$/.test(facts.machine_id??'')||
    !Array.isArray(facts.gpus)||!facts.gpus.length||facts.gpus.length>16||facts.gpus.some(g=>typeof g.name!=='string'||!g.name.includes('GB10')||!/^GPU-[a-fA-F0-9-]{16,80}$/.test(g.uuid??'')))return null;
  const uuids=facts.gpus.map(g=>g.uuid).sort();
  if(new Set(uuids).size!==uuids.length)return null;
  return hash([facts.machine_id,uuids]);
}

export function localAddress(address){
  if(typeof address!=='string'||address.length>128)return false;
  const [base,zone,...extra]=address.split('%');
  if(extra.length||zone&&!interfacePattern.test(zone))return false;
  if(net.isIP(base)===4){
    if(zone)return false;
    const [a,b]=base.split('.').map(Number);
    return a===10||a===172&&b>=16&&b<=31||a===192&&b===168||a===169&&b===254;
  }
  if(net.isIP(base)===6)return /^(fc|fd)/i.test(base)?!zone:/^fe[89ab]/i.test(base)&&!!zone;
  return false;
}

export function networkAddresses(interfaces,{limit=1024}={}){
  const addresses=new Map(),issues=[];
  for(const [name,rows] of Object.entries(interfaces)){
    if(!attachedInterface(name))continue;
    for(const row of rows??[]){
      if(row.internal||!(row.family==='IPv4'||row.family===4)||!localAddress(row.address)||!row.cidr)continue;
      const bits=Number(row.cidr.split('/')[1]);
      if(!Number.isInteger(bits)||bits<0||bits>32){issues.push({interface:name,reason:'invalid_prefix'});continue;}
      const size=2**(32-bits);
      if(size>1024){issues.push({interface:name,reason:'subnet_too_large_for_bounded_sweep',cidr:row.cidr});continue;}
      const value=row.address.split('.').reduce((n,v)=>n*256+Number(v),0),base=Math.floor(value/size)*size;
      for(let i=bits>=31?0:1;i<(bits>=31?size:size-1);i++){
        const n=base+i,address=[24,16,8,0].map(s=>Math.floor(n/2**s)%256).join('.');
        if(address===row.address||!localAddress(address))continue;
        if(addresses.size>=limit&&!addresses.has(address)){issues.push({interface:name,reason:'address_limit',limit});break;}
        addresses.set(address,{address,interface:name,source:'connected_subnet'});
      }
    }
  }
  return {addresses:[...addresses.values()],issues};
}

export function neighborAddresses(text,{linux=false}={}){
  const rows=[];
  if(linux){
    let data;try{data=JSON.parse(text);}catch{return rows;}
    for(const row of Array.isArray(data)?data:[]){
      if(!interfacePattern.test(row.dev??'')||!row.dst||['FAILED','INCOMPLETE'].some(s=>[].concat(row.state??[]).includes(s)))continue;
      const address=net.isIP(row.dst)===6&&/^fe[89ab]/i.test(row.dst)?`${row.dst}%${row.dev}`:row.dst;
      if(localAddress(address))rows.push({address,interface:row.dev,source:'neighbor_cache'});
    }
  }else{
    for(const line of text.split('\n')){
      const arp=line.match(/\(([^)]+)\).*\bon\s+([\w.-]+)/);
      const ndp=line.match(/^([a-fA-F0-9:]+%[\w.-]+)\s+/);
      const address=arp?.[1]??ndp?.[1];
      if(!address||/incomplete/i.test(line)||!localAddress(address))continue;
      rows.push({address,interface:arp?.[2]??address.split('%')[1],source:'neighbor_cache'});
    }
  }
  return rows;
}

export function configuredSSH(config){
  const result=new Set();
  const visit=value=>{
    if(!value||typeof value!=='object')return;
    for(const [key,v] of Object.entries(value)){
      if(['ssh','ssh_fallbacks'].includes(key)){
        for(const s of [].concat(v??[]))if(typeof s==='string'&&aliasPattern.test(s))result.add(s);
      }else if(typeof v==='object')visit(v);
    }
  };
  visit(config);return [...result].sort();
}

async function mapLimit(items,limit,fn){
  let next=0;const results=Array(items.length);
  await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{
    for(;;){const i=next++;if(i>=items.length)return;results[i]=await fn(items[i],i);}
  }));return results;
}
export function probeSSHPort(address,{timeout=750}={}){
  return new Promise(resolve=>{
    const socket=net.createConnection({host:address,port:22});let done=false;
    const finish=value=>{if(done)return;done=true;socket.destroy();resolve(value);};
    socket.setTimeout(timeout,()=>finish(false));socket.once('connect',()=>finish(true));socket.once('error',()=>finish(false));
  });
}
async function readCommand(command,args,{timeout=5000,partial=false}={}){
  try{return {text:(await execute(command,args,{timeout,maxBuffer:1024*1024})).stdout,complete:true};}
  catch(e){return {text:partial&&typeof e.stdout==='string'?e.stdout:'',complete:false,error:e.code==='ENOENT'?'unavailable':'incomplete'};}
}
export function multicastInterfaces(interfaces,{limit=16}={}){
  const eligible=[],issues=[];
  for(const [name,rows] of Object.entries(interfaces)){
    if(!attachedInterface(name))continue;
    const local=rows.filter(row=>!row.internal);
    if(!local.length)continue;
    if(!local.some(row=>(row.family==='IPv6'||row.family===6)&&/^fe[89ab]/i.test(row.address)&&net.isIP(row.address.split('%')[0])===6)){
      issues.push({interface:name,reason:'no_observed_ipv6_link_local'});continue;
    }
    if(eligible.length>=limit){issues.push({interface:name,reason:'multicast_interface_limit',limit});continue;}
    eligible.push(name);
  }
  return {interfaces:eligible,issues};
}

export function multicastReplyAddresses(text,device){
  if(!attachedInterface(device))return [];
  const addresses=new Set();
  for(const line of text.split('\n')){
    // Only echo replies are evidence: do not interpret the multicast destination,
    // a timeout or an ICMP error as a discovered host.
    const match=line.match(/^\s*\d+ bytes from ([a-fA-F0-9:%\w.-]+)[:,]\s+.*\b(?:icmp_seq|seq)=\d+\b/);
    if(!match)continue;
    const [base,zone,...extra]=match[1].split('%');
    if(extra.length||zone&&zone!==device||net.isIP(base)!==6||!/^fe[89ab]/i.test(base))continue;
    const address=base+'%'+device;if(localAddress(address))addresses.add(address);
  }
  return [...addresses].map(address=>({address,interface:device,source:'ipv6_multicast_reply'}));
}

export async function localNetworkSources({interfaces=os.networkInterfaces(),platform=process.platform,command=readCommand}={}){
  const sweep=networkAddresses(interfaces),multicast=multicastInterfaces(interfaces),issues=[...sweep.issues,...multicast.issues],addresses=[...sweep.addresses];
  const local=new Set(Object.entries(interfaces).flatMap(([name,rows])=>rows.map(row=>net.isIP(row.address.split('%')[0])===6&&/^fe[89ab]/i.test(row.address)?row.address.split('%')[0]+'%'+name:row.address)));
  const append=rows=>addresses.push(...rows.filter(row=>attachedInterface(row.interface)&&!local.has(row.address)));
  if(['darwin','linux'].includes(platform)){
    await mapLimit(multicast.interfaces,4,async device=>{
      const target='ff02::1%'+device;
      const row=await command(platform==='darwin'?'/sbin/ping6':'ping',platform==='darwin'?['-n','-c','2','-I',device,target]:['-6','-n','-c','2','-I',device,target],{timeout:4000,partial:true});
      const replies=multicastReplyAddresses(row.text,device);append(replies);
      if(!replies.length||!row.complete)issues.push({source:'ipv6_multicast',interface:device,reason:row.error==='unavailable'?'probe_unavailable':!replies.length?'no_reply_not_absence':'probe_window_ended'});
    });
  }
  // Read neighbors after the bounded echo window, so new link-local peers can
  // be found even when the old cache was empty or replies went to the OS only.
  if(platform==='darwin'){
    const rows=await Promise.all([command('/usr/sbin/arp',['-an']),command('/usr/sbin/ndp',['-an'])]);
    for(let i=0;i<rows.length;i++){append(neighborAddresses(rows[i].text));if(!rows[i].complete)issues.push({source:i?'ndp':'arp',reason:rows[i].error});}
  }else if(platform==='linux'){
    const row=await command('ip',['-j','neighbor','show']);append(neighborAddresses(row.text,{linux:true}));
    if(!row.complete)issues.push({source:'ip_neighbors',reason:row.error});
  }else issues.push({source:'platform',reason:'neighbor_discovery_unsupported'});
  // Link-local multicast cannot enumerate disconnected/unconfigured NICs,
  // silent peers, other broadcast domains or a known Spark's cable network.
  issues.push({source:'discovery',reason:'silent_unconfigured_and_peer_only_links_not_excluded'});
  return {addresses:[...new Map(addresses.filter(row=>!local.has(row.address)).map(row=>[row.address,row])).values()],issues};
}

export function discoverySSHReason(error){
  if(['host_key_unverified','authentication_unavailable','name_resolution_unavailable','connection_unavailable','inspection_timeout','identity_probe_unavailable'].includes(error?.discovery_reason))return error.discovery_reason;
  const stderr=typeof error?.stderr==='string'?error.stderr:'';
  if(/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/i.test(stderr))return 'host_key_unverified';
  if(/Permission denied \([^\n]*(?:publickey|password|keyboard-interactive)/i.test(stderr))return 'authentication_unavailable';
  if(/Could not resolve hostname|Name or service not known/i.test(stderr))return 'name_resolution_unavailable';
  if(/Connection refused|No route to host|Network is unreachable|Connection timed out/i.test(stderr))return 'connection_unavailable';
  if(error?.killed||error?.code==='ETIMEDOUT')return 'inspection_timeout';
  return 'identity_probe_unavailable';
}
export async function inspectDiscoverySSH(ssh,{knownHosts}){
  try{
    const {stdout}=await execute('ssh',['-T','-o','BatchMode=yes','-o','ConnectTimeout=5','-o',`UserKnownHostsFile=${knownHosts}`,
      '-o','StrictHostKeyChecking=accept-new','--',ssh,`python3 -I -B -c ${quote(sparkIdentityProbe)}`],{timeout:35000,maxBuffer:131072});
    return JSON.parse(stdout);
  }catch(error){throw Object.assign(Error('Spark identity inspection was not confirmed.'),{discovery_reason:discoverySSHReason(error)});}
}
async function resolveSSH(ssh){
  const {stdout}=await execute('ssh',['-G','--',ssh],{timeout:5000,maxBuffer:131072});
  const fields=Object.fromEntries(stdout.split('\n').map(s=>{const i=s.indexOf(' ');return [s.slice(0,i),s.slice(i+1)];}));
  return {hostname:fields.hostname,username:fields.user};
}

function reportedAddresses(facts){
  const rows=[];
  for(const device of Array.isArray(facts?.interfaces)?facts.interfaces:[]){
    if(!interfacePattern.test(device?.ifname??''))continue;
    for(const entry of Array.isArray(device.addr_info)?device.addr_info:[]){
      const base=entry?.local;if(typeof base!=='string')continue;
      const address=net.isIP(base)===6&&/^fe[89ab]/i.test(base)?base+'%'+device.ifname:base;
      if(localAddress(address))rows.push({address,interface:device.ifname,source:'remote_interface_inventory',scope:'Reported by this authenticated host; gateway reachability is not established by this evidence.'});
    }
  }
  return rows;
}
function candidateRecord(facts,identity,existing){
  return {candidate_id:identity,identity,hostname:facts.hostname??null,manufacturer:facts.manufacturer??null,product:facts.product??null,bios_version:facts.bios_version??null,
    device_tree_model:facts.device_tree_model??null,addresses:[],reported_addresses:reportedAddresses(facts),existing_connections:existing,state:existing.length?'existing_spark':'discovered_spark',
    enrollment_ready:false,scope:'Hardware identified; discovery did not enroll, configure, update or qualify this host.'};
}
function initialAccessEndpoint(row,connections){
  return row.state==='ssh_access_unverified'&&row.ssh_open&&net.isIP(row.address)===4&&localAddress(row.address)&&!row.reported_by?.length&&
    !connections.some(c=>c.destination===row.address)&&row.attempts?.some(a=>a.reason==='authentication_unavailable');
}

export function createSparkDiscovery({directory,aliases=async()=>[],sources=localNetworkSources,port=probeSSHPort,inspect=inspectDiscoverySSH,resolve=resolveSSH,now=()=>new Date().toISOString(),maxCandidates=64}={}){
  fs.mkdirSync(directory,{recursive:true,mode:0o700});
  const file=path.join(directory,'discovery.json');let running=null;
  let state=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{state:'not_started'};
  if(state.state==='running')state={...state,state:'observation_lost',scope:'The earlier read-only scan is no longer observed by this dashboard. No enrollment or setup was performed.'};
  const write=(destination,value)=>{const temp=destination+'.'+randomUUID(),fd=fs.openSync(temp,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(value,null,2)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(temp,destination);};
  const save=()=>{
    if(scanIdPattern.test(state.scan_id??'')){const dir=path.join(directory,state.scan_id);fs.mkdirSync(dir,{recursive:true,mode:0o700});write(path.join(dir,'result.json'),state);}
    write(file,state);
  };
  const run=async(username,id)=>{
    const runDir=path.join(directory,id);fs.mkdirSync(runDir,{recursive:true,mode:0o700});
    const knownHosts=path.join(runDir,'known_hosts'),original=path.join(os.homedir(),'.ssh','known_hosts');
    fs.writeFileSync(knownHosts,fs.existsSync(original)?fs.readFileSync(original):'',{mode:0o600,flag:'wx'});
    const issues=[],known=[],connections=[],users=new Set(username?[username]:[]);
    const configured=[...new Set(await aliases())];
    if(configured.length>64)throw Error('More than 64 configured SSH connections; discovery needs an explicit bounded topology.');
    await mapLimit(configured,4,async ssh=>{
      if(!aliasPattern.test(ssh)){issues.push({source:'configured_host',reason:'unsupported_alias'});return;}
      try{
        const resolved=await resolve(ssh);if(userPattern.test(resolved.username??''))users.add(resolved.username);
        connections.push({ssh,destination:resolved.hostname});
        const facts=await inspect(ssh,{knownHosts}),identity=sparkIdentity(facts);
        known.push({ssh,hostname:resolved.hostname,identity,facts});
        if(!identity)issues.push({source:'configured_host',ssh,reason:'physical_identity_unverified'});
      }catch(error){issues.push({source:'configured_host',ssh,reason:discoverySSHReason(error)});}
    });
    const network=await sources();issues.push(...network.issues);
    const addresses=new Map();
    for(const row of network.addresses)if(localAddress(row.address))addresses.set(row.address,row);
    if(addresses.size>1024)throw Error('Discovery source exceeded the 1024-address limit.');
    const ports=await mapLimit([...addresses.values()],32,async row=>({...row,ssh_open:await port(row.address)}));
    const open=ports.filter(row=>row.ssh_open);
    const candidates=new Map(),unverified=[];
    // Authentication through an existing alias is hardware evidence even when
    // literal-address login needs alias-specific keys or routing options.
    for(const host of known.filter(k=>k.identity)){
      let candidate=candidates.get(host.identity);
      if(!candidate){candidate=candidateRecord(host.facts,host.identity,[]);candidates.set(host.identity,candidate);}
      candidate.state='existing_spark';candidate.existing_connections.push(host.ssh);
    }
    if(open.length>maxCandidates)issues.push({source:'ssh_identification',reason:'candidate_limit',limit:maxCandidates});
    if(users.size>4)issues.push({source:'ssh_identification',reason:'ambiguous_usernames'});
    const usernames=username?[username]:users.size<=4?[...users]:[];
    if(!usernames.length)issues.push({source:'ssh_identification',reason:'no_existing_ssh_username'});
    await mapLimit(open.slice(0,maxCandidates),4,async row=>{
      const failures=[];
      for(const user of usernames){
        try{
          const facts=await inspect(`${user}@${row.address}`,{knownHosts}),identity=sparkIdentity(facts);
          if(!identity){unverified.push({...row,state:'not_verified_as_spark'});return;}
          const existing=known.filter(k=>k.identity===identity);
          let candidate=candidates.get(identity);
          if(!candidate){candidate=candidateRecord(facts,identity,existing.map(k=>k.ssh));candidates.set(identity,candidate);}
          candidate.addresses.push({...row,username:user});return;
        }catch(error){failures.push({username:user,reason:discoverySSHReason(error)});}
      }
      // A remote link-local zone can share its name with a local interface but
      // still refer to a different physical link. Never match across scopes.
      const reportedBy=row.address.includes('%')?[]:known.filter(k=>reportedAddresses(k.facts).some(a=>a.address===row.address)).map(k=>k.ssh);
      unverified.push({...row,state:'ssh_access_unverified',attempts:failures,reported_by:reportedBy,scope:reportedBy.length?'An authenticated known host reported this address; this direct SSH path is still unverified.':'No hardware identity is established for this endpoint.'});
    });
    const peers=[];
    for(const host of known)for(const neighbor of Array.isArray(host.facts?.neighbors)?host.facts.neighbors:[]){
      if(!interfacePattern.test(neighbor?.dev??''))continue;
      const address=net.isIP(neighbor.dst)===6&&/^fe[89ab]/i.test(neighbor.dst)?`${neighbor.dst}%${neighbor.dev}`:neighbor.dst;
      if(localAddress(address))peers.push({via:host.ssh,address,interface:neighbor.dev,state:'peer_visible_unverified',scope:address.includes('%')?'IPv6 link-local scope belongs to the remote interface, not a gateway interface.':'Remote neighbor evidence alone establishes neither gateway reachability nor unreachability.'});
    }
    for(const row of unverified){row.endpoint_id=hash([id,row.address]);row.initial_access_available=!!initialAccessEndpoint(row,connections);}
    state={scan_id:id,state:'complete',observed_at:now(),addresses_checked:ports.length,ssh_open:open.length,candidates:[...candidates.values()].sort((a,b)=>a.identity.localeCompare(b.identity)),unverified,peer_neighbors:peers,
      configured_aliases:configured.sort(),configured_connections:connections,known_hosts:known.map(({ssh,identity,hostname,facts})=>({ssh,identity,destination:hostname,reported_addresses:reportedAddresses(facts)})),issues,coverage:'partial',scope:'Read-only discovery. Missing candidates may require multicast, cable configuration, peer reachability or SSH access; this result never proves absence.'};save();
  };
  const status=({scan_id}={})=>{
    if(scan_id===undefined||scan_id===state.scan_id)return structuredClone(state);
    if(!scanIdPattern.test(scan_id))throw Error('Use a saved discovery scan ID.');
    const saved=path.join(directory,scan_id,'result.json');if(!fs.existsSync(saved))throw Error('Discovery scan is not recorded.');
    const result=JSON.parse(fs.readFileSync(saved,'utf8'));
    return result.state==='running'?{...result,state:'observation_lost',scope:'The earlier read-only scan is no longer observed. No enrollment or setup was performed.'}:result;
  };
  const connectionProof=async(connection)=>{
    if(!aliasPattern.test(connection??'')||!(await aliases()).includes(connection))throw Error('Choose an existing configured SSH connection.');
    const resolved=await resolve(connection);
    if(net.isIP(resolved.hostname)!==4||!userPattern.test(resolved.username??''))throw Error('Retained connection repair requires the same configured IPv4 destination and username.');
    const proofs=[];
    for(const id of fs.readdirSync(directory).filter(name=>scanIdPattern.test(name))){
      const scan=status({scan_id:id});
      if(scan.state!=='complete'||!scan.configured_aliases?.includes(connection))continue;
      const row=scan.known_hosts?.find(h=>h.ssh===connection&&h.destination===resolved.hostname&&/^[a-f0-9]{64}$/.test(h.identity??''));
      if(!row)continue;
      const knownHosts=path.join(directory,id,'known_hosts'),stat=fs.lstatSync(knownHosts);
      if(!stat.isFile()||stat.isSymbolicLink()||stat.uid!==process.getuid()||(stat.mode&0o077))throw Error('Retained host-key evidence is not a private owned file; nothing changed.');
      proofs.push({scan_id:id,connection,identity:row.identity,host:resolved.hostname,username:resolved.username,knownHosts,
        known_hosts_sha256:createHash('sha256').update(fs.readFileSync(knownHosts)).digest('hex'),
        scan_sha256:createHash('sha256').update(fs.readFileSync(path.join(directory,id,'result.json'))).digest('hex'),observed_at:scan.observed_at});
    }
    proofs.sort((a,b)=>Date.parse(b.observed_at)-Date.parse(a.observed_at));
    if(!proofs.length)throw Error('No retained authenticated discovery identity matches this configured connection. Discovery or explicit access reconciliation is required.');
    if(new Set(proofs.map(p=>p.identity)).size!==1)throw Error('Retained authenticated hardware identities conflict for this connection; nothing changed.');
    return proofs[0];
  };
  return {status,connectionProof,async configuredConnections(){return [...new Set(await aliases())].sort();},async accessCandidates({scan_id}={}){
    const scan=status({scan_id});
    if(scan.state!=='complete'||!scanIdPattern.test(scan.scan_id??''))throw Error('Ask Genie to finish a discovery scan before authorizing initial access.');
    if(JSON.stringify([...new Set(await aliases())].sort())!==JSON.stringify(scan.configured_aliases))throw Error('A fresh discovery scan is needed after configured connections changed.');
    const knownHosts=path.join(directory,scan.scan_id,'known_hosts');
    if(!fs.existsSync(knownHosts))throw Error('The scan host-key receipt is missing.');
    return {scan_id:scan.scan_id,knownHosts,known_hosts_sha256:createHash('sha256').update(fs.readFileSync(knownHosts)).digest('hex'),
      known_identities:scan.known_hosts.filter(h=>h.identity).map(h=>h.identity),
      endpoints:scan.unverified.filter(row=>initialAccessEndpoint(row,scan.configured_connections)).map(row=>({
          endpoint_id:hash([scan.scan_id,row.address]),host:row.address,username:row.attempts.find(a=>a.reason==='authentication_unavailable'&&userPattern.test(a.username??''))?.username??null,
          scope:'Unidentified SSH endpoint from this scan. Hardware must be verified before adding a key.'})),
    };
  },async candidate({scan_id,candidate_id}){
    if(!scanIdPattern.test(scan_id??'')||!/^[a-f0-9]{64}$/.test(candidate_id??''))throw Error('Select a saved scan and hardware-verified candidate ID.');
    const scan=status({scan_id});if(scan.state!=='complete')throw Error('Wait for this discovery scan to complete.');
    if(JSON.stringify([...new Set(await aliases())].sort())!==JSON.stringify(scan.configured_aliases))throw Error('Configured SSH connections changed or this scan predates enrollment evidence; discover again before enrollment.');
    const candidate=scan.candidates.find(c=>c.candidate_id===candidate_id);
    if(!candidate||candidate.identity!==candidate_id||candidate.state!=='discovered_spark'||candidate.existing_connections.length)throw Error('This is not a hardware-verified new Spark; existing machines cannot be enrolled as new.');
    const address=candidate.addresses.find(a=>a.ssh_open&&net.isIP(a.address)===4&&localAddress(a.address)&&userPattern.test(a.username??''));
    if(!address)throw Error('This candidate has no verified IPv4 SSH path for the current setup transport. Discovery evidence is retained.');
    if(scan.configured_connections.some(c=>c.destination===address.address))throw Error('This address belongs to a configured SSH connection; it cannot be enrolled as new.');
    const knownHosts=path.join(directory,scan_id,'known_hosts');if(!fs.existsSync(knownHosts))throw Error('The scan host-key receipt is missing; no enrollment is allowed.');
    return {scan_id,candidate_id,identity:candidate.identity,host:address.address,username:address.username,knownHosts};
  },async discover({username}={}){
    if(username!==undefined&&!userPattern.test(username))throw Error('Use an SSH username, never a password or command.');
    if(running)return structuredClone(state);
    const id=randomUUID();state={scan_id:id,state:'running',started_at:now(),scope:'Read-only discovery; no enrollment or setup.'};save();
    running=run(username,id).catch(()=>{state={...state,state:'failed',finished_at:now(),error:'Discovery did not finish. Inspect the same scan; no enrollment or setup was performed.'};try{save();}catch{state.error+=' The failure receipt could not be saved; retained files were not replaced with a successful result.';}}).finally(()=>{running=null;});
    return structuredClone(state);
  },settled:()=>running??Promise.resolve()};
}
