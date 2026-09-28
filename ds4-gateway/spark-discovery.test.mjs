import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createSparkDiscovery,sparkIdentity,networkAddresses,neighborAddresses,localAddress,configuredSSH,sparkIdentityProbe,multicastInterfaces,multicastReplyAddresses,localNetworkSources,discoverySSHReason} from './spark-discovery.mjs';
import {createSparkSetupTools} from './spark-setup-transport.mjs';

// Generate synthetic RFC1918 addresses for locality tests; never use deployment inventory.
const ip=(...octets)=>octets.join('.');
const facts=(id='a')=>({system:'Linux',architecture:'aarch64',machine_id:id.repeat(64),hostname:'observed-spark',manufacturer:'NVIDIA',product:'DGX Spark',bios_version:'fixture-version',
  gpus:[{name:'NVIDIA GB10',uuid:`GPU-${id.repeat(32)}`}],neighbors:[]});
function fixture(t,extra={}){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'sg-discovery-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const calls=[];
  const options={directory,aliases:async()=>['existing-spark'],resolve:async()=>({hostname:ip(192,168,9,2),username:'owner'}),
    sources:async()=>({addresses:[{address:ip(192,168,9,2)},{address:ip(192,168,9,3)},{address:ip(192,168,9,4)}],issues:[]}),port:async()=>true,
    inspect:async(ssh,opts)=>{calls.push({ssh,opts});return facts(ssh==='existing-spark'||ssh.endsWith('.2')?'a':'b');},...extra};
  return {directory,calls,options,service:createSparkDiscovery(options)};
}
test('connected subnet discovery handles small cable networks and reports unsearched large networks',()=>{
  const result=networkAddresses({en0:[{address:ip(192,168,9,1),family:'IPv4',cidr:`${ip(192,168,9,1)}/30`}],en1:[{address:ip(10,1,0,1),family:'IPv4',cidr:`${ip(10,1,0,1)}/16`}],utun4:[{address:ip(10,2,0,1),family:'IPv4',cidr:`${ip(10,2,0,1)}/24`}]});
  assert.deepEqual(result.addresses,[{address:ip(192,168,9,2),interface:'en0',source:'connected_subnet'}]);
  assert.equal(result.issues[0].reason,'subnet_too_large_for_bounded_sweep');
  assert.equal(networkAddresses({en0:[{address:ip(10,0,0,0),family:4,cidr:`${ip(10,0,0,0)}/31`}]}).addresses[0].address,ip(10,0,0,1));
  const capped=networkAddresses({en0:[{address:ip(10,0,0,1),family:4,cidr:`${ip(10,0,0,1)}/24`}]},{limit:4});
  assert.equal(capped.addresses.length,4);assert.equal(capped.issues[0].reason,'address_limit');
});
test('only local address literals and correctly scoped link-local IPv6 become probe targets',()=>{
  for(const address of [ip(10,0,0,2),ip(172,16,0,1),ip(192,168,1,2),'169.254.1.2','fe80::12%en5','fd12::2'])assert.equal(localAddress(address),true,address);
  for(const address of ['1.1.1.1','127.0.0.1','0.0.0.0','224.0.0.1','::1','fe80::12','fd12::2%en5','fe80::12%en5;reboot',`${ip(10,0,0,2)}%en0`,'-oProxyCommand=x',['hostname','local'].join('.')])assert.equal(localAddress(address),false,address);
});
test('neighbor caches preserve origin interfaces and reject failed or public entries',()=>{
  const mac=neighborAddresses(`? (${ip(192,168,9,3)}) at aa:bb:cc:dd:ee:ff on en0 ifscope [ethernet]\nfe80::12%en5 aa:bb:cc:dd:ee:00 en5 23h59m59s S\n? (${ip(192,168,9,4)}) at (incomplete) on en0 ifscope [ethernet]`);
  assert.deepEqual(mac.map(r=>r.address),[ip(192,168,9,3),'fe80::12%en5']);
  const linux=neighborAddresses(JSON.stringify([{dst:'fe80::1',dev:'enp1s0',state:['REACHABLE']},{dst:ip(10,1,0,3),dev:'eth0',state:['FAILED']},{dst:'8.8.8.8',dev:'eth0',state:['REACHABLE']}]),{linux:true});
  assert.equal(linux.length,1);assert.equal(linux[0].address,'fe80::1%enp1s0');
});
test('multicast probes only observed link-local interfaces, bounds fanout and excludes tunnels',()=>{
  const link={address:'fe80::1',family:'IPv6',internal:false};
  const result=multicastInterfaces({en0:[link],en5:[link],en6:[link],utun4:[link],lo0:[{...link,internal:true}],eth9:[{family:'IPv4',address:ip(10,0,0,1)}]},{limit:2});
  assert.deepEqual(result.interfaces,['en0','en5']);
  assert.ok(result.issues.some(r=>r.interface==='en6'&&r.reason==='multicast_interface_limit'));
  assert.ok(result.issues.some(r=>r.interface==='eth9'&&r.reason==='no_observed_ipv6_link_local'));
});
test('multicast replies retain exact local scope and reject errors, destination headers and foreign scopes',()=>{
  const text=['PING6(56=40+8+8 bytes) fe80::1%en5 --> ff02::1%en5',
    '16 bytes from fe80::2%en5, icmp_seq=0 hlim=64 time=0.3 ms',
    '64 bytes from fe80::3: icmp_seq=1 ttl=64 time=0.4 ms',
    '64 bytes from fe80::4%en0: icmp_seq=1 ttl=64 time=0.4 ms',
    '64 bytes from 2001:db8::2: icmp_seq=1 ttl=64 time=0.4 ms',
    'From fe80::5%en5 icmp_seq=1 Destination unreachable: Address unreachable',
    'Request timeout for icmp_seq 1','64 bytes from fe80::3: icmp_seq=1 ttl=64 time=0.4 ms (DUP!)'].join('\n');
  assert.deepEqual(multicastReplyAddresses(text,'en5').map(r=>r.address),['fe80::2%en5','fe80::3%en5']);
  assert.deepEqual(multicastReplyAddresses(text,'en5; command'),[]);
});
test('macOS cable discovery retains replies from an expired probe and refreshes neighbors afterward',async()=>{
  const calls=[],interfaces={en5:[{family:'IPv6',address:'fe80::1%en5'}],utun8:[{family:'IPv6',address:'fe80::9%utun8'}]};
  const result=await localNetworkSources({interfaces,platform:'darwin',command:async(command,args,options)=>{
    calls.push({command,args,options});
    if(command==='/sbin/ping6')return {text:'16 bytes from fe80::1%en5, icmp_seq=0 hlim=64 time=0.1 ms\n16 bytes from fe80::2%en5, icmp_seq=0 hlim=64 time=0.2 ms',complete:false,error:'incomplete'};
    if(command==='/usr/sbin/ndp')return {text:'fe80::3%en5 aa:bb:cc:dd:ee:ff en5 23h59m59s S\nfe80::8%utun8 aa:bb:cc:dd:ee:ff utun8 23h59m59s S',complete:true};
    return {text:'',complete:true};
  }});
  assert.deepEqual(calls[0],{command:'/sbin/ping6',args:['-n','-c','2','-I','en5','ff02::1%en5'],options:{timeout:4000,partial:true}});
  assert.deepEqual(result.addresses.map(r=>r.address),['fe80::2%en5','fe80::3%en5']);
  assert.ok(result.issues.some(r=>r.reason==='probe_window_ended'));
  assert.equal(calls.length,3);
});
test('Linux cable discovery uses IPv6 ping and reports silence without declaring absence',async()=>{
  const calls=[],interfaces={eth0:[{family:6,address:'fe80::1'}]};
  const result=await localNetworkSources({interfaces,platform:'linux',command:async(command,args)=>{
    calls.push({command,args});return command==='ping'?{text:'',complete:false,error:'incomplete'}:{text:JSON.stringify([{dst:'fe80::2',dev:'eth0',state:['REACHABLE']}]),complete:true};
  }});
  assert.deepEqual(calls,[{command:'ping',args:['-6','-n','-c','2','-I','eth0','ff02::1%eth0']},{command:'ip',args:['-j','neighbor','show']}]);
  assert.equal(result.addresses[0].address,'fe80::2%eth0');assert.ok(result.issues.some(r=>r.reason==='no_reply_not_absence'));
});
test('hardware identity requires GB10 and stable host/GPU IDs, and ignores names and interface addresses',()=>{
  const original=facts();assert.equal(sparkIdentity(original),sparkIdentity({...original,hostname:'different-hostname'}));
  assert.notEqual(sparkIdentity(original),sparkIdentity(facts('b')));
  for(const patch of [{system:'Darwin'},{architecture:'x86_64'},{machine_id:null},{gpus:[]},{gpus:[{name:'NVIDIA Other',uuid:original.gpus[0].uuid}]},{gpus:[original.gpus[0],original.gpus[0]]}])assert.equal(sparkIdentity({...original,...patch}),null);
  assert.doesNotMatch(sparkIdentityProbe,/\b(sudo|reboot|apt|install|docker|fwupdmgr)\b/);
});
test('configured usernames/connections come from nested SSH fields rather than arbitrary config text',()=>{
  assert.deepEqual(configuredSSH({workers:[{ssh:'first',ssh_fallbacks:['backup']}],profile:{nested:{ssh:['second','first']}},token:'secret',prompt:'ssh root@elsewhere'}),['backup','first','second']);
});
test('a scan deduplicates physical hosts, distinguishes existing workers, and persists evidence without enrollment',async t=>{
  const f=fixture(t);const accepted=await f.service.discover();assert.equal(accepted.state,'running');
  await f.service.settled();const result=f.service.status();assert.equal(result.state,'complete');assert.equal(result.candidates.length,2);
  assert.equal(result.candidates.find(c=>c.state==='existing_spark').existing_connections[0],'existing-spark');
  const candidate=result.candidates.find(c=>c.state==='discovered_spark');assert.equal(candidate.addresses.length,2);assert.equal(candidate.enrollment_ready,false);
  assert.equal(result.coverage,'partial');assert.ok(f.calls.every(c=>c.opts.knownHosts.startsWith(f.directory)));
  assert.equal(fs.statSync(path.join(f.directory,'discovery.json')).mode&0o777,0o600);
  assert.equal(fs.existsSync(path.join(f.directory,'targets.json')),false);
  const restored=createSparkDiscovery(f.options);assert.deepEqual(restored.status(),result);
});
test('repeated discovery while a scan is observed returns its existing ID, status reads do not launch probes',async t=>{
  let release;const wait=new Promise(r=>release=r);let sources=0;
  const f=fixture(t,{sources:async()=>{sources++;await wait;return {addresses:[],issues:[]};}});
  const first=await f.service.discover(),second=await f.service.discover();assert.equal(first.scan_id,second.scan_id);
  f.service.status();f.service.status();release();await f.service.settled();assert.equal(sources,1);
});
test('a lost dashboard observation is explicit and never silently restarts the scan',t=>{
  const f=fixture(t);fs.writeFileSync(path.join(f.directory,'discovery.json'),JSON.stringify({state:'running',scan_id:'old-scan'}));
  const service=createSparkDiscovery(f.options);assert.equal(service.status().state,'observation_lost');assert.equal(service.status().scan_id,'old-scan');assert.equal(f.calls.length,0);
});
test('later scans preserve earlier receipts and status cannot escape the private scan directory',async t=>{
  const f=fixture(t);const first=await f.service.discover();await f.service.settled();const expected=f.service.status();
  const second=await f.service.discover();await f.service.settled();assert.notEqual(second.scan_id,first.scan_id);
  const restored=createSparkDiscovery(f.options);assert.deepEqual(restored.status({scan_id:first.scan_id}),expected);
  for(const scan_id of ['../../outside','invalid','00000000-0000-4000-8000-000000000000'])assert.throws(()=>restored.status({scan_id}));
});
test('a failed receipt write is reported without an unhandled background rejection',async t=>{
  let release;const gate=new Promise(resolve=>release=resolve);
  const f=fixture(t,{sources:async()=>{await gate;throw Error('source unavailable');}});
  await f.service.discover();const file=path.join(f.directory,'discovery.json');fs.renameSync(file,file+'.retained');fs.mkdirSync(file);
  release();await f.service.settled();assert.equal(f.service.status().state,'failed');assert.match(f.service.status().error,/could not be saved/);
  assert.equal(JSON.parse(fs.readFileSync(file+'.retained')).state,'running');
});
test('unavailable SSH and neighbor-only links remain uncertain and never become enrollment-ready',async t=>{
  const f=fixture(t,{inspect:async ssh=>{if(ssh!=='existing-spark')throw Error('private authentication detail');return {...facts(),neighbors:[{dst:'fe80::2',dev:'enp1s0'}]};}});
  await f.service.discover();await f.service.settled();const result=f.service.status();assert.equal(result.candidates.length,1);assert.equal(result.candidates[0].state,'existing_spark');assert.equal(result.unverified.length,3);
  assert.deepEqual(result.peer_neighbors[0],{via:'existing-spark',address:'fe80::2%enp1s0',interface:'enp1s0',state:'peer_visible_unverified',scope:'IPv6 link-local scope belongs to the remote interface, not a gateway interface.'});
  assert.doesNotMatch(JSON.stringify(result),/private authentication/);
});
test('all authenticated configured machines survive direct-IP authentication failure without becoming new candidates',async t=>{
  const aliases=['alpha','beta','gamma','delta','gamma-backup'],calls=[];
  const index=alias=>alias==='gamma-backup'?2:aliases.indexOf(alias);
  const interfaces=i=>[{ifname:'eth0',addr_info:[{local:ip(192,168,9,i+2)}]}];
  const f=fixture(t,{aliases:async()=>aliases,resolve:async ssh=>({hostname:ip(192,168,9,index(ssh)+2),username:'owner'}),
    sources:async()=>({addresses:[2,3,4,5,6].map(n=>({address:ip(192,168,9,n)})),issues:[]}),
    inspect:async ssh=>{
      calls.push(ssh);
      if(aliases.includes(ssh)){const i=index(ssh);return {...facts('abcd'[i]),interfaces:interfaces(i)};}
      throw Object.assign(Error('private login detail'),{stderr:'owner@private-host: Permission denied (publickey,password).'});
    }});
  await f.service.discover();await f.service.settled();const result=f.service.status();
  assert.equal(result.state,'complete');assert.equal(result.candidates.length,4);assert.equal(result.known_hosts.length,5);
  assert.ok(result.candidates.every(c=>c.state==='existing_spark'&&c.addresses.length===0&&c.reported_addresses.length===1&&!c.enrollment_ready));
  assert.deepEqual(result.candidates.find(c=>c.identity===sparkIdentity(facts('c'))).existing_connections.sort(),['gamma','gamma-backup']);
  assert.deepEqual(result.unverified.find(r=>r.address===ip(192,168,9,4)).reported_by.sort(),['gamma','gamma-backup']);
  assert.deepEqual(result.unverified.find(r=>r.address===ip(192,168,9,6)).reported_by,[]);
  assert.ok(result.unverified.every(r=>r.attempts[0].reason==='authentication_unavailable'));
  assert.ok(result.known_hosts.every(h=>h.reported_addresses.length===1&&h.destination));
  assert.equal(calls.length,10);assert.doesNotMatch(JSON.stringify(result),/private login|private-host|Permission denied/);
});
test('remote interface scope never identifies a local link just because its interface name matches',async t=>{
  const f=fixture(t,{sources:async()=>({addresses:[{address:'fe80::2%eth0'}],issues:[]}),inspect:async ssh=>{
    if(ssh!=='existing-spark')throw Object.assign(Error(),{stderr:'No route to host'});
    return {...facts(),interfaces:[null,{ifname:'bad;command',addr_info:[{local:ip(10,1,0,2)}]},{ifname:'broken',addr_info:{}},{ifname:'eth0',addr_info:[null,{local:'fe80::2'},{local:ip(10,1,0,2)}]}],neighbors:[null,{dst:ip(10,1,0,3),dev:'eth0'}]};
  }});
  await f.service.discover();await f.service.settled();const result=f.service.status();
  assert.equal(result.state,'complete');assert.deepEqual(result.unverified[0].reported_by,[]);
  assert.equal(result.unverified[0].attempts[0].reason,'connection_unavailable');
  assert.equal(result.candidates[0].reported_addresses.length,2);
  assert.match(result.peer_neighbors[0].scope,/neither gateway reachability nor unreachability/);
});
test('SSH diagnostics separate access, transport, trust and probe uncertainty without exposing stderr',()=>{
  for(const [stderr,expected] of [
    ['Permission denied (publickey,password).','authentication_unavailable'],
    ['Permission denied (keyboard-interactive).','authentication_unavailable'],
    ['WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!','host_key_unverified'],
    ['Host key verification failed.','host_key_unverified'],
    ['Could not resolve hostname private-machine: nodename nor servname provided','name_resolution_unavailable'],
    ['ssh: connect to host private-machine port 22: Connection refused','connection_unavailable'],
    ['No route to host','connection_unavailable'],
    ['Connection timed out','connection_unavailable'],
    ['python3: command not found','identity_probe_unavailable'],
  ])assert.equal(discoverySSHReason({stderr}),expected);
  assert.equal(discoverySSHReason({killed:true}),'inspection_timeout');
  assert.equal(discoverySSHReason({code:'ETIMEDOUT'}),'inspection_timeout');
  assert.equal(discoverySSHReason({discovery_reason:'secret details'}),'identity_probe_unavailable');
  assert.equal(discoverySSHReason({discovery_reason:'authentication_unavailable'}),'authentication_unavailable');
});
test('initial-access eligibility binds saved IDs and keys and excludes known inventory, IPv6 and transport failures',async t=>{
  let aliases=['existing-spark'];
  const addresses=[2,3,4,5].map(n=>({address:ip(192,168,9,n)}));addresses.push({address:'fe80::2%en5'});
  const f=fixture(t,{aliases:async()=>aliases,sources:async()=>({addresses,issues:[]}),inspect:async ssh=>{
    if(ssh==='existing-spark')return {...facts(),interfaces:[{ifname:'eth0',addr_info:[{local:ip(192,168,9,3)}]}]};
    throw Object.assign(Error(),{stderr:ssh.endsWith('.5')?'No route to host':'Permission denied (publickey,password).'});
  }});
  await f.service.discover();await f.service.settled();const scan=f.service.status();
  assert.deepEqual(scan.unverified.filter(e=>e.initial_access_available).map(e=>e.address),[ip(192,168,9,4)]);
  const proof=await f.service.accessCandidates({scan_id:scan.scan_id});assert.equal(proof.endpoints.length,1);assert.equal(proof.endpoints[0].endpoint_id,scan.unverified.find(e=>e.initial_access_available).endpoint_id);
  assert.deepEqual(proof.known_identities,[sparkIdentity(facts())]);assert.match(proof.known_hosts_sha256,/^[a-f0-9]{64}$/);
  aliases.push('other');await assert.rejects(f.service.accessCandidates({scan_id:scan.scan_id}),/fresh discovery/);
});
test('setup tool exposes discovery with capability/testing gates and strict argument schemas',async t=>{
  const f=fixture(t);let enabled=false,testing=false;
  const tools=createSparkSetupTools({ui_worker_management:true,spark_setup:{enabled:true}},{discovery:f.service,isEnabled:()=>enabled,isTesting:()=>testing});
  await assert.rejects(tools.tool({action:'discover'}),/switched off/);enabled=true;testing=true;await assert.rejects(tools.tool({action:'discover'}),/testing mode/);testing=false;
  for(const extra of [{password:'no'},{host:ip(10,0,0,1)},{command:'reboot'},{username:'owner;whoami'}])await assert.rejects(tools.tool({action:'discover',...extra}));
  const result=await tools.tool({action:'discover'});await f.service.settled();assert.equal((await tools.tool({action:'discovery_status'})).scan_id,result.scan_id);
  assert.equal((await tools.tool({action:'status'})).discovery.state,'complete');
  await assert.rejects(tools.tool({action:'discovery_status',username:'owner'}),/no other arguments/);
});
test('no configured user never invents a login, and incomplete known-host identity stays visible',async t=>{
  const f=fixture(t,{aliases:async()=>[]});await f.service.discover();await f.service.settled();
  assert.equal(f.calls.length,0);assert.ok(f.service.status().issues.some(i=>i.reason==='no_existing_ssh_username'));
  const g=fixture(t,{inspect:async()=>{throw Error('unreachable');}});await g.service.discover();await g.service.settled();
  assert.ok(g.service.status().issues.some(i=>i.reason==='identity_probe_unavailable'));
});
test('read-only discovery uses inspection permission without enabling new-host enrollment',async t=>{
  const f=fixture(t);let inspection=true;
  const tools=createSparkSetupTools({ui_worker_management:true,spark_setup:{enabled:true}},{discovery:f.service,isEnabled:()=>false,isDiscoveryEnabled:()=>inspection});
  assert.equal((await tools.tool({action:'discover'})).state,'running');await f.service.settled();
  await assert.rejects(tools.tool({action:'enroll',target_id:'new'}),/New Spark setup is switched off/);
  inspection=false;await assert.rejects(tools.tool({action:'discover'}),/Server inspection is switched off/);
  assert.equal((await tools.tool({action:'discovery_status'})).state,'complete','Existing receipts stay readable when inspection is disabled.');
});
test('candidate enrollment resolves IDs from saved evidence, excludes existing machines and rejects changed topology',async t=>{
  let aliases=['existing-spark'];const f=fixture(t,{aliases:async()=>aliases});
  await f.service.discover();await f.service.settled();const scan=f.service.status(),candidate=scan.candidates.find(c=>c.state==='discovered_spark');
  const ids={scan_id:scan.scan_id,candidate_id:candidate.candidate_id};
  const proof=await f.service.candidate(ids);assert.equal(proof.host,ip(192,168,9,3));assert.equal(proof.username,'owner');assert.equal(proof.identity,candidate.identity);
  assert.equal(proof.knownHosts,path.join(f.directory,scan.scan_id,'known_hosts'));
  await assert.rejects(f.service.candidate({...ids,candidate_id:scan.candidates.find(c=>c.state==='existing_spark').candidate_id}),/not a hardware-verified new/);
  await assert.rejects(f.service.candidate({...ids,scan_id:'../escape'}),/saved scan/);
  aliases.push('added-host');await assert.rejects(f.service.candidate(ids),/connections changed/);
});
test('IPv6-only evidence, missing pinned keys and configured destinations cannot become new enrollments',async t=>{
  const f=fixture(t,{aliases:async()=>[],sources:async()=>({addresses:[{address:'fe80::2%en5'}],issues:[]})});
  await f.service.discover({username:'owner'});await f.service.settled();const scan=f.service.status();
  await assert.rejects(f.service.candidate({scan_id:scan.scan_id,candidate_id:scan.candidates[0].candidate_id}),/no verified IPv4/);
  const g=fixture(t);await g.service.discover();await g.service.settled();const second=g.service.status();
  const ids={scan_id:second.scan_id,candidate_id:second.candidates.find(c=>c.state==='discovered_spark').candidate_id};
  fs.unlinkSync(path.join(g.directory,ids.scan_id,'known_hosts'));await assert.rejects(g.service.candidate(ids),/host-key receipt is missing/);
  const h=fixture(t,{resolve:async()=>({hostname:ip(192,168,9,3),username:'owner'})});await h.service.discover();await h.service.settled();const third=h.service.status();
  await assert.rejects(h.service.candidate({scan_id:third.scan_id,candidate_id:third.candidates.find(c=>c.state==='discovered_spark').candidate_id}),/configured SSH connection/);
});
