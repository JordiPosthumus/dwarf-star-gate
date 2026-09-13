import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {test} from 'node:test';import assert from 'node:assert/strict';import {EndpointTelemetry,vllmSnapshot,omlxSnapshot,omlxActivity} from './endpoint-telemetry.mjs';
const metrics=(tokens=100)=>`vllm:num_requests_running{engine="0"} 1\nvllm:num_requests_waiting{engine="0"} 2\nvllm:generation_tokens_total{engine="0"} ${tokens}\nvllm:request_generation_tokens_sum 100\nvllm:request_decode_time_seconds_sum 5\nvllm:request_prefill_kv_computed_tokens_sum 500\nvllm:request_prefill_time_seconds_sum 2\nvllm:request_generation_tokens_count 2\n`;
test('vLLM separates session phase averages and live intervals, handles counter resets',()=>{const a=vllmSnapshot(metrics(),1000);assert.equal(a.prefill_tps,250);assert.equal(a.decode_tps,20);assert.equal(a.live_decode_tps,null);assert.equal(vllmSnapshot(metrics(140),3000,a).live_decode_tps,20);assert.equal(vllmSnapshot(metrics(1),3000,a).live_decode_tps,null);assert.throws(()=>vllmSnapshot('other 5',1));});
test('oMLX exposes server measurements without inventing live phase rates',()=>{const a=omlxSnapshot({status:'ok',total_requests:3,avg_prefill_tps:1020,avg_generation_tps:28,active_requests:1},1);assert.equal(a.prefill_tps,1020);assert.equal(a.decode_tps,28);assert.equal(a.live_decode_tps,null);assert.throws(()=>omlxSnapshot({},1));});
test('only OpenAI workers are sampled; status fallback is read-only and credentials remain local',async()=>{let calls=[];const t=new EndpointTelemetry({now:()=>1000,fetcher:async(url,opts)=>{calls.push({url:String(url),opts});return String(url).endsWith('/metrics')?new Response('',{status:404}):Response.json({status:'ok',total_requests:1,avg_prefill_tps:400,avg_generation_tps:30});}});const dwarf={id:'dwarf',url:'http://127.0.0.1:8000'},m={id:'m3',backend:'openai',url:'http://127.0.0.1:8013/v1'};t.sync([dwarf,m]);assert.deepEqual(t.workers,[m]);await t.sample(m);assert.equal(calls.length,3);assert.equal(t.snapshot('m3').source,'omlx');assert.equal(t.snapshot('m3').decode_tps,30);assert.equal(t.snapshot('dwarf'),null);assert.ok(calls.every(c=>c.opts.method===undefined&&c.opts.redirect==='error'));t.close();});

test('oMLX live activity includes prefill progress and generated thinking tokens',()=>{const a=omlxActivity({active_models:{models:[{active_requests:1,prefilling:[{processed:8192,total:150000,speed:1050}],generating:[]}]}});assert.equal(a.phase,'prefill');assert.equal(a.live_prefill_tps,1050);assert.equal(a.prefill_total,150000);const b=omlxActivity({active_models:{models:[{active_requests:1,prefilling:[],generating:[{generated_tokens:1200,tokens_per_second:31}]}]}});assert.equal(b.phase,'decode');assert.equal(b.live_decode_tps,31);assert.equal(b.generated_tokens,1200);});

import {Activity,phase} from './ui/activity.js';
test('activity colors use fresh engine phases even outside DSG or with routing paused',()=>{
 const worker={id:'m3',load:0,is_healthy:true,drained:true};
 const device={id:'m3',endpoint_metrics:{connected:true,at:1000,running:1,phase:'prefill'}};
 assert.equal(phase(device,worker,1000),'prefill');
 const activity=new Activity();activity.update([device],[worker],1000);device.endpoint_metrics.phase='decode';device.endpoint_metrics.at=3000;activity.update([device],[worker],3000);activity.update([device],[worker],5000);
 assert.deepEqual(activity.get('m3').map(r=>r.phase),['prefill','decode']);
 assert.equal(phase(device,worker,19000),'unknown');assert.equal(phase(device,worker,4000,true),'unknown');
 assert.equal(phase({connected:true,last_event:1000,phase:'thinking'},{...worker,load:1},2000),'thinking');
});

test('prompt counter batches alone cannot establish prefill duration or speed',()=>{
 const raw=(g,p)=>metrics(g)+`vllm:prompt_tokens_by_source_total{source="local_compute"} ${p}\n`;
 const a=vllmSnapshot(raw(100,1000),1000),b=vllmSnapshot(raw(100,227073),3000,a);
 assert.equal(b.phase,'working');assert.equal(b.live_prefill_tps,null);
 const c=vllmSnapshot(raw(160,227073),5000,b);assert.equal(c.phase,'decode');assert.equal(c.live_decode_tps,30);
 const reset=vllmSnapshot(raw(1,1),7000,c);assert.equal(reset.live_decode_tps,null);assert.equal(reset.completed_prefill,null);
});
test('simultaneous token-counter changes are not proof of concurrent prefill and decode',()=>{
 const m=omlxActivity({active_models:{models:[{active_requests:2,prefilling:[{processed:50,total:100,speed:1000}],generating:[{generated_tokens:20,tokens_per_second:30}]}]}});assert.equal(m.phase,'mixed');
 const raw=(g,p)=>metrics(g)+`vllm:prompt_tokens_by_source_total{source="local_compute"} ${p}\n`;
 const a=vllmSnapshot(raw(100,1000),1000),b=vllmSnapshot(raw(120,2000),3000,a);
 assert.equal(b.phase,'decode');assert.equal(b.live_prefill_tps,null);assert.equal(b.live_decode_tps,10);
});
test('endpoint replacement and delayed failures do not resurrect old telemetry',async()=>{
 let fail;const t=new EndpointTelemetry({fetcher:()=>new Promise((_,reject)=>{fail=reject;})});const w={id:'spark',backend:'openai',url:'http://127.0.0.1:9999/v1'};t.sync([w]);t.states.set(w.id,{url:w.url,source:'vllm',at:1,connected:true});const pending=t.sample(w);t.sync([]);fail(Error('offline'));await pending;assert.equal(t.snapshot(w.id),null);t.close();
});
test('authenticated oMLX activity reuses a private session; failures expose no credentials',async(testContext)=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'endpoint-auth-'));testContext.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const keyFile=path.join(dir,'key');fs.writeFileSync(keyFile,'PRIVATE_KEY',{mode:0o600});
 let logins=0,cookies=[],now=1000;
 const t=new EndpointTelemetry({now:()=>now,fetcher:async(url,opts)=>{
  if(String(url).endsWith('/metrics'))return new Response('',{status:404});
  if(String(url).endsWith('/api/status'))return Response.json({status:'ok',total_requests:1,avg_prefill_tps:300,avg_generation_tps:30});
  if(String(url).endsWith('/login')){logins++;assert.equal(JSON.parse(opts.body).api_key,'PRIVATE_KEY');return new Response('{}',{headers:{'set-cookie':'omlx_admin_session=PRIVATE_COOKIE; HttpOnly'}});}
  cookies.push(opts.headers.cookie);return opts.headers.cookie?Response.json({active_models:{models:[{active_requests:1,generating:[{generated_tokens:30,tokens_per_second:30}]}]}}):new Response('',{status:401});
 }});
 const w={id:'m3',backend:'openai',url:'http://127.0.0.1:1/v1',api_key_file:keyFile};t.sync([w]);await t.sample(w);now+=3000;await t.sample(w);assert.equal(logins,1);assert.equal(cookies.at(-1),'omlx_admin_session=PRIVATE_COOKIE');assert.equal(t.snapshot(w.id).series.length,2);assert.ok(!JSON.stringify(t.snapshot(w.id)).includes('PRIVATE'));t.sync([]);assert.equal(t.cookies.size,0);assert.equal(t.snapshot(w.id),null);t.close();
});
test('oversized and failing endpoint telemetry stays unavailable without leaking credentials',async()=>{
 const t=new EndpointTelemetry({fetcher:async()=>new Response('x'.repeat(1048577))});const w={id:'w',backend:'openai',url:'http://127.0.0.1:1/v1',api_key:'PRIVATE'};t.sync([w]);await t.sample(w);assert.equal(t.snapshot('w').connected,false);assert.ok(!JSON.stringify(t.snapshot('w')).includes('PRIVATE'));t.close();
});

test('oMLX does not call zero-token preparation generation or invent rates from absent fields',()=>{
 const preparing=omlxActivity({active_models:{models:[{active_requests:1,prefilling:[],generating:[{generated_tokens:0,elapsed_seconds:null,tokens_per_second:0}]}]}});
 assert.equal(preparing.phase,'working');assert.equal(preparing.live_decode_tps,null);
 const missing=omlxActivity({active_models:{models:[{active_requests:1,prefilling:[{processed:0,total:100}],generating:[]}]}});
 assert.equal(missing.live_prefill_tps,null);
});
test('unavailable OpenAI engine activity does not claim idle from gateway ownership or a pause',()=>{
 const worker={id:'m3',is_healthy:true,load:0,drained:true};
 for(const engine of [{connected:false},{connected:true,at:1000,running:0},{connected:true,at:20000,running:0},{connected:true,at:18000,running:null}]){
  assert.equal(phase({endpoint_metrics:engine},worker,19000),'unknown');
 }
 assert.equal(phase({endpoint_metrics:{connected:true,live_activity:true,at:18000,running:0,phase:'idle'}},worker,19000),'idle');
});
test('successful samples reach the activity observer immediately and preserve nominal poll cadence',async()=>{
 let now=1000;const seen=[];const w={id:'spark',backend:'openai',url:'http://127.0.0.1:1/v1'};
 const t=new EndpointTelemetry({now:()=>now,onSample:(id,value)=>seen.push({id,phase:value.phase}),fetcher:async()=>{now+=100;return new Response(metrics());}});t.sync([w]);await t.sample(w);
 assert.equal(seen.length,1);assert.equal(seen[0].id,'spark');assert.equal(t.states.get('spark').retryAt,3000);t.close();
});
test('prefill completed entirely between vLLM polls retains interval evidence even when idle',()=>{
 const raw=(p)=>metrics().replace('running{engine="0"} 1','running{engine="0"} 0')+`vllm:prompt_tokens_by_source_total{source="local_compute"} ${p}\n`;
 const a=vllmSnapshot(raw(100),1000),b=vllmSnapshot(raw(500),3000,a);
 assert.equal(b.phase,'idle');assert.equal(b.interval_prefill,400);assert.equal(b.interval_phase,null);assert.equal(b.completed_prefill,null);
});
test('oMLX completed-prefill evidence records computation without assigning a fabricated phase duration',async()=>{
 let now=1000,requests=1;const w={id:'m3',backend:'openai',url:'http://127.0.0.1:1/v1'};
 const t=new EndpointTelemetry({now:()=>now,fetcher:async(url)=>String(url).endsWith('/metrics')?new Response('',{status:404}):String(url).endsWith('/api/status')?Response.json({status:'ok',total_requests:requests,total_prompt_tokens:requests*1000,total_cached_tokens:requests*900,avg_prefill_tps:300,avg_generation_tps:30,active_requests:0}):Response.json({active_models:{models:[]}})});
 t.sync([w]);await t.sample(w);now+=2000;requests++;await t.sample(w);
 assert.equal(t.snapshot(w.id).completed_prefill_tokens,100);assert.equal(t.snapshot(w.id).phase,'idle');t.close();
});
test('short samples reach the timeline before the next dashboard poll and completion markers are deduplicated',async()=>{
 let now=1000,stage='prefill';const worker={id:'m3',backend:'openai',url:'http://127.0.0.1:1/v1',load:0,drained:true,is_healthy:true},activity=new Activity();
 const collector=new EndpointTelemetry({now:()=>now,onSample:(id,metrics,at)=>activity.observe({id,backend:'openai',endpoint_metrics:metrics},worker,at),fetcher:async(url)=>{
  if(String(url).endsWith('/metrics'))return new Response('',{status:404});
  if(String(url).endsWith('/api/status'))return Response.json({status:'ok',total_requests:stage==='idle'?2:1,total_prompt_tokens:stage==='idle'?2000:1000,total_cached_tokens:stage==='idle'?1800:900,avg_prefill_tps:500,avg_generation_tps:30});
  return Response.json({active_models:{models:stage==='idle'?[]:[{active_requests:1,prefilling:stage==='prefill'?[{processed:50,total:100,speed:500}]:[],generating:stage==='decode'?[{generated_tokens:1,tokens_per_second:30}]:[]}]}});
 }});
 collector.sync([worker]);await collector.sample(worker);now=1500;stage='decode';await collector.sample(worker);
 assert.deepEqual(activity.get(worker.id).map(row=>row.phase),['prefill','decode']);
 assert.equal(activity.get(worker.id)[0].end-activity.get(worker.id)[0].start,500);
 now=2000;stage='idle';await collector.sample(worker);const device={id:worker.id,backend:'openai',endpoint_metrics:collector.snapshot(worker.id)};
 activity.update([device],[worker],2200);activity.update([device],[worker],2400);
 assert.equal(activity.getMarkers(worker.id,2400).length,1);assert.equal(activity.getMarkers(worker.id,2400)[0].tokens,100);
 assert.equal(activity.getMarkers(worker.id,2400)[0].basis,'completed_request');collector.close();
});
test('collector rediscovers a replacement engine at the same URL without carrying old source rates',async()=>{
 let now=1000,replaced=false;const w={id:'w',backend:'openai',url:'http://127.0.0.1:1/v1'};
 const t=new EndpointTelemetry({now:()=>now,fetcher:async(url)=>String(url).endsWith('/metrics')?new Response(replaced?'':metrics(),{status:replaced?404:200}):String(url).endsWith('/api/status')?Response.json({status:'ok',total_requests:1,avg_prefill_tps:100,avg_generation_tps:10,active_requests:0}):Response.json({active_models:{models:[]}})});
 t.sync([w]);await t.sample(w);assert.equal(t.snapshot(w.id).source,'vllm');replaced=true;now+=2000;await t.sample(w);assert.equal(t.snapshot(w.id).source,'omlx');assert.equal(t.snapshot(w.id).interval_generated,undefined);t.close();
});
test('credential registration changes abort pending observations and cannot publish old state',async()=>{
 let finish;const w={id:'w',backend:'openai',url:'http://127.0.0.1:1/v1'},t=new EndpointTelemetry({fetcher:()=>new Promise(resolve=>finish=resolve)});
 t.sync([w]);const pending=t.sample(w),controller=t.busy.get(w.id).controller;t.sync([{...w,api_key_file:'/different-private-key'}]);assert.equal(controller.signal.aborted,true);
 finish(new Response(metrics()));await pending;assert.equal(t.snapshot(w.id),null);t.close();
});

// Mirrors the installed vLLM emission contract: first-token counters publish
// the full prompt, while timing/computed-token histograms publish at finish.
const phaseMetrics=({running=0,g=0,first=0,done=0,prompt=0,computed=0,prefillSeconds=0,decodeSeconds=0,computedCount=done,prefillCount=done}={})=>[
 ['num_requests_running',running],['num_requests_waiting',0],['generation_tokens_total',g],['time_to_first_token_seconds_count',first],['request_generation_tokens_count',done],['request_generation_tokens_sum',g],
 ['prompt_tokens_by_source_total{source="local_compute"}',prompt],['prompt_tokens_by_source_total{source="local_cache_hit"}',999999],
 ['request_prefill_kv_computed_tokens_sum',computed],['request_prefill_kv_computed_tokens_count',computedCount],['request_prefill_time_seconds_sum',prefillSeconds],['request_prefill_time_seconds_count',prefillCount],['request_decode_time_seconds_sum',decodeSeconds],['request_decode_time_seconds_count',done]
].map(([key,value])=>`vllm:${key} ${value}`).join('\n');

test('118-second prefill stays blue, first token starts green, and measured speed never uses the 2-second scrape denominator',()=>{
 let previous=vllmSnapshot(phaseMetrics(),1000);
 for(let now=3000;now<121000;now+=2000){previous=vllmSnapshot(phaseMetrics({running:1}),now,previous);assert.equal(previous.phase,'prefill');assert.equal(previous.live_prefill_tps,null);}
 const first=vllmSnapshot(phaseMetrics({running:1,g:1,first:1,prompt:226073}),121000,previous);
 assert.equal(first.phase,'decode');assert.equal(first.interval_prefill,226073);assert.equal(first.live_prefill_tps,null);
 const done=vllmSnapshot(phaseMetrics({g:101,first:1,done:1,prompt:226073,computed:226073,prefillSeconds:118,decodeSeconds:4}),125000,first);
 assert.equal(done.phase,'idle');assert.equal(done.completed_prefill.tps,226073/118);
 assert.equal(done.completed_prefill.start,3000);assert.equal(done.completed_prefill.end,121000);
});
test('decode pauses retain the generation phase; an immediately following request returns to prefill',()=>{
 const idle=vllmSnapshot(phaseMetrics(),1000),a=vllmSnapshot(phaseMetrics({running:1,first:1,g:10}),3000,idle);
 const paused=vllmSnapshot(phaseMetrics({running:1,first:1,g:10}),5000,a);assert.equal(paused.phase,'decode');
 const next=vllmSnapshot(phaseMetrics({running:1,first:1,g:12,done:1,computed:100,prefillSeconds:1,decodeSeconds:3}),7000,paused);
 assert.equal(next.phase,'prefill');assert.equal(next.decoding_requests,0);
});
test('actual concurrent lifecycle states are mixed, and aggregated finishes do not invent a single prefill interval',()=>{
 const idle=vllmSnapshot(phaseMetrics(),1000),a=vllmSnapshot(phaseMetrics({running:2,first:1,g:10}),3000,idle);
 assert.equal(a.phase,'mixed');const b=vllmSnapshot(phaseMetrics({running:2,first:2,g:20}),5000,a);assert.equal(b.phase,'decode');
 const c=vllmSnapshot(phaseMetrics({first:2,done:2,g:30,computed:9000,prefillSeconds:6,decodeSeconds:10}),7000,b);
 assert.equal(c.completed_prefill.tps,1500);assert.equal(c.completed_prefill.requests,2);assert.equal(c.completed_prefill.start,undefined);
});
test('timing counts must align; resets, missed samples and missing counters never produce invented prefill rates',()=>{
 const a=vllmSnapshot(phaseMetrics(),1000);
 for(const overrides of [{computedCount:0},{prefillCount:0},{prefillSeconds:0}]){
  const b=vllmSnapshot(phaseMetrics({done:1,first:1,g:10,computed:9000,prefillSeconds:6,decodeSeconds:1,...overrides}),3000,a);assert.equal(b.completed_prefill,null);
 }
 const done=vllmSnapshot(phaseMetrics({done:1,first:1,g:10,computed:9000,prefillSeconds:6,decodeSeconds:1}),3000,a);
 const reset=vllmSnapshot(phaseMetrics({running:1}),5000,done);assert.equal(reset.phase,'working');assert.equal(reset.completed_prefill,null);
 const gap=vllmSnapshot(phaseMetrics({done:2,first:2,g:20,computed:10000,prefillSeconds:7,decodeSeconds:2}),40000,done);assert.equal(gap.completed_prefill,null);
 const reconnect=vllmSnapshot(phaseMetrics({running:1}),5000,{...a,connected:false});assert.equal(reconnect.phase,'working');
});
test('sub-poll prefill is reconstructed from measured duration, not drawn as a 2-second token tick',()=>{
 const idle=vllmSnapshot(phaseMetrics(),1000),done=vllmSnapshot(phaseMetrics({first:1,done:1,g:10,computed:500,prefillSeconds:.25,decodeSeconds:.75}),3000,idle);
 const activity=new Activity(),worker={id:'spark',is_healthy:true,load:0};
 activity.observe({endpoint_metrics:idle},worker,1000);activity.observe({endpoint_metrics:done},worker,3000);
 const blue=activity.get('spark').filter(row=>row.phase==='prefill');assert.equal(blue.length,1);assert.equal(blue[0].end-blue[0].start,250);
 assert.equal(activity.getMarkers('spark',3000).length,0);
 activity.observe({endpoint_metrics:done},worker,3500);assert.equal(activity.get('spark').filter(row=>row.phase==='prefill').length,1);
});
test('collector charts completed-request prefill speed separately from live decode throughput',async()=>{
 let now=1000,value=phaseMetrics();const worker={id:'spark',backend:'openai',url:'http://127.0.0.1:1/v1'};
 const collector=new EndpointTelemetry({now:()=>now,fetcher:async()=>new Response(value)});collector.sync([worker]);await collector.sample(worker);
 now=3000;value=phaseMetrics({running:1,g:1,first:1,prompt:200000});await collector.sample(worker);assert.equal(collector.snapshot(worker.id).series.filter(p=>p.kind==='prefill').length,0);
 now=5000;value=phaseMetrics({done:1,g:51,first:1,prompt:200000,computed:200000,prefillSeconds:100,decodeSeconds:2});await collector.sample(worker);
 const point=collector.snapshot(worker.id).series.find(p=>p.kind==='prefill');assert.equal(point.tps,2000);assert.equal(point.scope,'completed_request_average');
 now=7000;await collector.sample(worker);assert.equal(collector.snapshot(worker.id).series.filter(p=>p.kind==='prefill').length,1);collector.close();
});

test('server restart invalidates a baseline even when replacement counters are already larger',()=>{
 const a=vllmSnapshot(phaseMetrics()+'\nvllm:generation_tokens_created 100',1000);
 const b=vllmSnapshot(phaseMetrics({running:1,done:1,first:1,g:100,computed:10000,prefillSeconds:10})+'\nvllm:generation_tokens_created 200',3000,a);
 assert.equal(b.completed_prefill,null);assert.equal(b.live_decode_tps,null);assert.equal(b.phase,'working');
});
