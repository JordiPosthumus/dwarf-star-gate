// Read-only local checks: no inference, SSH, file creation or settings changes.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {loadConfig,dashboardPort,gatewayPort,continuityEnabled,doorSocket} from '../ds4-gateway/config.mjs';
import {workerConfigs} from '../ds4-gateway/worker-config.mjs';
import {recoveryConfig} from '../ds4-gateway/recovery-transport.mjs';
try {
  if(process.argv.length>2)throw new Error('Usage: npm run doctor (select config with DWARF_GATE_CONFIG)');
  const version=process.versions.node.split('.').map(Number);
  if(version[0]<22||version[0]===22&&(version[1]<22||version[1]===22&&version[2]<2))throw new Error('Node 22.22.2 or newer is required');
  const {config:c,filename}=loadConfig(),ui=dashboardPort(c);
  const core=gatewayPort(c);
  if(!Number.isInteger(c.port)||c.port<1||c.port>65535||new Set([c.port,core,ui]).size!==(continuityEnabled(c)?3:2))throw new Error('Continuity door, gateway core and dashboard need distinct valid ports');
  if(c.host!==undefined&&c.host!=='localhost'&&!net.isIP(c.host))throw new Error('Gateway host must be an IP address or localhost');
  if(typeof c.api_key!=='string'||!c.api_key||c.api_key==='REPLACE_WITH_YOUR_KEY')throw new Error('Set a private inference API key');
  if(typeof c.model!=='string'||!c.model||!Number.isSafeInteger(c.context_length)||c.context_length<1)throw new Error('Set the served model and positive pool context limit');
  let nodes=workerConfigs(c.nodes);recoveryConfig(c.recovery);
  const warnings=[];
  if(fs.existsSync(c.state_file)){
    const state=JSON.parse(fs.readFileSync(c.state_file,'utf8'));
    if(state.version!==1||!state.sessions||typeof state.sessions!=='object')throw new Error('Existing affinity state is invalid; do not reset it');
    if(state.workers!==undefined)nodes=workerConfigs(state.workers);
  }
  if(!nodes.length)warnings.push('No workers registered yet; inference is unavailable until you add and enable a compatible DS4 endpoint.');
  if(nodes.some(n=>[c.port,core,ui].includes(Number(new URL(n.url).port))))throw new Error('Worker tunnel/listener port collides with DSG');
  if(c.ui_worker_management===true&&!c.control_socket)throw new Error('Worker controls require control_socket');
  const continuitySocket=doorSocket(c);
  for(const socket of [c.control_socket,continuitySocket].filter(Boolean))if(Buffer.byteLength(socket)>=104)throw new Error('Control socket path is too long; select a shorter local path');
  for(const value of [c.state_file,c.control_socket,continuitySocket].filter(Boolean)){
    let dir=path.dirname(value);while(!fs.existsSync(dir))dir=path.dirname(dir);
    fs.accessSync(dir,fs.constants.W_OK);
  }
  if((fs.statSync(filename).mode&0o077)!==0)warnings.push('Private config is readable by other accounts; restrict its permissions to 0600.');
  if(c.host==='0.0.0.0'||c.host==='::')warnings.push('Gateway is LAN-facing; verify authentication and firewall policy. No setting was changed.');
  for(const file of Object.values(c.telemetry_files??{}))if(!fs.existsSync(file))warnings.push('A configured local telemetry file is missing; metrics will remain unavailable.');
  if(c.embeddings?.enabled===true){fs.accessSync(c.embeddings.python,fs.constants.X_OK);fs.accessSync(path.join(c.embeddings.model_dir,'manifest.json'),fs.constants.R_OK);}
  if(c.predictor?.enabled===true){
    if(c.dataset_enabled!==true)throw new Error('Predictor requires dataset_enabled');
    fs.accessSync(c.predictor.python,fs.constants.X_OK);
    const p=JSON.parse(fs.readFileSync(c.predictor.profiles));if(p.schema!==1||!p.workers)throw new Error('Predictor requires a versioned private worker inventory');
    warnings.push('Predictor configuration is present; doctor does not certify fitted models or routing evidence. Inspect Analytics → Predictor lifecycle.');
  }
  console.log(JSON.stringify({ok:true,read_only:true,config:filename,workers:nodes.length,gateway_port:c.port,gateway_core_port:core,continuity_door:continuityEnabled(c),dashboard_port:ui,context_length:c.context_length,warnings},null,2));
}catch(error){console.error(error.message);process.exitCode=1;}
