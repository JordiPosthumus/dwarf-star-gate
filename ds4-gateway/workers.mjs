import { loadConfig } from './config.mjs';
import { workerControl } from './worker-client.mjs';

const args = process.argv.slice(2);
const option = name => { const i=args.indexOf(name); if(i<0)return undefined; if(!args[i+1]||args[i+1].startsWith('--'))throw new Error(`Missing ${name} value`); const value=args[i+1];args.splice(i,2);return value; };
try {
  const {config}=loadConfig(option('--config'));
  const url=option('--url'), ssh=option('--ssh'), fallback=option('--ssh-fallbacks'), remote=option('--remote-port'), journal=option('--journal-unit');
  const [command='list',id,...extra]=args;
  if(extra.length)throw new Error('Unexpected arguments');
  let route,body;
  if(command==='list')route='/workers';
  else if(command==='add') {
    if(!id||!url)throw new Error('add requires an ID and --url (a local endpoint or SSH tunnel URL)');
    route='/add-worker';body={worker:{id,url,...(ssh?{ssh}:{}),...(fallback?{ssh_fallbacks:fallback.split(',').map(v=>v.trim()).filter(Boolean)}:{}),...(remote?{remote_port:Number(remote)}:{}),...(journal?{telemetry_service:journal}:{})}};
  } else if(['drain','resume','remove'].includes(command)) {
    if(!id)throw new Error(`${command} requires a worker ID`);
    route={drain:'/drain-workers',resume:'/resume-workers',remove:'/remove-worker'}[command];
    body=command==='remove'?{id}:{workers:[id]};
  } else throw new Error('Usage: workers.mjs [--config FILE] list|add ID --url URL [--ssh HOST --ssh-fallbacks HOST,HOST --remote-port PORT]|drain ID|resume ID|remove ID');
  const result=await workerControl(config.control_socket,route,body);
  console.log(JSON.stringify(result,null,2));
  if(command==='add')console.log('Registered paused. Enable routing in the local UI or run resume ID. Model settings were not changed.');
} catch(e) { console.error(e.message);process.exitCode=1; }
