import { loadConfig } from './config.mjs';
import { workerControl } from './worker-client.mjs';
import {randomUUID} from 'node:crypto';

const args = process.argv.slice(2);
const option = name => { const i=args.indexOf(name); if(i<0)return undefined; if(!args[i+1]||args[i+1].startsWith('--'))throw new Error(`Missing ${name} value`); const value=args[i+1];args.splice(i,2);return value; };
try {
  const {config}=loadConfig(option('--config'));
  const url=option('--url'), ssh=option('--ssh'), fallback=option('--ssh-fallbacks'), remote=option('--remote-port'), journal=option('--journal-unit'),name=option('--name'),reason=option('--reason'),review=option('--review-after-hours'),suppliedRequestId=option('--request-id');
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
  } else if(command==='lock') {
    if(!id||!name||!reason)throw new Error('lock requires a worker ID, --name and --reason');
    const review_after_hours=review===undefined?null:Number(review),request_id=suppliedRequestId??randomUUID();
    if(review_after_hours!==null&&(!Number.isSafeInteger(review_after_hours)||review_after_hours<1||review_after_hours>8760))throw new Error('--review-after-hours must be 1–8760 whole hours');
    route='/maintenance-lock';body={worker_id:id,name,reason,review_after_hours,request_id};
    console.error(JSON.stringify({request_id,note:'Save this ID; on an uncertain reply, query maintenance-receipt before retrying.'}));
  } else if(command==='unlock') {
    if(!id||!reason)throw new Error('unlock requires a maintenance lock ID and --reason');
    if(review!==undefined||name!==undefined)throw new Error('unlock does not accept --name or --review-after-hours');
    const request_id=suppliedRequestId??randomUUID();route='/release-maintenance-lock';body={lock_id:id,reason,request_id};
    console.error(JSON.stringify({request_id,note:'Save this ID; on an uncertain reply, query maintenance-receipt before retrying.'}));
  } else if(command==='maintenance-receipt') {
    if(!id)throw new Error('maintenance-receipt requires a request ID');
    if([name,reason,review,suppliedRequestId].some(value=>value!==undefined))throw new Error('maintenance-receipt accepts only its request ID');
    route='/maintenance-receipt';body={request_id:id};
  } else if(['fallbacks','clear-fallbacks'].includes(command)) {
    if(!id)throw new Error(`${command} requires a worker ID`);
    if(command==='fallbacks'&&fallback===undefined)throw new Error('fallbacks requires --ssh-fallbacks HOST,HOST');
    if(command==='clear-fallbacks'&&fallback!==undefined)throw new Error('clear-fallbacks takes no --ssh-fallbacks option');
    const registered=await workerControl(config.control_socket,'/workers',undefined,{channel:'workers_cli'}),current=registered.workers?.find(worker=>worker.id===id);
    if(!current)throw new Error('Unknown worker');
    route='/set-ssh-fallbacks';body={id,expected_ssh_fallbacks:current.ssh_fallbacks??[],ssh_fallbacks:command==='clear-fallbacks'?[]:fallback.split(',').map(value=>value.trim()).filter(Boolean)};
  } else throw new Error('Usage: workers.mjs [--config FILE] list|add ID --url URL [--ssh HOST --ssh-fallbacks HOST,HOST --remote-port PORT]|fallbacks ID --ssh-fallbacks HOST,HOST|clear-fallbacks ID|drain ID|resume ID|remove ID|lock ID --name NAME --reason REASON [--review-after-hours HOURS] [--request-id UUID]|unlock LOCK_ID --reason REASON [--request-id UUID]|maintenance-receipt REQUEST_ID');
  const result=await workerControl(config.control_socket,route,body,{channel:'workers_cli'});
  console.log(JSON.stringify(result,null,2));
  if(command==='add')console.log('Registered paused. Enable routing in the local UI or run resume ID. Model settings were not changed.');
} catch(e) { console.error(e.message);process.exitCode=1; }
