// Passwords are process-memory grants. Durable receipts contain no credentials.
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID,createHash,timingSafeEqual} from 'node:crypto';
import {isIP} from 'node:net';
import {sparkIdentity,localAddress} from './spark-discovery.mjs';
const uuid=id=>/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id??'');
const user=name=>typeof name==='string'&&/^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/.test(name);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
const pending=new Set(['pending','credentials_required','permission_paused']);
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const states=new Set([...pending,'inspecting','key_installing','verifying','verification_pending','key_ready','same_verified_machine','existing_machine','blocked']);
function validRecord(id,op){
  return op&&uuid(id)&&op.access_id===id&&uuid(op.scan_id)&&typeof op.knownHosts==='string'&&path.isAbsolute(op.knownHosts)&&digest(op.known_hosts_sha256)
    &&Array.isArray(op.known_identities)&&op.known_identities.every(digest)&&(op.username===null||user(op.username))
    &&Number.isSafeInteger(op.authorization_generation)&&op.authorization_generation>=0
    &&['credentials_required','authorized','running','complete','verification_pending','needs_attention','observation_lost'].includes(op.state)
    &&Array.isArray(op.endpoints)&&op.endpoints.length>=1&&op.endpoints.length<=8
    &&new Set(op.endpoints.map(e=>e?.endpoint_id)).size===op.endpoints.length
    &&op.endpoints.every(e=>e&&digest(e.endpoint_id)&&isIP(e.host)===4&&localAddress(e.host)&&states.has(e.state)
      &&(e.identity===undefined||digest(e.identity))&&(!['key_installing','verifying','verification_pending','key_ready','same_verified_machine','existing_machine'].includes(e.state)||digest(e.identity)));
}

export class SparkAccess {
  constructor({directory,discovery,transport,isEnabled,isTesting=()=>false,now=Date.now}){
    Object.assign(this,{directory,discovery,transport,isEnabled,isTesting,now});this.running=null;this.closed=false;this.secrets=new Map();this.operations={};this.error=null;
    fs.mkdirSync(directory,{recursive:true,mode:0o700});this.file=path.join(directory,'operations.json');
    try{
      if(fs.existsSync(this.file))this.operations=JSON.parse(fs.readFileSync(this.file,'utf8'));
      if(!this.operations||typeof this.operations!=='object'||Array.isArray(this.operations)||Object.entries(this.operations).some(([id,op])=>!validRecord(id,op)))throw Error();
      for(const op of Object.values(this.operations)){
        for(const endpoint of op.endpoints){
          if(['key_installing','verifying'].includes(endpoint.state))endpoint.state='verification_pending';
          else if(['inspecting','pending','permission_paused'].includes(endpoint.state))endpoint.state='credentials_required';
        }
        if(['running','authorized'].includes(op.state))op.state=op.endpoints.some(e=>e.state==='verification_pending')?'verification_pending':'credentials_required';
      }
    }catch{this.error='Saved initial-access records need inspection. The original file was preserved.';this.operations={};}
  }
  save(){
    if(this.error)throw Error(this.error);
    const temp=this.file+'.'+randomUUID(),fd=fs.openSync(temp,'wx',0o600);
    try{fs.writeFileSync(fd,JSON.stringify(this.operations,null,2)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    fs.renameSync(temp,this.file);
  }
  forget(id){const grant=this.secrets.get(id);if(grant?.timer)clearTimeout(grant.timer);this.secrets.delete(id);}
  available(op){const grant=this.secrets.get(op.access_id);if(grant&&grant.expires_at<=this.now())this.forget(op.access_id);return this.secrets.has(op.access_id);}
  status({access_id}={}){
    if(access_id!==undefined&&(!uuid(access_id)||!this.operations[access_id]))throw Error('Use a saved initial-access ID.');
    const rows=access_id?[this.operations[access_id]]:Object.values(this.operations).slice(-20);
    const present=op=>({access_id:op.access_id,scan_id:op.scan_id,state:op.state,authorization_generation:op.authorization_generation??0,
      credential_available:this.available(op),credential_expires_at:this.secrets.get(op.access_id)?.expires_at??null,
      created_at:op.created_at,updated_at:op.updated_at,username:op.username,
      endpoints:op.endpoints.map(e=>({endpoint_id:e.endpoint_id,host:e.host,state:e.state,identity:e.identity??null,key_fingerprint:e.key_fingerprint??null,key_change:e.key_change??null,reason:e.reason??null})),
      scope:'Initial SSH access only. No models, firmware, daemon settings or existing keys are replaced. New key access still needs a fresh discovery scan and enrollment.'});
    return access_id?present(rows[0]):{available:!this.error,busy:!!this.running,enabled:this.isEnabled(),error:this.error,operations:rows.map(present)};
  }
  guard(){if(this.error)throw Error(this.error);if(this.closed)throw Error('Initial access is closing.');if(!this.isEnabled())throw Error('New Spark setup is switched off.');if(this.isTesting())throw Error('Initial access is paused in testing mode.');}
  async request(input){
    this.guard();
    if(!input||Object.keys(input).sort().join(',')!=='endpoint_ids,scan_id'||!uuid(input.scan_id)||!Array.isArray(input.endpoint_ids)||!input.endpoint_ids.length||input.endpoint_ids.length>8||new Set(input.endpoint_ids).size!==input.endpoint_ids.length||input.endpoint_ids.some(id=>!/^[a-f0-9]{64}$/.test(id)))throw Error('Select one to eight initial-access endpoint IDs from a saved discovery scan. No addresses or credentials.');
    const proof=await this.discovery.accessCandidates({scan_id:input.scan_id}),selected=input.endpoint_ids.map(id=>proof.endpoints.find(e=>e.endpoint_id===id));
    if(selected.some(e=>!e))throw Error('An endpoint is not eligible for initial access in this saved scan.');
    const ids=[...input.endpoint_ids].sort();
    const existing=Object.values(this.operations).find(op=>op.scan_id===input.scan_id&&JSON.stringify(op.endpoints.map(e=>e.endpoint_id).sort())===JSON.stringify(ids));
    if(existing)return this.status({access_id:existing.access_id});
    const id=randomUUID(),op={access_id:id,scan_id:input.scan_id,knownHosts:proof.knownHosts,known_hosts_sha256:proof.known_hosts_sha256,
      known_identities:proof.known_identities,username:selected.every(e=>e.username===selected[0].username)?selected[0].username:null,
      state:'credentials_required',authorization_generation:0,created_at:this.now(),updated_at:this.now(),endpoints:selected.map(e=>({...e,state:'credentials_required'}))};
    this.operations[id]=op;
    try{this.save();}catch(error){delete this.operations[id];throw error;}
    return this.status({access_id:id});
  }
  authorize(input){
    this.guard();
    if(!input||Object.keys(input).sort().join(',')!=='access_id,password,username'||!uuid(input.access_id)||!user(input.username)||typeof input.password!=='string'||!Buffer.byteLength(input.password)||Buffer.byteLength(input.password)>1024||/[\r\n\0]/.test(input.password))throw Error('Enter the SSH username and password only in this local initial-access form.');
    const op=this.operations[input.access_id];if(!op||op.state==='running')throw Error('Select a saved request that is not currently running.');
    if(!op.endpoints.some(e=>pending.has(e.state)))throw Error('This request has no unstarted credential step. Inspect its recorded outcome.');
    if(op.endpoints.some(e=>e.identity)&&op.username!==input.username)throw Error('Keep the original username for a partially completed access request.');
    op.username=input.username;op.authorization_generation++;op.updated_at=this.now();op.state='authorized';
    for(const e of op.endpoints)if(pending.has(e.state)){e.state='pending';delete e.reason;}
    this.save();this.forget(op.access_id);
    const timer=setTimeout(()=>this.forget(op.access_id),15*60*1000);timer.unref();
    this.secrets.set(op.access_id,{password:input.password,expires_at:this.now()+15*60*1000,timer});
    return this.status({access_id:op.access_id});
  }
  revoke(access_id){
    if(!uuid(access_id)||!this.operations[access_id])throw Error('Select a saved initial-access request.');
    this.forget(access_id);const op=this.operations[access_id];
    for(const e of op.endpoints)if(pending.has(e.state))e.state='credentials_required';
    if(op.state!=='running'&&op.endpoints.some(e=>pending.has(e.state)))op.state='credentials_required';op.updated_at=this.now();this.save();return this.status({access_id});
  }
  async begin({access_id}){
    this.guard();const op=this.operations[access_id];if(!uuid(access_id)||!op)throw Error('Use the saved initial-access ID.');
    if(this.running){if(this.activeId!==access_id)throw Error('Another initial-access request is running. Observe it before starting this one.');return this.status({access_id});}
    if(!op.endpoints.some(e=>pending.has(e.state)||e.state==='verification_pending'))return this.status({access_id});
    if(!this.available(op)&&!op.endpoints.some(e=>e.state==='verification_pending')){op.state='credentials_required';this.save();return this.status({access_id});}
    op.state='running';op.updated_at=this.now();this.save();
    this.activeId=access_id;
    this.running=this.run(op).catch(()=>{op.state='observation_lost';op.updated_at=this.now();try{this.save();}catch{/* Keep the prior receipt rather than fabricate success. */}}).finally(()=>{this.running=null;this.activeId=null;this.forget(access_id);});
    return this.status({access_id});
  }
  async run(op){
    for(const endpoint of op.endpoints){
      const target={ssh:`${op.username}@${endpoint.host}`,knownHosts:op.knownHosts};
      if(!pending.has(endpoint.state)&&endpoint.state!=='verification_pending')continue;
      if(hash(fs.readFileSync(op.knownHosts))!==op.known_hosts_sha256){endpoint.state='blocked';endpoint.reason='scan_host_keys_changed';this.save();continue;}
      if(endpoint.state!=='verification_pending'){
        if(this.closed||!this.isEnabled()||this.isTesting()){endpoint.state='permission_paused';this.save();continue;}
        if(!this.available(op)){endpoint.state='credentials_required';this.save();continue;}
        const password=this.secrets.get(op.access_id).password;
        try{
          const fresh=await this.discovery.accessCandidates({scan_id:op.scan_id});
          if(!fresh.endpoints.some(e=>e.endpoint_id===endpoint.endpoint_id))throw Error();
          let key;
          try{key=await this.transport.key(target);}catch{endpoint.state='credentials_required';endpoint.reason='gateway_ssh_key_unavailable';this.save();continue;}
          endpoint.state='inspecting';this.save();
          const identity=sparkIdentity(await this.transport.inspect(target,password));
          if(!identity){endpoint.state='blocked';endpoint.reason='not_verified_as_spark';this.save();continue;}
          endpoint.identity=identity;
          if(op.endpoints.some(other=>other!==endpoint&&other.identity===identity&&other.state==='key_ready')){endpoint.state='same_verified_machine';this.save();continue;}
          if(op.known_identities.includes(identity)||Object.values(this.operations).some(other=>other!==op&&other.endpoints.some(e=>e.identity===identity&&e.state==='key_ready'))){endpoint.state='existing_machine';endpoint.reason='already_known_hardware';this.save();continue;}
          endpoint.key_fingerprint=key.fingerprint;
          if(this.closed||!this.isEnabled()||this.isTesting()||!this.available(op)){endpoint.state='permission_paused';this.save();continue;}
          const beforeInstall=await this.discovery.accessCandidates({scan_id:op.scan_id});
          if(!beforeInstall.endpoints.some(e=>e.endpoint_id===endpoint.endpoint_id))throw Error();
          if(this.closed||!this.isEnabled()||this.isTesting()||!this.available(op)){endpoint.state='permission_paused';this.save();continue;}
          endpoint.state='key_installing';this.save();
          let installed;
          try{installed=await this.transport.install(target,password,{operation_id:op.access_id,identity,public_key:key.public_key});}
          catch{/* Verify the exact key path; do not replay a possibly applied write. */}
          endpoint.key_change=typeof installed?.changed==='boolean'?installed.changed:null;
          if(installed&&['identity_changed','existing_key_restricted'].includes(installed.state)){endpoint.state='blocked';endpoint.reason=installed.state;this.save();continue;}
          endpoint.state='verifying';this.save();
        }catch{
          // A failed password probe can be retried after a fresh local grant.
          // Once a write may have begun, reconcile it by key-only observation.
          const issued=['key_installing','verifying'].includes(endpoint.state);
          endpoint.state=issued?'verification_pending':'credentials_required';
          endpoint.reason=issued?'key_access_unconfirmed':'initial_access_unconfirmed';this.save();continue;
        }
      }
      try{
        const identity=sparkIdentity(await this.transport.verify(target));
        if(!identity||identity!==endpoint.identity)throw Error();
        endpoint.state='key_ready';delete endpoint.reason;
      }catch{endpoint.state='verification_pending';endpoint.reason='key_access_unconfirmed';}
      op.updated_at=this.now();this.save();
    }
    op.state=op.endpoints.every(e=>['key_ready','same_verified_machine'].includes(e.state))?'complete':op.endpoints.some(e=>e.state==='verification_pending')?'verification_pending':op.endpoints.some(e=>pending.has(e.state))?'credentials_required':'needs_attention';
    op.updated_at=this.now();this.save();
  }
  settled(){return this.running??Promise.resolve();}
  close(){this.closed=true;for(const id of this.secrets.keys())this.forget(id);}
}

export function handleSparkAccessSettings(req,res,{access,csrf,reply}){
  if(req.url!=='/api/genie/spark-access')return false;
  if(req.method==='GET'){reply(200,{...(access?.status()??{available:false,busy:false}),csrf_token:csrf});return true;}
  if(req.method!=='POST'){reply(405,{error:'Use GET or POST.'});return true;}
  if(req.headers.origin!==`http://${req.headers.host}`||!same(req.headers['x-dsg-csrf'],csrf)){reply(403,{error:'Same-origin initial Spark access required.'});return true;}
  if(!access){reply(409,{error:'Initial Spark access is not configured.'});return true;}
  if(req.headers['content-type']!=='application/json'){reply(415,{error:'JSON required.'});return true;}
  let body='',ended=false;req.setEncoding('utf8');const timer=setTimeout(()=>{ended=true;body='';reply(408,{error:'Incomplete initial-access request.'});},10000);
  const finish=()=>{ended=true;body='';clearTimeout(timer);};req.on('error',finish);req.on('aborted',finish);
  req.on('data',chunk=>{if(ended)return;body+=chunk;if(Buffer.byteLength(body)>8192){finish();reply(413,{error:'Initial-access request too large.'});}});
  req.on('end',()=>{clearTimeout(timer);if(ended)return;ended=true;
    try{
      const input=JSON.parse(body),keys=Object.keys(input).sort().join(',');body='';let result;
      if(input.action==='authorize'&&keys==='access_id,action,password,username'){const {action,...details}=input;result=access.authorize(details);}
      else if(input.action==='revoke'&&keys==='access_id,action')result=access.revoke(input.access_id);
      else throw Error('Invalid initial-access fields.');
      reply(200,result);
    }catch(error){reply(400,{error:error instanceof SyntaxError?'Invalid JSON.':error.message});}
    finally{body='';}
  });return true;
}
