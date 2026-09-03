// One configuration convention for servers, launchers and operator commands.
// Relative local paths belong to the config file, never to the caller's cwd.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
export const projectRoot=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export function configPath(explicit,{env=process.env,cwd=process.cwd(),root=projectRoot}={}) {
  const selected=explicit||env.DWARF_GATE_CONFIG;
  return selected?path.resolve(cwd,selected):path.join(root,'config.local.json');
}
export function loadConfig(explicit,options) {
  const filename=configPath(explicit,options);
  let config;
  try {config=JSON.parse(fs.readFileSync(filename,'utf8'));}
  catch {throw new Error(`Cannot read valid configuration at ${filename}. Run npm run setup or select DWARF_GATE_CONFIG.`);}
  if(!config||typeof config!=='object'||Array.isArray(config))throw new Error('Configuration must be a JSON object');
  const base=path.dirname(filename),local=(value,key)=>{
    if(typeof value!=='string'||!value.trim())throw new Error(`${key} must be a nonempty local path`);
    return path.resolve(base,value);
  };
  config.state_file=local(config.state_file,'state_file');
  if(config.control_socket!=null)config.control_socket=local(config.control_socket,'control_socket');
  if(config.continuity_door?.control_socket!=null)config.continuity_door.control_socket=local(config.continuity_door.control_socket,'continuity_door.control_socket');
  if(config.telemetry_files && typeof config.telemetry_files==='object'&&!Array.isArray(config.telemetry_files))
    config.telemetry_files=Object.fromEntries(Object.entries(config.telemetry_files).map(([id,file])=>[id,local(file,'telemetry_files')]));
  if(config.embeddings?.enabled===true)for(const key of ['python','model_dir'])config.embeddings[key]=local(config.embeddings[key],`embeddings.${key}`);
  if(config.predictor?.enabled===true)for(const key of ['python','profiles'])config.predictor[key]=local(config.predictor[key],`predictor.${key}`);
  // Recovery helper/config paths are REMOTE paths; deliberately untouched.
  return {config,filename};
}
export function continuityEnabled(config){return config.continuity_door?.enabled===true;}
export function gatewayPort(config){
  const value=continuityEnabled(config)?Number(config.continuity_door.core_port):Number(config.port);
  if(!Number.isInteger(value)||value<(continuityEnabled(config)?1:0)||value>65535)throw new Error(continuityEnabled(config)?'continuity_door.core_port must be 1–65535':'port must be 0–65535');
  if(continuityEnabled(config)&&value===Number(config.port))throw new Error('Continuity door and gateway core ports must differ');
  return value;
}
export function gatewayHost(config){
  // In continuity mode only the stable Door may inherit the public/LAN bind.
  // The replaceable core is a local implementation detail and is never exposed
  // merely because an existing single-process installation used 0.0.0.0.
  return continuityEnabled(config)?'127.0.0.1':config.host;
}
export function doorSocket(config){
  if(!continuityEnabled(config))return null;
  if(typeof config.continuity_door.control_socket!=='string'||!config.continuity_door.control_socket)throw new Error('continuity_door.control_socket is required when enabled');
  return config.continuity_door.control_socket;
}
export function dashboardPort(config,env=process.env) {
  const port=Number(env.GATEWAY_UI_PORT??config.ui_port??30010);
  if(!Number.isInteger(port)||port<1||port>65535)throw new Error('Dashboard port must be 1–65535');
  return port;
}
export function isDashboard(value) {
  return value?.service==='dwarf-star-gate-dashboard'&&value.version===1&&typeof value.read_only==='boolean'&&typeof value.worker_management==='boolean';
}
export function isMain(url,entry=process.argv[1]) {
  if(!entry||entry==='-')return false;
  try{return url===pathToFileURL(fs.realpathSync(entry)).href;}catch{return false;}
}
if(isMain(import.meta.url)){
  try{if(process.argv[2]!=='runtime')throw new Error('Usage: config.mjs runtime [CONFIG]');console.log(path.dirname(loadConfig(process.argv[3]).config.state_file));}
  catch(error){console.error(error.message);process.exitCode=1;}
}
