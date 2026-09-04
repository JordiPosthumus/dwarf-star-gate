// Optional, low-rate and read-only hardware observations. Adapters emit one
// allowlisted numeric schema; paths, SSH aliases, commands and raw output never
// enter dashboard snapshots or metric rows.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';

const ID=/^[a-zA-Z0-9][\w-]{0,63}$/,SSH=/^[a-zA-Z0-9][\w.@-]{0,252}$/;
const MAX_LINE=4096,MAX_READ=256*1024,HISTORY_MS=15*60000,MAX_SAMPLES=180;
const ADAPTERS=new Set(['nvidia-linux','jsonl-file']);
const MEMORY_SCOPES=new Set(['host','host_unified']);
const ACTIVITY_SCOPES=new Set(['gpu_kernel_time','accelerator']);
const POWER_SCOPES=new Set(['compute_module','system']);
const CLOCK_SCOPES=new Set(['sm','accelerator']);

// This command is a source constant: configuration can choose the adapter and
// sample interval, but can never inject a command or SSH option. Spark's unified
// memory is read from /proc; nvidia-smi framebuffer memory is deliberately not
// used. Module power is accepted only when the driver exposes that exact field.
export function nvidiaLinuxCommand(intervalMs){
  const seconds=intervalMs/1000;
  if(!Number.isInteger(seconds)||seconds<10||seconds>60)throw new Error('Hardware interval must be whole seconds from 10–60');
  return `while :; do mem=$(awk '/^MemTotal:/{t=$2}/^MemAvailable:/{a=$2}END{printf "%s,%s",t,a}' /proc/meminfo); gpu=$(timeout 3s nvidia-smi --query-gpu=module.power.draw.instant,utilization.gpu,clocks.current.sm --format=csv,noheader,nounits -i 0 2>/dev/null | head -n 1 | tr -d ' '); case "$gpu" in *,*,*) ;; *) gpu=",$(timeout 3s nvidia-smi --query-gpu=utilization.gpu,clocks.current.sm --format=csv,noheader,nounits -i 0 2>/dev/null | head -n 1 | tr -d ' ')" ;; esac; printf 'DSG_HW_V1|%s|%s\\n' "$mem" "$gpu"; sleep ${seconds}; done`;
}

const finite=(value,min,max)=>{
  if(value===null||value===undefined||typeof value==='string'&&!value.trim())return null;
  const number=typeof value==='number'?value:Number(String(value??'').trim());
  return Number.isFinite(number)&&number>=min&&number<=max?number:null;
};
const sampleShape=(raw,time=Date.now())=>{
  if(!raw||typeof raw!=='object'||Array.isArray(raw))return null;
  const at=finite(raw.time??time,1,Number.MAX_SAFE_INTEGER);if(at===null||at>time+5000)return null;
  const memoryTotal=finite(raw.memory_total_bytes,1,2**60),memoryUsed=finite(raw.memory_used_bytes,0,2**60);
  const activity=finite(raw.accelerator_activity_pct,0,100),power=finite(raw.power_watts,0,5000),clock=finite(raw.clock_mhz,0,100000);
  const sample={time:at};
  if(memoryTotal!==null&&memoryUsed!==null&&memoryUsed<=memoryTotal&&MEMORY_SCOPES.has(raw.memory_scope))Object.assign(sample,{memory_used_bytes:memoryUsed,memory_total_bytes:memoryTotal,memory_scope:raw.memory_scope});
  if(activity!==null&&ACTIVITY_SCOPES.has(raw.accelerator_scope))Object.assign(sample,{accelerator_activity_pct:activity,accelerator_scope:raw.accelerator_scope});
  if(power!==null&&POWER_SCOPES.has(raw.power_scope))Object.assign(sample,{power_watts:power,power_scope:raw.power_scope});
  if(clock!==null&&CLOCK_SCOPES.has(raw.clock_scope))Object.assign(sample,{clock_mhz:clock,clock_scope:raw.clock_scope});
  return Object.keys(sample).length>1?sample:null;
};

export function parseNvidiaLinux(line,time=Date.now()){
  if(typeof line!=='string'||line.length>MAX_LINE||!line.startsWith('DSG_HW_V1|'))return null;
  const [tag,memory,gpu,...extra]=line.trim().split('|');if(tag!=='DSG_HW_V1'||extra.length)return null;
  const [totalKiB,availableKiB,...memoryExtra]=(memory??'').split(','),[watts,activity,clock,...gpuExtra]=(gpu??'').split(',');
  if(memoryExtra.length||gpuExtra.length)return null;
  const total=finite(totalKiB,1,2**50),available=finite(availableKiB,0,2**50),raw={time};
  if(total!==null&&available!==null&&available<=total)Object.assign(raw,{memory_used_bytes:(total-available)*1024,memory_total_bytes:total*1024,memory_scope:'host_unified'});
  if(finite(activity,0,100)!==null)Object.assign(raw,{accelerator_activity_pct:Number(activity),accelerator_scope:'gpu_kernel_time'});
  if(finite(watts,0,5000)!==null)Object.assign(raw,{power_watts:Number(watts),power_scope:'compute_module'});
  if(finite(clock,0,100000)!==null)Object.assign(raw,{clock_mhz:Number(clock),clock_scope:'sm'});
  return sampleShape(raw,time);
}

export function hardwareTelemetryConfig(raw={}){
  if(raw==null||raw===false)return {enabled:false,interval_ms:10000,workers:new Map()};
  if(typeof raw!=='object'||Array.isArray(raw))throw new Error('hardware_telemetry must be an object or false');
  if(raw.enabled!==true)return {enabled:false,interval_ms:10000,workers:new Map()};
  if(Object.keys(raw).some(key=>!['enabled','interval_ms','workers'].includes(key)))throw new Error('Unsupported hardware_telemetry setting');
  const interval=raw.interval_ms??10000;
  if(!Number.isInteger(interval)||interval%1000||interval<10000||interval>60000)throw new Error('hardware_telemetry.interval_ms must be whole seconds from 10000–60000');
  if(!raw.workers||typeof raw.workers!=='object'||Array.isArray(raw.workers))throw new Error('hardware_telemetry.workers must be an object');
  const workers=new Map();
  for(const [id,value] of Object.entries(raw.workers)){
    if(!ID.test(id)||!value||typeof value!=='object'||Array.isArray(value)||!ADAPTERS.has(value.adapter))throw new Error('Invalid hardware telemetry worker');
    const allowed=value.adapter==='jsonl-file'?['adapter','path']:['adapter'];
    if(Object.keys(value).some(key=>!allowed.includes(key)))throw new Error('Unsupported hardware telemetry worker setting');
    if(value.adapter==='jsonl-file'&&(typeof value.path!=='string'||!path.isAbsolute(value.path)||value.path.length>4096||value.path.includes('\0')))throw new Error('jsonl-file hardware telemetry requires an absolute local path');
    workers.set(id,Object.freeze({...value}));
  }
  return {enabled:true,interval_ms:interval,workers};
}

class FileSource{
  constructor(file,accept){this.file=file;this.accept=accept;this.identity=null;this.offset=0;this.fragment='';this.skipping=false;}
  poll(now){let fd;
    try{
      const before=fs.lstatSync(this.file);if(!before.isFile()||before.isSymbolicLink())throw new Error();
      fd=fs.openSync(this.file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);const stat=fs.fstatSync(fd);if(!stat.isFile())throw new Error();
      const identity=`${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
      if(identity!==this.identity||stat.size<this.offset){this.identity=identity;this.offset=Math.max(0,stat.size-MAX_READ);this.fragment='';this.skipping=this.offset>0;}
      const length=Math.min(MAX_READ,Math.max(0,stat.size-this.offset)),buffer=Buffer.alloc(length),read=length?fs.readSync(fd,buffer,0,length,this.offset):0;this.offset+=read;
      const lines=(this.fragment+buffer.subarray(0,read).toString('utf8')).split('\n');this.fragment=lines.pop();
      for(const line of lines){if(this.skipping){this.skipping=false;continue;}if(Buffer.byteLength(line)>MAX_LINE)continue;try{const raw=JSON.parse(line),sample=sampleShape(raw,now);if(sample)this.accept(sample);}catch{/* Unrecognized producer rows cannot enter metrics. */}}
      if(Buffer.byteLength(this.fragment)>MAX_LINE){this.fragment='';this.skipping=true;}return {state:'connected',reason:null};
    }catch{return {state:'disconnected',reason:'adapter_unavailable'};}finally{if(fd!==undefined)fs.closeSync(fd);}
  }
  close(){}
}

class NvidiaSource{
  constructor(ssh,interval,accept,status,{spawnImpl=spawn,setTimer=setTimeout,clearTimer=clearTimeout,now=Date.now}={}){
    Object.assign(this,{ssh,interval,accept,status,spawnImpl,setTimer,clearTimer,now});this.child=null;this.retry=null;this.watchdog=null;this.closed=false;this.buffer='';this.bad=0;this.pendingReason=null;
  }
  start(){if(this.closed||this.child||this.retry)return;this.status('connecting',null);let child;try{child=this.spawnImpl('/usr/bin/ssh',['-T','-o','BatchMode=yes','-o','ConnectTimeout=8','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=2',this.ssh,nvidiaLinuxCommand(this.interval)],{stdio:['ignore','pipe','ignore']});}catch{this.status('disconnected','adapter_spawn_failed');this.retry=this.setTimer(()=>{this.retry=null;this.start();},10000);return;}this.child=child;child.stdout.setEncoding('utf8');this.arm();
    child.stdout.on('data',data=>this.data(data));child.on('error',()=>this.finish('adapter_spawn_failed'));child.on('close',()=>this.finish(this.pendingReason??'adapter_unavailable'));
  }
  arm(){if(this.watchdog)this.clearTimer(this.watchdog);this.watchdog=this.setTimer(()=>{this.watchdog=null;this.pendingReason='adapter_timeout';this.status('disconnected',this.pendingReason);this.child?.kill();},Math.max(35000,this.interval*3+5000));}
  data(data){this.buffer+=data;if(Buffer.byteLength(this.buffer)>MAX_LINE*4){this.pendingReason='adapter_output_limit';this.status('disconnected',this.pendingReason);this.child?.kill();return;}let end;
    while((end=this.buffer.indexOf('\n'))>=0){const line=this.buffer.slice(0,end).replace(/\r$/,'');this.buffer=this.buffer.slice(end+1);const sample=parseNvidiaLinux(line,this.now());if(sample){this.bad=0;this.pendingReason=null;this.accept(sample);this.status('connected',null);this.arm();}else if(++this.bad>=3){this.pendingReason='adapter_invalid_output';this.status('disconnected',this.pendingReason);this.child?.kill();return;}}
  }
  finish(reason){if(!this.child)return;this.child=null;this.buffer='';this.pendingReason=null;if(this.watchdog){this.clearTimer(this.watchdog);this.watchdog=null;}if(this.closed)return;this.status('disconnected',reason);if(!this.retry)this.retry=this.setTimer(()=>{this.retry=null;this.start();},10000);}
  close(){this.closed=true;if(this.retry)this.clearTimer(this.retry);if(this.watchdog)this.clearTimer(this.watchdog);this.retry=this.watchdog=null;this.child?.kill();this.child=null;}
}

export class HardwareTelemetry{
  constructor(raw,save=()=>{},options={}){
    this.config=hardwareTelemetryConfig(raw);this.save=save;this.options=options;this.sources=new Map();this.states=new Map();this.sequence=0;this.nextPoll=0;
    for(const [id,config] of this.config.workers)this.states.set(id,{configured:true,adapter:config.adapter,state:'waiting',reason:null,last_sample_at:null,current:null,series:[],rejected:0});
  }
  status(id,state,reason=null){const value=this.states.get(id);if(value){value.state=state;value.reason=reason;}}
  accept(id,sample){const value=this.states.get(id),safe=sampleShape(sample,this.options.now?.()??Date.now());if(!value||!safe){if(value)value.rejected++;return;}
    if(value.last_sample_at!==null&&safe.time<=value.last_sample_at){value.rejected++;return;}
    const row={sample_id:createHash('sha256').update(`dsg-hardware-v1\0${id}\0${safe.time}\0${this.sequence++}\0${JSON.stringify(safe)}`).digest('hex'),observed_at:this.options.now?.()??Date.now(),node:id,kind:'hardware',...safe};
    value.current=safe;value.last_sample_at=safe.time;value.series.push(safe);value.series=value.series.filter(item=>safe.time-item.time<HISTORY_MS).slice(-MAX_SAMPLES);value.state='connected';value.reason=null;this.save(row);
  }
  sync(definitions=[],workers=[]){if(!this.config.enabled)return;const active=new Set(workers.map(worker=>worker.id)),nodes=new Map(definitions.map(node=>[node.id,node]));
    for(const [id,config] of this.config.workers){const signature=config.adapter==='nvidia-linux'?`${config.adapter}:${nodes.get(id)?.ssh??''}`:`${config.adapter}:${config.path}`;const existing=this.sources.get(id);
      if(!active.has(id)){existing?.source.close();this.sources.delete(id);this.status(id,'waiting','worker_not_registered');continue;}
      if(existing?.signature===signature)continue;existing?.source.close();this.sources.delete(id);
      if(config.adapter==='nvidia-linux'){
        const ssh=nodes.get(id)?.ssh;if(!SSH.test(ssh??'')||ssh.startsWith('-')){this.status(id,'disconnected','management_transport_unavailable');continue;}
        const source=new NvidiaSource(ssh,this.config.interval_ms,sample=>this.accept(id,sample),(state,reason)=>this.status(id,state,reason),this.options);this.sources.set(id,{signature,source,adapter:config.adapter});source.start();
      }else this.sources.set(id,{signature,source:new FileSource(config.path,sample=>this.accept(id,sample)),adapter:config.adapter});
    }
  }
  poll(now=this.options.now?.()??Date.now()){if(!this.config.enabled||now<this.nextPoll)return;this.nextPoll=now+this.config.interval_ms;
    for(const [id,{source,adapter}] of this.sources)if(adapter==='jsonl-file'){const result=source.poll(now);if(result.state!=='connected')this.status(id,result.state,result.reason);}
  }
  snapshot(id,now=this.options.now?.()??Date.now()){
    const value=this.states.get(id);if(!value)return {schema:1,configured:false,state:'not_configured',reason:null,last_sample_at:null,current:null,series:[]};
    const stale=value.last_sample_at!==null&&now-value.last_sample_at>Math.max(60000,this.config.interval_ms*4);
    return {schema:1,configured:true,adapter:value.adapter,state:stale?'stale':value.state,reason:stale?'sample_stale':value.reason,last_sample_at:value.last_sample_at,current:value.current,series:value.series.filter(sample=>now-sample.time<HISTORY_MS),rejected:value.rejected};
  }
  close(){for(const {source} of this.sources.values())source.close();this.sources.clear();}
}
