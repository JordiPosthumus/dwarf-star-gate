// Carry a scan's verified host keys into the normal SSH transport without
// accepting another first-use key or rewriting the owner's SSH configuration.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID,createHash} from 'node:crypto';
const execute=promisify(execFile);
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
async function matchingKeys(file,host,command){
  if(!fs.existsSync(file))return [];
  let stdout;
  try{({stdout}=await command('ssh-keygen',['-F',host,'-f',file],{timeout:10000,maxBuffer:131072}));}
  catch(error){if(error.code===1&&!error.stdout&&!error.stderr)return [];throw Error('SSH host-key receipt could not be read; no trust was changed.');}
  return stdout.split('\n').filter(line=>line.trim()&&!line.startsWith('#')).map(line=>{
    const fields=line.trim().split(/\s+/);
    if(fields.length<3||fields[0].startsWith('@')||!/^[-\w]+$/.test(fields[1])||!/^[A-Za-z0-9+/]+={0,3}$/.test(fields[2]))throw Error('Unsupported host-key record; preserve it for explicit inspection.');
    // Only this exact destination gains trust, even if the source line also
    // names other hosts or uses a wildcard. Comments are not copied.
    return fields[1]+' '+fields[2];
  });
}
export async function promoteDiscoveryTrust({ssh,host,username,knownHosts,directory},{home=os.homedir(),command=execute}={}){
  if(net.isIP(host)!==4||ssh!==`${username}@${host}`)throw Error('Trust promotion requires the verified IPv4 discovery destination.');
  const {stdout}=await command('ssh',['-G','--',ssh],{timeout:10000,maxBuffer:131072});
  const settings=Object.fromEntries(stdout.split('\n').map(line=>{const i=line.indexOf(' ');return [line.slice(0,i),line.slice(i+1)];}));
  const known=path.join(home,'.ssh','known_hosts');
  const stores=(settings.userknownhostsfile??'').split(/\s+/).map(p=>p.startsWith('~/')?path.join(home,p.slice(2)):p);
  if(settings.hostname!==host||settings.user!==username||settings.port!=='22'||settings.hostkeyalias&&settings.hostkeyalias!=='none'||!stores.includes(known)||
    !['yes','true','ask','accept-new'].includes(settings.stricthostkeychecking))throw Error('Existing SSH configuration does not provide the required destination and host-key checks. It was preserved; no enrollment was performed.');
  const keys=[...new Set(await matchingKeys(knownHosts,host,command))];
  if(!keys.length)throw Error('The scan has no pinned host-key record for this address; no enrollment was performed.');
  if(fs.existsSync(known)){const stat=fs.lstatSync(known);if(!stat.isFile()||stat.isSymbolicLink()||stat.uid!==process.getuid()||(stat.mode&0o022))throw Error('Existing known_hosts is not a regular owner-controlled file; preserved unchanged.');}
  const original=fs.existsSync(known)?fs.readFileSync(known):null;
  const current=await matchingKeys(known,host,command);
  if(current.some(key=>!keys.includes(key)))throw Error('The normal SSH trust store has a different key for this host; it was preserved unchanged.');
  const additions=keys.filter(key=>!current.includes(key));
  if(!additions.length)return {changed:false,keys:keys.length};
  fs.mkdirSync(directory,{recursive:true,mode:0o700});
  const stamp=`${Date.now()}-${randomUUID()}`,prepared=path.join(directory,`host-key-${stamp}`);
  let bytes=Buffer.from(additions.map(key=>host+' '+key).join('\n')+'\n');
  if(['yes','true'].includes(settings.hashknownhosts)){
    fs.writeFileSync(prepared,bytes,{flag:'wx',mode:0o600});
    try{await command('ssh-keygen',['-H','-f',prepared],{timeout:10000,maxBuffer:131072});bytes=fs.readFileSync(prepared);}
    finally{for(const file of [prepared,prepared+'.old'])if(fs.existsSync(file))fs.unlinkSync(file);}
  }
  if(original)fs.writeFileSync(path.join(directory,'known-hosts-before-'+stamp),original,{flag:'wx',mode:0o600});
  fs.mkdirSync(path.dirname(known),{recursive:true,mode:0o700});
  const fd=fs.openSync(known,original===null?'wx':fs.constants.O_RDWR|fs.constants.O_APPEND|fs.constants.O_NOFOLLOW,0o600);
  try{
    if(original!==null){const stat=fs.fstatSync(fd);if(!stat.isFile()||!fs.readFileSync(fd).equals(original))throw Error('SSH trust changed during enrollment; no keys were appended.');}
    if(original?.length&&original.at(-1)!==10)bytes=Buffer.concat([Buffer.from('\n'),bytes]);
    fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);
  }finally{fs.closeSync(fd);}
  return {changed:true,keys:keys.length,added_sha256:digest(bytes)};
}
