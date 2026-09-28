import fs from 'node:fs';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {configPath,projectRoot} from '../ds4-gateway/config.mjs';
const args=process.argv.slice(2);
if(args.includes('--help')){console.log('npm run setup -- [--controls] [--gateway-only] — installs gateway configuration; legacy Genie has been removed.');}
else {
  if(args.some(x=>!['--controls','--gateway-only'].includes(x)))throw Error('Use --controls or --gateway-only. Agent setup is not available in gateway-only mode.');
  const destination=configPath();
  if(fs.existsSync(destination))console.log('Existing gateway configuration preserved. Gateway-only mode; no agent is installed or started.');
  else {
    const config={...JSON.parse(fs.readFileSync(path.join(projectRoot,'examples/config.json'))),api_key:randomBytes(32).toString('base64url'),nodes:[],state_file:'./runtime/affinity.json',control_socket:'./runtime/control.sock',ui_worker_management:args.includes('--controls'),genie:false};
    delete config.genie_chat;
    fs.writeFileSync(destination,JSON.stringify(config,null,2)+'\n',{flag:'wx',mode:0o600});
    console.log('Gateway configuration saved. Run npm run doctor, then ./start-dsg.sh on macOS.');
  }
}
