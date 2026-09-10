// Prepare only. Never edits Pi's live profile or restarts any service.
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
import {preparePiModelRoutes} from '../ds4-gateway/pi-model-routes.mjs';
const args=process.argv.slice(2),options={};
for(let i=0;i<args.length;i+=2){if(!['--models','--out'].includes(args[i])||!args[i+1])throw new Error('Usage: prepare-pi-model-routes.mjs [--models path] [--out path]');options[args[i]]=args[i+1];}
const source=path.resolve(options['--models']??path.join(os.homedir(),'.pi','agent','models.json'));
const output=path.resolve(options['--out']??'runtime/model-routing/pi-models-staged.json');
if(source===output)throw new Error('Output must not be the live model profile');
const staged=preparePiModelRoutes(JSON.parse(fs.readFileSync(source,'utf8')));
fs.mkdirSync(path.dirname(output),{recursive:true,mode:0o700});
if(fs.existsSync(output)){
 if(!fs.lstatSync(output).isFile())throw new Error('Staged output must be a regular file');
 const backup=output+'.'+new Date().toISOString().replace(/[:.]/g,'-')+'.bak';fs.copyFileSync(output,backup);fs.chmodSync(backup,0o600);
}
const temporary=output+'.'+process.pid+'.tmp';
try{fs.writeFileSync(temporary,JSON.stringify(staged,null,2)+'\n',{flag:'wx',mode:0o600});fs.renameSync(temporary,output);}finally{if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
console.log('Prepared current-profile route entries with a source fingerprint. Live Pi and services unchanged.');
