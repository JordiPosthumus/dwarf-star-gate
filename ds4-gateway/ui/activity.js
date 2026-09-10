// Shared by the dashboard and UI; percentages describe gateway slots, not GPU load.
export function capacity(gateway, stale=false) {
  if(!gateway || stale)return null;
  const eligible=gateway.workers.filter(w=>w.is_healthy && !w.drained);
  const occupied=eligible.filter(w=>w.load>0).length;
  return {eligible:eligible.length,occupied,free:gateway.draining?0:eligible.filter(w=>!w.load && !w.queued).length,
    percent:eligible.length?Math.round(100*occupied/eligible.length):null};
}
export function phase(device, worker, now, stale=false) {
  if(stale || !worker)return 'unknown';
  const engine=device?.endpoint_metrics;
  if(engine||device?.backend==='openai'){
    const at=engine?.activity_at??engine?.at;
    if(!engine?.connected||!Number.isFinite(at)||now-at<0||now-at>=15000)return worker.load?'working':'unknown';
    if(engine.running>0)return ['prefill','thinking','decode','mixed'].includes(engine.phase)?engine.phase:'working';
    if(engine.running===0&&engine.phase==='idle'&&engine.live_activity!==false)return 'idle';
    return worker.load?'working':'unknown';
  }
  if(!worker.is_healthy)return 'unavailable';
  if(!worker.load)return worker.drained?'paused':'idle';
  if(!device?.connected || !device.last_event || now-device.last_event>30000)return 'working';
  return ['prefill','thinking','decode'].includes(device.phase)?device.phase:'working';
}
export class Activity {
  constructor(){this.history=new Map();this.markers=new Map();this.lastSamples=new Map();this.last=null;}
  observe(device,worker,now,stale=false){
    if(!worker||!Number.isFinite(now))return;
    const rows=this.history.get(worker.id)||[],previous=rows.at(-1);
    if(previous&&now<previous.end)return;
    if(previous)previous.end=Math.min(now,previous.end+6000);
    if(previous&&previous.end<now)rows.push({start:previous.end,end:now,phase:'unknown'});
    const state=phase(device,worker,now,stale);
    if(rows.at(-1)?.phase===state)rows.at(-1).end=now;
    else rows.push({start:now,end:now,phase:state});
    this.history.set(worker.id,rows.filter(row=>row.end>now-900000).slice(-1024));
    const engine=device?.endpoint_metrics;
    if(!stale&&engine?.connected&&Number.isFinite(engine.at)&&now>=engine.at&&now-engine.at<15000&&this.lastSamples.get(worker.id)!==engine.at){
      this.lastSamples.set(worker.id,engine.at);
      const tokens=engine.source==='vllm'?engine.interval_prefill:engine.completed_prefill_tokens;
      if(Number.isFinite(tokens)&&tokens>0){
        const markers=this.markers.get(worker.id)||[];
        markers.push({time:engine.at,phase:'prefill',tokens,basis:engine.source==='vllm'?'poll_interval':'completed_request'});
        this.markers.set(worker.id,markers.filter(row=>row.time>now-900000).slice(-512));
      }
    }
    this.last=now;
  }
  update(devices,workers,now,stale=false){
    for(const worker of workers){
      const device=devices.find(row=>row.id===worker.id);
      // Independent endpoint samples remain engine evidence when gateway status
      // is unavailable; admission/capacity still use the gateway's stale flag.
      this.observe(device,worker,now,device?.backend==='openai'?false:stale);
    }
    for(const id of this.history.keys())if(!workers.some(worker=>worker.id===id)){
      this.history.delete(id);this.markers.delete(id);this.lastSamples.delete(id);
    }
    this.last=now;
  }
  get(id){return this.history.get(id)||[];}
  getMarkers(id,now=Date.now()){return (this.markers.get(id)||[]).filter(row=>row.time<=now&&row.time>now-900000);}
}
