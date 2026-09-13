// Read-only view of an operator-maintained private Git configuration library.
// Recipe paths, commands, credentials and evidence files never cross this boundary.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
const ID=/^[a-zA-Z0-9][\w-]{0,63}$/,KINDS=['observed','approved','proposed'];
const object=v=>v&&typeof v==='object'&&!Array.isArray(v);
const text=v=>typeof v==='string'?v.slice(0,256):null;
const number=v=>Number.isFinite(v)&&v>=0?v:null;
const date=v=>typeof v==='string'&&Number.isFinite(Date.parse(v))?v:null;
const digest=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v)?v:null;
const pick=(v,fields,convert)=>Object.fromEntries(fields.filter(k=>v?.[k]!==undefined).map(k=>[k,convert(v[k])]));
export function recordSummary(record,kind,workerId,revision){
  if(record?.schema!==1||record.worker_id!==workerId||record.kind!==kind||!date(record.recorded_at)||!object(record.runtime)||!object(record.model))throw new Error('Invalid configuration record');
  if(kind==='approved'&&(!date(record.approval?.at)||!text(record.approval?.reference)))throw new Error('Approval receipt missing');
  return safeSummary({...record,revision,restoration:{...record.restoration,drill:{...record.restoration?.drill,
    receipt_revision:text(record.restoration?.drill?.receipt)?createHash('sha256').update(record.restoration.drill.receipt).digest('hex'):null}}});
}
function safeSummary(record){
  const kind=record.kind;
  if(!KINDS.includes(kind)||!date(record.recorded_at)||!object(record.runtime)||!object(record.model))throw new Error('Invalid configuration summary');
  if(kind==='approved'&&!date(record.approval?.at))throw new Error('Approval date missing');
  return {kind,revision:digest(record.revision),recorded_at:record.recorded_at,
    runtime:pick(record.runtime,['name','version','build'],text),model:pick(record.model,['name','quantization'],text),
    settings:{...pick(record.settings,['context_length','server_concurrency','max_output_tokens','prefill_batch_tokens'],number),
      ...pick(record.settings,['kv_cache_dtype'],text),
      ...(typeof record.settings?.prefix_caching==='boolean'?{prefix_caching:record.settings.prefix_caching}:{}),
      ...(object(record.settings?.speculative_decoding)?{speculative_decoding:{method:text(record.settings.speculative_decoding.method),tokens:number(record.settings.speculative_decoding.tokens)}}:{})},
    approval:kind==='approved'?{at:record.approval.at}:null,
    restoration:{previous_approved_revision:text(record.restoration?.previous_approved_revision),
      retention:['retained','not_retained','unverified'].includes(record.restoration?.retention)?record.restoration.retention:'unverified',
      drill:record.restoration?.drill?.status==='restored-in-drill'&&date(record.restoration.drill.at)&&digest(record.restoration.drill.receipt_revision)?{status:'restored-in-drill',at:record.restoration.drill.at,receipt_revision:record.restoration.drill.receipt_revision}:{status:'unproven'}},
    // These fixed categories identify differences without forwarding raw prose.
    discrepancies:(record.discrepancies??[]).filter(v=>['configured_route_differs','recovery_binding_differs','launcher_differs','source_has_local_changes','runtime_settings_unverified'].includes(v)),
  };
}
export function recordsForChat(value){
  if(!value?.configured)return {configured:false,records:[]};
  // Apply the allowlist again even if an alternate snapshot supplier is used.
  return {configured:true,authority:'none',records:(value.records??[]).filter(r=>ID.test(r.worker_id??'')).map(r=>({worker_id:r.worker_id,
    ...Object.fromEntries(KINDS.map(kind=>{const v=r[kind];if(!v||v.kind!==kind)return [kind,null];try{return [kind,safeSummary(v)];}catch{return [kind,null];}}))})),
    scope:'Dated configuration records, not continuous engine inspection. Observed and proposed records are not approval. No record gives this chat permission to act.'};
}
export class ServerRecords {
  constructor(directory){this.directory=directory?path.resolve(directory):null;}
  snapshot(workerIds=[]){
    if(!this.directory)return {configured:false,records:[]};
    const records=[],unavailable=[];
    for(const id of [...new Set(workerIds)].filter(id=>ID.test(id))){
      const row={worker_id:id};
      for(const kind of KINDS){
        row[kind]=null;let fd;
        try{
          const folder=path.join(this.directory,kind),file=path.join(folder,id+'.json');
          // No symlink traversal into a credential file or unrelated directory.
          if(fs.lstatSync(this.directory).isSymbolicLink()||fs.lstatSync(folder).isSymbolicLink())throw new Error();
          fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);const stat=fs.fstatSync(fd);
          if(!stat.isFile()||stat.size>1024*1024)throw new Error();
          const bytes=fs.readFileSync(fd),value=JSON.parse(bytes);
          row[kind]=recordSummary(value,kind,id,createHash('sha256').update(bytes).digest('hex'));
        }catch(error){if(error.code!=='ENOENT')unavailable.push({worker_id:id,kind});}
        finally{if(fd!==undefined)fs.closeSync(fd);}
      }
      records.push(row);
    }
    return {configured:true,authority:'none',records,unavailable};
  }
}
