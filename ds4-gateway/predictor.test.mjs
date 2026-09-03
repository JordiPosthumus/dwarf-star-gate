import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import http from 'node:http';
import {once} from 'node:events';
import {createGateway} from './gateway.mjs';
import {createDashboard} from './dashboard.mjs';
import {workerControl} from './worker-client.mjs';
import {PredictionHistory,replay,FEATURE_SCHEMA} from './prediction-features.mjs';
import {predictTreeModel,validateCandidate,reference,encode} from './xgb-runtime.mjs';
import {Predictor,promotionEligible} from './predictor.mjs';
import {PredictionEvidence} from './analytics.mjs';
import {parseGenieReview,Genie,briefing} from './genie.mjs';

const origin=1700000000000;
const inventory={schema:1,workers:{a:{matching_profiles:['p'],hardware_family:'spark',accelerator_family:'cuda',ram_gib:128},b:{matching_profiles:['q'],hardware_family:'spark',accelerator_family:'cuda',ram_gib:128}}};
let sequence=0;
function row(kind,id,at,extra={}){return {schema:1,event_id:'e'+(++sequence),run_id:'run',request_id:id,node:'a',time:new Date(origin+at).toISOString(),kind,...extra};}
function decision(id,at,session='s',extra={}){return row('decision',id,at,{session,affinity:'new',traffic_class:'unclassified',candidates:[{node:'a',profile:'p',context_length:262144,active:0,queued:0}],...extra});}
function complete(h,id,at,session='s',extra={}){h.observe(decision(id,at,session));h.observe(row('dispatch',id,at+1));return h.observe(row('finish',id,at+10001,{outcome:'complete',finish_reason:'stop',service_ms:10000,usage:{prompt_tokens:100,completion_tokens:40,cached_tokens:50},generation:{thinking_characters:30,answer_characters:10,tool_characters:0,first_semantic_ms:2000},...extra}));}
function model(overrides={}){return {kind:'admission',id:'a'.repeat(64),encoding:{names:['history_count'],categorical:[],vocabulary:{},encoded_names:['f0']},base_margin:10,factor:1,transform:'raw',trees:[{left_children:[-1],right_children:[-1],split_indices:[0],split_conditions:[0],default_left:[1]}],parity:[{features:{history_count:0},seconds:10}],support:{a:{profiles:['p'],requests:50,first_observed_requests:8},b:{profiles:['q'],requests:50,first_observed_requests:8}},holdout_passed:true,holdout:{long_requests:0},new_session_validated:true,...overrides};}
function bundle(m=model()){return {schema:2,feature_schema:FEATURE_SCHEMA,created_at:new Date(origin-1000).toISOString(),snapshot:{feature_builder_sha256:createHash('sha256').update(fs.readFileSync(new URL('./prediction-features.mjs',import.meta.url))).digest('hex')},models:{[m.kind]:m},reports:{[m.kind]:{status:'holdout_passed'}}};}
function rig(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dsg-predictor-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));fs.writeFileSync(path.join(dir,'profiles.json'),JSON.stringify(inventory));fs.mkdirSync(path.join(dir,'data'));let now=origin;const events=[];const p=new Predictor({enabled:true,python:process.execPath,profiles:path.join(dir,'profiles.json')},{directory:dir,dataDirectory:path.join(dir,'data'),now:()=>now,record:(kind,r)=>events.push({kind,...r})});t.after(()=>p.close());return {p,dir,events,setTime:n=>{now=n;}};}
function install(r,name,b){const d=path.join(r.dir,'candidates',name);fs.mkdirSync(d);const text=JSON.stringify(b);fs.writeFileSync(path.join(d,'candidate.json'),text);fs.writeFileSync(path.join(d,'report.json'),JSON.stringify({candidate_sha256:createHash('sha256').update(text).digest('hex')}));r.p.loadCandidates();}
const goodRows=(node='a',profile='p')=>Array.from({length:30},(_,i)=>({key:'r'+i,session:'s'+i%5,node,profile,error:1,baseline_error:10,prediction:100,actual:100,long:false}));

test('first request keeps previous-turn data missing; peer and fleet priors are measured, not invented',()=>{
  const h=new PredictionHistory(inventory),first=h.observe(decision('first',0)).points[0];
  assert.equal(first.features.history_count,0);assert.equal(first.features.prior_service_s,null);assert.equal(first.features.worker_service_median,null);
  complete(h,'old',1,'other');const d=decision('new',12000,'new',{node:'b',candidates:[{node:'b',profile:'q',context_length:262144,active:0,queued:0}]});
  const f=h.observe(d).points[0].features;assert.equal(f.prior_service_s,null);assert.equal(f.worker_service_median,null);assert.equal(f.hardware_service_median,10);assert.equal(reference(f),10);
});
test('prior ratios, generation-rate estimate and missing reasoning are causal and zero-safe',()=>{
  const h=new PredictionHistory(inventory);complete(h,'a',0);const f=h.observe(decision('b',20000)).points[0].features;
  assert.equal(f.prior_output_prompt_ratio,.4);assert.equal(f.prior_thinking_fraction,.75);assert.equal(f.prior_generation_tps,5);assert.equal(f.history_generation_estimate_s,8);assert.equal(f.prior_cached_fraction,.5);
  complete(h,'zero',30000,'z',{usage:{prompt_tokens:0,completion_tokens:0,cached_tokens:0},generation:{}});
  const z=h.observe(decision('z2',50000,'z')).points[0].features;assert.equal(z.prior_output_prompt_ratio,null);assert.equal(z.prior_thinking_fraction,null);
});
test('overlapping future finishes, after-upload embeddings and partial failures cannot leak into admission',()=>{
  const h=new PredictionHistory(inventory);h.observe(decision('a',0));h.observe(row('dispatch','a',1));
  const b=h.observe(decision('b',2)).points[0];assert.equal(b.features.prior_service_s,null);
  h.observe(row('dispatch','b',3));
  const e=h.observe(row('embedding','b',5,{status:'ready',available_at:origin+5,dimensions:384,vectors:{latest_user:{vector:Array(384).fill(1/Math.sqrt(384))}}})).points[0];
  assert.equal(e.stage,'embedded');assert.equal(e.features.embedding_present,1);assert.equal(b.features.embedding_present,0);
  h.observe(row('finish','a',10000,{outcome:'complete',finish_reason:'length',service_ms:9999}));assert.equal(h.completed,0);
  const f=h.observe(row('finish','b',10001,{outcome:'complete',finish_reason:'stop',service_ms:9998}));assert.equal(f.rows.length,2);
});
test('progress is post-dispatch, remaining target is elapsed-adjusted; replay equals live features',()=>{
  const events=[decision('a',0),row('progress','a',0,{active_elapsed_ms:0}),row('dispatch','a',1),row('progress','a',30001,{active_elapsed_ms:30000,semantic_characters:200,thinking_characters:180,answer_characters:20,phase:'thinking'}),row('finish','a',40001,{outcome:'complete',finish_reason:'stop',service_ms:40000})];
  const h=new PredictionHistory(inventory),live=events.flatMap(r=>h.observe(r).rows),offline=replay(events,inventory).rows;
  assert.deepEqual(live,offline);assert.equal(live.length,2);assert.equal(live[1].target_s,10);assert.equal(live[1].features.thinking_characters,180);
  assert.throws(()=>replay([...events,{...events[0],node:'b'}],inventory),/Conflicting/);
});
test('duplicate dispatch, unverified profiles, Genie and cancelled jobs do not produce training labels',()=>{
  const h=new PredictionHistory(inventory);h.observe(decision('dup',0));h.observe(row('dispatch','dup',1));h.observe(row('dispatch','dup',2));assert.equal(h.observe(row('finish','dup',100,{outcome:'complete',finish_reason:'stop',service_ms:99})).rows.length,0);
  complete(h,'genie',100,'g',{outcome:'client_cancelled'});assert.equal(h.completed,0);
  h.observe(decision('gg',20000,'g',{traffic_class:'genie'}));h.observe(row('dispatch','gg',20001));assert.equal(h.observe(row('finish','gg',30001,{outcome:'complete',finish_reason:'stop',service_ms:10000})).rows.length,0);
  const unknown=new PredictionHistory({});assert.equal(complete(unknown,'x',0).rows.length,0);
});
test('native evaluator validates shape, missing branches, float32 and Python parity',()=>{
  const m=model();assert.equal(validateCandidate(bundle(m)).models.admission,m);assert.equal(predictTreeModel(m,{}),10);
  assert.ok(Number.isNaN(encode({},m.encoding)[0]));assert.throws(()=>validateCandidate(bundle(model({parity:[{features:{},seconds:999}]}))),/disagreement/);
  const bad=model();bad.trees[0]={left_children:[0],right_children:[0],split_indices:[0],split_conditions:[0],default_left:[1]};assert.throws(()=>validateCandidate(bundle(bad)),/edge/);
  assert.throws(()=>validateCandidate(bundle(model({transform:'arbitrary-code'}))),/Unsupported/);
});
test('holdout and future gates require multiple sessions, genuine gain, calibration and per-worker coverage',()=>{
  const m=model(),rows=goodRows();assert.ok(promotionEligible(m,rows));assert.ok(!promotionEligible({...m,holdout_passed:false},rows));assert.ok(!promotionEligible(m,rows.slice(0,29)));
  assert.ok(!promotionEligible(m,rows.map(r=>({...r,session:'same'}))));assert.ok(!promotionEligible(m,rows.map(r=>({...r,prediction:200}))));assert.ok(!promotionEligible(m,[...rows,{...rows[0],node:'new'}]));
});
test('future-only scoring, successful activation, restart persistence and rollback rejection prevent promote loops',t=>{
  const r=rig(t),b=bundle();install(r,'candidate-one',b);r.p.state.automatic_promotion=true;
  assert.throws(()=>r.p.activate({...b,directory_id:'candidate-one'},'admission','test'),/gate/);
  r.p.state.evaluations[b.models.admission.id]=goodRows();r.p.activate({...b,directory_id:'candidate-one'},'admission','validator');assert.equal(r.p.model('admission',{active:true}).id,b.models.admission.id);
  r.p.persist();const loaded=new Predictor(r.p.config,{directory:r.dir,dataDirectory:path.join(r.dir,'data')});t.after(()=>loaded.close());assert.equal(loaded.model('admission',{active:true}).id,b.models.admission.id);
  loaded.rollback('operator');assert.equal(loaded.model('admission',{active:true}),undefined);assert.throws(()=>loaded.activate({...b,directory_id:'candidate-one'},'admission','test'),/gate/);
  loaded.live.set('old-request',{admission:{seconds:10,at:origin,model_id:b.models.admission.id,experimental:false}});assert.equal(loaded.forecasts('old-request').admission.experimental,true);
  r.p.state.evaluations={};const job={decision:{time:new Date(origin-2000).toISOString(),session:'s'}};r.p.scoreFinished({run_id:'r',request_id:'past',time:new Date(origin).toISOString(),node:'a',service_ms:10000},job,[{model:b.models.admission,point:{profile:'p',features:{}},seconds:10,baseline:20}]);assert.deepEqual(r.p.state.evaluations,{});
});
test('malformed candidates are rejected without removing a valid active model',t=>{
  const r=rig(t);install(r,'candidate-good',bundle());r.p.state.active.admission='candidate-good';install(r,'candidate-bad',{schema:999});assert.equal(r.p.candidateRejections,1);assert.ok(r.p.model('admission',{active:true}));
});
test('Genie cannot change policy, train without an offer or promote; operator toggles persist',t=>{
  const {p}=rig(t);for(const v of [{action:'placement',enabled:true},{action:'activate'},{action:'train',evidence_id:'fake'}])assert.throws(()=>p.control(v,'genie'));
  p.control({action:'automatic_training',enabled:true});assert.equal(p.state.automatic_training,true);assert.throws(()=>p.control({action:'train',command:'shell'}));
});
test('new-session placement abstains on missing validation, hardware or remaining-time evidence',t=>{
  const r=rig(t),b=bundle(),m=b.models.admission;install(r,'candidate-one',b);r.p.state.active.admission='candidate-one';r.p.state.placement=true;r.p.state.evaluations[m.id]=[...goodRows(),...goodRows('b','q')];
  const a={id:'a',queue:[]},bb={id:'b',queue:[]},candidate=n=>({node:n.id,profile:n.id==='a'?'p':'q',context_length:262144,active:Number(!!n.active),queued:n.queue.length});
  assert.equal(r.p.choose([a,bb],'new',bb,candidate),a);
  a.active={id:'busy'};assert.equal(r.p.choose([a,bb],'new',bb,candidate),bb);delete a.active;
  r.p.bundles.get('candidate-one').models.admission.new_session_validated=false;assert.equal(r.p.choose([a,bb],'new',bb,candidate),bb);
});
test('subprocess failure is bounded, logs stay private, no arbitrary executable from action input',async t=>{
  const {p}=rig(t);p.spawnImpl=()=>{const c=new EventEmitter();c.stdout=new PassThrough();c.stderr=new PassThrough();c.kill=()=>{};queueMicrotask(()=>{c.stderr.write('private synthetic failure');c.emit('close',1);});return c;};
  await assert.rejects(p.runProcess('/fake',['fixed'],1000),e=>e.privateOutput.includes('synthetic failure'));
});
test('analytics freezes independent model versions/stages and excludes failed and pre-30s remaining estimates',()=>{
  const a=new PredictionEvidence();a.accept(decision('a',0));a.accept(row('model_prediction','a',1,{predictor_schema:2,model_id:'a'.repeat(64),model_kind:'admission',prediction_stage:'admission',available_at:origin+1,seconds:50}));a.accept(row('dispatch','a',2,{queue_ms:2}));
  for(const elapsed of [0,30,35])a.accept(row('model_prediction','a',elapsed*1000+2,{predictor_schema:2,model_id:'b'.repeat(64),model_kind:'remaining',prediction_stage:'remaining',available_at:origin+elapsed*1000+2,elapsed_s:elapsed,seconds:20}));
  a.accept(row('finish','a',50002,{outcome:'complete',finish_reason:'stop',service_ms:50000}));const s=a.snapshot().model_series;assert.equal(s.length,2);assert.equal(s[1].rows.length,1);assert.equal(s[1].rows[0].service_ms,20000);
});
test('Genie parses only exact predictor offers and reports executor actions, not invented promotion',async()=>{
  const snapshot={time:origin,gateway_at:origin,gateway:{workers:[],predictor:{configured:true,offers:[{action:'train',evidence_id:'offered'}]}},devices:[]};
  const answer={assessment:'New evidence is ready.',ticker:[{severity:'info',text:'Training available',recommendation:null,evidence_refs:['predictor']}],predictor_requests:[{action:'train',evidence_id:'offered'}]};
  assert.equal(parseGenieReview(JSON.stringify(answer),briefing(snapshot)).predictor_requests.length,1);
  assert.equal(parseGenieReview(JSON.stringify({...answer,predictor_requests:[{action:'activate',evidence_id:'offered'}]}),briefing(snapshot)).predictor_requests.length,0);
  const actions=[];const g=new Genie({url:'http://127.0.0.1:12345/v1'},()=>snapshot,{predict:async r=>{actions.push(r);return {state:'running'};},fetchImpl:async()=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(answer)},finish_reason:'stop'}]}))});g.setEnabled(true);await g.ask();assert.equal(actions.length,1);assert.equal(g.reports[0].actions_taken[0].state,'running');g.close();
});

test('enabled predictor: real gateway/control/dashboard path preserves bytes and affinity and writes matched shadow forecasts',{timeout:10000},async t=>{
  const r=rig(t),received=[];
  const sse='data: {"choices":[{"delta":{"reasoning_content":"test","content":"OK"},"finish_reason":"stop"}],"usage":{"prompt_tokens":100,"completion_tokens":10}}\n\ndata: [DONE]\n\n';
  const backend=http.createServer((req,res)=>{if(req.url==='/v1/models')return res.end(JSON.stringify({data:[{id:'fixture-model',context_length:262144}]}));let body='';req.on('data',c=>body+=c);req.on('end',()=>{received.push(body);res.writeHead(200,{'content-type':'text/event-stream'});res.end(sse);});});backend.listen(0,'127.0.0.1');await once(backend,'listening');t.after(()=>{backend.closeAllConnections();backend.close();});
  const url=`http://127.0.0.1:${backend.address().port}`,profile=createHash('sha256').update(JSON.stringify({id:'a',url,model:'fixture-model',context:262144})).digest('hex');
  const inv=structuredClone(inventory);inv.workers.a.matching_profiles=[profile];fs.writeFileSync(path.join(r.dir,'profiles.json'),JSON.stringify(inv));
  const m=model();m.support.a.profiles=[profile];const artifact=bundle(m),d=path.join(r.dir,'predictor','candidates','candidate-fixture');fs.mkdirSync(d,{recursive:true});const bytes=JSON.stringify(artifact);fs.writeFileSync(path.join(d,'candidate.json'),bytes);fs.writeFileSync(path.join(d,'report.json'),JSON.stringify({candidate_sha256:createHash('sha256').update(bytes).digest('hex')}));
  const config={host:'127.0.0.1',port:0,api_key:'test-only',model:'fixture-model',context_length:262144,state_file:path.join(r.dir,'affinity.json'),control_socket:path.join(r.dir,'c.sock'),nodes:[{id:'a',url}],dataset_enabled:true,predictor:{enabled:true,python:process.execPath,profiles:path.join(r.dir,'profiles.json')}};
  let ui;const gateway=createGateway(config);const address=await gateway.start();t.after(()=>{ui?.closeAllConnections();ui?.close();return gateway.close();});
  assert.equal(gateway.stats().predictor.configured,true);
  ui=createDashboard(()=>({gateway:gateway.stats()}),undefined,{read:()=>workerControl(config.control_socket,'/workers'),act:(_action,input)=>workerControl(config.control_socket,'/predictor',input)});ui.listen(0,'127.0.0.1');await once(ui,'listening');
  const base=`http://127.0.0.1:${ui.address().port}`,token=(await(await fetch(base+'/api/workers')).json()).csrf_token;
  const toggle={action:'automatic_promotion',enabled:true};assert.equal((await fetch(base+'/api/workers/predictor',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(toggle)})).status,403);
  const toggled=await fetch(base+'/api/workers/predictor',{method:'POST',headers:{origin:base,'content-type':'application/json','x-dsg-csrf':token},body:JSON.stringify(toggle)});assert.equal(toggled.status,200,await toggled.text());
  const body=JSON.stringify({model:'fixture-model',reasoning_effort:'xhigh',max_tokens:131072,messages:[{role:'user',content:'private fixture'}],stream:true});
  for(let i=0;i<2;i++){const response=await fetch(`http://127.0.0.1:${address.port}/v1/chat/completions`,{method:'POST',headers:{authorization:'Bearer test-only','content-type':'application/json','x-session-affinity':'synthetic-session'},body});assert.equal(await response.text(),sse);}
  assert.deepEqual(received,[body,body]);assert.equal(gateway.stats().workers[0].assigned_sessions,1);assert.equal(gateway.stats().context_length,262144);await gateway.close();
  const data=fs.readdirSync(path.join(r.dir,'training')).flatMap(f=>fs.readFileSync(path.join(r.dir,'training',f),'utf8').trim().split('\n').map(JSON.parse));assert.equal(data.filter(e=>e.kind==='model_prediction').length,2);assert.ok(data.filter(e=>e.kind==='model_prediction').every(e=>e.experimental));assert.ok(!JSON.stringify(data).includes('private fixture'));
});
