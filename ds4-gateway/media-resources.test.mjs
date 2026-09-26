import test from 'node:test';
import assert from 'node:assert/strict';
import {createMediaResources,mediaRecipeResources,inspectMediaResources} from './media-resources.mjs';
import {createMediaTools} from './genie-media.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

test('resource observations distinguish the two physical members of an enrolled pair',async()=>{
 const worker={id:'pair',url:'http://fixture'},config={workers:[worker],genie_chat:{inspection:{workers:{pair:{ssh:['head'],container:'head-model'}}}},media_jobs:{pairs:{pair:{kind:'glm53-docker-pair',model:'GLM',worker_binding:{...worker},members:[{ssh:'head',container:'head-model'},{ssh:'rank',container:'rank-model'}]}}}};
 const seen=[],service=createMediaResources(config,{inspect:async target=>{seen.push(target);return {system:'Linux',architecture:'aarch64',docker_architecture:'arm64',gpu_names:['GB10']};}});
 await service.inspect('pair',0);await service.inspect('pair',1);
 assert.deepEqual(seen.map(t=>t.ssh[0]),['head','rank']);assert.equal(service.status()['pair:1'].member,1);
 await assert.rejects(service.inspect('pair',2),/enrolled paired/);
 config.media_jobs.pairs.pair.worker_binding.url='http://changed';await assert.rejects(service.inspect('pair',1),/enrolled paired/);
});

test('packaged SSH collector reads the exact stopped ACE witness without running its CLI or native commands',async t=>{
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'media-resource-transport-')),oldPath=process.env.PATH;
 t.after(()=>{process.env.PATH=oldPath;fs.rmSync(folder,{recursive:true,force:true});});
 const script=`#!/usr/bin/env python3
import json,platform,shlex,subprocess,sys
from pathlib import Path
cid='a'*64
image='sha256:'+'b'*64
calls=[]
platform.system=lambda:'Linux'
platform.machine=lambda:'aarch64'
def output(args,**kwargs):
 calls.append(args)
 if args[0]=='nvidia-smi':return 'NVIDIA GB10'
 if args[:2]==('docker','info'):return json.dumps({'Architecture':'aarch64'})
 if args[:2]==('docker','ps'):return cid
 if args[:2]==('docker','inspect'):return json.dumps([{'Id':cid,'Image':image,'State':{'Running':False},'HostConfig':{'PortBindings':{'8002/tcp':[{'HostPort':'8002'}]}},'Mounts':[]}])
 raise AssertionError('Unexpected resource command')
def run(args,**kwargs):
 calls.append(args)
 if args==['docker','inspect',cid]:return subprocess.CompletedProcess(args,0,json.dumps([{'Id':cid,'Image':image,'Config':{'WorkingDir':'/opt/ace-step'},'State':{'Running':False}}]).encode())
 if args==['docker','cp',cid+':/opt/stargate/recipe-fields-verification.json','-']:raise subprocess.CalledProcessError(1,args,stderr=b'private path must not leak')
 raise AssertionError('Unexpected native command')
subprocess.check_output=output
subprocess.run=run
args=shlex.split(sys.argv[-1])
assert args[:4]==['python3','-I','-B','-c']
exec(compile(args[4],'<fixed-collector>','exec'),{'__name__':'__main__'})
Path(__file__).with_name('calls.json').write_text(json.dumps(calls))
`;
 fs.writeFileSync(path.join(folder,'ssh'),script,{mode:0o700});process.env.PATH=folder+path.delimiter+oldPath;
 const result=await inspectMediaResources({container:'llm',ssh:['fixture']});
 assert.equal(result.native_port_inventory.state,'observed');
 const [candidate]=result.native_port_inventory.containers;
 assert.equal(candidate.running,false);assert.equal(candidate.recipe_contract.state,'unverified');
 assert.ok(!JSON.stringify(result).includes('private path'));
 const calls=JSON.parse(fs.readFileSync(path.join(folder,'calls.json')));
 assert.ok(calls.some(c=>c[1]==='cp'&&c[2]==='a'.repeat(64)+':/opt/stargate/recipe-fields-verification.json'));
 assert.ok(calls.every(c=>c[0]==='nvidia-smi'||c[0]==='docker'&&['ps','info','inspect','cp'].includes(c[1])));
});
