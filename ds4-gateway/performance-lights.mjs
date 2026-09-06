// Observational comparisons only. No routing, server settings or action authority.
import {createHash} from 'node:crypto';
import {FleetSpeed,FleetSpeedReader} from './fleet-speed.mjs';
const MINUTE=60000,RECENT=30*MINUTE,HISTORY=7*24*60*MINUTE,FRESH=15000;
const DIGEST=/^[a-f0-9]{64}$/,ID=/^[a-zA-Z0-9][\w-]{0,63}$/;
const integer=n=>Number.isSafeInteger(n)&&n>=0;
const bucket=n=>integer(n)?Math.floor(Math.log2(Math.max(1,n))):null;
export function performanceActive(device,worker,now=Date.now()){
  if(worker?.load>0)return true;
  if(device?.connected&&Number.isFinite(device.last_event)&&now-device.last_event>=0&&now-device.last_event<=FRESH){
    if(['prefill','thinking','decode'].includes(device.phase))return true;
    if(device.phase==='idle')return false;
  }
  return null;
}
export function performanceProfile(value){
  // Explicit operator-attested equivalence; never infer hardware from its name.
  if(!value||value.concurrency!==1)return null;
  const fields=['hardware','model','quantization','engine_build'];
  if(fields.some(key=>typeof value[key]!=='string'||!value[key].trim()||Buffer.byteLength(value[key])>128))return null;
  return createHash('sha256').update(JSON.stringify(fields.map(key=>value[key]).concat(1))).digest('hex');
}
export function performanceThresholds(value={}){
  const amber=value.amber_slowdown??.15,red=value.red_slowdown??.30;
  if(!Number.isFinite(amber)||!Number.isFinite(red)||amber<=0||red<=amber||red>=1)throw new Error('Performance slowdown thresholds require 0 < amber < red < 1');
  return {amber,red};
}
const rank=level=>({grey:0,green:1,amber:2,red:3})[level];
const grey=(reason,extra={})=>({level:'grey',reason,...extra});
const aggregate=rows=>{
  let tokens=0,seconds=0;const requests=new Set();
  for(const r of rows){tokens+=r.tokens;seconds+=r.seconds;requests.add(r.request);}
  return {tps:seconds?tokens/seconds:null,seconds,requests:requests.size};
};
const clip=(row,from,to)=>{
  const start=Math.max(from,row.start),end=Math.min(to,row.end);if(end<=start)return null;
  const seconds=(end-start)/1000;return {...row,start,end,seconds,tokens:row.rate*seconds};
};
const supported=summary=>summary.seconds>=60&&summary.requests>=3;

export class PerformanceHistory extends FleetSpeed {
  constructor(options={}){super(options);this.thresholds=performanceThresholds(options);this.contexts=new Map();this.restore=new Map();this.skipped=0;this.skipReasons={};}
  skip(reason){this.skipped++;this.skipReasons[reason]=(this.skipReasons[reason]??0)+1;}
  accept(row){
    if(!row||!ID.test(row.node??'')||!DIGEST.test(row.sample_id??'')||!Number.isFinite(row.time)||row.time<=0)return;
    if(this.seen.has(`${row.node}:${row.sample_id}`))return;
    const old=this.contexts.get(row.node);
    if(old&&row.time<old.time){this.rejected++;return;}
    if(row.kind==='process_start'||old&&row.backend_epoch!==old.epoch){this.contexts.delete(row.node);this.restore.delete(row.node);}
    if(row.kind==='disk_restore'){
      if(integer(row.cached)&&row.cached>0&&Number.isFinite(row.load_ms)&&row.load_ms>=0)this.restore.set(row.node,{at:row.time,epoch:row.backend_epoch});
      if(this.restore.size>512){this.restore.delete(this.restore.keys().next().value);this.skip('metadata_budget');}
      // Only the phase marker is retained; disk time is never counted as prefill.
      return;
    }
    if(row.kind==='start'){
      const prior=this.contexts.get(row.node),overlap=prior?.depth??0;
      if(overlap){this.intervals=this.intervals.filter(interval=>interval.request!==prior.request);this.skip('unresolved_prior_start');}
      const restore=this.restore.get(row.node),disk=restore&&restore.epoch===row.backend_epoch&&row.time>=restore.at&&row.time-restore.at<=60000;
      const valid=integer(row.prompt)&&integer(row.cached)&&integer(row.new_tokens)&&row.prompt===row.cached+row.new_tokens&&DIGEST.test(row.backend_epoch??'');
      this.contexts.set(row.node,{time:row.time,depth:overlap+1,valid:valid&&!overlap,invalidReason:overlap?'unresolved_prior_start':'missing_process_or_prompt',request:row.sample_id,epoch:row.backend_epoch,prompt:row.prompt,cached:row.cached,new_tokens:row.new_tokens,
        mode:disk?'restored_suffix':row.cached>0?'cached_suffix':'cold',profile:DIGEST.test(row.performance_profile??'')?row.performance_profile:null});
      this.restore.delete(row.node);
    }
    if(['start','prefill','prefill_done','decode','finish','process_start'].includes(row.kind))super.accept(row);
    if(this.contexts.size>512){const id=this.contexts.keys().next().value;this.contexts.delete(id);this.states.delete(id);this.skip('metadata_budget');}
    if(this.states.size>512){const id=this.states.keys().next().value;this.states.delete(id);this.contexts.delete(id);this.skip('metadata_budget');}
    if(row.kind==='finish'){
      const current=this.contexts.get(row.node);
      if(current?.depth>1){current.depth--;current.valid=false;current.time=row.time;}else this.contexts.delete(row.node);
    }
  }
  add(node,kind,at,current){
    const prior=this.states.get(node)?.[kind],context=this.contexts.get(node);
    if(prior&&(current.tokens<prior.tokens||current.seconds<prior.seconds)&&context){context.valid=false;context.invalidReason='counter_regression';}
    const last=this.intervals.at(-1);super.add(node,kind,at,current);
    const added=this.intervals.at(-1);if(!added||added===last)return;
    if(!context?.valid){this.intervals.pop();this.skip(context?.invalidReason??'missing_start');return;}
    const contextBucket=bucket(context.prompt+(kind==='decode'?current.tokens:0));
    Object.assign(added,{request:context.request,epoch:context.epoch,profile:context.profile,
      cohort:`${contextBucket}:${kind==='prefill'?`${context.mode}:${bucket(context.new_tokens)}`:'decode'}`});
  }
  compare(recent,baseline){
    const groups=new Map();for(const row of baseline){const group=groups.get(row.cohort)??[];group.push(row);groups.set(row.cohort,group);}
    const references=new Map([...groups].map(([key,rows])=>[key,aggregate(rows)]).filter(([,summary])=>supported(summary)));
    const matched=recent.filter(row=>references.has(row.cohort)),summary=aggregate(matched),all=aggregate(recent);
    const coverage=all.seconds?summary.seconds/all.seconds:0;
    if(!supported(summary)||coverage<.8)return grey('insufficient_matched_history',{recent:all,matched_fraction:coverage});
    let expected=0;for(const row of matched)expected+=references.get(row.cohort).tps*row.seconds;
    const slowdown=1-summary.tps/(expected/summary.seconds);
    const candidate=slowdown>=this.thresholds.red?'red':slowdown>=this.thresholds.amber?'amber':'green';
    // Require the same direction in two disjoint ten-minute blocks. Polling the
    // same evidence twice cannot manufacture sustained confirmation.
    const end=recent.reduce((end,row)=>Math.max(end,row.end),0),levels=[];
    for(const [from,to] of [[end-20*MINUTE,end-10*MINUTE],[end-10*MINUTE,end]]){
      const rows=matched.map(row=>clip(row,from,to)).filter(Boolean),part=aggregate(rows);
      if(part.seconds<20||part.requests<2){levels.push(null);continue;}
      const expectedTokens=rows.reduce((sum,row)=>sum+references.get(row.cohort).tps*row.seconds,0),drop=1-part.tps/(expectedTokens/part.seconds);
      levels.push(drop>=this.thresholds.red?'red':drop>=this.thresholds.amber?'amber':'green');
    }
    const sustained=levels.every(level=>level&&rank(level)>=rank(candidate));
    return {level:candidate==='green'||sustained?candidate:'grey',reason:candidate!=='green'&&!sustained?'awaiting_sustained_confirmation':'matched_comparison',
      recent:summary,baseline_tps:expected/summary.seconds,slowdown,matched_fraction:coverage,cohorts:references.size,sustained,baseline_requests:new Set(baseline.filter(row=>references.has(row.cohort)).map(row=>row.request)).size};
  }
  snapshot(now=Date.now(),devices=[]){
    this.intervals=this.intervals.filter(row=>row.end>now-HISTORY&&row.end<=now+5000);
    for(const [id,row] of this.contexts)if(row.time<now-HISTORY)this.contexts.delete(id);
    for(const [id,row] of this.restore)if(row.at<now-MINUTE)this.restore.delete(id);
    const workers={};
    for(const device of devices){
      const own=this.intervals.filter(row=>row.node===device.id),lights={};
      for(const kind of ['decode','prefill']){
        const fresh=device.connected===true&&Number.isFinite(device[kind]?.time)&&now-device[kind].time>=0&&now-device[kind].time<=FRESH&&device.active===true;
        let recent=own.filter(row=>row.kind===kind&&row.epoch===device.backend_epoch).map(row=>clip(row,now-RECENT,now)).filter(Boolean);
        if(!fresh){lights[kind]=grey(device.active===false?'idle':'stale_or_unavailable',{as_of:device[kind]?.time??null});continue;}
        const profile=recent.at(-1)?.profile;
        recent=recent.filter(row=>row.profile===profile);
        const baseline=own.filter(row=>row.kind===kind&&(profile?row.profile===profile:row.epoch===device.backend_epoch)).map(row=>clip(row,now-HISTORY,now-RECENT)).filter(Boolean);
        const peerRows=profile?this.intervals.filter(row=>row.node!==device.id&&row.kind===kind&&row.profile===profile).map(row=>clip(row,now-RECENT,now)).filter(Boolean):[];
        const self=this.compare(recent,baseline),peers=profile?this.compare(recent,peerRows):grey('peer_configuration_unverified');
        const selected=rank(self.level)>=rank(peers.level)?self:peers;
        lights[kind]={...selected,self,peers,basis:selected.level==='grey'?'none':self.level===peers.level?'self_and_peers':selected===self?'self':'peers',
          as_of:device[kind]?.time??null,confidence:profile?'bounded_attestation':'limited_same_process',configuration_basis:profile?'operator_attested_profile':'same_backend_process',
          history_from:baseline.length?baseline.reduce((start,row)=>Math.min(start,row.start),Infinity):null,history_until:now-RECENT};
      }
      workers[device.id]={...lights,active:device.active??null};
    }
    return {schema:1,as_of:now,recent_ms:RECENT,history_ms:HISTORY,thresholds:this.thresholds,workers,intervals:this.intervals.length,rejected_records:this.rejected,evicted_intervals:this.evicted,skipped_intervals:this.skipped,exclusion_reasons:{...this.skipReasons}};
  }
}
export class PerformanceReader extends FleetSpeedReader {
  constructor(directory,options={}){super(directory,{retainedFiles:8,createAccumulator:()=>new PerformanceHistory(options)});}
  snapshot(now,devices){
    const value=super.snapshot(now,devices);
    value.partial_history||=!!value.skipped_intervals;value.retained_files=this.cursors.size;
    if(this.status!=='ready'||!Number.isFinite(this.lastRead)||now-this.lastRead>FRESH){
      for(const worker of Object.values(value.workers))for(const kind of ['decode','prefill'])worker[kind]=grey('history_reader_unavailable');
    }
    return value;
  }
}
