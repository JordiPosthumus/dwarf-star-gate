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
