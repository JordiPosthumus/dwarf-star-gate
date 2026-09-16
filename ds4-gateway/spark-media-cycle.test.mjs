import test from 'node:test';import assert from 'node:assert/strict';
import {qualifySparkMedia,mediaPlanIdentity} from './spark-media-cycle.mjs';
const container=id=>({Id:id,Image:'sha256:'+id,Config:{Cmd:['serve']},HostConfig:{},Mounts:[],State:{Running:false}});
function fixture(){
 const containers={llm:container('llm'),h3:container('h3'),ace:container('ace')},calls=[],rows={};let sequence=0;
 const plan={target_id:'new-spark',preparation:{llm_container:'llm',engines:{h3:{container:'h3',image:'sha256:h3',kind:'comfyui',inspection:structuredClone(containers.h3)},'ace-step':{container:'ace',image:'sha256:ace',kind:'ace-step',inspection:structuredClone(containers.ace)}}}};
 const jobs={enqueue:(kind,payload)=>{const job={id:String(++sequence),kind,payload,state:'queued'};rows[job.id]=job;return {job};},dispatch:async id=>{calls.push('submit:'+rows[id].kind);rows[id].state='submitted';},observe:async id=>({...rows[id],state:'completed'}),collect:async id=>{calls.push('collect:'+rows[id].kind);rows[id].outputs={state:'ready',files:[{id:'output'}]};},get:id=>rows[id],results:{file:id=>id}};
 const io={jobs,save:()=>{},progress:()=>{},owned:()=>true,inspect:async id=>structuredClone(containers[id]),start:async id=>{calls.push('start:'+id);containers[id].State.Running=true;},stop:async id=>{calls.push('stop:'+id);containers[id].State.Running=false;},delay:async()=>{},payload:()=>({prompt:{one:{class_type:'VideoNode'}}}),decode:async(file,kind)=>{calls.push('decode:'+kind);return {full_decode:true,streams:kind==='video'?[{codec_type:'video'},{codec_type:'audio'}]:[{codec_type:'audio'}]};},connect:async selected=>({close:()=>{},backend:{request:async route=>route==='/health'?{data:{status:'ok',models_initialized:true}}:route==='/v1/stats'?{data:{jobs:{queued:0,running:0},queue_size:0}}:route==='/queue'?{queue_running:[],queue_pending:[]}:route==='/object_info'?{VideoNode:{}}:{}}})};
 return {plan,io,containers,calls};
}
test('both prepared media engines generate, retain and decode before stopping; LLM untouched',async()=>{
 const f=fixture();const result=await qualifySparkMedia(f.plan,f.io);assert.equal(result.state,'qualified_stopped');assert.deepEqual(f.calls,['start:h3','submit:video','collect:video','decode:video','stop:h3','start:ace','submit:music','collect:music','decode:music','stop:ace']);assert.ok(Object.values(f.containers).every(c=>!c.State.Running));
});
test('music-only preparation qualifies only music and leaves the original LLM stopped for its owner',async()=>{
 const f=fixture();delete f.plan.preparation.engines.h3;
 const result=await qualifySparkMedia(f.plan,f.io);
 assert.deepEqual(Object.keys(result.engines),['ace-step']);
 assert.deepEqual(f.calls,['start:ace','submit:music','collect:music','decode:music','stop:ace']);
 assert.equal(f.containers.llm.State.Running,false);
});
test('already running LLM or changed candidate is never stopped',async()=>{
 for(const which of ['llm','h3']){const f=fixture();if(which==='llm')f.containers.llm.State.Running=true;else f.containers.h3.Config.Cmd=['different'];await assert.rejects(qualifySparkMedia(f.plan,f.io));assert.deepEqual(f.calls,[]);}
});
test('decode or native failure stops the owned idle media engine and does not start the next one',async()=>{
 for(const failure of ['decode','native']){const f=fixture();if(failure==='decode')f.io.decode=async()=>{throw Error('truncated media');};else f.io.jobs.observe=async()=>({state:'failed'});await assert.rejects(qualifySparkMedia(f.plan,f.io));assert.equal(f.calls.at(-1),'stop:h3');assert.ok(!f.calls.includes('start:ace'));assert.ok(!f.containers.llm.State.Running);}
});
test('native idle uncertainty and direct work are observed before stop, without resubmitting',async()=>{
 const f=fixture(),connect=f.io.connect;let checks=0,delays=0;f.io.delay=async()=>{delays++;};
 f.io.connect=async selected=>{const c=await connect(selected),request=c.backend.request;c.backend.request=async route=>{if(selected.kind==='comfyui'&&route==='/queue'){checks++;if(checks===2)throw Error('status lost');if(checks===3)return {queue_running:[['other']],queue_pending:[]};}return request(route);};return c;};
 await qualifySparkMedia(f.plan,f.io);assert.equal(delays,2);assert.equal(f.calls.filter(c=>c==='submit:video').length,1);
});
test('lost host ownership prevents starting any container',async()=>{const f=fixture();f.io.owned=()=>false;await assert.rejects(qualifySparkMedia(f.plan,f.io),/lock lost/);assert.deepEqual(f.calls,[]);});

test('H3 audio may be separate from video, but must actually exist',async()=>{
 const f=fixture();f.io.decode=async()=>({streams:[{codec_type:'video'}],full_decode:true});await assert.rejects(qualifySparkMedia(f.plan,f.io),/audio is missing/);assert.equal(f.calls.at(-1),'stop:h3');
});

test('preflight compares container configuration and ports, not transient inspect metadata',()=>{
 const f=fixture();f.plan.preparation.engines.h3.inspection.Mounts=[{Destination:'/b',Source:'/second'},{Destination:'/a',Source:'/first'}];const changed=structuredClone(f.plan.preparation);changed.engines.h3.inspection.Mounts.reverse();changed.engines.h3.inspection.State.FinishedAt='later metadata';changed.engines.h3.inspection.ExecIDs=['inspection'];
 assert.deepEqual(mediaPlanIdentity(changed),mediaPlanIdentity(f.plan.preparation));changed.engines.h3.inspection.Config.Cmd=['changed'];assert.notDeepEqual(mediaPlanIdentity(changed),mediaPlanIdentity(f.plan.preparation));
});
