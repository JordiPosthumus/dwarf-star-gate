import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {doorSocket} from './config.mjs';

// The Door is the sole writer. Genie reads this shared operational state before
// starting inference/actions, so a dashboard restart cannot re-enable testing noise.
export const testingModeFile=config=>path.join(path.dirname(config.state_file??doorSocket(config)),'testing-mode.json');
export function readTestingMode(filename){
  let value;try{value=JSON.parse(fs.readFileSync(filename,'utf8'));}catch(error){if(error.code==='ENOENT')return {schema:1,enabled:false,since:null};throw new Error('Testing mode state unavailable; existing state must be preserved');}
  if(value?.schema!==1||typeof value.enabled!=='boolean'||!(value.since===null||typeof value.since==='string'&&Number.isFinite(Date.parse(value.since))))throw new Error('Invalid testing mode state; existing state must be preserved');
  return {schema:1,enabled:value.enabled,since:value.since};
}
export function writeTestingMode(filename,enabled,now=Date.now()){
  if(typeof enabled!=='boolean')throw new Error('Testing enabled must be boolean');
  const before=readTestingMode(filename);if(before.enabled===enabled)return before;
  const value={schema:1,enabled,since:enabled?new Date(now).toISOString():null},temporary=`${filename}.${randomUUID()}.tmp`;
  fs.mkdirSync(path.dirname(filename),{recursive:true,mode:0o700});
  try{const fd=fs.openSync(temporary,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(value)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(temporary,filename);}finally{try{fs.unlinkSync(temporary);}catch(error){if(error.code!=='ENOENT')throw error;}}
  return value;
}
export function testingSuspended(filename){try{return readTestingMode(filename).enabled;}catch{return true;}}
