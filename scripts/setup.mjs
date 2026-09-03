// Explicit initialization only. Never overwrite existing config or print its key.
import fs from 'node:fs';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {configPath,projectRoot} from '../ds4-gateway/config.mjs';
try {
  const args=process.argv.slice(2);
  if(args.some(x=>x!=='--controls')||args.length>1)throw new Error('Usage: npm run setup -- [--controls]');
  const destination=configPath();
  const config=JSON.parse(fs.readFileSync(path.join(projectRoot,'examples/config.json'),'utf8'));
  Object.assign(config,{api_key:randomBytes(32).toString('base64url'),nodes:[],state_file:'./runtime/affinity.json',control_socket:'./runtime/control.sock',ui_worker_management:args.includes('--controls')});
  fs.writeFileSync(destination,JSON.stringify(config,null,2)+'\n',{flag:'wx',mode:0o600});
  console.log(`Created private config: ${destination}\nNo workers or services were changed. Add existing DS4 endpoints in the local UI${config.ui_worker_management?'': ' after explicitly enabling ui_worker_management'}, or edit nodes in this file. Run npm run doctor next. The API key is in the private file, not this output.`);
}catch(error){console.error(error.code==='EEXIST'?'Configuration already exists; nothing overwritten.':error.message);process.exitCode=1;}
