import {test} from 'node:test';import assert from 'node:assert/strict';
import {createNativeHermesContext,publishNativeHermesDescriptor} from './genie-native-context.mjs';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createDashboard} from './dashboard.mjs';
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
