import { spawn } from 'node:child_process';
// Independently supervised SSH transport. Never an inference-pool registration.
export function genieTunnel(config) {
  if(!config?.ssh)return ()=>{};
  const url=new URL(config.url),port=Number(url.port),remote=Number(config.remote_port);
  if(url.hostname!=='127.0.0.1'||!Number.isInteger(port)||port<1024||port>65535||!Number.isInteger(remote)||remote<1||remote>65535||
    !/^[a-zA-Z0-9][\w.@-]{0,252}$/.test(config.ssh))throw new Error('Invalid Genie SSH tunnel configuration');
  let child,timer,closed=false;
  const start=()=>{
    if(closed)return;
    child=spawn('/usr/bin/ssh',['-N','-T','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ExitOnForwardFailure=yes',
      '-o','ConnectTimeout=8','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=2',
      '-L',`127.0.0.1:${port}:127.0.0.1:${remote}`,config.ssh],{stdio:'ignore'});
    child.on('error',()=>{});
    child.on('close',()=>{if(!closed)timer=setTimeout(start,10000);});
  };
  start();return ()=>{closed=true;clearTimeout(timer);child?.kill();};
}
