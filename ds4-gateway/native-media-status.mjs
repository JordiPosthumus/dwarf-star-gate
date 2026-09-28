import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mediaPair} from './media-pair.mjs';
import {mediaNativeEnrollments} from './media-enrollment.mjs';
const exec=promisify(execFile);
// Read only enrolled loopback engines. Filter on the host before returning data:
// native queue tuples contain full prompts and must never enter dashboard state.
export function createNativeMediaStatus(config,{run=exec,now=Date.now}={}){
  let rows=[],pending=null,last=-Infinity,identity=null;
  const retryAfter=new Map();
  const key=t=>JSON.stringify([t.worker_id,t.member,t.kind]);
  const targetsFor=inventory=>(inventory?.native_targets??mediaNativeEnrollments(config)).map(target=>{
    const worker=(config.workers??config.nodes??[]).find(w=>w.id===target.worker_id)??config.media_jobs?.pairs?.[target.worker_id]?.worker_binding;
    const pair=mediaPair(config,worker);
    const host=target.member===undefined?config.genie_chat?.inspection?.workers?.[target.worker_id]?.ssh?.[0]:[0,1].includes(target.member)?pair?.members[target.member]?.ssh:undefined;
    return {...target,host};
  });
  const observe=async target=>{
    const base={worker_id:target.worker_id,kind:target.kind,engine:target.engine,...(target.member!==undefined?{member:target.member}:{})};
    if(!['comfyui','ace-step'].includes(target.engine))return {...base,state:'unknown',reason:'Native queue observation not supported',observed_at:now()};
    if(!/^[a-zA-Z0-9][\w.@-]*$/.test(target.host??'')||!Number.isSafeInteger(target.port)||target.port<1||target.port>65535)return {...base,state:'unknown',reason:'Engine observation address is not enrolled',observed_at:now()};
    const script=target.engine==='ace-step'?`import json,urllib.request\nd=json.load(urllib.request.urlopen('http://127.0.0.1:${target.port}/v1/stats',timeout=3))['data']\nj=d['jobs']\nprint(json.dumps({'running_count':j['running'],'waiting_count':j['queued'],'queue_size':d['queue_size']}))\n`:`import json,urllib.request\nd=json.load(urllib.request.urlopen('http://127.0.0.1:${target.port}/queue',timeout=3))\nout={}\nfor key in ('queue_running','queue_pending'):\n rows=d[key]\n assert isinstance(rows,list)\n assert all(isinstance(r,list) and len(r)>1 and isinstance(r[1],str) for r in rows)\n out[key]=[r[1] for r in rows]\nprint(json.dumps(out))\n`;
    try{
      const {stdout}=await run('ssh',['-o','BatchMode=yes','-o','ConnectTimeout=3',target.host,'python3 -c '+"'"+script.replaceAll("'","'\\''")+"'"],{timeout:7000,maxBuffer:65536});
      const data=JSON.parse(stdout);
      if(target.engine==='ace-step'){
        if(![data.running_count,data.waiting_count,data.queue_size].every(n=>Number.isSafeInteger(n)&&n>=0))throw Error('Invalid native counters');
        const running_count=data.running_count,waiting_count=Math.max(data.waiting_count,data.queue_size);
        return {...base,state:running_count||waiting_count?'busy':'idle',running_count,waiting_count,observed_at:now()};
      }
      const running=data.queue_running,waiting=data.queue_pending;
      if(![running,waiting].every(a=>Array.isArray(a)&&a.every(id=>typeof id==='string'&&/^[\w-]{1,128}$/.test(id))))throw Error('Invalid queue');
      return {...base,state:running.length||waiting.length?'busy':'idle',running,waiting,running_count:running.length,waiting_count:waiting.length,observed_at:now()};
    }catch{return {...base,state:'unknown',reason:'Native engine queue unavailable',observed_at:now()};}
  };
  const read=(inventory,{refresh=false}={})=>{
    const targets=targetsFor(inventory),current=JSON.stringify(targets);
    if(current!==identity){identity=current;rows=[];last=-Infinity;retryAfter.clear();}
    const snapshot=()=>targets.map(t=>rows.find(row=>key(row)===key(t))??{
      worker_id:t.worker_id,kind:t.kind,engine:t.engine,...(t.member!==undefined?{member:t.member}:{}),
      state:'unknown',reason:'Not checked. Use Refresh media status when needed.',observed_at:null});
    const selected=targets.filter(t=>refresh||(inventory?.jobs??[]).some(j=>j.execution?.worker_id===t.worker_id&&j.kind===t.kind&&
        (j.execution.member===undefined||j.execution.member===t.member)&&
        !['returned','failed_returned','failed_unchanged'].includes(j.execution.phase))||
      rows.some(row=>key(row)===key(t)&&row.state==='busy'))
      .filter(t=>refresh||now()>=(retryAfter.get(key(t))??0));
    if(!pending&&selected.length&&(refresh||now()-last>=10000)){
      last=now();pending=Promise.all(selected.map(observe)).then(value=>{
        if(identity!==current)return;
        for(const row of value){
          rows=rows.filter(old=>key(old)!==key(row));rows.push(row);
          if(row.state==='unknown')retryAfter.set(key(row),now()+60000);else retryAfter.delete(key(row));
        }
      }).finally(()=>{pending=null;});
    }
    return snapshot();
  };
  let refreshPending=null;
  read.refresh=inventory=>refreshPending??=(async()=>{
    if(pending)await pending;
    const initial=read(inventory,{refresh:true});
    if(pending)await pending;
    return initial.map(row=>rows.find(current=>key(current)===key(row))??row);
  })().finally(()=>{refreshPending=null;});
  return read;
}
