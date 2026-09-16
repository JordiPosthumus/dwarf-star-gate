import assert from 'node:assert/strict';
import {isDeepStrictEqual} from 'node:util';
export const mediaContainerSignature=c=>({Id:c.Id,Image:c.Image,Config:c.Config,HostConfig:{...c.HostConfig,OomKillDisable:c.HostConfig.OomKillDisable??false},Mounts:[...c.Mounts].sort((a,b)=>a.Destination.localeCompare(b.Destination))});
export const mediaPlanIdentity=p=>({llm_container:p.llm_container,engines:Object.fromEntries(Object.entries(p.engines).map(([key,e])=>[key,{container:e.container,image:e.image,port:e.port,kind:e.kind,configuration:mediaContainerSignature(e.inspection)}]))});
// New-host-only: all prepared engines begin stopped. Existing serving LLMs are never touched.
export async function qualifySparkMedia(plan,io){
 const {save,progress,inspect,start,stop,connect,delay,jobs,decode,owned}=io;
 const completed={};
 for(const [engine,kind] of [['h3','video'],['ace-step','music']]){
  const selected=plan.preparation.engines[engine];let connection,started=false,ready=false;
  const before=selected.inspection;
  const unchanged=async()=>{assert.ok(owned(),'Setup host lock lost');assert.ok(isDeepStrictEqual(mediaContainerSignature(await inspect(selected.container)),mediaContainerSignature(before)),'Prepared media settings changed');};
  const idle=async()=>{
   if(selected.kind==='ace-step'){const {data}=await connection.backend.request('/v1/stats');const counts=[data?.jobs?.queued,data?.jobs?.running,data?.queue_size];assert.ok(counts.every(n=>Number.isSafeInteger(n)&&n>=0));return counts.every(n=>n===0);}
   const q=await connection.backend.request('/queue');assert.ok(Array.isArray(q.queue_running)&&Array.isArray(q.queue_pending));return q.queue_running.length+q.queue_pending.length===0;
  };
  try{
   await unchanged();assert.equal((await inspect(plan.preparation.llm_container)).State.Running,false,'Prepared LLM is already running; leave it alone');assert.equal((await inspect(selected.container)).State.Running,false);
   connection=await connect(selected);save(engine+'-start-intent.json',{container:selected.container});started=true;await start(selected.container);
   progress(engine,'loading','Waiting for the prepared native media engine.');
   for(;;){assert.ok(owned());assert.ok((await inspect(selected.container)).State.Running,'Media engine exited');progress(engine,'loading','Polling the prepared native engine for readiness.');try{const h=await connection.backend.request(selected.kind==='ace-step'?'/health':'/system_stats');if(selected.kind==='ace-step')assert.ok(h?.data?.status==='ok'&&h.data.models_initialized===true);ready=true;break;}catch{await delay(3000);}}
   assert.ok(await idle(),'Direct media work is present; no qualification job submitted');await unchanged();
   const job=jobs.enqueue(kind,io.payload(kind),{key:'native-'+engine}).job;
   if(kind==='video'){const catalog=await connection.backend.request('/object_info');for(const node of Object.values(job.payload.prompt))assert.ok(catalog[node.class_type],'Missing ComfyUI node '+node.class_type);}
   progress(engine,'generating','Submitting one retained native qualification job.');await jobs.dispatch(job.id,connection.backend,plan.target_id);
   for(;;){let observed;try{observed=await jobs.observe(job.id,connection.backend);}catch{progress(engine,'observing','Native status unavailable; the same job is retained.');await delay(3000);continue;}
    progress(engine,'generating',`Native job: ${observed.state}.`);
    if(['completed','failed'].includes(observed.state)){assert.equal(observed.state,'completed','Native generation failed');break;}await delay(3000);
   }
   progress(engine,'checking_outputs','Retaining and fully decoding generated files.');await jobs.collect(job.id,connection.backend);const result=jobs.get(job.id);assert.equal(result.outputs.state,'ready');const proofs=[];
   for(const file of result.outputs.files)proofs.push(await decode(jobs.results.file(job.id,file.id),kind));
   const types=new Set(proofs.flatMap(p=>p.streams.map(s=>s.codec_type)));assert.ok(types.has('audio'),'Generated audio is missing');if(kind==='video')assert.ok(types.has('video'),'Generated video is missing');
   completed[engine]={job_id:job.id,container:selected.container,image:selected.image,outputs:result.outputs,decoded:proofs};save(engine+'-proof.json',completed[engine]);
  }finally{
   if(started){
    if((await inspect(selected.container)).State.Running){
     for(;;){try{if(await idle())break;}catch{}progress(engine,'waiting_idle','Observing native idle before stopping only this prepared engine.');await delay(3000);}
     await unchanged();await stop(selected.container);
    }
    assert.equal((await inspect(selected.container)).State.Running,false);await unchanged();
   }
   connection?.close();
  }
 }
 assert.equal((await inspect(plan.preparation.llm_container)).State.Running,false);
 return {state:'qualified_stopped',engines:completed,scope:'Real native media generation, retained files and full decode. All prepared engines remain stopped; qualify/start the LLM next. This does not enroll media or recovery.'};
}
