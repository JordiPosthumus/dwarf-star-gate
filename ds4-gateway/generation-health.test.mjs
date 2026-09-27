import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {verifyGeneration} from './generation-health.mjs';

test('recovery lets a reasoning model finish before judging its visible answer',async t=>{
  const server=http.createServer((req,res)=>{
    let raw='';req.on('data',chunk=>raw+=chunk);req.on('end',()=>{
      const body=JSON.parse(raw);
      // This model needs 96 reasoning tokens; a 32-token budget never reaches its answer.
      const truncated=body.max_tokens!==undefined&&body.max_tokens<100;
      const changedThinking=body.chat_template_kwargs?.enable_thinking===false||body.thinking?.type==='disabled'||body.reasoning_effort==='none';
      res.setHeader('content-type','application/json');
      res.end(JSON.stringify({choices:[{finish_reason:truncated?'length':'stop',message:{reasoning_content:'Internal reasoning',content:truncated||changedThinking?'':'DSG_RECOVERY_OK'}}]}));
    });
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>{server.closeAllConnections();server.close();});
  const url=`http://127.0.0.1:${server.address().port}/v1`;
  const result=await verifyGeneration(url,'reasoning-model',{worker:{url,backend:'openai'},timeoutMs:5000});
  assert.equal(result.check,'generation_exact_marker');
});

test('failed generation and the configured deadline still prevent readmission',async t=>{
  const server=http.createServer((req,res)=>{
    if(req.headers['x-wait'])return;
    res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'Incorrect response'}}]}));
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>{server.closeAllConnections();server.close();});
  const url=`http://127.0.0.1:${server.address().port}/v1`;
  await assert.rejects(verifyGeneration(url,'model',{timeoutMs:5000}),/did not pass/);
  server.removeAllListeners('request');server.on('request',()=>{});
  await assert.rejects(verifyGeneration(url,'model',{timeoutMs:20}),/timed out/);
});
