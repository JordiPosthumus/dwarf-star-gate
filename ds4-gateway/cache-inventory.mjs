// Privacy-safe, read-only inventory of stock DS4 disk-KV headers.
// Verbatim prompt bytes begin after byte 52 and are never read here.
import fs from 'node:fs';
import path from 'node:path';
import {createHash,createHmac,randomBytes} from 'node:crypto';

export const DS4_CACHE_HEADER_BYTES=52;
const SHA_STEM=/^[\da-f]{40}$/i;
const SHA_NAME=/^([\da-f]{40})\.kv$/i;
const WORKER_ID=/^[a-zA-Z0-9][\w-]{0,63}$/;
const MAX_CACHE_FILES=4096;
const MAX_DIRECTORY_ENTRIES=16384;
const MAX_SAFE_BIGINT=BigInt(Number.MAX_SAFE_INTEGER);

function safeInteger64(buffer,offset){
  const value=buffer.readBigUInt64LE(offset);
  return value<=MAX_SAFE_BIGINT?Number(value):null;
}
function cohort(fields){
  return createHash('sha256').update(['dsg-cache-cohort-v1',fields.model_id,fields.weights_fp24,fields.quant_bits,fields.ctx_size,fields.ext_flags,fields.payload_abi].join('\0')).digest('hex');
}
export function cacheSnapshotReference(secret,name){
  if(!Buffer.isBuffer(secret)||secret.length<32)throw new Error('Cache inventory key must contain at least 32 bytes');
  const match=typeof name==='string'?(SHA_NAME.exec(name)??(SHA_STEM.test(name)?[name,name]:null)):null;
  if(!match)throw new Error('Cache snapshot name must be a stock 40-hex .kv filename or canonical stem');
  return createHmac('sha256',secret).update('dsg-cache-key-v1\0').update(match[1].toLowerCase()).digest('hex');
}

export function cacheInventoryDirectories(raw={}){
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('Invalid cache_directories map');
  const result=new Map();
  for(const [worker,directory] of Object.entries(raw)){
    if(!WORKER_ID.test(worker)||typeof directory!=='string'||!path.isAbsolute(directory)||directory.length>4096||directory.includes('\0'))throw new Error('cache_directories requires worker IDs and absolute local directory paths');
    result.set(worker,directory);
  }
  return result;
}

export function parseCacheHeader(buffer,{filename,file_size,secret}={}){
  if(!Buffer.isBuffer(buffer)||buffer.length<DS4_CACHE_HEADER_BYTES||typeof filename!=='string'||!SHA_NAME.test(filename)||!Number.isSafeInteger(file_size)||file_size<DS4_CACHE_HEADER_BYTES)return null;
  if(buffer[0]!==0x4b||buffer[1]!==0x56||buffer[2]!==0x43||buffer[3]!==1||buffer[20]!==2)return null;
  const quant_bits=buffer[4];if(![2,4].includes(quant_bits))return null;
  const tokens=buffer.readUInt32LE(8);if(tokens===0)return null;
  const text_bytes=buffer.readUInt32LE(48),payload_bytes=safeInteger64(buffer,40);if(payload_bytes===null)return null;
  const expected=BigInt(DS4_CACHE_HEADER_BYTES)+BigInt(text_bytes)+BigInt(payload_bytes);if(expected>BigInt(file_size))return null;
  const fields={
    model_id:buffer[7],weights_fp24:buffer[21]|buffer[22]<<8|buffer[23]<<16,quant_bits,
    ctx_size:buffer.readUInt32LE(16),ext_flags:buffer[6],payload_abi:buffer[20]
  };
  const created_at=safeInteger64(buffer,24),last_used=safeInteger64(buffer,32);if(created_at===null||last_used===null)return null;
  return {schema:1,snapshot_ref:cacheSnapshotReference(secret,filename),compatibility_cohort:cohort(fields),compatibility:fields,
    compatibility_confidence:fields.weights_fp24===0?'legacy_unknown_weights':'bounded_header',
    reason:buffer[5]<=6?buffer[5]:0,tokens,hits:buffer.readUInt32LE(12),created_at,last_used,
    payload_bytes,text_bytes,file_bytes:file_size};
}

function readHeader(fd){
  const buffer=Buffer.alloc(DS4_CACHE_HEADER_BYTES);let offset=0;
  while(offset<buffer.length){const read=fs.readSync(fd,buffer,offset,buffer.length-offset,offset);if(!read)break;offset+=read;}
  return offset===buffer.length?buffer:null;
}

export function scanCacheDirectory(directory,{worker,secret,now=Date.now(),max_files=MAX_CACHE_FILES,max_entries=MAX_DIRECTORY_ENTRIES}={}){
  cacheInventoryDirectories({[worker]:directory});
  if(!Number.isSafeInteger(max_files)||max_files<1||max_files>MAX_CACHE_FILES)throw new Error(`max_files must be 1–${MAX_CACHE_FILES}`);
  if(!Number.isSafeInteger(max_entries)||max_entries<1||max_entries>MAX_DIRECTORY_ENTRIES)throw new Error(`max_entries must be 1–${MAX_DIRECTORY_ENTRIES}`);
  const observed_at=Number.isFinite(now)&&now>=0?now:Date.now();
  const result={schema:1,worker,source:'stock_ds4_kvstore_headers',privacy:'installation_keyed_hmac',observed_at,status:'ready',scanned:0,accepted:0,rejected:0,capped:false,entries:[]};
  let dir;
  try{
    const stat=fs.lstatSync(directory);if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('not_regular_directory');
    dir=fs.opendirSync(directory);
    let visited=0;
    for(let item;(item=dir.readSync())!==null;){
      if(visited>=max_entries){result.capped=true;break;}
      visited++;
      if(!SHA_NAME.test(item.name))continue;
      if(result.scanned>=max_files){result.capped=true;break;}
      result.scanned++;
      const file=path.join(directory,item.name);let fd;
      try{
        fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
        const stat=fs.fstatSync(fd);if(!stat.isFile()||!Number.isSafeInteger(stat.size))throw new Error('not_regular_file');
        const header=readHeader(fd),entry=header&&parseCacheHeader(header,{filename:item.name,file_size:stat.size,secret});
        if(!entry)throw new Error('invalid_header');
        result.entries.push(entry);result.accepted++;
      }catch{result.rejected++;}
      finally{if(fd!==undefined)fs.closeSync(fd);}
    }
  }catch{result.status='unavailable';result.entries=[];result.accepted=0;}
  finally{try{dir?.closeSync();}catch{/* Read-only scan is already complete. */}}
  result.entries.sort((a,b)=>b.last_used-a.last_used||b.tokens-a.tokens||a.snapshot_ref.localeCompare(b.snapshot_ref));
  return result;
}

export function loadCacheInventoryKey(runtime){
  if(typeof runtime!=='string'||!path.isAbsolute(runtime)||runtime.includes('\0'))throw new Error('Cache inventory runtime must be an absolute local path');
  fs.mkdirSync(runtime,{recursive:true,mode:0o700});
  const runtimeStat=fs.lstatSync(runtime);if(!runtimeStat.isDirectory()||runtimeStat.isSymbolicLink()||(runtimeStat.mode&0o077)!==0)throw new Error('Cache inventory runtime must be a private regular directory');
  const file=path.join(runtime,'cache-inventory.key');
  try{
    const fd=fs.openSync(file,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
    try{fs.writeSync(fd,randomBytes(32));fs.fsyncSync(fd);}
    finally{fs.closeSync(fd);}
  }catch(error){if(error.code!=='EEXIST')throw error;}
  const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077)!==0||stat.size!==32)throw new Error('Cache inventory key must be a private 32-byte regular file');
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const value=Buffer.alloc(32),n=fs.readSync(fd,value,0,value.length,0);if(n!==value.length)throw new Error('Cache inventory key could not be read');return value;}finally{fs.closeSync(fd);}
}

export class CacheInventoryReader{
  constructor(worker,directory,secret,{interval_ms=60000}={}){
    cacheInventoryDirectories({[worker]:directory});cacheSnapshotReference(secret,'0'.repeat(40));
    if(!Number.isSafeInteger(interval_ms)||interval_ms<10000||interval_ms>3600000)throw new Error('Cache inventory interval must be 10 seconds–1 hour');
    this.worker=worker;this.directory=directory;this.secret=secret;this.intervalMs=interval_ms;this.lastPoll=null;this.inventory={schema:1,worker,status:'unavailable',entries:[]};
  }
  poll(now=Date.now()){
    if(this.lastPoll!==null&&now-this.lastPoll<this.intervalMs)return this.snapshot();
    this.lastPoll=now;this.inventory=scanCacheDirectory(this.directory,{worker:this.worker,secret:this.secret,now});return this.snapshot();
  }
  snapshot(){return summarizeCacheInventory(this.inventory);}
  privateInventory(){return this.inventory;}
}

export function summarizeCacheInventory(inventory){
  const entries=inventory?.status==='ready'&&Array.isArray(inventory.entries)?inventory.entries:[];
  const cohorts=new Map();
  for(const entry of entries){
    const current=cohorts.get(entry.compatibility_cohort)??{cohort:entry.compatibility_cohort,entries:0,file_bytes:0,max_tokens:0,compatibility_confidence:'bounded_header'};
    current.entries++;current.file_bytes+=entry.file_bytes;current.max_tokens=Math.max(current.max_tokens,entry.tokens);
    if(entry.compatibility_confidence!=='bounded_header')current.compatibility_confidence='contains_legacy_unknown_weights';
    cohorts.set(entry.compatibility_cohort,current);
  }
  return {schema:1,worker:WORKER_ID.test(inventory?.worker??'')?inventory.worker:null,source:'stock_ds4_kvstore_headers',privacy:'installation_keyed_hmac',
    observed_at:Number.isFinite(inventory?.observed_at)?inventory.observed_at:null,status:['ready','unavailable'].includes(inventory?.status)?inventory.status:'unavailable',
    scanned:Number.isSafeInteger(inventory?.scanned)?inventory.scanned:0,accepted:entries.length,rejected:Number.isSafeInteger(inventory?.rejected)?inventory.rejected:0,capped:inventory?.capped===true,
    total_file_bytes:entries.reduce((sum,entry)=>sum+entry.file_bytes,0),cohorts:[...cohorts.values()].sort((a,b)=>b.entries-a.entries||a.cohort.localeCompare(b.cohort)).slice(0,32),
    note:'Only stock DS4 header bytes were read. Prompt bytes, cache paths and raw SHA-1 filenames are excluded.'};
}

export function cacheCompatibility(entry,target,{reject_different_quant=false}={}){
  const source=entry?.compatibility;
  if(!source||!target||![source,target].every(value=>Number.isSafeInteger(value.model_id)&&Number.isSafeInteger(value.weights_fp24)&&[2,4].includes(value.quant_bits)&&Number.isSafeInteger(value.ctx_size)))return {status:'unknown',reasons:['missing_profile_evidence']};
  const reasons=[];
  if(source.model_id!==target.model_id)reasons.push('model_shape_mismatch');
  if(target.ctx_size<source.ctx_size)reasons.push('target_context_too_small');
  if(reject_different_quant&&source.quant_bits!==target.quant_bits)reasons.push('quant_policy_mismatch');
  if(source.quant_bits===target.quant_bits&&source.weights_fp24&&target.weights_fp24&&source.weights_fp24!==target.weights_fp24)reasons.push('weights_mismatch');
  if(reasons.length)return {status:'incompatible',reasons};
  if(!source.weights_fp24||!target.weights_fp24)return {status:'unknown',reasons:['legacy_unknown_weights']};
  return {status:'compatible',reasons:[],confidence:'bounded_header'};
}
