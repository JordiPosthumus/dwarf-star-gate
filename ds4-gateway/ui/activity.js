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
  if(!worker.is_healthy)return 'unavailable';
  if(!worker.load)return worker.drained?'paused':'idle';
  if(!device?.connected || !device.last_event || now-device.last_event>30000)return 'working';
  return ['prefill','thinking','decode'].includes(device.phase)?device.phase:'working';
}
export class Activity {
  constructor(){this.history=new Map();this.last=null;}
  update(devices,workers,now,stale=false) {
    for(const w of workers) {
      const rows=this.history.get(w.id)||[];
      const previous=rows.at(-1);
      if(previous)previous.end=Math.min(now,previous.end+6000);
      if(previous && previous.end<now)rows.push({start:previous.end,end:now,phase:'unknown'});
      const state=phase(devices.find(d=>d.id===w.id),w,now,stale);
      if(rows.at(-1)?.phase===state)rows.at(-1).end=now;
      else rows.push({start:now,end:now,phase:state});
      this.history.set(w.id,rows.filter(r=>r.end>now-900000).slice(-1024));
    }
    for(const id of this.history.keys())if(!workers.some(w=>w.id===id))this.history.delete(id);
    this.last=now;
  }
  get(id){return this.history.get(id)||[];}
}
