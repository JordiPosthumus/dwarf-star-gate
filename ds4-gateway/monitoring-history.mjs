// Bounded operational telemetry only. No request bodies, model output, paths,
// credentials, cookies, or counter baselines are persisted in this notebook.
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';

const WINDOW_MS=900000,MAX_BYTES=8*1024*1024;
const phases=new Set(['prefill','decode','thinking','mixed','working','idle','paused','unavailable','unknown']);
const scopes=new Set(['poll_interval_throughput','active_request_average']);
const validId=value=>typeof value==='string'&&/^[\w-]{1,64}$/.test(value);
const fingerprint=(worker,file)=>createHash('sha256').update(JSON.stringify([
  worker.id,worker.backend??'ds4',worker.url,worker.api_key_file??null,
  worker.backend==='openai'?null:[worker.ssh??null,worker.telemetry_service??null,file??null],
])).digest('hex');
const recent=(time,now)=>Number.isFinite(time)&&time<=now&&time>now-WINDOW_MS;
function safeEntry(entry,now){
  return {
    phases:(Array.isArray(entry?.phases)?entry.phases:[]).filter(row=>phases.has(row?.phase)&&Number.isFinite(row.start)&&recent(row.end,now)&&row.start<=row.end)
      .slice(-1024).map(row=>({start:Math.max(row.start,now-WINDOW_MS),end:row.end,phase:row.phase})).sort((a,b)=>a.start-b.start),
    markers:(Array.isArray(entry?.markers)?entry.markers:[]).filter(row=>recent(row?.time,now)&&row.phase==='prefill'&&Number.isFinite(row.tokens)&&row.tokens>0&&['poll_interval','completed_request'].includes(row.basis))
      .slice(-512).map(row=>({time:row.time,phase:'prefill',tokens:row.tokens,basis:row.basis})),
    rates:(Array.isArray(entry?.rates)?entry.rates:[]).filter(row=>recent(row?.time,now)&&['prefill','decode'].includes(row.kind)&&Number.isFinite(row.tps)&&row.tps>=0&&scopes.has(row.scope))
      .slice(-1024).map(row=>({time:row.time,kind:row.kind,tps:row.tps,scope:row.scope})),
  };
}
export class MonitoringHistory {
  constructor(filename,{now=Date.now}={}){
    Object.assign(this,{filename,now});this.identities=new Map();this.loaded=new Map();this.status='waiting';this.lastSaved=null;
    try{
      const fd=fs.openSync(filename,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
      try{
        const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.size>MAX_BYTES)throw new Error('Invalid history file');
        const raw=JSON.parse(fs.readFileSync(fd,'utf8'));
        if(raw.schema!==1||!raw.workers||typeof raw.workers!=='object'||Array.isArray(raw.workers))throw new Error('Unsupported history');
        for(const [id,entry]of Object.entries(raw.workers))if(validId(id)&&/^[a-f0-9]{64}$/.test(entry?.identity??''))this.loaded.set(id,{identity:entry.identity,...safeEntry(entry,now())});
        this.status='loaded';
      }finally{fs.closeSync(fd);}
    }catch(error){this.status=error.code==='ENOENT'?'new':'unavailable';}
  }
  sync(workers,activity,telemetry,files=new Map()){
    const next=new Map(workers.map(worker=>[worker.id,fingerprint(worker,files.get(worker.id))]));
    for(const [id,identity]of this.identities)if(next.get(id)!==identity){
      activity.history.delete(id);activity.markers.delete(id);activity.lastSamples.delete(id);telemetry.histories.delete(id);this.loaded.delete(id);
    }
    for(const [id,identity]of next)if(!this.identities.has(id)){
      const saved=this.loaded.get(id);this.loaded.delete(id);
      if(saved?.identity!==identity)continue;
      const now=this.now(),entry=safeEntry(saved,now);
      // A restart gap is unknown, including gaps shorter than the normal sample
      // interval. Do not stretch the last observed phase across downtime.
      const last=entry.phases.at(-1);
      if(last&&last.end<now)entry.phases.push({start:last.end,end:now,phase:'unknown'});
      activity.history.set(id,entry.phases);activity.markers.set(id,entry.markers);telemetry.histories.set(id,entry.rates);
    }
    this.identities=next;
  }
  save(activity,telemetry){
    let temporary;
    try{
      try{if(!fs.lstatSync(this.filename).isFile())throw new Error('Not regular');}catch(error){if(error.code!=='ENOENT')throw error;}
      const now=this.now(),workers={};
      for(const [id,identity]of this.identities)if(validId(id))workers[id]={identity,...safeEntry({phases:activity.get(id),markers:activity.getMarkers(id,now),rates:telemetry.histories.get(id)},now)};
      const bytes=JSON.stringify({schema:1,saved_at:now,workers});if(Buffer.byteLength(bytes)>MAX_BYTES)throw new Error('History storage limit');
      temporary=path.join(path.dirname(this.filename),`.monitoring-history-${randomUUID()}.tmp`);
      fs.writeFileSync(temporary,bytes,{mode:0o600,flag:'wx'});fs.renameSync(temporary,this.filename);temporary=null;
      this.lastSaved=now;this.status='ready';
    }catch{this.status='unavailable';}
    finally{if(temporary)try{fs.unlinkSync(temporary);}catch{/* A failed save does not affect live telemetry. */}}
  }
  snapshot(){return {status:this.status,window_ms:WINDOW_MS,last_saved_at:this.lastSaved,counter_baselines_persisted:false};}
}
