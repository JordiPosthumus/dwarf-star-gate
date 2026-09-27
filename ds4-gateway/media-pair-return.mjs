import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pairedMediaReturn} from './media-pair.mjs';
import {endpointHeaders,endpointUrl} from './endpoint.mjs';
const execute=promisify(execFile),quote=s=>"'"+String(s).replaceAll("'","'\\''")+"'";
export function mediaPairReturn(plan,save){
 if(!plan.llm_pair)return undefined;
 const remote=async(host,args)=>(await execute('ssh',['-o','BatchMode=yes','-o','ConnectTimeout=10','--',host,args.map(quote).join(' ')],{maxBuffer:8*1024*1024})).stdout;
 return pairedMediaReturn(plan.llm_pair,{
  snapshotRemote:async(host,container,recipe)=>{
   const payload={paths:container.Mounts.filter(m=>m.Type==='bind').map(m=>m.Source),recipe};
   const code=`import base64,hashlib,json,pathlib,sys
p=json.loads(sys.argv[1]);paths=set(p['paths']);root=p.get('recipe')
if root:
 for name in ['.env','start.sh','.glm53-exl3-head.inner.sh']:paths.add(str(pathlib.Path(root)/name))
result={};total=0
for name in sorted(paths):
 f=pathlib.Path(name)
 if f.is_file():
  data=f.read_bytes();total+=len(data)
  if total>8388608:raise ValueError('Mounted configuration snapshot exceeds limit')
  result[name]={'sha256':hashlib.sha256(data).hexdigest(),'mode':f.stat().st_mode&511,'data':base64.b64encode(data).decode()}
 elif name not in p['paths']:result[name]={'absent':True}
print(json.dumps(result))`;
   return JSON.parse(await remote(host,['python3','-I','-c',code,JSON.stringify(payload)]));
  },
  save,inspectRemote:async(host,id)=>JSON.parse(await remote(host,['docker','inspect',id]))[0],
  startRemote:(host,id)=>remote(host,['docker','start',id]),stopRemote:(host,id)=>remote(host,['docker','stop','-t','120',id]),
  request:async(route,body)=>{
   const response=await fetch(endpointUrl(plan.endpoint,route),{redirect:'error',signal:AbortSignal.timeout(body?300000:15000),headers:{...endpointHeaders(plan.endpoint),'content-type':'application/json'},...(body?{method:'POST',body:JSON.stringify(body)}:{})});
   if(!response.ok)throw Error('Paired LLM readiness request failed');return response.json();
  }
 });
}
