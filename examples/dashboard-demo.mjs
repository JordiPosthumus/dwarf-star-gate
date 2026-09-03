// Synthetic, clearly labelled telemetry for screenshots. No gateway, SSH, logs or secrets.
import { createDashboard } from '../ds4-gateway/dashboard.mjs';
import { workerConfig, assertUniqueWorker } from '../ds4-gateway/worker-config.mjs';
import { DeviceTelemetry } from '../ds4-gateway/telemetry.mjs';
import { isMain } from '../ds4-gateway/config.mjs';
import {TRAINING_RECIPES,DEFAULT_RECIPE} from '../ds4-gateway/training-recipes.mjs';
import {calibrationPreflight} from '../ds4-gateway/calibration.mjs';
import {FleetThroughput} from '../ds4-gateway/throughput.mjs';
// Optional memory is supplied only by the isolated browser-test fixture. The
// ordinary demo has no persistent storage and reads no installation config.
export function createDemoServer({learningMilestone=false,agentHold=false,quarantinedWorker=false,memory=null}={}) {
const now = Date.now();
const workers = [
  { id:'sparkA', is_healthy:true, drained:false, load:1, queued:1, active_seconds:84, completed:42, failed:0, assigned_sessions:4 },
  { id:'sparkB', is_healthy:true, drained:false, load:1, queued:0, active_seconds:37, completed:36, failed:1, assigned_sessions:3 },
  { id:'mac-ultra', is_healthy:true, drained:false, load:0, queued:0, active_seconds:0, completed:51, failed:0, assigned_sessions:2 },
];
workers.forEach((w,i)=>{w.url=`http://127.0.0.1:${39101+i}`;w.context_length=262144;});
const devices = workers.map((w,i) => ({
  id:w.id, connected:true, telemetry_source:i===2?'file':'journal', observed_since:now-900000, last_event:now-(i===2?120000:0), phase:i ? 'decode':'thinking',
  decode:{ time:now-(i===2?120000:1000), tps:[14.6,14.4,28.2][i], average:[14.5,14.3,27.9][i] },
  prefill:{ time:now-(i===2?180000:45000), tps:[853.2,824.8,460.3][i], average:[827.5,802.6,442.8][i] },
  prompt:{ prompt:i ? 42600:55300, cached:i ? 42402:53248, cache:i ? 'prefix reuse':'disk restore' },
  cache:{ starts:i ? 30:34, reused:i ? 28:31, cold:i ? 2:3, resident_misses:i ? 4:6, disk_restores:i ? 3:5 },
  series:Array.from({length:70},(_,j)=>[{time:now-900000+j*11000,kind:'decode',tps:(i===2?27:13.8)+Math.sin(j*.8)*.35+j*.008}, {time:now-900000+j*10000,kind:'prefill',tps:(i===2?440:790)+Math.sin(j*.65+i)*60}]).flat(),
  activity:['idle','prefill','thinking','decode','prefill',i===2?'idle':i?'decode':'thinking'].map((phase,j)=>({start:now-900000+j*150000,end:now-750000+j*150000,phase})),
  recent:[],
}));
workers[0].requested_thinking = { status:'specified', fields:{reasoning_effort:'xhigh'} };
workers[1].requested_thinking = { status:'specified', fields:{thinking:false} };
workers[2].last_requested_thinking = { status:'specified', fields:{reasoning_effort:'high'} };
workers[2].last_request_finished_at = new Date(now-120000).toISOString();
const modelIds=['a'.repeat(64),'b'.repeat(64),'c'.repeat(64)];
const predictor={configured:true,automatic_training:true,automatic_promotion:true,placement:false,busy:false,new_requests:24,baseline:{id:'causal-history-v1',name:'Measured history baseline'},milestones:[],
  training_recipes:TRAINING_RECIPES,default_recipe:DEFAULT_RECIPE,
  models:['admission','updated','remaining'].map((kind,i)=>({kind,active_model_id:null,candidate_model_id:modelIds[i],status:i===2?'awaiting_future':'holdout_failed',
    holdout:{mae_s:[64,48,26][i]},future:{mae_s:[58,44,25][i],baseline_mae_s:[51,42,31][i],requests:24,sessions:4},
    selected:{family:i===2?['base','progress']:['base','history'],rounds:i===1?16:128,transform:'log'}})),
  actions:[{time:now-120000,actor:'genie',action:'train',status:'completed',reason:'Synthetic example: candidate evaluated; no routing model activated.'}]};
if(learningMilestone){
  predictor.models[2].active_model_id=modelIds[2];
  predictor.milestones.push({id:'demo-learning-win',time:now-60000,kind:'remaining',model_id:modelIds[2],baseline_id:'causal-history-v1',comparator_id:'causal-history-v1',commentary:{actor:'genie',text:'Synthetic celebration: the challenger brought receipts. <No HTML is interpreted.>'},evidence:{baseline:{mae_s:20,baseline_mae_s:30,requests:42,sessions:8},champion:null,workers:['sparkA','sparkB','mac-ultra']}});
}
const recovery={configured:true,automatic:false,workers:workers.slice(0,2).map(w=>({worker_id:w.id,state:'healthy',eligible:false,reason:'no_current_fatal_evidence'})),operations:[]};
const dataset={enabled:true,written:4200,bytes:18*1048576,pending:0,dropped:0,finished:312,missing_usage:2,truncated:3,failed_or_cancelled:1,last_write:now,
  embedding_collection:{enabled:true,ready:true,completed:308,observed:312,pending:0,failed:0,dropped:0,missing:4,last_duration_ms:24,
    model:'all-MiniLM-L6-v2',revision:'demo-only',dimensions:384}};
const genie={enabled:true,busy:false,source:'primary',memory,
  status(){return {configured:true,enabled:this.enabled,busy:false,source:this.source,fallback_available:true,last_served_by:'dedicated',mode:'bounded-recovery',predictor_supervision:true,last_check:now-60000,memory:memory?{...memory.status(),...memory.retrieve(snapshot)}:null,
    reports:[{id:'synthetic-review',time:now-60000,evidence_at:now-62000,source:'demo',text:'Synthetic demonstration, not a live assessment. One request is waiting at its session home while the Mac is idle. That preserves cache locality; it does not prove the fastest completion time. Compare warm-home wait against measured cache acquisition elsewhere before changing placement. The candidate models are still shadow-only.',actions_taken:[]}],
    ticker:{state:this.enabled?'ready':'off',evidence_at:now-62000,entries:[
      {severity:'warning',text:'Demo: one request is waiting at a busy session home.',recommendation:'Compare its warm-cache wait with idle-server acquisition cost.'},
      {severity:'good',text:'Demo: three healthy servers; the Mac has a free request slot.'},
      {severity:'info',text:'Demo: XGB candidates are scoring in shadow. No model is promoted.'}]}};},
  setEnabled(value){this.enabled=value===true;return this.status();},
  setSource(value){if(!['primary','pool'].includes(value))throw new Error('Unknown demo source');this.source=value;return this.status();},
  async ask(){return this.status();}};
const events = Array.from({length:8},(_,i)=>({
  time:new Date(now-(8-i)*37000).toISOString(),event:'request_finished',node:workers[i%3].id,
  request_id:`${(0xa1b2c300+i).toString(16)}-0000-4000-8000-000000000000`,outcome:i===1?'client_cancelled':'complete',queue_ms:i===4?4200:0,elapsed_ms:12340+i*3700,
  usage:{prompt_tokens:28500+i*3800,cached_tokens:27000+i*3800,completion_tokens:160+i*23},
}));
const throughput=new FleetThroughput();
// Fictional completions, independent of the 12-row request-log illustration.
for(let i=0;i<30;i++)throughput.accept({schema:1,kind:'finish',run_id:'demo',request_id:`demo-usage-${i}`,node:workers[i%3].id,
  time:new Date(now-(i<12?i*250000:7200000+(i-12)*180000)).toISOString(),outcome:'complete',
  usage:i===0?null:{completion_tokens:i<12?6200+i*100:8500,prompt_tokens:60000,cached_tokens:54000}});
const relocation={schema:1,automatic:true,automatic_scope:'first_dsg_request_or_unaffined',completed:2,rejected:0,offers:[{schema:1,evidence_id:'d'.repeat(64),request_id:'12345678-1234-4234-8234-123456789abc',source:'sparkA',destination:'mac-ultra',waiting_seconds:84,affinity:'existing',cache_locality:'unknown',automatic:false}]};
const snapshot = { version:1,demo:true,time:now,started:now-900000,read_only:false,worker_management:true,gateway_at:now,gateway_error:null,telemetry_error:null,
  gateway:{model:'deepseek-v4-flash',context_length:262144,queue_timeout_ms:72000000000,total:3,healthy:3,available:3,active:2,queued:1,draining:false,workers,dataset,predictor,recovery,
    continuity:{patient_wait:true,queued_relocation:true,automatic_relocation:true,automatic_relocation_scope:'first_dsg_request_or_unaffined',relocation:{completed:2,rejected:0,offers:1}}},devices,events };
const registry=()=>({model:'deepseek-v4-flash',minimum_context:snapshot.gateway.context_length,context_limit_control:true,context_limit_source:'saved',queue_timeout_ms:snapshot.gateway.queue_timeout_ms,queue_timeout_control:true,queue_timeout_source:'saved',workers,recovery,queued_relocation:relocation});
if(agentHold)Object.assign(workers[2],{drained:true,operator_paused:false,holds:[{id:'demo-hold',owner_id:'test-agent',reason:'<DS4 compatibility test>'}]});
if(quarantinedWorker)Object.assign(workers[2],{is_healthy:false,quarantine:{reason:'repeated_inference_failures',at:new Date(now-600000).toISOString()}});
return createDashboard(()=>({...snapshot,time:Date.now(),gateway_at:Date.now(),
  devices:workers.map(w=>devices.find(d=>d.id===w.id)||new DeviceTelemetry(w.id).snapshot()),
  gateway:{...snapshot.gateway,calibration:calibrationPreflight(workers.map(w=>({id:w.id,healthy:w.is_healthy,drained:w.drained,active:w.load,queue:Array(w.queued).fill(null)}))),total:workers.length,healthy:workers.filter(w=>w.is_healthy).length,available:workers.filter(w=>w.is_healthy&&!w.drained).length,active:workers.filter(w=>w.load).length,queued:workers.reduce((a,w)=>a+w.queued,0)}}),undefined,{
  read:async()=>registry(),
  act:async(action,input)=>{
    if(action==='predictor'&&input.action==='acknowledge_milestone'&&Object.keys(input).sort().join(',')==='action,milestone_id'){
      if(!predictor.milestones.some(m=>m.id===input.milestone_id))throw new Error('No such synthetic milestone');
      predictor.milestones=predictor.milestones.filter(m=>m.id!==input.milestone_id);
    }else if(action==='predictor'&&input.action==='reset_baseline'&&Object.keys(input).join(',')==='action'){
      for(const m of predictor.models)m.active_model_id=null;
      predictor.reset_at=Date.now();
    }else if(action==='queue-timeout'){
      if(Object.keys(input).sort().join(',')!=='expected_queue_timeout_ms,queue_timeout_ms'||!Number.isSafeInteger(input.queue_timeout_ms)||input.queue_timeout_ms<1)throw new Error('Invalid queue allowance');
      if(input.expected_queue_timeout_ms!==snapshot.gateway.queue_timeout_ms)throw new Error('Queue allowance changed');
      snapshot.gateway.queue_timeout_ms=input.queue_timeout_ms;
    }else if(action==='relocate') {
      const offer=relocation.offers[0];
      if(!offer||Object.keys(input).sort().join(',')!=='destination,evidence_id,request_id,source'||['destination','evidence_id','request_id','source'].some(k=>input[k]!==offer[k]))throw new Error('Synthetic handover offer changed');
      relocation.offers=[];relocation.completed++;workers[0].queued=0;workers[2].load=1;
      return {state:'relocated',schema:1,request_id:offer.request_id,source:offer.source,destination:offer.destination,actor:'operator',waiting_ms:offer.waiting_seconds*1000,dispatch_state:'not_dispatched',body_replayed:false,deadline_preserved:true,cache_locality:'unknown'};
    }else if(action==='context') {
      if(input.expected_context_length!==snapshot.gateway.context_length)throw new Error('Pool context changed; refresh before applying');
      if(!Number.isSafeInteger(input.context_length)||input.context_length<=0)throw new Error('Enter a positive whole token count');
      const enabled=workers.filter(w=>!w.drained);
      if(!enabled.length||enabled.some(w=>!w.is_healthy||w.context_length<input.context_length))throw new Error('Enabled servers do not support that context limit');
      snapshot.gateway.context_length=input.context_length;
    } else if(action==='add') {
      const w=workerConfig(input.worker,{registration:true});assertUniqueWorker(workers,w);
      workers.push({...w,is_healthy:true,drained:true,load:0,queued:0,context_length:300000,completed:0,failed:0,assigned_sessions:0});
    } else if(action==='remove') {
      const w=workers.find(w=>w.id===input.id);if(!w||!w.drained||w.load||w.queued||w.holds?.length)throw new Error('Drain and release holds before removal');
      workers.splice(workers.indexOf(w),1);
    } else if(['drain','resume'].includes(action)) {
      for(const id of input.workers) {
        const w=workers.find(w=>w.id===id);if(!w)throw new Error('Unknown demo worker');
        if(action==='resume'&&w.holds?.length)throw new Error('Release agent holds first');
        // Synthetic verification succeeds; never calls a real model endpoint.
        if(action==='resume'&&w.quarantine){w.quarantine=null;w.is_healthy=true;}
        w.operator_paused=action==='drain';
        w.drained=action==='drain';
        if(w.drained)setTimeout(()=>{w.load=0;w.queued=0;w.last_requested_thinking=w.requested_thinking;w.requested_thinking=null;w.last_request_finished_at=new Date().toISOString();},500);
      }
    } else throw new Error('This screenshot demo does not run recovery or training. No real services are connected.');
    return registry();
  },
},genie,()=>({enabled:true,status:'ready',demo:true,window_limit:500,not_dispatched:1,throughput:throughput.snapshot(),
  model_series:['admission','upload','embedded','remaining'].map((stage,j)=>({id:modelIds[j===0?0:j===3?2:1],stage,
    rows:Array.from({length:24},(_,i)=>({node:workers[i%workers.length]?.id,at:now-i*30000,experimental:true,
      service_ms:8000+i*2600+(i%3)*3200,predicted_service_ms:i%7?10000+i*2450:null,service_state:'complete'}))})),
  rows:Array.from({length:20},(_,i)=>({node:workers[i%workers.length]?.id,at:now-i*60000,
    queue_ms:i?10000+i*3000:0,predicted_queue_ms:i%5?8000+i*2800:null,
    service_ms:i<18?40000+i*2100:null,predicted_service_ms:i%4?35000+i*2500:null,service_state:i<18?'complete':i===18?'pending':'excluded'}))}));
}
if(isMain(import.meta.url)) {
const server=createDemoServer();
server.listen(Number(process.env.DEMO_PORT??30011),'127.0.0.1',()=>console.log(`Demo only: http://127.0.0.1:${server.address().port}`));
const close = () => { server.closeAllConnections(); server.close(); };
process.on('SIGINT',close); process.on('SIGTERM',close);
}
