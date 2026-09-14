import test from 'node:test';import assert from 'node:assert/strict';import {withGatewayProgress} from './genie-request-progress.mjs';import {createDashboard,genieChatConfig} from './dashboard.mjs';
const id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';const conversation=()=>({id:'conversation',messages:[{id,state:'working',gateway_call_id:id,text:'',at:1000}]});
const snapshot=(jobs=[])=>({genie_progress_version:1,observed_at:10000,jobs});
const job=(extra={})=>({call_id:id,traffic_class:'genie',state:'queued',request_id:'gateway-request',machine:'example',request_preview:{text:'PRIVATE_OTHER_PREVIEW'},...extra});
test('only one matching Genie call supplies live state and no preview or other job data',()=>{
 const c=conversation(),s=snapshot([job({call_id:'different',request_id:'PRIVATE_OTHER_ID'}),job(),job({traffic_class:'unclassified',request_id:'PRIVATE_UNCLASSIFIED'})]);
 const result=withGatewayProgress(c,s);assert.deepEqual(result.messages[0].gateway_execution,{state:'queued',observed_at:10000,request_id:'gateway-request',machine:'example'});assert.doesNotMatch(JSON.stringify(result),/PRIVATE_/);assert.equal(c.messages[0].gateway_execution,undefined);
 assert.equal(withGatewayProgress(c,snapshot([job({state:'running'})])).messages[0].gateway_execution.state,'running');assert.equal(withGatewayProgress(c,snapshot([job({state:'blocked'})])).messages[0].gateway_execution.state,'blocked');
});
test('absent, old, ambiguous and completed snapshots never imply cancellation or success',()=>{
 const c=conversation();assert.equal(withGatewayProgress(c,{...snapshot([job()]),jobs_truncated:true}).messages[0].gateway_execution.state,'unavailable');assert.equal(withGatewayProgress(c,null).messages[0].gateway_execution.state,'unavailable');assert.equal(withGatewayProgress(c,{jobs:[job()]}).messages[0].gateway_execution.state,'unavailable');assert.equal(withGatewayProgress(c,snapshot()).messages[0].gateway_execution.state,'not_observed');assert.equal(withGatewayProgress(c,snapshot([job(),job()])).messages[0].gateway_execution.state,'ambiguous');c.messages[0].state='complete';assert.deepEqual(withGatewayProgress(c,snapshot([job()])),c);
});
test('tracking is configured only for this exact local gateway, never a remote provider',()=>{
 const c={port:9000,genie_chat:{url:'http://127.0.0.1:9000/v1',gateway_tracking:false}};assert.equal(genieChatConfig(c).gateway_tracking,true);assert.equal(genieChatConfig({...c,genie_chat:{url:'https://example.invalid/v1',gateway_tracking:true}}).gateway_tracking,false);
});
test('chat HTTP response follows fresh gateway state without persisting it or delaying on a stuck core',async t=>{
 let state=snapshot([job()]),reads=0,hang=false;const c=conversation();const jobs={read:async()=>{reads++;if(hang)return new Promise(()=>{});return state;}};const chat={get:()=>structuredClone(c)};
 const server=createDashboard(()=>({}),undefined,null,null,null,jobs,null,null,chat);await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close();});const url=`http://127.0.0.1:${server.address().port}/api/genie/chat/conversation`;
 assert.equal((await(await fetch(url)).json()).messages[0].gateway_execution.state,'queued');state=snapshot([job({state:'running'})]);assert.equal((await(await fetch(url)).json()).messages[0].gateway_execution.state,'running');assert.equal(c.messages[0].gateway_execution,undefined);
 hang=true;const start=Date.now(),results=await Promise.all([fetch(url).then(r=>r.json()),fetch(url).then(r=>r.json())]);assert.ok(Date.now()-start<3000);assert.ok(results.every(r=>r.messages[0].gateway_execution.state==='unavailable'));assert.equal(reads,3,'overlapping polls share one core read');
});
