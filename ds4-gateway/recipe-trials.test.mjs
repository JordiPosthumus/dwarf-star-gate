import {machinesFor} from './fleet-machines.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {createHash} from 'node:crypto';
import {createRecipeTrials} from './recipe-trials.mjs';
const id='119219df-2284-4b34-a479-aab1e8d51513';
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'recipe-trial-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const plan_file=path.join(dir,'plan.json'),plan={schema:1,kind:'glm53-spark-pair-long-coding',worker:'glm53f-sparks34',ssh:'fixture-host',recipe_root:'/fixture/recipe'};
 fs.writeFileSync(plan_file,JSON.stringify(plan));const plan_sha256=createHash('sha256').update(fs.readFileSync(plan_file)).digest('hex');
 const config={state_file:path.join(dir,'state.json'),control_socket:path.join(dir,'control.sock'),genie_chat:{python:'/fixture/python',inspection:{workers:{'glm53f-sparks34':{ssh:['fixture-host'],recipe_root:'/fixture/recipe'}}}},recipe_trials:{fixture:{plan_file,plan_sha256}}};
 const launched=[],launch=(...args)=>{launched.push(args);const child=new EventEmitter();child.unref=()=>{};return child;};
 return {config,launched,launch,folder:path.join(dir,'genie','recipe-trials',id)};
}
test('recipe stages use a pinned plan, durable deduplication and shared hardware busy state',async t=>{
 const f=fixture(t),manager=createRecipeTrials(f),args={profile:'fixture',stage:'prepare',trial_id:id};
 assert.equal((await manager.start(args)).state,'starting');assert.equal(f.launched.length,1);
 assert.equal(f.launched[0][0],'/fixture/python');assert.equal(f.launched[0][1][1],'prepare');assert.equal(f.launched[0][2].detached,true);
 assert.equal(manager.busy('ds41-sparks34'),true);assert.equal(manager.busy('glm53f-sparks12'),false);
 const reloaded=createRecipeTrials(f);await reloaded.start(args);assert.equal(f.launched.length,1);
 await assert.rejects(reloaded.start({...args,trial_id:'229219df-2284-4b34-a479-aab1e8d51513'}),/already running/);
 const statusFile=path.join(f.folder,'prepare.status.json');const receipt=JSON.parse(fs.readFileSync(statusFile));fs.writeFileSync(statusFile,JSON.stringify({...receipt,state:'prepared'}));
 assert.equal(reloaded.busy('glm53f-sparks34'),false);await reloaded.start({...args,stage:'run'});assert.equal(f.launched.length,2);
 await reloaded.start({...args,stage:'run'});assert.equal(f.launched.length,2);
});
test('changed plans, unknown profiles, active power and unprepared runs never launch',async t=>{
 const f=fixture(t),args={profile:'fixture',stage:'run',trial_id:id},manager=createRecipeTrials(f);
 await assert.rejects(manager.start(args));assert.equal(f.launched.length,0);
 await assert.rejects(manager.start({...args,profile:'arbitrary'}),/enrolled/);
 await assert.rejects(createRecipeTrials({...f,powerBusy:()=>true}).start({...args,stage:'prepare'}),/already running/);
 fs.appendFileSync(f.config.recipe_trials.fixture.plan_file,' ');
 await assert.rejects(manager.start({...args,stage:'prepare'}),/plan changed/);assert.equal(f.launched.length,0);
});
test('unresolved old restoration remains busy beyond the public history limit',async t=>{
 const f=fixture(t),manager=createRecipeTrials(f);
 for(let i=0;i<35;i++){
  const trial_id=String(i).padStart(8,'0')+'-2284-4b34-a479-aab1e8d51513',folder=path.join(path.dirname(f.folder),trial_id);fs.mkdirSync(folder,{recursive:true});
  fs.writeFileSync(path.join(folder,'run.status.json'),JSON.stringify({trial_id,worker:'glm53f-sparks34',state:i?'complete':'restoration_required',started_at:String(i).padStart(3,'0')}));
 }
 assert.equal(manager.status().length,32);assert.equal(manager.busy('glm53f-sparks34'),true);
});
test('local MTP trial must match every private inspection binding and reserves M3 hardware',async t=>{
 const f=fixture(t),plan={schema:1,kind:'omlx-glm53-mtp-depth',worker:'glm53f-m3',root:'/fixture/m3',url:'http://127.0.0.1:8013/v1',api_key_file:'/fixture/private-key'};
 const binding=f.config.recipe_trials.fixture;
 fs.writeFileSync(binding.plan_file,JSON.stringify(plan));binding.plan_sha256=createHash('sha256').update(fs.readFileSync(binding.plan_file)).digest('hex');
 f.config.genie_chat.inspection.workers['glm53f-m3']={kind:'omlx-local',root:plan.root,url:plan.url,api_key_file:'/wrong-key'};
 const manager=createRecipeTrials(f),args={profile:'fixture',stage:'prepare',trial_id:id};
 await assert.rejects(manager.start(args),/inspection binding/);assert.equal(f.launched.length,0);
 f.config.genie_chat.inspection.workers['glm53f-m3'].api_key_file=plan.api_key_file;
 await manager.start(args);assert.match(f.launched[0][1][0],/omlx_recipe_trial.py$/);
 assert.equal(manager.busy('qwen-image'),true);assert.equal(manager.busy('glm53f-sparks34'),false);
});
test('custom local trial needs explicit shared hardware and exact loopback inspection enrollment',async t=>{
 const f=fixture(t),plan={schema:1,kind:'omlx-glm53-mtp-depth',worker:'my-local-glm',root:'/fixture/local',url:'http://127.0.0.1:9001/v1',api_key_file:'/fixture/key',candidate_depth:5};
 const binding=f.config.recipe_trials.fixture,write=()=>{fs.writeFileSync(binding.plan_file,JSON.stringify(plan));binding.plan_sha256=createHash('sha256').update(fs.readFileSync(binding.plan_file)).digest('hex');};write();
 const target={kind:'omlx-local',root:plan.root,url:plan.url,api_key_file:plan.api_key_file};f.config.genie_chat.inspection.workers[plan.worker]=target;
 const manager=createRecipeTrials(f),args={profile:'fixture',stage:'prepare',trial_id:id};
 await assert.rejects(manager.start(args),/explicit physical machine/);
 f.config.machine_groups={[plan.worker]:['mac-a','mac-b']};await assert.rejects(manager.start(args),/explicit physical machine/);
 f.config.machine_groups={[plan.worker]:['mac-a'],'image-worker':['mac-a'],spare:['mac-b']};
 const credentialUrl=new URL(plan.url);credentialUrl.username='fixture-user';credentialUrl.password='fixture-password';
 for(const url of ['http://example.test:9001/v1','http://127.0.0.1/v1','http://127.0.0.1:0/v1','http://127.0.0.1:65536/v1',credentialUrl.href,'http://127.0.0.1:9001/v1?x=1','http://127.0.0.1:9001/other']){
  plan.url=url;write();target.url=url;await assert.rejects(manager.start(args),/loopback/);
 }
 assert.equal(f.launched.length,0);assert.equal(fs.existsSync(f.folder),false);
 plan.url='http://[::1]:9001/v1';write();target.url='http://127.0.0.1:9001/v1';await assert.rejects(manager.start(args),/inspection binding/);
 target.url=plan.url;await manager.start(args);assert.equal(f.launched.length,1);
 assert.match(f.launched[0][1][0],/omlx_recipe_trial.py$/);assert.equal(manager.busy('image-worker'),true);assert.equal(manager.busy('spare'),false);
});
test('permanent rollout is explicitly enrolled, independently launched and deduplicated after publication',async t=>{
 const f=fixture(t),binding=f.config.recipe_trials.fixture;
 const plan=JSON.parse(fs.readFileSync(binding.plan_file));plan.kind='glm53-spark-pair-rollout';
 fs.writeFileSync(binding.plan_file,JSON.stringify(plan));binding.plan_sha256=createHash('sha256').update(fs.readFileSync(binding.plan_file)).digest('hex');
 const manager=createRecipeTrials(f),args={profile:'fixture',stage:'rollout',trial_id:id};
 await assert.rejects(manager.start({...args,stage:'prepare'}),/operation stage/);assert.equal(f.launched.length,0);
 const receipt=await manager.start(args);assert.equal(receipt.operation_kind,'permanent_rollout');assert.equal(receipt.rollout_id,id);
 assert.match(f.launched[0][1][0],/spark_recipe_rollout.py$/);assert.equal(f.launched[0][2].detached,true);
 assert.equal(manager.busy('glm53f-sparks34'),true);
 f.config.genie_chat.inspection.workers['glm53f-sparks34'].recipe_root='/published/recipe';
 await createRecipeTrials(f).start(args);assert.equal(f.launched.length,1);
});

test('only an exact confirmed pre-maintenance copy failure resumes, preserving its prior receipt and identity',async t=>{
 const f=fixture(t),binding=f.config.recipe_trials.fixture,plan=JSON.parse(fs.readFileSync(binding.plan_file));plan.kind='glm53-spark-pair-rollout';fs.writeFileSync(binding.plan_file,JSON.stringify(plan));binding.plan_sha256=createHash('sha256').update(fs.readFileSync(binding.plan_file)).digest('hex');
 const manager=createRecipeTrials(f),args={profile:'fixture',stage:'rollout',trial_id:id},first=await manager.start(args),file=path.join(f.folder,'rollout.status.json');
 await assert.rejects(manager.start({...args,expected_finished_at:123}),/confirmed failed/);
 const failed={...first,state:'failed',phase:'copying_qualified_image',finished_at:123,error:'fixture transport failed'};fs.writeFileSync(file,JSON.stringify(failed));
 await assert.rejects(manager.start({...args,expected_finished_at:124}),/confirmed failed/);
 fs.mkdirSync(path.join(f.folder,'gateway'));fs.writeFileSync(path.join(f.folder,'gateway/acquire.intent.json'),'{}');await assert.rejects(manager.start({...args,expected_finished_at:123}),/advanced beyond/);fs.unlinkSync(path.join(f.folder,'gateway/acquire.intent.json'));
 const next=await manager.start({...args,expected_finished_at:123});assert.equal(next.resume_copy,true);assert.equal(next.attempt,2);assert.equal(next.trial_id,id);assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.folder,'rollout-attempt-1.json'))),failed);assert.equal(f.launched.length,2);
 f.config.genie_chat.inspection.workers[plan.worker].recipe_root='/published';await manager.start({...args,expected_finished_at:123});assert.equal(f.launched.length,2);
});

test('custom pair names require configured independent hardware and reserve every overlapping route',async t=>{
 const f=fixture(t),binding=f.config.recipe_trials.fixture,plan=JSON.parse(fs.readFileSync(binding.plan_file));
 plan.worker='my-glm-pair';plan.separate_workers=['my-spare'];
 fs.writeFileSync(binding.plan_file,JSON.stringify(plan));binding.plan_sha256=createHash('sha256').update(fs.readFileSync(binding.plan_file)).digest('hex');
 f.config.genie_chat.inspection.workers[plan.worker]={ssh:['fixture-host'],recipe_root:'/fixture/recipe'};
 f.config.machine_groups={'my-glm-pair':['gpu-a','gpu-b'],'my-spare':['gpu-b'],alias:['gpu-a']};
 const manager=createRecipeTrials(f),args={profile:'fixture',stage:'prepare',trial_id:id};
 await assert.rejects(manager.start(args),/non-overlapping/);assert.equal(f.launched.length,0);
 f.config.machine_groups['my-spare']=['gpu-c'];await manager.start(args);
 assert.equal(manager.busy('my-glm-pair'),true);assert.equal(manager.busy('alias'),true);assert.equal(manager.busy('my-spare'),false);
 await assert.rejects(manager.start({...args,trial_id:'229219df-2284-4b34-a479-aab1e8d51513'}),/already running/);
});

 test('legacy single Spark aliases share their physical pair reservation despite SSH aliases',()=>{
  const config={genie_chat:{inspection:{workers:{spark1:{ssh:['head-lan']},spark2:{ssh:['rank-lan']}}}}};
  assert.deepEqual(machinesFor('spark1',config),['spark1']);
  assert.deepEqual(machinesFor('spark2',config),['spark2']);
  assert.ok(machinesFor('glm53f-sparks12',config).includes(machinesFor('spark1',config)[0]));
 });
