import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {hermesProvider} from './genie-hermes.mjs';
import {GenieChat} from './genie-chat.mjs';

test('actual Hermes retains a rejected discovery dispatch even when no DSG handler runs',{
  skip:!process.env.DSG_TEST_HERMES_SOURCE||!process.env.DSG_TEST_HERMES_PYTHON,timeout:60000,
},async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'genie-dispatch-'));
  let modelCalls=0,domainCalls=0;
  const server=http.createServer((req,res)=>{
    if(req.method==='GET'){res.end(JSON.stringify({data:[{id:'fixture',context_length:131072}]}));return;}
    let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{
      if(req.url==='/api/genie/power-tools'){domainCalls++;res.end('{}');return;}
      const body=JSON.parse(raw);modelCalls++;
      const message=modelCalls===1?{role:'assistant',content:null,tool_calls:[{
        id:'native-rejected-call',type:'function',function:{name:'tool_call',arguments:JSON.stringify({name:'unknown_PRIVATE_TOOL',arguments:{secret:'PRIVATE_ARGUMENT'}})},
      }]}:{role:'assistant',content:'The requested tool was unavailable.'};
      if(modelCalls===2)assert.ok(body.messages.some(m=>m.role==='tool'),'Native dispatcher returns a real tool-result message');
      if(body.stream){
        res.setHeader('content-type','text/event-stream');
        const delta={...message,...(message.tool_calls?{tool_calls:message.tool_calls.map((v,index)=>({...v,index}))}:{})};
        res.end('data: '+JSON.stringify({id:'fixture',model:'fixture',choices:[{index:0,delta,finish_reason:null}]})+'\n\ndata: '+JSON.stringify({id:'fixture',model:'fixture',choices:[{index:0,delta:{},finish_reason:modelCalls===1?'tool_calls':'stop'}]})+'\n\ndata: [DONE]\n\n');
      }else res.end(JSON.stringify({id:'fixture',model:'fixture',choices:[{message,finish_reason:modelCalls===1?'tool_calls':'stop'}]}));
    });
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const origin='http://127.0.0.1:'+server.address().port;
  const provider=hermesProvider({python:process.env.DSG_TEST_HERMES_PYTHON,source:process.env.DSG_TEST_HERMES_SOURCE,
    url:origin+'/v1',model:'fixture',power:{url:origin+'/api/genie/power-tools',token:'PRIVATE_CREDENTIAL'}},{directory});
  t.after(()=>{provider.close();server.closeAllConnections();server.close();fs.rmSync(directory,{recursive:true,force:true});});
  const chat=new GenieChat({directory:path.join(directory,'chats'),provider}),conversation=chat.create();
  chat.submit(conversation.id,'Inspect the fixture.','dispatch-evidence-fixture');await chat.idle();
  const reply=chat.get(conversation.id).messages[1];
  assert.equal(reply.state,'complete',JSON.stringify(reply));assert.equal(domainCalls,0);
  assert.equal(reply.power?.events?.length??0,0);
  assert.equal(reply.dispatch.available,true);assert.equal(reply.dispatch.calls.length,1);
  const call=reply.dispatch.calls[0];
  assert.equal(call.tool,'tool_call');assert.equal(call.target,'unrecognized');assert.equal(call.state,'error');
  assert.match(call.call_id_sha256,/^[a-f0-9]{64}$/);assert.match(call.result_sha256,/^[a-f0-9]{64}$/);assert.ok(call.result_bytes>0);
  assert.doesNotMatch(JSON.stringify(reply.dispatch),/PRIVATE_|unknown_PRIVATE_TOOL/);
  const reopened=new GenieChat({directory:chat.directory,provider:null});
  assert.deepEqual(reopened.get(conversation.id).messages[1].dispatch,reply.dispatch);
});
