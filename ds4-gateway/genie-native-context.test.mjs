import {test} from 'node:test';import assert from 'node:assert/strict';
import {createNativeHermesContext,publishNativeHermesDescriptor} from './genie-native-context.mjs';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createDashboard} from './dashboard.mjs';
import {GenieMemory} from './genie-memory.mjs';
test('native Hermes keeps current evidence and domain controls across capability changes',async()=>{
 let inspection=false,testing=false;
 const bridge=createNativeHermesContext({snapshot:()=>({time:123,gateway:{workers:[{id:'fixture',physical_machines:['machine-a'],is_healthy:true}],genie_capabilities:{inspection}}}),tools:()=>({inspection:{workers:{}},spark_setup:{url:'private'},power:{url:'private'},unknown:{}}),isEnabled:key=>key==='inspection'&&inspection,isTesting:()=>testing});
 let s=await bridge.tool({action:'context'});assert.deepEqual(s.context.servers[0].physical_machines,['machine-a']);assert.ok(s.tools.inspection);assert.ok(!s.enabled_sections.includes('inspection'));assert.ok(s.enabled_sections.includes('spark_setup'),'discovery/status keep existing independent server-side capability gates');assert.equal(s.tools.unknown,undefined);
 inspection=true;s=await bridge.tool({action:'context'});assert.ok(s.enabled_sections.includes('inspection'));assert.equal(s.context.genie_capabilities.inspection,true);
 testing=true;assert.deepEqual((await bridge.tool({action:'context'})).enabled_sections,[]);
 await assert.rejects(bridge.tool({action:'context',command:'ignored'}));
});

test('native bridge descriptor rotates privately and an old process cannot remove its successor',t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'dsg-native-descriptor-'));
 t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const file=path.join(directory,'private','bridge.json');
 const first={url:'http://127.0.0.1:1234/api/genie/native-tools',token:'first-token'};
 const oldClose=publishNativeHermesDescriptor(file,first);
 assert.equal(fs.statSync(file).mode&0o777,0o600);
 assert.equal(fs.statSync(path.dirname(file)).mode&0o777,0o700);
 const second={...first,token:'second-token'};
 const newClose=publishNativeHermesDescriptor(file,second);oldClose();
 assert.deepEqual(JSON.parse(fs.readFileSync(file)),second);
 newClose();assert.equal(fs.existsSync(file),false);
 const target=path.join(directory,'unchanged');fs.writeFileSync(target,'preserved');
 fs.symlinkSync(target,file);
 assert.throws(()=>publishNativeHermesDescriptor(file,first),/unsafe/);
 assert.equal(fs.readFileSync(target,'utf8'),'preserved');
 fs.unlinkSync(file);fs.chmodSync(path.dirname(file),0o755);
 assert.throws(()=>publishNativeHermesDescriptor(file,first),/private/);
});

test('real dashboard exposes native context only through its private authenticated endpoint',async t=>{
 const snapshot=()=>({time:123,gateway:{workers:[]}});
 const native=createNativeHermesContext({snapshot,tools:()=>({power:{url:'private-power-url',token:'private-power-token'}})});
 const server=createDashboard(snapshot,undefined,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,native);
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>{server.closeAllConnections();server.close();});native.bind(server.address().port);
 const send=extra=>fetch(native.toolConfig.url,{method:'POST',headers:{'content-type':'application/json',...extra},body:JSON.stringify({action:'context'})});
 assert.equal((await send({})).status,403);
 assert.equal((await send({'x-sg-native-tool':native.toolConfig.token,origin:'https://untrusted.example'})).status,403);
 const response=await send({'x-sg-native-tool':native.toolConfig.token});
 assert.equal(response.status,200);const value=await response.json();
 assert.equal(value.tools.power.token,'private-power-token');assert.equal(value.schema,1);
 const publicStatus=await(await fetch(native.toolConfig.url.replace('/api/genie/native-tools','/api/status'))).text();
 assert.ok(!publicStatus.includes('private-power-token'));
});

test('native context uses current shared notebook revisions and respects memory being disabled',async t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'dsg-native-notebook-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const memory=new GenieMemory(path.join(fs.realpathSync(directory),'memory'));memory.setEnabled(true);
 const snapshot={time:1000,gateway:{workers:[{id:'fixture'}]},genie:{memory:{enabled:true}}};
 memory.saveOperatorNote({worker:'fixture',text:'PRIVATE_NOTE: preserve the configured cache.'},snapshot);
 const bridge=createNativeHermesContext({snapshot:()=>snapshot,tools:()=>({}),notebook:memory});
 const before=fs.readFileSync(memory.file);
 const context=(await bridge.tool({action:'context'})).context;
 assert.equal(context.operational_notebook.included,true);assert.match(JSON.stringify(context.operational_notebook.notes),/PRIVATE_NOTE/);
 assert.deepEqual(fs.readFileSync(memory.file),before,'Observation does not write the notebook');
 memory.setEnabled(false);
 const off=(await bridge.tool({action:'context'})).context.operational_notebook;
 assert.equal(off.included,false);assert.deepEqual(off.notes,[]);assert.equal(off.reason,'memory_disabled');
 const unconfigured=createNativeHermesContext({snapshot:()=>snapshot,tools:()=>({})});
 assert.equal((await unconfigured.tool({action:'context'})).context.operational_notebook.configured,false);
});
