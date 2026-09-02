// Synthetic, clearly labelled telemetry for screenshots. No gateway, SSH, logs or secrets.
import { createDashboard } from '../ds4-gateway/dashboard.mjs';
import { workerConfig, assertUniqueWorker } from '../ds4-gateway/worker-config.mjs';
import { DeviceTelemetry } from '../ds4-gateway/telemetry.mjs';
const now = Date.now();
const workers = [
  { id:'spark1', is_healthy:true, drained:false, load:1, queued:0, active_seconds:84, completed:42, failed:0, assigned_sessions:4 },
  { id:'spark2', is_healthy:true, drained:false, load:1, queued:1, active_seconds:37, completed:36, failed:1, assigned_sessions:3 },
];
workers.forEach((w,i)=>{w.url=`http://127.0.0.1:${39101+i}`;w.context_length=153600;});
const devices = workers.map((w,i) => ({
  id:w.id, connected:true, observed_since:now-900000, last_event:now, phase:i ? 'decode':'thinking',
  decode:{ time:now-1000, tps:i ? 14.4:14.6, average:i ? 14.3:14.5 },
  prefill:{ time:now-45000, tps:i ? 824.8:853.2, average:i ? 802.6:827.5 },
  prompt:{ prompt:i ? 42600:55300, cached:i ? 42402:53248, cache:i ? 'prefix reuse':'disk restore' },
  cache:{ starts:i ? 30:34, reused:i ? 28:31, cold:i ? 2:3, resident_misses:i ? 4:6, disk_restores:i ? 3:5 },
  series:Array.from({length:70},(_,j)=>[{time:now-900000+j*12800,kind:'decode',tps:13.8+i*.1+Math.sin(j*.8)*.35+j*.008}, {time:now-900000+j*12800,kind:'prefill',tps:790+Math.sin(j*.65+i)*60}]).flat(),
  recent:[],
}));
workers[0].requested_thinking = { status:'specified', fields:{reasoning_effort:'xhigh'} };
workers[1].requested_thinking = { status:'specified', fields:{thinking:false} };
const events = Array.from({length:8},(_,i)=>({
  time:new Date(now-(8-i)*37000).toISOString(),event:'request_finished',node:`spark${i%2+1}`,
  request_id:`${(0xa1b2c300+i).toString(16)}-0000-4000-8000-000000000000`,outcome:i===1?'client_cancelled':'complete',queue_ms:i===4?4200:0,elapsed_ms:12340+i*3700,
  usage:{prompt_tokens:28500+i*3800,cached_tokens:27000+i*3800,completion_tokens:160+i*23},
}));
const snapshot = { version:1,demo:true,time:now,started:now-900000,read_only:false,worker_management:true,gateway_at:now,gateway_error:null,telemetry_error:null,
  gateway:{model:'deepseek-v4-flash',context_length:153600,total:2,healthy:2,available:2,active:2,queued:1,draining:false,workers},devices,events };
const registry=()=>({model:'deepseek-v4-flash',minimum_context:153600,workers});
const server = createDashboard(()=>({...snapshot,time:Date.now(),gateway_at:Date.now(),
  devices:workers.map(w=>devices.find(d=>d.id===w.id)||new DeviceTelemetry(w.id).snapshot()),
  gateway:{...snapshot.gateway,total:workers.length,healthy:workers.length,available:workers.filter(w=>!w.drained).length,active:workers.filter(w=>w.load).length,queued:workers.reduce((a,w)=>a+w.queued,0)}}),undefined,{
  read:async()=>registry(),
  act:async(action,input)=>{
    if(action==='add') {
      const w=workerConfig(input.worker,{registration:true});assertUniqueWorker(workers,w);
      workers.push({...w,is_healthy:true,drained:true,load:0,queued:0,context_length:300000,completed:0,failed:0,assigned_sessions:0});
    } else if(action==='remove') {
      const w=workers.find(w=>w.id===input.id);if(!w||!w.drained||w.load||w.queued)throw new Error('Drain and wait before removal');
      workers.splice(workers.indexOf(w),1);
    } else {
      for(const id of input.workers) {
        const w=workers.find(w=>w.id===id);if(!w)throw new Error('Unknown demo worker');
        w.drained=action==='drain';
        if(w.drained)setTimeout(()=>{w.load=0;w.queued=0;w.last_requested_thinking=w.requested_thinking;w.requested_thinking=null;w.last_request_finished_at=new Date().toISOString();},500);
      }
    }
    return registry();
  },
});
server.listen(30011,'127.0.0.1',()=>console.log('Demo only: http://127.0.0.1:30011'));
const close = () => { server.closeAllConnections(); server.close(); };
process.on('SIGINT',close); process.on('SIGTERM',close);
