import {createHash,randomBytes,randomUUID} from 'node:crypto';

export const CLIENT_WATCH_HEADER='x-dsg-client-watch-id';
export const CLIENT_WATCH_ROUTE='/gateway/client-watch';
const clients=new Set(['pi','hermes','generic']);
const states=new Set(['local_tool','waiting_for_model','idle','done']);
const requestStates=new Set(['received','queued','dispatched','complete','incomplete','failed','cancelled','rejected']);
const terminalRequests=new Set(['complete','incomplete','failed','cancelled','rejected']);
const exactKeys=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===keys.slice().sort().join(',');
const validId=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

export function validClientWatchId(value){return validId(value)?value.toLowerCase():null;}

export class ClientWatch {
  constructor({now=()=>Date.now(),maxEntries=256,ttlMs=24*60*60*1000,freshMs=45_000,preGatewayMs=20_000,salt=randomBytes(32)}={}){
    if(typeof now!=='function'||!Number.isSafeInteger(maxEntries)||maxEntries<1||maxEntries>4096||!Number.isSafeInteger(ttlMs)||ttlMs<freshMs||!Number.isSafeInteger(freshMs)||freshMs<1000||!Number.isSafeInteger(preGatewayMs)||preGatewayMs<0||!Buffer.isBuffer(salt)||salt.length<16)throw new Error('Invalid Client Watch limits');
    this.now=now;this.maxEntries=maxEntries;this.ttlMs=ttlMs;this.freshMs=freshMs;this.preGatewayMs=preGatewayMs;this.salt=salt;this.entries=new Map();
  }
  ref(id){return createHash('sha256').update(this.salt).update('\0').update(id).digest('hex').slice(0,12);}
  cleanup(now=this.now()){
    for(const [id,entry] of this.entries)if(now-entry.lastSeen>this.ttlMs)this.entries.delete(id);
    if(this.entries.size<=this.maxEntries)return;
    for(const entry of [...this.entries.values()].sort((a,b)=>a.lastSeen-b.lastSeen).slice(0,this.entries.size-this.maxEntries))this.entries.delete(entry.id);
  }
  heartbeat(input){
    if(!exactKeys(input,['schema','watch_id','client','state','sequence','process_alive'])||input.schema!==1||!validId(input.watch_id)||!clients.has(input.client)||!states.has(input.state)||!Number.isSafeInteger(input.sequence)||input.sequence<0||input.sequence>Number.MAX_SAFE_INTEGER||typeof input.process_alive!=='boolean')throw new Error('Invalid Client Watch heartbeat');
    const now=this.now(),id=input.watch_id.toLowerCase();this.cleanup(now);
    let entry=this.entries.get(id);
    if(entry&&input.sequence<entry.sequence)return {accepted:false,reason:'stale_sequence',watch_ref:this.ref(id)};
    if(!entry){entry={id,client:input.client,state:input.state,sequence:input.sequence,processAlive:input.process_alive,lastSeen:now,stateChanged:now,request:null,heartbeatSeen:true};this.entries.set(id,entry);}
    else{
      if(input.state!==entry.state||input.process_alive!==entry.processAlive)entry.stateChanged=now;
      entry.client=input.client;entry.state=input.state;entry.processAlive=input.process_alive;entry.sequence=input.sequence;entry.lastSeen=now;entry.heartbeatSeen=true;
    }
    this.cleanup(now);
    return {accepted:true,watch_ref:this.ref(id)};
  }
  observeRequest(rawId,requestId,state){
    const id=validClientWatchId(rawId);if(!id||!validId(requestId)||!requestStates.has(state))return false;
    const now=this.now();this.cleanup(now);let entry=this.entries.get(id);
    if(!entry){entry={id,client:'generic',state:'waiting_for_model',sequence:0,processAlive:true,lastSeen:now,stateChanged:now,request:null,heartbeatSeen:false};this.entries.set(id,entry);}
    if(state==='received')entry.request={id:requestId,state,updatedAt:now};
    else if(!entry.request||entry.request.id!==requestId)return false;
    else entry.request={...entry.request,state,updatedAt:now};
    this.cleanup(now);return true;
  }
  diagnosis(entry,now){
    if(now-entry.lastSeen>this.freshMs)return 'heartbeat_stale_unknown';
    if(entry.state==='done')return 'done';
    if(entry.state==='idle')return 'idle';
    if(entry.state==='local_tool')return 'local_tool_active';
    const request=entry.request;
    if(!request)return now-entry.stateChanged>=this.preGatewayMs?'no_request_reached_dsg':'waiting_to_reach_dsg';
    if(request.state==='received'||request.state==='queued')return 'waiting_inside_dsg';
    if(request.state==='dispatched')return 'model_response_active';
    if(terminalRequests.has(request.state))return 'client_processing_after_dsg';
    return 'unknown';
  }
  snapshot(){
    const now=this.now();this.cleanup(now);
    const runs=[...this.entries.values()].filter(entry=>entry.heartbeatSeen).sort((a,b)=>b.lastSeen-a.lastSeen).map(entry=>({
      watch_ref:this.ref(entry.id),client:entry.client,state:entry.state,process_alive:entry.processAlive,
      fresh:now-entry.lastSeen<=this.freshMs,last_seen_at:new Date(entry.lastSeen).toISOString(),last_seen_seconds:Math.max(0,(now-entry.lastSeen)/1000),state_seconds:Math.max(0,(now-entry.stateChanged)/1000),
      request:entry.request?{state:entry.request.state,age_seconds:Math.max(0,(now-entry.request.updatedAt)/1000)}:null,
      diagnosis:this.diagnosis(entry,now)
    }));
    return {schema:1,mode:'advisory',fresh_after_seconds:this.freshMs/1000,pre_gateway_after_seconds:this.preGatewayMs/1000,runs};
  }
}

const safeNumber=(value,min,max)=>Number.isFinite(value)&&value>=min&&value<=max?value:null;
export function clientWatchForDisplay(raw){
  if(!raw||raw.schema!==1||raw.mode!=='advisory'||!Array.isArray(raw.runs))return null;
  const diagnoses=new Set(['heartbeat_stale_unknown','done','idle','local_tool_active','no_request_reached_dsg','waiting_to_reach_dsg','waiting_inside_dsg','model_response_active','client_processing_after_dsg','unknown']);
  const safeStates=new Set(states),safeRequestStates=new Set(requestStates);
  const runs=raw.runs.slice(0,256).flatMap(run=>{
    if(!run||typeof run.watch_ref!=='string'||!/^[a-f0-9]{12}$/.test(run.watch_ref)||!clients.has(run.client)||!safeStates.has(run.state)||typeof run.process_alive!=='boolean'||typeof run.fresh!=='boolean'||!diagnoses.has(run.diagnosis)||typeof run.last_seen_at!=='string'||!Number.isFinite(Date.parse(run.last_seen_at)))return [];
    const request=run.request&&safeRequestStates.has(run.request.state)&&safeNumber(run.request.age_seconds,0,86400)!==null?{state:run.request.state,age_seconds:run.request.age_seconds}:null;
    return [{watch_ref:run.watch_ref,client:run.client,state:run.state,process_alive:run.process_alive,fresh:run.fresh,last_seen_at:run.last_seen_at,last_seen_seconds:safeNumber(run.last_seen_seconds,0,86400),state_seconds:safeNumber(run.state_seconds,0,86400),request,diagnosis:run.diagnosis}];
  });
  return {schema:1,mode:'advisory',fresh_after_seconds:safeNumber(raw.fresh_after_seconds,1,3600),pre_gateway_after_seconds:safeNumber(raw.pre_gateway_after_seconds,0,3600),runs};
}

export function createClientWatchId(){return randomUUID();}
