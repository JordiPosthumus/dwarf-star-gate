import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createBrainStore} from './hermes-brain.mjs';
import {createDashboard} from './dashboard.mjs';
const root=fileURLToPath(new URL('../vendor/hermes',import.meta.url));
const runtimeHome=process.env.HERMES_HOME||fileURLToPath(new URL('../runtime/hermes-home',import.meta.url));
const installed=fs.existsSync(path.join(root,'.hermes/bin/hermes'));
const fixture=t=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'sg-brain-'));
 t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
 const config={model:{provider:'custom',default:'PoolModel',base_url:'http://127.0.0.1:30000/v1',context_length:400000},agent:{reasoning_effort:'max',gateway_notify_interval:0},approvals:{mode:'off'},security:{protected_instruction_files:false},display:{platforms:{telegram:{long_running_notifications:false}}},extra:{untouched:[1,2,'three']}};
 const original='# owner comment — keep it\n'+JSON.stringify(config)+'\n';
 fs.writeFileSync(path.join(home,'config.yaml'),original);fs.writeFileSync(path.join(home,'.env'),'OPENAI_API_KEY=fixture-only\n');
 const store=createBrainStore(home,{root,runtimeHome});return {home,store,config,original};
};
function readYaml(home){
 const python=JSON.parse(execFileSync(path.join(root,'.hermes/bin/hermes'),['--print-runtime-command'],{encoding:'utf8',env:{...process.env,HERMES_HOME:runtimeHome}}))[0];
 const code="import sys,json;sys.path.insert(0,sys.argv[1]);from pathlib import Path;from pm.environments import activate_dependencies;activate_dependencies(Path(sys.argv[1]));from hermes_cli.config import require_readable_config_before_write;print(json.dumps(require_readable_config_before_write(Path(sys.argv[2]))))";
 return JSON.parse(execFileSync(python,['-I','-c',code,root,path.join(home,'config.yaml')],{encoding:'utf8',env:{...process.env,HERMES_HOME:runtimeHome}}));
}
test('Brain saves through native Hermes, preserves unrelated settings/comments, backs up, and rejects stale drafts',{skip:!installed},async t=>{
 const {store,home,config,original}=fixture(t),first=await store.read();
 assert.equal(first.settings.reasoning,'max');assert.equal(first.settings.model,'PoolModel');
 const settings={provider:'custom',model:'another-model',base_url:'http://127.0.0.1:34567/v1',reasoning:'high'};
 const saved=await store.save({settings,revision:first.revision});
 assert.deepEqual(saved.settings,settings);assert.equal(fs.readFileSync(saved.backup,'utf8'),original);
 const actual=readYaml(home);assert.deepEqual(actual,{...config,model:{...config.model,provider:settings.provider,default:settings.model,base_url:settings.base_url},agent:{...config.agent,reasoning_effort:'high'}});
 assert.match(fs.readFileSync(path.join(home,'config.yaml'),'utf8'),/owner comment/);
 await assert.rejects(store.save({settings,revision:first.revision}),{status:409});
 await store.save({settings,revision:saved.revision});assert.equal(fs.readdirSync(path.join(home,'brain-history')).length,1);
 await assert.rejects(store.save({settings:{...settings,base_url:'file:///tmp/no'},revision:saved.revision}));
 assert.deepEqual(readYaml(home),actual);
});
test('Brain HTTP editor and model-list test use a temporary profile without inference',{skip:!installed},async t=>{
 const {store,home,original}=fixture(t);const requests=[];
 const provider=http.createServer((req,res)=>{requests.push([req.method,req.url]);res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({data:[{id:'fixture-model'}]}));});
 provider.listen(0,'127.0.0.1');await once(provider,'listening');t.after(()=>{provider.closeAllConnections();provider.close();});
 const server=createDashboard(()=>({}), {brain:store});
 server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});
 const base=`http://127.0.0.1:${server.address().port}`,loaded=await(await fetch(base+'/api/brain')).json();
 const headers={'content-type':'application/json',origin:base,'x-dsg-csrf':loaded.csrf_token};
 const settings={...loaded.settings,model:'fixture-model',base_url:`http://127.0.0.1:${provider.address().port}/v1`};
 const body=JSON.stringify({settings,revision:loaded.revision});
 assert.equal((await fetch(base+'/api/brain',{method:'PUT',body})).status,403);
 assert.equal((await fetch(base+'/api/brain',{method:'PUT',headers:{...headers,origin:'http://other.test'},body})).status,403);
 const tested=await fetch(base+'/api/brain/test',{method:'POST',headers,body});assert.equal(tested.status,200);assert.equal((await tested.json()).model_listed,true);
 assert.deepEqual(requests,[['GET','/v1/models']]);assert.equal(fs.readFileSync(path.join(home,'config.yaml'),'utf8'),original);
 const saved=await fetch(base+'/api/brain',{method:'PUT',headers,body});assert.equal(saved.status,200);assert.equal((await saved.json()).settings.model,'fixture-model');
 assert.equal((await fetch(base+'/api/brain',{method:'PUT',headers,body})).status,409);
 for(const asset of ['/brain.js','/brain.css'])assert.equal((await fetch(base+asset)).status,200);
 assert.equal((await fetch(base+'/api/brain/status')).status,200);
});
