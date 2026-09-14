import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const defaults=fileURLToPath(new URL('../genie/',import.meta.url));
export function seedGenieHome(directory){
  const home=path.resolve(directory,'hermes-home');
  fs.mkdirSync(home,{recursive:true,mode:0o700});
  for(const name of ['SOUL.md','AGENTS.md']){
    const destination=path.join(home,name);
    try{fs.copyFileSync(path.join(defaults,name),destination,fs.constants.COPYFILE_EXCL);fs.chmodSync(destination,0o600);}
    catch(error){if(error.code!=='EEXIST')throw error;}
  }
  return home;
}
