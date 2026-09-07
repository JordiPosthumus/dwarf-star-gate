// Read-only fleet pulse from persisted, allowlisted DS4 engine timing rows.
// Cumulative request counters are differenced before aggregation; repeated log
// samples therefore cannot make a long request count more than its token/time.
import fs from 'node:fs';
import path from 'node:path';

const HOUR=3600000,DAY=24*HOUR,FILE=/^metrics-\d{4}-\d{2}-\d{2}\.jsonl$/;
const ID=/^[a-zA-Z0-9][\w-]{0,63}$/,SAMPLE=/^[\da-f]{64}$/,EPOCH=/^[\da-f]{64}$/;
const WINDOWS=Object.freeze({'1h':HOUR,'12h':12*HOUR,'24h':DAY});
const LINE_BYTES=64*1024,READ_BYTES=4*1024*1024,MAX_INTERVALS=200000;
const count=value=>Number.isSafeInteger(value)&&value>=0?value:null;
const seconds=value=>Number.isFinite(value)&&value>=0&&value<=7*86400?value:null;
const niceCeiling=value=>{
  if(!Number.isFinite(value)||value<=0)return null;
  const power=10**Math.floor(Math.log10(value)),scaled=value/power;
  return (scaled<=1?1:scaled<=2?2:scaled<=5?5:10)*power;
};

export class FleetSpeed {
  constructor({maxIntervals=MAX_INTERVALS}={}){
    if(!Number.isInteger(maxIntervals)||maxIntervals<1||maxIntervals>MAX_INTERVALS)throw new Error('Fleet speed interval budget must be 1–200000');
    this.maxIntervals=maxIntervals;this.states=new Map();this.powerStates=new Map();this.powerObservations=new Map();this.excludedPower=0;this.seen=new Set();this.intervals=[];this.energy=[];this.rejected=0;this.evicted=0;
  }
  resetNode(node,epoch=null,at=null){this.states.set(node,{epoch,at,prefill:null,decode:null});}
  add(node,kind,at,current){
    const state=this.states.get(node)??{epoch:null,at:null,prefill:null,decode:null},prior=state[kind];
    if(prior&&at<prior.at){this.rejected++;return;}
    state[kind]=current;state.at=at;this.states.set(node,state);
    if(!prior)return;
    const tokenDelta=current.tokens-prior.tokens,secondDelta=current.seconds-prior.seconds;
    if(tokenDelta<0||secondDelta<0){this.rejected++;return;}
    if(tokenDelta===0||secondDelta===0)return;
    const rate=tokenDelta/secondDelta;
    if(!Number.isFinite(rate)||rate<=0||rate>100000){this.rejected++;return;}
    // The interval is bounded by both the engine's phase duration delta and
    // the observed event timestamps. A late/replayed log line cannot invent
    // activity before the prior sample.
    const start=Math.max(prior.at,at-secondDelta*1000),duration=(at-start)/1000;
    if(!(duration>0))return;
    const fraction=duration/secondDelta;
    this.intervals.push({node,kind,start,end:at,seconds:duration,tokens:tokenDelta*fraction,rate});
    if(this.intervals.length>this.maxIntervals){this.intervals.splice(0,this.intervals.length-this.maxIntervals);this.evicted++;}
  }
  addPower(node,at,watts,epoch,scope,sensor=null){
    const prior=this.powerStates.get(node);
    if(prior&&at<=prior.at){this.rejected++;return;}
    this.powerStates.set(node,{at,watts,epoch,scope,sensor});
    if(!prior||(prior.epoch&&epoch&&prior.epoch!==epoch)||prior.scope!==scope||prior.sensor!==sensor)return;
    const duration=(at-prior.at)/1000;
    // The planned hardware lane samples every 10 seconds. Never bridge a
    // collector outage or machine disappearance into fictional energy use.
    if(duration>60)return;
    this.energy.push({node,start:prior.at,end:at,seconds:duration,watt_hours:(prior.watts+watts)/2*duration/3600,start_watts:prior.watts,end_watts:watts,scope,sensor});
    if(this.energy.length>this.maxIntervals){this.energy.splice(0,this.energy.length-this.maxIntervals);this.evicted++;}
  }
  accept(row){
    if(!['process_start','start','prefill','prefill_done','decode','finish','hardware'].includes(row?.kind))return;
    if(!ID.test(row.node??'')||!SAMPLE.test(row.sample_id??'')||!Number.isFinite(row.time)||row.time<=0){this.rejected++;return;}
    const key=`${row.node}:${row.sample_id}`;if(this.seen.has(key))return;this.seen.add(key);
    if(this.seen.size>400000)this.seen.delete(this.seen.values().next().value);
    const epoch=EPOCH.test(row.backend_epoch??'')?row.backend_epoch:null,state=this.states.get(row.node);
    if(row.kind==='hardware'){
      // A RAM-only or thermal-only sample says nothing about power; it is not
      // zero watts and does not refresh a power sample or its coverage.
      if(row.power_watts===undefined||row.power_watts===null)return;
      const watts=row.power_watts;if(typeof watts!=='number'||!Number.isFinite(watts)||watts<0||watts>5000||!['compute_module','system','gpu_only'].includes(row.power_scope)){this.rejected++;return;}
      const sensor=row.power_sensor==='smc_pstr'&&row.power_scope==='system'?'smc_pstr':null;
      if(row.time<=(this.powerObservations.get(row.node)?.at??0)){this.rejected++;return;}
      this.powerObservations.set(row.node,{at:row.time,scope:row.power_scope,sensor});
      if(this.powerObservations.size>512)this.powerObservations.delete(this.powerObservations.keys().next().value);
      if(row.power_scope==='gpu_only'){this.excludedPower++;this.powerStates.delete(row.node);return;}
      this.addPower(row.node,row.time,watts,epoch,row.power_scope,sensor);return;
    }
    if(state?.epoch&&epoch&&state.epoch!==epoch)this.resetNode(row.node,epoch,row.time);
    else if(state&&epoch&&!state.epoch)state.epoch=epoch;
    if(row.kind==='process_start'||row.kind==='start'){
      if(row.kind==='process_start')this.powerStates.delete(row.node);
      this.resetNode(row.node,epoch,row.time);
      if(row.kind==='start'){
        const next=this.states.get(row.node);next.prefill={tokens:0,seconds:0,at:row.time};next.decode={tokens:0,seconds:0,at:row.time};
      }
      return;
    }
    if(row.kind==='finish'){this.states.delete(row.node);return;}
    if(row.kind==='prefill'||row.kind==='prefill_done'){
      const tokens=count(row.kind==='prefill'?row.processed:row.new_tokens),elapsed=seconds(row.seconds);
      if(tokens===null||elapsed===null){this.rejected++;return;}
      this.add(row.node,'prefill',row.time,{tokens,seconds:elapsed,at:row.time});return;
    }
    const tokens=count(row.generated),elapsed=seconds(row.seconds);
    if(tokens===null||elapsed===null){this.rejected++;return;}
    this.add(row.node,'decode',row.time,{tokens,seconds:elapsed,at:row.time});
  }
  phase(kind,windowMs,now,workers){
    const from=now-windowMs,allowed=new Set(workers),byWorker=new Map();let tokens=0,active=0,samples=0;
    for(const row of this.intervals){
      if(row.kind!==kind||row.end<=from||row.start>=now||(allowed.size&&!allowed.has(row.node)))continue;
      const start=Math.max(row.start,from),end=Math.min(row.end,now),duration=(end-start)/1000;
      if(!(duration>0))continue;
      const share=duration/row.seconds;tokens+=row.tokens*share;active+=duration;samples++;
      byWorker.set(row.node,(byWorker.get(row.node)??0)+duration);
    }
    const workerCount=workers.length,lowerBound=workerCount?100*[...byWorker.values()].reduce((sum,value)=>sum+Math.min(value,windowMs/1000),0)/(workerCount*windowMs/1000):null;
    return {mean_tps:active>0?tokens/active:null,tokens_observed:active>0?tokens:null,active_seconds:active,samples,observed_workers:byWorker.size,worker_count:workerCount,
      activity_lower_bound_pct:lowerBound===null?null:Math.min(100,lowerBound)};
  }
  energySummary(windowMs,now,workers){
    const from=now-windowMs,allowed=new Set(workers),byWorker=new Map();let measured=0;
    for(const row of this.energy){
      if(row.end<=from||row.start>=now||!allowed.has(row.node))continue;
      const start=Math.max(row.start,from),end=Math.min(row.end,now),duration=(end-start)/1000;if(!(duration>0))continue;
      const span=row.end-row.start,delta=row.end_watts-row.start_watts,wattsStart=row.start_watts+delta*(start-row.start)/span,wattsEnd=row.start_watts+delta*(end-row.start)/span,wattHours=(wattsStart+wattsEnd)/2*duration/3600,entry=byWorker.get(row.node)??{seconds:0,watt_hours:0,scopes:new Set(),sensors:new Set()};entry.seconds+=duration;entry.watt_hours+=wattHours;entry.scopes.add(row.scope);if(row.sensor)entry.sensors.add(row.sensor);byWorker.set(row.node,entry);measured+=wattHours;
    }
    const windowSeconds=windowMs/1000,coverage=workers.length?100*[...byWorker.values()].reduce((sum,row)=>sum+Math.min(windowSeconds,row.seconds),0)/(workers.length*windowSeconds):null;
    let estimated=0,ready=workers.length>0;
    const included=workers.map(worker=>{
      const row=byWorker.get(worker),share=row?Math.min(1,row.seconds/windowSeconds):0,latest=this.powerObservations.get(worker),scopes=[...(row?.scopes??[])].sort(),sensors=[...(row?.sensors??[])].sort();
      const eligible=!!row&&share>=.8&&scopes.length===1;
      if(!eligible)ready=false;else estimated+=row.watt_hours/share;
      return {worker,measured_kwh:row?row.watt_hours/1000:0,coverage_pct:share*100,estimated_kwh:eligible?row.watt_hours/share/1000:null,scopes,sensors,
        status:eligible?'estimated_from_measured_power':scopes.length>1?'power_scope_changed':row?'insufficient_power_coverage':latest?.scope==='gpu_only'&&latest.at>from?'gpu_only_excluded':'awaiting_power_data'};
    });
    return {estimated_kwh:ready?estimated/1000:null,measured_kwh:measured/1000,coverage_pct:coverage===null?null:Math.min(100,coverage),
      window_start:from,window_end:now,workers:included,method:'trapezoidal_measured_power_max_60s_gap_per_worker_80pct_extrapolation',
      status:ready?'estimated_from_measured_power':byWorker.size?'insufficient_power_coverage':'awaiting_power_data'};
  }
  snapshot(now=Date.now(),workers=[]){
    const ids=[...new Set(Array.isArray(workers)?workers.filter(value=>ID.test(value)):[])],from=now-DAY;
    this.intervals=this.intervals.filter(row=>row.end>from&&row.end<=now+5000);
    this.energy=this.energy.filter(row=>row.end>from&&row.end<=now+5000);
    const relevant=this.intervals.filter(row=>!ids.length||ids.includes(row.node));
    const calibration={};
    for(const kind of ['decode','prefill']){
      const rates=relevant.filter(row=>row.kind===kind).map(row=>row.rate).sort((a,b)=>a-b);
      const p95=rates.length?rates[Math.max(0,Math.ceil(rates.length*.95)-1)]:null;
      calibration[kind]={max_tps:niceCeiling(p95===null?null:p95*1.15),basis:'p95_24h_padded',samples:rates.length};
    }
    return {schema:1,source:'ds4_engine_cumulative_timing_deltas',as_of:now,
      windows:Object.fromEntries(Object.entries(WINDOWS).map(([name,ms])=>[name,{window_ms:ms,decode:this.phase('decode',ms,now,ids),prefill:this.phase('prefill',ms,now,ids),energy:this.energySummary(ms,now,ids)}])),
      calibration,intervals:relevant.length,power_intervals:this.energy.filter(row=>!ids.length||ids.includes(row.node)).length,excluded_power_records:this.excludedPower,rejected_records:this.rejected,evicted_intervals:this.evicted,
      oldest_interval_at:relevant.length?relevant.reduce((oldest,row)=>Math.min(oldest,row.start),Infinity):null};
  }
}

export class FleetSpeedReader {
  constructor(directory,{readBytes=READ_BYTES,retainedFiles=2,createAccumulator=()=>new FleetSpeed()}={}){
    if(typeof directory!=='string'||!path.isAbsolute(directory))throw new Error('Fleet speed directory must be absolute');
    if(!Number.isInteger(readBytes)||readBytes<1024||readBytes>READ_BYTES)throw new Error('Fleet speed read budget must be 1024–4194304');
    if(!Number.isInteger(retainedFiles)||retainedFiles<2||retainedFiles>8||typeof createAccumulator!=='function')throw new Error('Metric reader requires 2–8 files and an accumulator');
    Object.assign(this,{directory,readBytes,retainedFiles,createAccumulator});this.cursors=new Map();this.speed=createAccumulator();this.status='waiting';this.lastRead=null;this.malformed=0;this.rescans=0;
  }
  rebuild(){this.cursors.clear();this.speed=this.createAccumulator();this.rescans++;this.status='rescanning';}
  poll(now=Date.now()){
    try{
      const root=fs.lstatSync(this.directory);if(!root.isDirectory()||root.isSymbolicLink())throw new Error('Not a real directory');
      const files=fs.readdirSync(this.directory).filter(name=>FILE.test(name)).sort().slice(-this.retainedFiles);
      if([...this.cursors.keys()].some(file=>!files.includes(file))){this.rebuild();return;}
      let backlog=false;
      for(const file of files){
        const full=path.join(this.directory,file);if(!fs.lstatSync(full).isFile())throw new Error('Not a regular file');
        const fd=fs.openSync(full,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
        try{
          const stat=fs.fstatSync(fd);if(!stat.isFile())throw new Error('Not a regular file');
          const identity=`${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;let cursor=this.cursors.get(file);
          const anchor=cursor?Buffer.alloc(cursor.anchor.length):Buffer.alloc(0);
          const changed=cursor&&(cursor.identity!==identity||stat.size<cursor.offset||(anchor.length&&(fs.readSync(fd,anchor,0,anchor.length,cursor.offset-anchor.length)!==anchor.length||!anchor.equals(cursor.anchor))));
          if(changed){this.rebuild();return;}
          cursor??={identity,offset:0,fragment:Buffer.alloc(0),skipping:false,anchor:Buffer.alloc(0)};this.cursors.set(file,cursor);
          const length=Math.min(this.readBytes,Math.max(0,stat.size-cursor.offset)),chunk=Buffer.alloc(length),read=length?fs.readSync(fd,chunk,0,length,cursor.offset):0;cursor.offset+=read;
          const buffer=Buffer.concat([cursor.fragment,chunk.subarray(0,read)]);let from=0,end;
          while((end=buffer.indexOf(10,from))>=0){
            if(!cursor.skipping&&end-from<=LINE_BYTES){try{this.speed.accept(JSON.parse(buffer.subarray(from,end).toString('utf8')));}catch{this.malformed++;}}
            else if(!cursor.skipping)this.malformed++;
            cursor.skipping=false;from=end+1;
          }
          cursor.fragment=Buffer.from(buffer.subarray(from));if(cursor.fragment.length>LINE_BYTES||cursor.skipping){if(!cursor.skipping)this.malformed++;cursor.fragment=Buffer.alloc(0);cursor.skipping=true;}
          cursor.anchor=Buffer.alloc(Math.min(64,cursor.offset));if(cursor.anchor.length)fs.readSync(fd,cursor.anchor,0,cursor.anchor.length,cursor.offset-cursor.anchor.length);
          backlog||=cursor.offset<stat.size;if(backlog)break;
        }finally{fs.closeSync(fd);}
      }
      this.status=!files.length?'waiting':backlog?'catching_up':'ready';this.lastRead=now;
    }catch{this.status='unavailable';}
  }
  workerRates(node,now=Date.now()){
    const partial=!!(this.malformed||this.speed.rejected||this.speed.evicted);
    const ready=this.status==='ready',windowMs=6*HOUR;
    return Object.fromEntries(['decode','prefill'].map(kind=>{
      const total=this.speed.phase(kind,windowMs,now,[node]);
      const recent=this.speed.phase(kind,3*HOUR,now,[node]);
      const previous=this.speed.phase(kind,3*HOUR,now-3*HOUR,[node]);
      const supported=ready&&!partial&&[recent,previous].every(x=>x.samples>=3&&x.active_seconds>=60&&x.mean_tps>0);
      const change=supported?100*(recent.mean_tps/previous.mean_tps-1):null;
      let oldest=null;
      for(const row of this.speed.intervals)if(row.node===node&&row.kind===kind&&row.end>now-windowMs&&row.start<now)
        oldest=oldest===null?Math.max(now-windowMs,row.start):Math.min(oldest,Math.max(now-windowMs,row.start));
      return [kind,{window_ms:windowMs,mean_tps:ready?total.mean_tps:null,samples:ready?total.samples:0,
        active_seconds:ready?total.active_seconds:0,history_span_ms:ready&&oldest!==null?now-oldest:0,
        recent_mean_tps:ready?recent.mean_tps:null,previous_mean_tps:ready?previous.mean_tps:null,
        change_pct:change,trend:change===null?'insufficient':change>=5?'up':change<=-5?'down':'steady',
        status:this.status,partial_history:partial}];
    }));
  }
  snapshot(now=Date.now(),workers=[]){return {...this.speed.snapshot(now,workers),status:this.status,last_read_at:this.lastRead,malformed_lines:this.malformed,rescans:this.rescans,
    partial_history:!!(this.malformed||this.speed.rejected||this.speed.evicted)};}
}
