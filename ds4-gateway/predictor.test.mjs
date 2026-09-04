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
import {PredictionHistory as PredictionHistoryV3,replay as replayV3,FEATURE_SCHEMA as FEATURE_SCHEMA_V3} from './prediction-features-v3.mjs';
import {featureBuilderHash} from './prediction-feature-registry.mjs';
import {predictTreeModel,validateCandidate,reference,encode} from './xgb-runtime.mjs';
import {Predictor,promotionEligible,DEFAULT_BASELINE} from './predictor.mjs';
import {PredictionEvidence} from './analytics.mjs';
import {parseGenieReview,Genie,briefing} from './genie.mjs';
import {TRAINING_RECIPES,DEFAULT_RECIPE,RECIPE_POLICY_SHA256} from './training-recipes.mjs';

const origin=1700000000000;
const inventory={schema:1,workers:{a:{matching_profiles:['p'],hardware_family:'spark',accelerator_family:'cuda',ram_gib:128},b:{matching_profiles:['q'],hardware_family:'spark',accelerator_family:'cuda',ram_gib:128}}};
let sequence=0;
function row(kind,id,at,extra={}){return {schema:1,event_id:'e'+(++sequence),run_id:'run',request_id:id,node:'a',time:new Date(origin+at).toISOString(),kind,...extra};}
function decision(id,at,session='s',extra={}){return row('decision',id,at,{session,affinity:'new',traffic_class:'unclassified',candidates:[{node:'a',profile:'p',context_length:262144,active:0,queued:0}],...extra});}
function complete(h,id,at,session='s',extra={}){h.observe(decision(id,at,session));h.observe(row('dispatch',id,at+1));return h.observe(row('finish',id,at+10001,{outcome:'complete',finish_reason:'stop',service_ms:10000,usage:{prompt_tokens:100,completion_tokens:40,cached_tokens:50},generation:{thinking_characters:30,answer_characters:10,tool_characters:0,first_semantic_ms:2000},...extra}));}
function model(overrides={}){return {kind:'admission',id:'a'.repeat(64),encoding:{names:['history_count'],categorical:[],vocabulary:{},encoded_names:['f0']},base_margin:10,factor:1,transform:'raw',trees:[{left_children:[-1],right_children:[-1],split_indices:[0],split_conditions:[0],default_left:[1]}],parity:[{features:{history_count:0},seconds:10}],support:{a:{profiles:['p'],requests:50,first_observed_requests:8},b:{profiles:['q'],requests:50,first_observed_requests:8}},holdout_passed:true,holdout:{long_requests:0},new_session_validated:true,...overrides};}
function bundle(m=model()){return {schema:2,feature_schema:FEATURE_SCHEMA,created_at:new Date(origin-1000).toISOString(),snapshot:{feature_builder_sha256:createHash('sha256').update(fs.readFileSync(new URL('./prediction-features.mjs',import.meta.url))).digest('hex')},models:{[m.kind]:m},reports:{[m.kind]:{status:'holdout_passed'}}};}
function bundleV3(m=model({id:'3'.repeat(64)})){return {...bundle(m),feature_schema:FEATURE_SCHEMA_V3,created_at:new Date(origin).toISOString(),snapshot:{feature_builder_sha256:featureBuilderHash(FEATURE_SCHEMA_V3)}};}
function rig(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dsg-predictor-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));fs.writeFileSync(path.join(dir,'profiles.json'),JSON.stringify(inventory));fs.mkdirSync(path.join(dir,'data'));let now=origin;const events=[];const p=new Predictor({enabled:true,python:process.execPath,profiles:path.join(dir,'profiles.json')},{directory:dir,dataDirectory:path.join(dir,'data'),now:()=>now,record:(kind,r)=>events.push({kind,...r})});t.after(()=>p.close());return {p,dir,events,setTime:n=>{now=n;}};}
function install(r,name,b){const d=path.join(r.dir,'candidates',name);fs.mkdirSync(d);const text=JSON.stringify(b);fs.writeFileSync(path.join(d,'candidate.json'),text);fs.writeFileSync(path.join(d,'report.json'),JSON.stringify({candidate_sha256:createHash('sha256').update(text).digest('hex')}));r.p.loadCandidates();}
const goodRows=(node='a',profile='p')=>Array.from({length:30},(_,i)=>({key:'r'+i,session:'s'+i%5,node,profile,at:origin+i*1000,error:1,baseline_error:10,prediction:100,actual:100,long:false}));

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
test('v3 feeds collected admission, cache, request-shape and progress evidence into XGB rows without changing v2',()=>{
  assert.equal(FEATURE_SCHEMA,'dsg-latency-v2');assert.equal(FEATURE_SCHEMA_V3,'dsg-latency-v3');
  const candidate={node:'a',profile:'p',context_length:262144,active:1,queued:2,assigned_sessions:7,worker_idle_ms:null,active_elapsed_ms:9000,upstream_byte_age_ms:1200,
    session_last_used_ms:4000,session_last_finished_ms:3000,intervening_requests:2,prior_prompt_tokens:900,prior_cached_tokens:810,observation_epoch:4,cache_residence:'unknown'};
  const d=decision('v3',0,'v3-session',{admission_wait_ms:2500,client_metadata:{status:'ready',prompt_tokens_estimate:1000,turn_index:8,compaction_count:1,reasoning_effort:'xhigh'},candidates:[candidate]});
  const events=[d,row('dispatch','v3',1),row('request_features','v3',2,{status:'ready',available_at:origin+2,request_bytes:12000,message_count:20,user_messages:10,assistant_messages:9,system_messages:1,tool_messages:0,text_characters:44000,image_parts:1,tool_definitions:12,max_output_tokens:32768,temperature:.7,top_p:.95,request_stream:true,request_route:'/v1/chat/completions'}),row('progress','v3',5002,{active_elapsed_ms:5000,semantic_characters:100,semantic_age_ms:20,phase:'thinking'}),row('finish','v3',10002,{outcome:'complete',finish_reason:'stop',service_ms:10000})];
  const h=new PredictionHistoryV3(inventory),points=[],liveRows=[];for(const event of events){const result=h.observe(event);points.push(...result.points);liveRows.push(...result.rows);}
  const admission=points[0].features,upload=points.find(point=>point.stage==='upload').features,progress=points.find(point=>point.stage==='remaining').features;
  assert.deepEqual({prompt:admission.client_prompt_tokens_estimate,turn:admission.client_turn_index,compactions:admission.client_compaction_count,effort:admission.client_reasoning_effort,active:admission.selected_active,queued:admission.selected_queued,idle:admission.worker_idle_s,activeAge:admission.active_elapsed_at_admission_s,cache:admission.candidate_prior_cached_fraction,growth:admission.current_prompt_growth_ratio},
    {prompt:1000,turn:8,compactions:1,effort:'xhigh',active:1,queued:2,idle:null,activeAge:9,cache:.9,growth:1000/900});
  assert.deepEqual({bytes:upload.request_bytes,messages:upload.request_message_count,characters:upload.request_text_characters,images:upload.request_image_parts,tools:upload.request_tool_definitions,max:upload.request_max_output_tokens,route:upload.request_route},
    {bytes:12000,messages:20,characters:44000,images:1,tools:12,max:32768,route:'/v1/chat/completions'});
  assert.equal(progress.elapsed_s,5);assert.equal(progress.phase,'thinking');
  assert.deepEqual(replayV3(events,inventory).rows,liveRows);
});
test('v2 remains active while a newer v3 challenger loads and scores in parallel',t=>{
  const r=rig(t),incumbent=bundle(),challenger=bundleV3();
  install(r,'candidate-v2',incumbent);r.p.state.active.admission='candidate-v2';
  install(r,'candidate-v3',challenger);
  assert.equal(r.p.model('admission',{active:true}).id,incumbent.models.admission.id);
  assert.equal(r.p.model('admission').id,challenger.models.admission.id);
  assert.equal(r.p.status().models[0].active_feature_schema,FEATURE_SCHEMA);
  assert.equal(r.p.status().models[0].candidate_feature_schema,FEATURE_SCHEMA_V3);
  assert.deepEqual([...r.p.histories.keys()].sort(),[FEATURE_SCHEMA,FEATURE_SCHEMA_V3].sort());
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
test('native evaluator rounds XGBoost split thresholds to float32 before branching',()=>{
  const boundary={...model(),base_margin:0,factor:1,transform:'raw',encoding:{names:['elapsed_s'],categorical:[],vocabulary:{},encoded_names:['f0']},
    trees:[{left_children:[1,-1,-1],right_children:[2,-1,-1],split_indices:[0,0,0],split_conditions:[42.436348,1,2],default_left:[0,0,0]}]};
  // Both the feature and split become the same float32 value. XGBoost's strict
  // less-than therefore takes the right branch; comparing to a JS double would
  // incorrectly take the left branch.
  assert.equal(predictTreeModel(boundary,{elapsed_s:42.43634796142578}),2);
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
test('a perfect baseline tie is not a victory; NaN cannot bypass the gate',()=>{
  assert.equal(promotionEligible(model(),goodRows().map(r=>({...r,error:0,baseline_error:0}))),false);
  assert.equal(promotionEligible(model(),goodRows().map(r=>({...r,error:NaN}))),false);
});
test('reset restores a named baseline without freezing learning or changing placement policy',t=>{
  const r=rig(t),first=bundle();install(r,'candidate-one',first);
  r.p.state.automatic_training=true;r.p.state.automatic_promotion=true;r.p.state.placement=true;
  r.p.state.evaluations[first.models.admission.id]=goodRows();r.p.activate({...first,directory_id:'candidate-one'},'admission','validator');
  r.p.history.completed=80;r.p.state.new_requests=60;
  const count=r.p.state.milestones.length;
  r.p.control({action:'reset_baseline'});
  assert.equal(r.p.status().models[0].effective_model_id,DEFAULT_BASELINE.id);
  for(const k of ['automatic_training','automatic_promotion','placement'])assert.equal(r.p.state[k],true);
  assert.equal(r.p.history.completed,80);assert.equal(r.p.state.new_requests,60);assert.equal(r.p.state.milestones.length,count);
  assert.equal(r.p.promotionEvidence({...first,directory_id:'candidate-one'},'admission').reason,'rejected_version');
  const stale=bundle(model({id:'b'.repeat(64)}));stale.snapshot.created_at=new Date(origin-1).toISOString();
  install(r,'candidate-stale',stale);r.p.state.evaluations[stale.models.admission.id]=goodRows();
  assert.equal(r.p.promotionEvidence({...stale,directory_id:'candidate-stale'},'admission').reason,'new_snapshot_required_after_reset');
  const fresh=bundle(model({id:'c'.repeat(64)}));fresh.created_at=new Date(origin+2).toISOString();fresh.snapshot.created_at=new Date(origin+1).toISOString();
  install(r,'candidate-fresh',fresh);r.p.state.evaluations[fresh.models.admission.id]=goodRows();r.setTime(origin+60000);
  r.p.activate({...fresh,directory_id:'candidate-fresh'},'admission','validator');assert.equal(r.p.status().models[0].effective_model_id,fresh.models.admission.id);
  assert.equal(r.p.state.milestones.length,count+1);
});
test('a challenger must beat the incumbent on matched forecast points, not merely the weaker baseline',t=>{
  const r=rig(t),first=bundle();install(r,'candidate-one',first);r.p.state.evaluations[first.models.admission.id]=goodRows();r.p.activate({...first,directory_id:'candidate-one'},'admission','validator');
  const challenger=bundle(model({id:'b'.repeat(64)}));install(r,'candidate-two',challenger);
  const b={...challenger,directory_id:'candidate-two'},m=b.models.admission;
  let rows=goodRows().map(r=>({...r,error:3,comparator_id:first.models.admission.id,comparator_error:2,comparator_points:1,comparator_fallback_points:0}));
  r.p.state.evaluations[m.id]=rows;assert.equal(r.p.promotionEvidence(b,'admission').eligible,false);
  assert.throws(()=>r.p.activate(b,'admission','validator'),/matched_champion/);
  rows=rows.map(r=>({...r,comparator_error:5}));r.p.state.evaluations[m.id]=rows.slice(0,29);assert.equal(r.p.promotionEvidence(b,'admission').eligible,false);
  r.p.state.evaluations[m.id]=rows.map(r=>({...r,comparator_id:'unmatched-version'}));assert.equal(r.p.promotionEvidence(b,'admission').eligible,false);
  r.p.state.evaluations[m.id]=rows;r.p.activate(b,'admission','validator');
  assert.equal(r.p.state.milestones.at(-1).evidence.champion.mae_s,3);assert.equal(r.p.state.milestones.at(-1).evidence.champion.baseline_mae_s,5);
  const count=r.p.state.milestones.length;assert.throws(()=>r.p.activate(b,'admission','validator'),/already_active/);assert.equal(r.p.state.milestones.length,count);
});
test('remaining-time comparisons pair the same causal forecast points and reject mixed incumbent versions',t=>{
  const r=rig(t),m=model({kind:'remaining',id:'c'.repeat(64)});install(r,'candidate-remaining',bundle(m));
  const job={decision:{time:new Date(origin).toISOString(),session:'s'}};
  const samples=[0,10].map(elapsed=>({model:m,point:{profile:'p',features:{elapsed_s:elapsed}},seconds:30-elapsed,baseline:40-elapsed,comparator:{id:'a'.repeat(64),seconds:35-elapsed,source:'model'}}));
  const finish={run_id:'r',request_id:'same',time:new Date(origin+20000).toISOString(),node:'a',service_ms:20000};
  r.p.scoreFinished(finish,job,samples);let scored=r.p.state.evaluations[m.id][0];assert.equal(scored.error,10);assert.equal(scored.comparator_error,15);assert.equal(scored.comparator_points,2);
  samples[1].comparator.id='b'.repeat(64);r.p.scoreFinished({...finish,request_id:'mixed'},job,samples);scored=r.p.state.evaluations[m.id][1];assert.equal(scored.comparator_id,undefined);
});
test('milestones survive restart, Genie can annotate only pending facts, and only the operator can dismiss',t=>{
  const r=rig(t),b=bundle();install(r,'candidate-one',b);r.p.state.evaluations[b.models.admission.id]=goodRows();r.p.activate({...b,directory_id:'candidate-one'},'admission','validator');
  const milestone=r.p.status().milestones[0],evidence=structuredClone(milestone.evidence);
  for(const input of [{action:'reset_baseline'},{action:'acknowledge_milestone',milestone_id:milestone.id}])assert.throws(()=>r.p.control(input,'genie'));
  const comment={action:'annotate_milestone',milestone_id:milestone.id,text:'The challenger brought receipts.'};
  assert.throws(()=>r.p.control(comment,'operator'));r.p.control(comment,'genie');assert.deepEqual(r.p.status().milestones[0].evidence,evidence);
  assert.throws(()=>r.p.control(comment,'genie'));assert.throws(()=>r.p.control({...comment,milestone_id:'invented'},'genie'));
  const load=()=>{const p=new Predictor(r.p.config,{directory:r.dir,dataDirectory:path.join(r.dir,'data')});t.after(()=>p.close());return p;};
  const restored=load();assert.equal(restored.status().milestones[0].commentary.text,comment.text);
  restored.control({action:'acknowledge_milestone',milestone_id:milestone.id});assert.equal(restored.model('admission',{active:true}).id,b.models.admission.id);
  assert.equal(load().status().milestones.length,0);
  assert.match(fs.readFileSync(path.join(r.dir,'actions.jsonl'),'utf8'),/"action":"activate"/);
});
test('a failed durable state write leaves neither activation nor an announcement or false success journal',t=>{
  const r=rig(t),b=bundle();install(r,'candidate-one',b);r.p.state.evaluations[b.models.admission.id]=goodRows();
  r.p.persist=()=>{throw new Error('Synthetic disk failure');};
  assert.throws(()=>r.p.activate({...b,directory_id:'candidate-one'},'admission','validator'),/disk failure/);
  assert.equal(r.p.model('admission',{active:true}),undefined);assert.equal(r.p.state.milestones.length,0);assert.equal(r.p.state.receipts.length,0);
  assert.equal(fs.existsSync(path.join(r.dir,'actions.jsonl')),false);
});
test('old state migrates additively; existing policy and candidate evidence are preserved',t=>{
  const r=rig(t);r.p.state.automatic_training=true;r.p.state.placement=true;r.p.state.evaluations['a'.repeat(64)]=goodRows();r.p.persist();
  const file=path.join(r.dir,'state.json'),old=JSON.parse(fs.readFileSync(file));delete old.reset_at;delete old.milestones;fs.writeFileSync(file,JSON.stringify(old));
  const loaded=new Predictor(r.p.config,{directory:r.dir,dataDirectory:path.join(r.dir,'data')});t.after(()=>loaded.close());assert.equal(loaded.configured,true);assert.equal(loaded.state.automatic_training,true);assert.equal(loaded.state.placement,true);assert.deepEqual(loaded.state.milestones,[]);assert.equal(loaded.state.evaluations['a'.repeat(64)].length,30);
});
test('Genie cannot change policy, train without an offer or promote; operator toggles persist',t=>{
  const {p}=rig(t);for(const v of [{action:'placement',enabled:true},{action:'activate'},{action:'train',evidence_id:'fake'}])assert.throws(()=>p.control(v,'genie'));
  p.control({action:'automatic_training',enabled:true});assert.equal(p.state.automatic_training,true);assert.throws(()=>p.control({action:'train',command:'shell'}));
});

test('Genie chooses one exact reviewed recipe; stale, arbitrary and extra-field choices cannot train',t=>{
  const {p,dir}=rig(t);p.history.completed=50;
  assert.deepEqual(p.status().offers,[]);
  p.control({action:'automatic_training',enabled:true});
  const offers=p.status().offers;
  assert.equal(offers.length,3);assert.equal(p.status().default_recipe,'standard-v1');
  assert.deepEqual(offers.map(o=>o.recipe_id),TRAINING_RECIPES.map(r=>r.id));
  const request=offers.find(o=>o.recipe_id==='regularized-v1');
  for(const bad of [{...request,recipe_id:'custom'}, {...request,evidence_id:'old'}, {...request,max_depth:99}, {action:'train',evidence_id:request.evidence_id}])assert.throws(()=>p.control(bad,'genie'));
  let dispatched;p.runTraining=async (...args)=>{dispatched=args;};
  const receipt=p.control(request,'genie');
  assert.equal(receipt.recipe_id,'regularized-v1');assert.equal(dispatched[3],receipt.recipe_id);
  const saved=JSON.parse(fs.readFileSync(path.join(dir,'state.json')));
  assert.equal(saved.training.recipe_policy_sha256,RECIPE_POLICY_SHA256);
  assert.equal(saved.training.recipe_id,'regularized-v1');assert.deepEqual(saved.active,{});
  assert.throws(()=>p.control(request,'genie'),'same offer cannot start a duplicate');
});

test('operator recipe default is unchanged and unknown recipes cannot launch a process',t=>{
  const {p}=rig(t);let selected;p.runTraining=async (...args)=>{selected=args[3];};
  assert.throws(()=>p.control({action:'train',recipe_id:'arbitrary'}));assert.equal(p.busy,false);
  p.control({action:'train'});assert.equal(selected,DEFAULT_RECIPE);
});

test('training checks the emitted recipe before loading or declaring a candidate completed',async t=>{
  const {p,dir}=rig(t),destination=path.join(dir,'candidates','candidate-wrong');
  fs.mkdirSync(destination);fs.writeFileSync(path.join(destination,'candidate.json'),JSON.stringify({training_recipe:{id:'standard-v1',policy_sha256:RECIPE_POLICY_SHA256}}));
  const calls=[];p.runProcess=async (_executable,args)=>{calls.push(args);return 'synthetic trainer output';};
  await p.runTraining(destination,'candidate-wrong','genie','interactions-v1');
  assert.deepEqual(calls[1].slice(-2),['--recipe','interactions-v1']);
  assert.equal(p.state.receipts[0].status,'failed');assert.equal(p.bundles.size,0);
  assert.ok(fs.readFileSync(path.join(destination,'failure.log'),'utf8').includes('recipe changed or mismatched'));
});

test('recipe mismatch remains rejected on reload without invalidating legacy artifacts',t=>{
  const r=rig(t);install(r,'candidate-legacy',bundle());
  const candidate=bundle(model({id:'b'.repeat(64)}));candidate.training_recipe={id:'standard-v1',policy_sha256:RECIPE_POLICY_SHA256};
  install(r,'candidate-mismatch',candidate);
  fs.writeFileSync(path.join(r.dir,'candidates','candidate-mismatch','training-request.json'),JSON.stringify({schema:1,recipe_id:'interactions-v1',recipe_policy_sha256:RECIPE_POLICY_SHA256}));
  r.p.loadCandidates();assert.equal(r.p.bundles.has('candidate-mismatch'),false);
  assert.equal(r.p.bundles.has('candidate-legacy'),true);
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
  a.accept(row('finish','a',50002,{outcome:'complete',finish_reason:'stop',service_ms:50000}));let s=a.snapshot().model_series;assert.equal(s.length,2);assert.equal(s[1].rows.length,1);assert.equal(s[1].rows[0].service_ms,20000);assert.equal(s[1].last_forecast_at,origin+30002);
  a.accept(decision('missing',60000));a.accept(row('dispatch','missing',60001,{queue_ms:1}));a.accept(row('finish','missing',100001,{outcome:'complete',finish_reason:'stop',service_ms:40000}));s=a.snapshot().model_series;assert.equal(s[1].rows.length,2);assert.equal(s[1].rows[1].forecast_eligible,true);assert.equal(s[1].rows[1].predicted_service_ms,null);assert.equal(s[1].rows[1].service_ms,null,'missing remaining forecasts must not fabricate an actual remaining label');
  assert.equal(s[1].last_forecast_at,origin+30002,'coverage rows without a forecast cannot make an old model look current');
});
test('Genie parses only exact predictor offers and reports executor actions, not invented promotion',async()=>{
  const snapshot={time:origin,gateway_at:origin,gateway:{workers:[],predictor:{configured:true,offers:[{action:'train',evidence_id:'offered'}]}},devices:[]};
  const answer={assessment:'New evidence is ready.',ticker:[{severity:'info',text:'Training available',recommendation:null,evidence_refs:['predictor']}],predictor_requests:[{action:'train',evidence_id:'offered'}]};
  assert.equal(parseGenieReview(JSON.stringify(answer),briefing(snapshot)).predictor_requests.length,1);
  assert.equal(parseGenieReview(JSON.stringify({...answer,predictor_requests:[{action:'activate',evidence_id:'offered'}]}),briefing(snapshot)).predictor_requests.length,0);
  const actions=[];const g=new Genie({url:'http://127.0.0.1:12345/v1'},()=>snapshot,{predict:async r=>{actions.push(r);return {state:'running'};},fetchImpl:async()=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(answer)},finish_reason:'stop'}]}))});g.setEnabled(true);await g.ask();assert.equal(actions.length,1);assert.equal(g.reports[0].actions_taken[0].state,'running');g.close();
});

test('Genie recipe selection is exact and one action only',()=>{
  const offer={action:'train',evidence_id:'offered',recipe_id:'interactions-v1'};
  const evidence={evidence_refs:['predictor'],predictor:{offers:[offer]}};
  const answer={assessment:'Test interactions on the next frozen dataset.',ticker:[{severity:'info',text:'Reviewed recipe offered',recommendation:null,evidence_refs:['predictor']}],predictor_requests:[offer]};
  assert.deepEqual(parseGenieReview(JSON.stringify(answer),evidence).predictor_requests,[offer]);
  for(const requests of [[{...offer,recipe_id:'custom'}],[{...offer,rounds:999}], [offer,offer]])
    assert.deepEqual(parseGenieReview(JSON.stringify({...answer,predictor_requests:requests}),evidence).predictor_requests,[]);
});
test('Genie attaches commentary to a real milestone without gaining activation or acknowledgement powers',async()=>{
  const snapshot={time:origin,gateway_at:origin,gateway:{workers:[],predictor:{configured:true,milestones:[{id:'verified-win',commentary:null}],offers:[]}},devices:[]};
  const answer={assessment:'The validator measured an improvement.',ticker:[{severity:'info',text:'Prediction evidence updated',recommendation:null,evidence_refs:['predictor']}],milestone_comments:[{milestone_id:'verified-win',text:'A new personal best. The tests checked the stopwatch.'}]};
  const data=briefing(snapshot),parsed=parseGenieReview(JSON.stringify(answer),data);assert.equal(parsed.milestone_comments.length,1);
  for(const bad of [[{milestone_id:'invented',text:'Claim'}],[{...answer.milestone_comments[0],evidence:{mae:0}}]])assert.equal(parseGenieReview(JSON.stringify({...answer,milestone_comments:bad}),data).milestone_comments.length,0);
  const actions=[],g=new Genie({url:'http://127.0.0.1:12345/v1'},()=>snapshot,{predict:async r=>{actions.push(r);return {status:'verified'};},fetchImpl:async()=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(answer)},finish_reason:'stop'}]}))});
  g.setEnabled(true);await g.ask();g.close();assert.deepEqual(actions,[{action:'annotate_milestone',...answer.milestone_comments[0]}]);
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
  assert.deepEqual(received,[body,body]);assert.equal(gateway.stats().workers[0].assigned_sessions,1);assert.equal(gateway.stats().context_length,262144);
  const reset=await fetch(base+'/api/workers/predictor',{method:'POST',headers:{origin:base,'content-type':'application/json','x-dsg-csrf':token},body:JSON.stringify({action:'reset_baseline'})});assert.equal(reset.status,200,await reset.text());
  assert.equal(gateway.stats().predictor.automatic_promotion,true);assert.equal(gateway.stats().predictor.models[0].effective_model_id,DEFAULT_BASELINE.id);
  assert.equal(gateway.stats().workers[0].assigned_sessions,1);assert.equal(gateway.stats().context_length,262144);assert.deepEqual(received,[body,body],'Reset must not send a model request');await gateway.close();
  const data=fs.readdirSync(path.join(r.dir,'training')).flatMap(f=>fs.readFileSync(path.join(r.dir,'training',f),'utf8').trim().split('\n').map(JSON.parse));assert.equal(data.filter(e=>e.kind==='model_prediction').length,2);assert.ok(data.filter(e=>e.kind==='model_prediction').every(e=>e.experimental));assert.ok(!JSON.stringify(data).includes('private fixture'));
});
