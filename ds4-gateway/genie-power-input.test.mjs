import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {hermesProvider} from './genie-hermes.mjs';

test('installed Hermes receives actionable local validation and corrects an exact receipt read without replaying a fleet action',{
 skip:!process.env.DSG_TEST_HERMES_SOURCE||!process.env.DSG_TEST_HERMES_PYTHON,timeout:60000,
},async t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'genie-power-input-'));
 const actionId='8b3f6d2c-5a41-4f9e-8c7d-6e5f1a2b3c4d';let modelCalls=0;const endpointCalls=[],events=[];
 const server=http.createServer((req,res)=>{if(req.method==='GET'){res.end(JSON.stringify({data:[{id:'fixture',context_length:131072}]}));return;}
 let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{
  const body=JSON.parse(raw);
  if(req.url==='/api/genie/power-tools'){endpointCalls.push(body);assert.deepEqual(body,{action:'status',action_id:actionId});res.end(JSON.stringify({action_id:actionId,state:'complete',receipt:{ok:false,state:'complete'}}));return;}
  modelCalls++;let message;
  if(modelCalls<=2){
   if(modelCalls===2){const result=JSON.parse(body.messages.filter(m=>m.role==='tool').at(-1).content);assert.equal(result.code,'invalid_arguments');assert.equal(result.no_request_sent,true);assert.match(result.error,/omit worker/);assert.equal(endpointCalls.length,0);}
   message={role:'assistant',content:null,tool_calls:[{id:'read-'+modelCalls,type:'function',function:{name:'tool_call',arguments:JSON.stringify({name:'fleet_power_status',arguments:{action_id:actionId,...(modelCalls===1?{worker:'glm53f-sparks34'}:{})}})}}]};
  }else{const result=JSON.parse(body.messages.filter(m=>m.role==='tool').at(-1).content);assert.equal(result.receipt.ok,false);message={role:'assistant',content:'The retained operation failed; no new fleet action was issued.'};}
  if(body.stream){res.setHeader('content-type','text/event-stream');res.end('data: '+JSON.stringify({id:'fixture',model:'fixture',choices:[{index:0,delta:{...message,...(message.tool_calls?{tool_calls:message.tool_calls.map((v,index)=>({...v,index}))}:{})},finish_reason:null}]})+'\n\ndata: '+JSON.stringify({id:'fixture',model:'fixture',choices:[{index:0,delta:{},finish_reason:message.tool_calls?'tool_calls':'stop'}]})+'\n\ndata: [DONE]\n\n');}
  else res.end(JSON.stringify({id:'fixture',model:'fixture',choices:[{message,finish_reason:message.tool_calls?'tool_calls':'stop'}]}));
 });});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const origin='http://127.0.0.1:'+server.address().port;
 const provider=hermesProvider({python:process.env.DSG_TEST_HERMES_PYTHON,source:process.env.DSG_TEST_HERMES_SOURCE,url:origin+'/v1',model:'fixture',power:{url:origin+'/api/genie/power-tools',token:'fixture-private-token'}},{directory});
 t.after(()=>{provider.close();server.closeAllConnections();server.close();fs.rmSync(directory,{recursive:true,force:true});});
 const answer=await provider.generate({sessionId:crypto.randomUUID(),message:'Read the existing recovery receipt.',history:[],context:{servers:[]},onDelta:()=>{},onPower:event=>events.push(event)});
 assert.equal(modelCalls,3);assert.equal(endpointCalls.length,1);assert.match(answer.text,/no new fleet action/);
 assert.equal(events[1].error_code,'invalid_arguments');assert.equal(events[1].no_request_sent,true);
 assert.equal(events.at(-1).state,'complete');assert.equal(events.at(-1).result.receipt.ok,false);
});
