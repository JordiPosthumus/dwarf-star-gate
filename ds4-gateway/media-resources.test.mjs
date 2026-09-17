import test from 'node:test';
import assert from 'node:assert/strict';
import {createMediaResources,mediaRecipeResources} from './media-resources.mjs';
import {createMediaTools} from './genie-media.mjs';

test('media resources keep permission, observations and fit claims separate',async()=>{
  let enabled=true,calls=0,fail=false,release;
  const waiting=new Promise(r=>release=r),target={container:'a'.repeat(64),ssh:['fixture']};
  const resources=createMediaResources({genie_chat:{inspection:{workers:{one:target}}}},{isEnabled:()=>enabled,inspect:async t=>{calls++;assert.equal(t,target);await waiting;if(fail)throw Error('SSH unavailable');return {observed_at:'2026-09-16T00:00:00Z',system:'Linux',architecture:'aarch64',docker_architecture:'aarch64',gpu_names:['NVIDIA GB10'],memory_total_bytes:128*2**30,memory_available_bytes:10*2**30,disks:[{location:'home',free_bytes:200*2**30}],errors:[]};}});
  const tools=createMediaTools({read:async()=>({jobs:[],hosts:[{id:'one',engines:[{id:'h3',enrolled:true,allowed:true}]}]}),resources});
  const first=tools.tool({action:'inspect',worker_id:'one'}),second=tools.tool({action:'inspect',worker_id:'one'});release();
  const [a,b]=await Promise.all([first,second]);assert.deepEqual(a,b);assert.equal(calls,1);assert.equal(a.recipe_platform_matches,true);assert.match(a.setup,/native qualification/);assert.equal(a.recipes.find(r=>r.engine==='h3').model_bytes_required,63440965087);assert.equal(mediaRecipeResources.find(r=>r.engine==='ace-step').model_bytes_required,28496774102);
  assert.equal((await tools.tool({action:'status'})).resource_checks.one.state,'observed');
  assert.equal(a.recipes[0].installed_model_inventory_checked,false);assert.equal(a.existing_engines[0].enrolled,true);assert.match(a.lifecycle,/do not need simultaneous residency/);
  await assert.rejects(tools.tool({action:'inspect',worker_id:'not-enrolled'}),/registered/);
  await assert.rejects(tools.tool({action:'inspect',worker_id:'one',command:'stop'}));
  enabled=false;await assert.rejects(tools.tool({action:'inspect',worker_id:'one'}),/switched off/);assert.equal(calls,1);
  enabled=true;fail=true;await assert.rejects(tools.tool({action:'inspect',worker_id:'one'}),/SSH unavailable/);assert.equal(resources.status().one.state,'unavailable');
});

test('other platforms remain unqualified without changing existing capabilities',async()=>{
  const resources=createMediaResources({genie_chat:{inspection:{workers:{mac:{kind:'omlx-local'}}}}},{inspect:async()=>({system:'Darwin',architecture:'arm64',gpu_names:[],docker_architecture:null})});
  const result=await resources.inspect('mac');assert.equal(result.recipe_platform_matches,false);assert.match(result.setup,/Existing engine enrollments and serving capabilities are unchanged/);
});
