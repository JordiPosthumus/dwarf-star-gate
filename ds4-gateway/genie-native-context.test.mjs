import {test} from 'node:test';import assert from 'node:assert/strict';
import {createNativeHermesContext} from './genie-native-context.mjs';
test('native Hermes keeps current evidence and domain controls across capability changes',async()=>{
 let inspection=false,testing=false;
 const bridge=createNativeHermesContext({snapshot:()=>({time:123,gateway:{workers:[{id:'fixture',physical_machines:['machine-a'],is_healthy:true}],genie_capabilities:{inspection}}}),tools:()=>({inspection:{workers:{}},spark_setup:{url:'private'},power:{url:'private'},unknown:{}}),isEnabled:key=>key==='inspection'&&inspection,isTesting:()=>testing});
 let s=await bridge.tool({action:'context'});assert.deepEqual(s.context.servers[0].physical_machines,['machine-a']);assert.ok(s.tools.inspection);assert.ok(!s.enabled_sections.includes('inspection'));assert.ok(s.enabled_sections.includes('spark_setup'),'discovery/status keep existing independent server-side capability gates');assert.equal(s.tools.unknown,undefined);
 inspection=true;s=await bridge.tool({action:'context'});assert.ok(s.enabled_sections.includes('inspection'));assert.equal(s.context.genie_capabilities.inspection,true);
 testing=true;assert.deepEqual((await bridge.tool({action:'context'})).enabled_sections,[]);
 await assert.rejects(bridge.tool({action:'context',command:'ignored'}));
});
