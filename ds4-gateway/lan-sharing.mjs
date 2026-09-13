import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';

let hostnameCheckedAt=0,cachedHostname=null;
export function localHostname(now=Date.now()){
  if(now-hostnameCheckedAt<60000&&hostnameCheckedAt)return cachedHostname;
  hostnameCheckedAt=now;cachedHostname=null;
  // LocalHostName is the Bonjour name, unlike ComputerName or a DHCP-derived
  // os.hostname(). Never append .local to an unverified name on other systems.
  if(process.platform==='darwin')try{
    const name=execFileSync('/usr/sbin/scutil',['--get','LocalHostName'],{encoding:'utf8',timeout:1000,stdio:['ignore','pipe','ignore']}).trim();
    if(/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(name))cachedHostname=name+'.local';
  }catch{/* Keep usable IP addresses when Bonjour discovery is unavailable. */}
  return cachedHostname;
}
export function lanSharingDetails(value,port,hostname=localHostname()){
  const ips=value.urls??[];
  const valid=typeof hostname==='string'&&/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.local$/.test(hostname);
  const preferred=valid&&ips.length&&Number.isInteger(port)&&port>0&&port<=65535?`http://${hostname}:${port}/v1`:null;
  return {...value,hostname_url:preferred,ip_urls:ips,urls:preferred?[preferred,...ips]:ips};
}

export const isLoopback=address=>address==='::1'||/^127\./.test(address??'')||/^::ffff:127\./i.test(address??'');
export const lanSharingFile=config=>path.join(path.dirname(config.state_file??config.continuity_door.control_socket),'lan-sharing.json');
export const lanBindable=config=>!!config.host&&!isLoopback(config.host)&&config.host!=='localhost';
export function readLanSharing(file,initialEnabled){
  let value;
  try{value=JSON.parse(fs.readFileSync(file,'utf8'));}
  catch(error){if(error.code==='ENOENT')return {schema:1,enabled:initialEnabled};throw new Error('LAN sharing state cannot be read; existing state must be preserved');}
  if(value?.schema!==1||typeof value.enabled!=='boolean')throw new Error('Invalid LAN sharing state; existing state must be preserved');
  return {schema:1,enabled:value.enabled};
}
export function writeLanSharing(file,enabled,initialEnabled){
  if(typeof enabled!=='boolean')throw new Error('LAN sharing enabled must be boolean');
  readLanSharing(file,initialEnabled);
  const value={schema:1,enabled},temporary=`${file}.${randomUUID()}.tmp`;
  fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  try{
    if(fs.existsSync(file))fs.copyFileSync(file,`${file}.${Date.now()}.${randomUUID()}.bak`,fs.constants.COPYFILE_EXCL);
    const fd=fs.openSync(temporary,'wx',0o600);
    try{fs.writeFileSync(fd,JSON.stringify(value)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    fs.renameSync(temporary,file);
  }finally{try{fs.unlinkSync(temporary);}catch(error){if(error.code!=='ENOENT')throw error;}}
  return value;
}
export function lanAddresses(config,interfaces=os.networkInterfaces()){
  const privateIPv4=address=>/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address);
  return [...new Set(Object.entries(interfaces).filter(([name])=>!/^(utun|tun|tap|tailscale|docker|veth|awdl|llw)/i.test(name))
    .sort(([a],[b])=>a.localeCompare(b,undefined,{numeric:true})).flatMap(([,rows])=>(rows??[])
      .filter(row=>!row.internal&&row.family==='IPv4'&&privateIPv4(row.address)&&(config.host==='0.0.0.0'||config.host==='::'||config.host===row.address))
      .map(row=>`http://${row.address}:${config.port}/v1`)))];
}
