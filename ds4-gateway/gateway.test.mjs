import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { AffinityStore, createGateway, UsageObserver } from './gateway.mjs';
import { requestedThinking, RequestedThinkingObserver, THINKING_CAPTURE_BYTES, safeRequestedThinking } from './requested-thinking.mjs';
import { workerControl } from './worker-client.mjs';
import { runDashboard } from './dashboard.mjs';
import { GenerationFaultObserver } from './generation-health.mjs';

async function until(fn, timeout = 3000) {
  const end = Date.now() + timeout;
  while (!fn()) { if (Date.now() > end) throw new Error('Condition timed out'); await delay(10); }
}
async function backend(id) {
  const b = { id, records: [], active: 0, peak: 0, aborts: 0, health: true, receivedBytes: 0, context_length:153600 };
  b.server = http.createServer((req, res) => {
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: b.health ? 'deepseek-v4-flash' : 'wrong-model', context_length: b.context_length, top_provider:{context_length:b.context_length,max_completion_tokens:b.context_length} }] }));
    const chunks = [];
    req.on('data', c => { chunks.push(c); b.receivedBytes += c.length; });
    req.on('end', () => {
      const body = Buffer.concat(chunks); const p = JSON.parse(body.toString());
      b.records.push({ body, headers: req.headers, payload: p }); b.active++; b.peak = Math.max(b.peak, b.active);
      let ended = false;
      res.on('close', () => { b.active--; if (!ended) b.aborts++; });
      if(p.messages?.[0]?.content==='Reply with exactly DSG_RECOVERY_OK and nothing else.') {
        res.setHeader('content-type','application/json');
        const timer=setTimeout(()=>{ended=true;res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:b.recoveryFails?'NO':'DSG_RECOVERY_OK'}}]}));},b.recoveryDelay??0);
        res.once('close',()=>clearTimeout(timer));return;
      }
      if(p.fatal_error) {
        const finish=()=>{ended=true;res.end(JSON.stringify({error:{message:'cuda prefill state reset failed',type:'invalid_request_error'}}));};
        res.writeHead(500,{'content-type':'application/json'});setTimeout(finish,p.delay??0);return;
      }
      if(p.fatal_sse) {ended=true;res.writeHead(200,{'content-type':'text/event-stream'});res.end('event: error\ndata: {"error":{"message":"cuda resumed prefill failed while extending checkpoint","type":"server_error"}}\n\ndata: [DONE]\n\n');return;}
      if(p.client_error) {ended=true;res.writeHead(400);res.end('invalid request');return;}
      if(typeof p.fixture_sse==='string') {ended=true;res.writeHead(200,{'content-type':'text/event-stream'});res.end(p.fixture_sse);return;}
      if (p.http_error) { ended = true; res.writeHead(503); res.end('backend-error'); return; }
      if (p.disconnect) { res.destroy(); return; }
      if (p.large_stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        let remaining = 128;
        const send = () => {
          while (remaining > 0) { remaining--; if (!res.write('data: ' + 'x'.repeat(32768) + '\n\n')) { res.once('drain', send); return; } }
          ended = true; res.end('data: [DONE]\n\n');
        }; send(); return;
      }
      if (p.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"reasoning_content":"thinking"}}]}\n\n');
        const timer = setTimeout(() => {
          if (res.destroyed) return;
          ended = true;
          res.end('data: {"choices":[{"delta":{"content":"OK"}}],"usage":{"prompt_tokens":9000,"completion_tokens":2,"prompt_tokens_details":{"cached_tokens":8192}}}\n\ndata: [DONE]\n\n');
        }, p.delay ?? 10);
        res.on('close', () => clearTimeout(timer));
      } else {
        setTimeout(() => { if (!res.destroyed) { ended = true; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ node: id, body: body.toString() })); } }, p.delay ?? 0);
      }
    });
  });
  await new Promise(r => b.server.listen(0, '127.0.0.1', r));
  b.url = `http://127.0.0.1:${b.server.address().port}`;
  b.close = async () => { b.server.closeAllConnections(); await new Promise(r => b.server.close(r)); };
  return b;
}
async function rig(t, count = 2, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds4-gateway-test-'));
  const backends = await Promise.all(Array.from({ length: count }, (_, i) => backend(`spark${i + 1}`)));
  const config = { host: '127.0.0.1', port: 0, api_key: 'none', model: 'deepseek-v4-flash', context_length: 153600,
    state_file: path.join(dir, 'affinity.json'), health_interval_ms: 100000, nodes: backends.map(b => ({ id: b.id, url: b.url })), ...overrides };
  if (config.control_socket === true) config.control_socket = path.join(dir, 'control.sock');
  const r = { config, backends, gateway: createGateway(config) };
  r.address = await r.gateway.start();
  r.request = (body = '{}', key, options = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: r.address.port, path: options.path ?? '/v1/chat/completions', method: options.method ?? 'POST', agent: false,
      headers: { authorization: 'Bearer none', 'content-type': 'application/json', ...(key ? { 'x-session-affinity': key } : {}), ...options.headers } }, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('error', reject); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject); req.end(body);
  });
  r.restart = async (extraNodes = []) => {
    await r.gateway.close(); r.config.nodes.push(...extraNodes);
    r.gateway = createGateway(r.config); r.address = await r.gateway.start();
  };
  t.after(async () => { await r.gateway.close(); await Promise.all(backends.map(b => b.close())); });
  return r;
}

test('usage observer skips an entire oversized SSE line, including a DONE-shaped suffix',()=>{
  const o=new UsageObserver();
  o.accept(Buffer.from('data: '+ 'x'.repeat(1048577)));
  o.accept(Buffer.from('data: [DONE]\n'));
  assert.equal(o.done,false,'a suffix inside the discarded line is not a separate SSE event');
  assert.ok(o.pending.length<=1048576);
  o.accept(Buffer.from('data: {"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":3}}\n\ndata: [DONE]\n\n'));
  assert.equal(o.done,true);assert.equal(o.usage.prompt_tokens,12);assert.equal(o.finish_reason,'stop');
});

test('unavailable embedding encoder cannot change inference bytes, thinking, model limits or success',async t=>{
  const r=await rig(t,1,{dataset_enabled:true,embeddings:{enabled:true,python:'/does-not-exist/dsg-python',model_dir:'/does-not-exist/encoder'}});
  const body=JSON.stringify({model:'deepseek-v4-flash',messages:[{role:'user',content:'PRIVATE_EMBED_TEST'}],reasoning_effort:'xhigh',max_tokens:131072,stream:true});
  const result=await r.request(body,'embed-missing');
  assert.equal(result.status,200);assert.ok(result.body.includes('[DONE]'));
  assert.equal(r.backends[0].records[0].body.toString(),body);
  await until(()=>r.gateway.stats().dataset.embedding_collection.failed===1);
  assert.equal(r.gateway.stats().workers[0].quarantine,null);assert.equal(r.gateway.stats().context_length,153600);
  await until(()=>r.gateway.stats().dataset.finished===1);
  const files=fs.readdirSync(path.join(path.dirname(r.config.state_file),'training'));
  const lines=files.map(f=>fs.readFileSync(path.join(path.dirname(r.config.state_file),'training',f),'utf8')).join('');
  assert.ok(!lines.includes('PRIVATE_EMBED_TEST'));
});

test('30-second progress is correlated to active work and its timer is cleared on completion',async t=>{
  const r=await rig(t,1,{dataset_enabled:true});
  const request=r.request(JSON.stringify({stream:true,delay:31000}),'progress-fixture');
  const read=()=>{
    const directory=path.join(path.dirname(r.config.state_file),'training');
    return fs.existsSync(directory)?fs.readdirSync(directory).flatMap(f=>fs.readFileSync(path.join(directory,f),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)):[];
  };
  await until(()=>read().filter(row=>row.kind==='progress').length>=2,32000);
  const progress=read().filter(row=>row.kind==='progress');
  assert.equal(progress[1].request_id,progress[0].request_id);assert.equal(progress[1].run_id,progress[0].run_id);
  assert.equal(progress[1].phase,'thinking');assert.equal(progress[1].semantic_characters,8);
  assert.ok(progress[1].active_elapsed_ms>=29000);assert.ok(progress[1].semantic_age_ms>=29000);
  assert.equal((await request).status,200);await until(()=>r.gateway.stats().dataset.finished===1);
  assert.equal(read().filter(row=>row.kind==='progress').length,2);
  // Gateway teardown completes instead of retaining an active progress callback.
});

test('opt-in prepared real encoder joins vectors to the forwarded request without persisting text',
  {skip:!process.env.DSG_TEST_ENCODER_PYTHON||!process.env.DSG_TEST_ENCODER_BUNDLE},async t=>{
  const r=await rig(t,1,{dataset_enabled:true,embeddings:{enabled:true,python:process.env.DSG_TEST_ENCODER_PYTHON,model_dir:process.env.DSG_TEST_ENCODER_BUNDLE}});
  await until(()=>r.gateway.stats().dataset.embedding_collection.ready,20000);
  const body=JSON.stringify({messages:[{role:'system',content:'PRIVATE_SYSTEM_FIXTURE'},{role:'user',content:'Previous fixture question'},{role:'assistant',content:'Previous fixture response'},{role:'user',content:'PRIVATE_LATEST_FIXTURE'}],reasoning_effort:'xhigh',stream:true});
  const result=await r.request(body,'embed-real');assert.equal(result.status,200);assert.ok(result.body.includes('[DONE]'));
  assert.equal(r.backends[0].records[0].body.toString(),body);
  await until(()=>r.gateway.stats().dataset.embedding_collection.completed===1,20000);
  await until(()=>r.gateway.stats().dataset.written>=6);
  const directory=path.join(path.dirname(r.config.state_file),'training');
  const text=fs.readdirSync(directory).map(f=>fs.readFileSync(path.join(directory,f),'utf8')).join('');
  assert.ok(!text.includes('PRIVATE_'));assert.ok(!text.includes('Previous fixture'));
  const rows=text.trim().split('\n').map(JSON.parse),embedding=rows.find(r=>r.kind==='embedding'),dispatch=rows.find(r=>r.kind==='dispatch');
  assert.equal(embedding.request_id,dispatch.request_id);assert.equal(embedding.run_id,dispatch.run_id);assert.equal(embedding.node,dispatch.node);
  for(const v of Object.values(embedding.vectors)){assert.equal(v.vector.length,384);assert.ok(Math.abs(Math.hypot(...v.vector)-1)<.001);}
  assert.ok(embedding.available_at>=Date.parse(dispatch.time));assert.ok(embedding.available_at>=embedding.queued_at);
});

test('removed quarantined worker can register paused without bypassing verified recovery',async t=>{
  const r=await rig(t,1,{control_socket:true});
  await r.request('{"fatal_error":true}','a');
  await workerControl(r.config.control_socket,'/drain-workers',{workers:['spark1']});
  await workerControl(r.config.control_socket,'/remove-worker',{id:'spark1'});
  await r.restart();
  r.backends[0].health=false;
  await assert.rejects(workerControl(r.config.control_socket,'/add-worker',{worker:{id:'spark1',url:r.backends[0].url}}),/Compatibility check failed/);
  r.backends[0].health=true;
  await workerControl(r.config.control_socket,'/add-worker',{worker:{id:'spark1',url:r.backends[0].url}});
  assert.equal(r.gateway.stats().workers[0].drained,true);
  assert.ok(r.gateway.stats().workers[0].quarantine);assert.equal(r.gateway.stats().available,0);
  r.backends[0].recoveryFails=true;
  await assert.rejects(workerControl(r.config.control_socket,'/resume-workers',{workers:['spark1']}),/generation did not pass/);
  assert.ok(r.gateway.stats().workers[0].quarantine);
  r.backends[0].recoveryFails=false;
  await workerControl(r.config.control_socket,'/resume-workers',{workers:['spark1']});
  assert.equal(r.gateway.stats().available,1);assert.equal(r.gateway.stats().workers[0].quarantine,null);
});

test('usage observation bounds huge single chunks, preserves split UTF-8 and only records numeric counts',()=>{
  const o=new UsageObserver();o.accept(Buffer.from('data: '+ 'x'.repeat(3*1048576)+'\n'));
  assert.equal(o.pending,'');assert.equal(o.done,false);
  const row=Buffer.from('data:{"choices":[{"delta":{"content":"星"},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":42,"completion_tokens":"PRIVATE_VALUE","prompt_tokens_details":{"cached_tokens":-1}}}\r\n');
  for(let i=0;i<row.length;i++)o.accept(row.subarray(i,i+1));
  assert.equal(o.usage.prompt_tokens,42);assert.equal(o.usage.completion_tokens,undefined);assert.equal(o.usage.cached_tokens,undefined);
  assert.equal(o.finish_reason,'tool_calls');assert.ok(!JSON.stringify(o).includes('PRIVATE_VALUE'));
});

test('worker control uses fresh connections across immediate gateway restarts',async t=>{
  const r=await rig(t,1,{control_socket:true});
  for(let i=0;i<3;i++) {
    await workerControl(r.config.control_socket,'/drain-workers',{workers:['spark1']});
    await r.restart();
    await workerControl(r.config.control_socket,'/resume-workers',{workers:['spark1']});
    assert.equal(r.gateway.stats().available,1);
  }
});

test('legacy recovery CLI waits beyond its former five-second timeout',async t=>{
  const r=await rig(t,1,{control_socket:true});await r.request('{"fatal_error":true}','a');
  r.backends[0].recoveryDelay=5200;
  const configPath=path.join(path.dirname(r.config.state_file),'fixture-config.json');
  fs.writeFileSync(configPath,JSON.stringify(r.config));
  const {stdout}=await promisify(execFile)(process.execPath,[fileURLToPath(new URL('./control.mjs',import.meta.url)),'resume-worker','spark1'],
    {env:{...process.env,DWARF_GATE_CONFIG:configPath},timeout:12000});
  assert.equal(JSON.parse(stdout).available,1);assert.equal(r.gateway.stats().workers[0].quarantine,null);
});

test('Messages and Responses completion events do not quarantine healthy workers',async t=>{
  const r=await rig(t,1,{dataset_enabled:true});
  const cases=[
    ['/v1/messages','event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n'],
    ['/v1/responses','data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":20,"output_tokens":3,"input_tokens_details":{"cached_tokens":12}}}}\n\n']
  ];
  for(const [path,stream] of cases)for(let i=0;i<3;i++) {
    const result=await r.request(JSON.stringify({fixture_sse:stream}),'a',{path});
    assert.equal(result.status,200);assert.equal(result.body,stream);
    assert.equal(r.gateway.stats().workers[0].inference_failures,0);
    assert.equal(r.gateway.stats().workers[0].quarantine,null);
  }
  assert.equal(r.gateway.stats().workers[0].completed,6);
});

test('Responses output limits are censored, but explicit failed responses count as failures',async t=>{
  const r=await rig(t,1,{dataset_enabled:true});
  const limited='data: {"type":"response.incomplete","response":{"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"}}}\n\n';
  for(let i=0;i<3;i++)await r.request(JSON.stringify({fixture_sse:limited}),'a',{path:'/v1/responses'});
  await until(()=>r.gateway.stats().dataset.finished===3);
  assert.equal(r.gateway.stats().dataset.truncated,3);assert.equal(r.gateway.stats().workers[0].quarantine,null);
  const failed='data: {"type":"response.failed","response":{"status":"failed","error":{"message":"generation failed"}}}\n\n';
  for(let i=0;i<3;i++)await r.request(JSON.stringify({fixture_sse:failed}),'a',{path:'/v1/responses'});
  assert.equal(r.gateway.stats().workers[0].quarantine.reason,'repeated_inference_failures');
});

test('an oversized unobservable terminal is unknown, not a proven failed or successful generation',async t=>{
  const r=await rig(t,1,{dataset_enabled:true});
  const stream='data: '+JSON.stringify({type:'response.completed',response:{status:'completed',output:'x'.repeat(1048577)}})+'\n\n';
  for(let i=0;i<3;i++) {
    const result=await r.request(JSON.stringify({fixture_sse:stream}),'a',{path:'/v1/responses'});
    assert.equal(result.body,stream);
  }
  await until(()=>r.gateway.stats().dataset.finished===3);
  assert.equal(r.gateway.stats().workers[0].quarantine,null);assert.equal(r.gateway.stats().workers[0].completed,0);
  assert.equal(r.gateway.stats().workers[0].failed,0);assert.equal(r.gateway.stats().workers[0].observation_limited,3);
  assert.equal(r.gateway.stats().dataset.failed_or_cancelled,0);assert.equal(r.gateway.stats().dataset.observation_limited,3);
  const file=fs.readdirSync(path.join(path.dirname(r.config.state_file),'training'))[0];
  const events=fs.readFileSync(path.join(path.dirname(r.config.state_file),'training',file),'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(events.filter(e=>e.kind==='finish').every(e=>e.outcome==='sse_observation_limited'));
});

test('fault observer recognizes split error envelopes but never quoted answers or oversized lines',()=>{
  const raw=Buffer.from('event: error\ndata: {"error":{"message":"cuda resumed prefill failed while extending checkpoint"}}\n\n');
  const o=new GenerationFaultObserver(true);for(let i=0;i<raw.length;i+=3)o.accept(raw.subarray(i,i+3));
  assert.equal(o.finish(),'accelerator_checkpoint_failure');assert.equal(o.pending,'');
  const answer=new GenerationFaultObserver(true);answer.accept(Buffer.from('data: {"choices":[{"delta":{"content":"cuda prefill state reset failed"}}]}\n\n'));assert.equal(answer.finish(),null);
  const big=new GenerationFaultObserver(true);big.accept(Buffer.from('data: '+ 'x'.repeat(200000)+'\n\n'));assert.ok(big.pending.length<=65536);big.accept(raw);assert.equal(big.finish(),'accelerator_checkpoint_failure');
  const json=new GenerationFaultObserver();json.accept(Buffer.from('{"message":"an illegal memory access was encountered","type":"invalid_request_error"}'));assert.equal(json.finish(),'fatal_accelerator_error');
  const response=new GenerationFaultObserver(true);response.accept(Buffer.from('data: {"type":"response.failed","response":{"status":"failed","error":{"message":"cuda prefill state reset failed"}}}\n\n'));
  assert.equal(response.finish(),'accelerator_checkpoint_failure');
});

test('fatal HTTP failure quarantines persistently despite good model probes and reassigns only next request',async t=>{
  const r=await rig(t,2,{health_interval_ms:20,control_socket:true});
  const failed=await r.request('{"fatal_error":true}','failed-session');
  assert.equal(failed.status,500);assert.match(failed.body,/cuda prefill state reset failed/);
  await until(()=>r.gateway.stats().workers[0].quarantine);
  await delay(80);assert.equal(r.gateway.stats().workers[0].is_healthy,false);
  assert.equal(r.backends[0].records.length,1);assert.equal(r.backends[1].records.length,0);
  await r.restart();assert.equal(r.gateway.stats().workers[0].is_healthy,false);
  const retry=await r.request('{}','failed-session');assert.equal(retry.headers['x-ds4-node'],'spark2');assert.equal(retry.headers['x-ds4-affinity'],'reassigned');
  await workerControl(r.config.control_socket,'/set-context-limit',{context_length:153600,expected_context_length:153600});
  assert.equal(r.gateway.stats().workers[0].is_healthy,false);
  assert.equal((await r.request('{}',null,{path:'/resume-workers'})).status,404);
});

test('fatal SSE envelope cannot masquerade as a successful DONE response',async t=>{
  const r=await rig(t,1,{dataset_enabled:true});const result=await r.request('{"fatal_sse":true}','sse-fail');
  assert.equal(result.status,200);assert.match(result.body,/resumed prefill/);assert.match(result.body,/\[DONE\]/);
  assert.equal(r.gateway.stats().workers[0].quarantine.reason,'accelerator_checkpoint_failure');
  await until(()=>r.gateway.stats().dataset.finished===1);assert.equal(r.gateway.stats().dataset.failed_or_cancelled,1);
});

test('quarantine rejects queued unstarted requests without replay and allows their subsequent retry elsewhere',async t=>{
  const r=await rig(t);const first=r.request('{"fatal_error":true,"delay":100}','a');
  await until(()=>r.backends[0].records.length===1);
  const queued=r.request('{}','a');await until(()=>r.gateway.stats().workers[0].queued===1);
  assert.equal((await first).status,500);assert.equal((await queued).status,503);
  assert.equal(r.backends[0].records.length,1);assert.equal(r.backends[1].records.length,0);
  assert.equal((await r.request('{}','a')).headers['x-ds4-node'],'spark2');
});

test('ordinary 4xx does not quarantine; success resets repeated operational failure streak',async t=>{
  const r=await rig(t,1,{health_interval_ms:20});
  for(let i=0;i<4;i++)assert.equal((await r.request('{"client_error":true}','a')).status,400);
  assert.equal(r.gateway.stats().workers[0].quarantine,null);
  await r.request('{"http_error":true}','a');await r.request('{"http_error":true}','a');
  assert.equal(r.gateway.stats().workers[0].quarantine,null);
  await r.request('{}','a');assert.equal(r.gateway.stats().workers[0].inference_failures,0);
  for(let i=0;i<3;i++)await r.request('{"http_error":true}','a');
  assert.equal(r.gateway.stats().workers[0].quarantine.reason,'repeated_inference_failures');
  await delay(80);assert.equal(r.gateway.stats().workers[0].is_healthy,false);
});

test('recovery requires real generation; failed verification retains quarantine and healthy recovery clears it durably',async t=>{
  const r=await rig(t,1,{control_socket:true});await r.request('{"fatal_error":true}','a');
  r.backends[0].recoveryFails=true;
  await assert.rejects(workerControl(r.config.control_socket,'/resume-workers',{workers:['spark1']}),/generation did not pass/);
  assert.ok(r.gateway.stats().workers[0].quarantine);assert.equal(r.gateway.stats().available,0);
  r.backends[0].recoveryFails=false;
  await workerControl(r.config.control_socket,'/resume-workers',{workers:['spark1']});
  assert.equal(r.gateway.stats().available,1);assert.equal(r.gateway.stats().workers[0].quarantine,null);
  await r.restart();assert.equal(r.gateway.stats().workers[0].quarantine,null);
  assert.equal((await r.request('{}','a')).status,200);
});

test('quarantine save failure blocks new admission instead of silently losing the fault',async t=>{
  const r=await rig(t,1);await r.request('{}','known');
  const save=r.gateway.store.save;r.gateway.store.save=()=>{throw new Error('disk full');};
  try {await r.request('{"fatal_error":true}','known');assert.equal(r.gateway.stats().draining,true);assert.equal((await r.request('{}')).status,503);}
  finally {r.gateway.store.save=save;}
});

test('multi-worker recovery does not partially clear quarantine when one verification fails',async t=>{
  const r=await rig(t,2,{control_socket:true});
  await r.request('{"fatal_error":true}','a');await r.request('{"fatal_error":true}','b');
  assert.equal(r.gateway.stats().available,0);r.backends[1].recoveryFails=true;
  await assert.rejects(workerControl(r.config.control_socket,'/resume-workers',{workers:['spark1','spark2']}),/generation did not pass/);
  assert.equal(r.gateway.stats().available,0);assert.ok(r.gateway.stats().workers.every(w=>w.quarantine));
  r.backends[1].recoveryFails=false;await workerControl(r.config.control_socket,'/resume-workers',{workers:['spark1','spark2']});
  assert.equal(r.gateway.stats().available,2);
});

test('collector records decision-time fleet and outcomes without altering body or stream',async t=>{
  const r=await rig(t,2,{dataset_enabled:true});
  const body=JSON.stringify({stream:true,messages:[{role:'user',content:'PRIVATE_UNIQUE_TEXT'}],reasoning_effort:'xhigh'});
  const response=await r.request(body,'collector-test');assert.equal(response.status,200);assert.match(response.body,/\[DONE\]/);
  assert.equal(r.backends[0].records[0].body.toString(),body);
  await until(()=>r.gateway.stats().dataset.finished===1);
  const dir=path.join(path.dirname(r.config.state_file),'training'),file=fs.readdirSync(dir)[0],text=fs.readFileSync(path.join(dir,file),'utf8');
  assert.ok(!text.includes('PRIVATE_UNIQUE_TEXT'));const rows=text.trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows.map(r=>r.kind),['decision','dispatch','progress','finish']);assert.equal(new Set(rows.map(r=>r.request_id)).size,1);
  assert.equal(rows[0].candidates.length,2);assert.equal(rows[0].candidates[0].assigned_sessions,0);assert.equal(rows[0].candidates[0].active,0);
  assert.equal(rows[2].phase,'awaiting_content');assert.equal(rows[2].semantic_age_ms,null);
  assert.equal(rows[3].usage.cached_tokens,8192);assert.equal(rows[3].requested_thinking.fields.reasoning_effort,'xhigh');
  assert.ok(rows[3].first_body_byte_ms>=0);assert.ok(rows[3].total_ms>=rows[3].service_ms);
});

test('shadow collection is opt-in, preserves bytes and affinity, and reassesses on worker completion',async t=>{
  const r=await rig(t,2,{dataset_enabled:true,routing_shadow_enabled:true});
  const first=r.request('{"stream":true,"delay":150}','same-private-session');
  await until(()=>r.backends[0].active===1);
  const body='{"stream":true,"messages":[{"role":"user","content":"PRIVATE_SHADOW_BODY"}],"delay":10}';
  const second=r.request(body,'same-private-session');
  await until(()=>r.gateway.stats().queued===1);
  assert.equal(r.backends[1].records.length,0,'shadow must not dispatch to idle alternative');
  assert.equal(r.gateway.stats().routing_shadow.last.verdict,'handover_blocked');
  await Promise.all([first,second]);await until(()=>r.gateway.stats().dataset.finished===2);
  assert.equal(r.backends[0].records[1].body.toString(),body);assert.equal(r.backends[1].records.length,0);
  const dir=path.join(path.dirname(r.config.state_file),'training');
  const text=fs.readdirSync(dir).map(f=>fs.readFileSync(path.join(dir,f),'utf8')).join('');
  assert.ok(!text.includes('PRIVATE_SHADOW_BODY'));assert.ok(!text.includes('same-private-session'));
  const rows=text.trim().split('\n').map(JSON.parse),shadow=rows.filter(x=>x.kind==='routing_shadow');
  assert.equal(shadow.length,2);assert.ok(shadow.every(x=>x.confidence==='unvalidated'));
  const decision=rows.filter(x=>x.kind==='decision')[1];assert.ok(decision.candidates[0].active_elapsed_ms>=0);
  assert.equal(decision.candidates[0].active_request_id,rows.find(x=>x.kind==='decision').request_id);
  assert.equal(decision.candidates[1].worker_idle_ms,null,'unknown initial history is not zero');
});

test('idle-worker event records shadow reassessment without consuming queued uploads or replay',async t=>{
  const r=await rig(t,2,{dataset_enabled:true,routing_shadow_enabled:true});
  const home=r.request('{"stream":true,"delay":200}','home');await until(()=>r.backends[0].active===1);
  const other=r.request('{"stream":true,"delay":60}','other');await until(()=>r.backends[1].active===1);
  const queued=r.request('{"stream":true,"delay":10}','home');await until(()=>r.gateway.stats().queued===1);
  await other;await until(()=>r.gateway.stats().routing_shadow.last.reason==='worker_free');
  assert.equal(r.gateway.stats().routing_shadow.last.verdict,'handover_blocked');assert.equal(r.backends[1].records.length,1);
  await Promise.all([home,queued]);assert.equal(r.backends[0].records.length,2);
});

test('shadow flag without private collection remains disabled',async t=>{
  const r=await rig(t,1,{routing_shadow_enabled:true});await r.request('{}','off');
  assert.equal(r.gateway.stats().routing_shadow.enabled,false);assert.equal(r.gateway.stats().routing_shadow.evaluations,0);
});

test('requested thinking captures allowlisted controls, never nested prompt text or an assumed default', () => {
  for (const effort of ['none','minimal','low','medium','high','xhigh','max']) {
    assert.deepEqual(requestedThinking({reasoning_effort:effort}), {status:'specified',fields:{reasoning_effort:effort}});
    assert.deepEqual(requestedThinking({reasoning:{effort}}), {status:'specified',fields:{'reasoning.effort':effort}});
    assert.deepEqual(requestedThinking({output_config:{effort}}), {status:'specified',fields:{'output_config.effort':effort}});
  }
  for (const value of [true,false,null]) assert.equal(requestedThinking({thinking:value}).fields.thinking,value);
  assert.deepEqual(requestedThinking({thinking:{type:'adaptive',budget_tokens:100000},reasoning_effort:'max'}),
    {status:'specified',fields:{reasoning_effort:'max','thinking.type':'adaptive','thinking.budget_tokens':100000}});
  assert.deepEqual(requestedThinking({reasoning_effort:null}),{status:'specified',fields:{reasoning_effort:null}});
  assert.deepEqual(requestedThinking({messages:[{content:'PRIVATE',reasoning_effort:'xhigh'}]}),{status:'not_specified'});
  assert.equal(requestedThinking({thinking:{new_field:'PRIVATE'}}).fields.thinking,'unrecognized');
  const bad = requestedThinking({reasoning_effort:'PRIVATE',thinking:{type:'PRIVATE',budget_tokens:'PRIVATE'},enable_thinking:'PRIVATE'});
  assert.ok(!JSON.stringify(bad).includes('PRIVATE'));
  assert.deepEqual(safeRequestedThinking({...bad,prompt:'PRIVATE',fields:{...bad.fields,secret:'PRIVATE'}}),bad);
});

test('request observer handles split UTF-8 and fields after a large prompt; drops raw body after parsing', () => {
  const o = new RequestedThinkingObserver();
  const body = Buffer.from(JSON.stringify({messages:[{content:'星'.repeat(1000)}],reasoning_effort:'xhigh'}));
  for (let i=0;i<body.length;i+=7) o.accept(body.subarray(i,i+7));
  assert.equal(o.result.status,'pending');
  assert.deepEqual(o.finish(),{status:'specified',fields:{reasoning_effort:'xhigh'}});
  assert.equal(o.chunks.length,0); assert.ok(!JSON.stringify(o).includes('星'));
});

test('observation budget has an exact boundary and does not claim omitted fields on overflow or encoding', () => {
  const body = Buffer.from('{"reasoning_effort":"high"}');
  const exact = new RequestedThinkingObserver();
  exact.accept(body); exact.accept(Buffer.alloc(THINKING_CAPTURE_BYTES-body.length,32));
  assert.equal(exact.finish().fields.reasoning_effort,'high');
  const big = new RequestedThinkingObserver(); big.accept(Buffer.alloc(THINKING_CAPTURE_BYTES+1,32));
  assert.deepEqual(big.finish(),{status:'unavailable',reason:'capture_limit'}); assert.equal(big.chunks.length,0);
  const encoded = new RequestedThinkingObserver('gzip'); encoded.accept(body);
  assert.deepEqual(encoded.finish(),{status:'unavailable',reason:'encoded_body'});
  const invalid = new RequestedThinkingObserver(); invalid.accept(Buffer.from('{bad'));
  assert.equal(invalid.finish().reason,'invalid_json');
  assert.equal(requestedThinking([]).reason,'invalid_json');
  const cancelled = new RequestedThinkingObserver(); cancelled.accept(body); cancelled.dispose();
  assert.equal(cancelled.result.reason,'incomplete_body'); assert.equal(cancelled.chunks.length,0);
});

test('per-worker requested thinking follows dispatch, not affinity or queued requests, and resets when idle', async t => {
  const r = await rig(t);
  const first = r.request('{"reasoning_effort":"xhigh","delay":250}', 'a');
  const other = r.request('{"thinking":false,"delay":250}', 'b');
  await until(()=>r.gateway.stats().workers.every(w=>w.requested_thinking?.status==='specified'));
  const queued = r.request('{"reasoning":{"effort":"low"},"delay":150}', 'a');
  await until(()=>r.gateway.stats().queued===1);
  let workers = r.gateway.stats().workers;
  assert.equal(workers[0].requested_thinking.fields.reasoning_effort,'xhigh');
  assert.equal(workers[1].requested_thinking.fields.thinking,false);
  await first;
  await until(()=>r.gateway.stats().workers[0].requested_thinking?.fields?.['reasoning.effort']==='low');
  await Promise.all([queued,other]);
  workers = r.gateway.stats().workers;
  assert.ok(workers.every(w=>w.requested_thinking===null));
  assert.equal(workers[0].last_requested_thinking.fields['reasoning.effort'],'low');
  assert.equal(workers[1].last_requested_thinking.fields.thinking,false);
  await r.request('{}','a');
  assert.deepEqual(r.gateway.stats().workers[0].last_requested_thinking,{status:'not_specified'});
});

test('oversized vision upload is forwarded byte-for-byte; only its thinking observation is unavailable', async t => {
  const r = await rig(t,1);
  const body = JSON.stringify({messages:[{content:[{type:'image_url',image_url:{url:'data:image/png;base64,'+'A'.repeat(THINKING_CAPTURE_BYTES)}}]}],reasoning_effort:'max',max_tokens:153600});
  assert.equal((await r.request(body)).status,200);
  assert.equal(r.backends[0].records[0].body.toString(),body);
  assert.deepEqual(r.gateway.stats().workers[0].last_requested_thinking,{status:'unavailable',reason:'capture_limit'});
});

test('chunked uploads reach the backend before metadata parsing; no buffer-then-forward behavior', async t => {
  const r = await rig(t,1);
  let req;
  const response = new Promise((resolve,reject)=>{
    req = http.request({host:'127.0.0.1',port:r.address.port,path:'/v1/chat/completions',method:'POST',headers:{authorization:'Bearer none','content-type':'application/json'}},res=>{
      res.resume();res.on('end',resolve);res.on('error',reject);
    }); req.on('error',reject);
  });
  const first = '{ "messages":[{"content":"PRIVATE"}],';
  req.write(first);
  await until(()=>r.backends[0].receivedBytes===Buffer.byteLength(first));
  assert.equal(r.gateway.stats().workers[0].requested_thinking.status,'pending');
  const last = ' "reasoning_effort":"xhigh" }'; req.end(last); await response;
  assert.equal(r.backends[0].records[0].body.toString(),first+last);
  assert.equal(r.gateway.stats().workers[0].last_requested_thinking.fields.reasoning_effort,'xhigh');
  assert.ok(!JSON.stringify(r.gateway.stats()).includes('PRIVATE'));
});

test('hot registration admits larger-context machines paused, preserves pool metadata and persists removal', async t => {
  const r=await rig(t,2,{control_socket:true});
  const m=await backend('m3-studio');m.context_length=300000;r.backends.push(m);
  const ctl=(route,body)=>workerControl(r.config.control_socket,route,body);
  const original=r.gateway.server;
  const added=await ctl('/add-worker',{worker:{id:'m3-studio',url:m.url+'/v1'}});
  assert.equal(added.workers.length,3);assert.equal(added.workers[2].drained,true);assert.equal(added.workers[2].context_length,300000);
  assert.equal(added.workers[2].telemetry_service,null);assert.equal(r.gateway.server,original);
  assert.notEqual((await r.request('{}','before-enable')).headers['x-ds4-node'],'m3-studio');
  await ctl('/resume-workers',{workers:['m3-studio']});
  await ctl('/drain-workers',{workers:['spark1','spark2']});
  const model=JSON.parse((await r.request('',null,{method:'GET',path:'/v1/models'})).body).data[0];
  assert.equal(model.context_length,153600);assert.equal(model.top_provider.max_completion_tokens,153600);
  assert.equal(m.context_length,300000);
  const body='{ "reasoning_effort":"xhigh", "max_tokens":153600, "messages":[{"content":"UNCHANGED"}] }';
  assert.equal((await r.request(body,'mac-session')).headers['x-ds4-node'],'m3-studio');
  assert.equal(m.records[0].body.toString(),body);
  await ctl('/remove-worker',{id:'spark2'});await r.restart();
  assert.deepEqual(r.gateway.nodes.map(n=>n.id),['spark1','m3-studio']);
  assert.equal((await r.request('{}','mac-session')).headers['x-ds4-node'],'m3-studio');
});

test('health refreshes native context without changing the pool guarantee; explicit restart raises it', async t => {
  const r=await rig(t,2,{health_interval_ms:25,health_failures:2});
  const metadata=async()=>JSON.parse((await r.request('',null,{method:'GET',path:'/v1/models'})).body).data[0];
  r.backends[0].context_length=262144;
  await until(()=>r.gateway.stats().workers[0].context_length===262144);
  assert.equal(r.gateway.stats().context_length,153600);
  assert.equal((await metadata()).context_length,153600);
  r.backends[1].context_length=300000;
  await until(()=>r.gateway.stats().workers[1].context_length===300000);
  assert.equal((await metadata()).top_provider.max_completion_tokens,153600);
  // A new config object represents an edited deployment config read at restart.
  await r.gateway.close();
  r.config={...r.config,context_length:262144};
  r.gateway=createGateway(r.config);r.address=await r.gateway.start();
  assert.equal(r.gateway.stats().healthy,2);
  assert.equal((await metadata()).context_length,262144);
  assert.equal((await metadata()).top_provider.max_completion_tokens,262144);
  const body='{"messages":[{"role":"user","content":"unchanged"}],"max_tokens":262144,"reasoning_effort":"xhigh"}';
  assert.equal((await r.request(body,'context-upgrade')).status,200);
  assert.equal(r.backends[0].records.at(-1).body.toString(),body);
  r.backends[0].context_length=153600;
  await until(()=>!r.gateway.stats().workers[0].is_healthy);
  assert.equal(r.gateway.stats().workers[0].probe_error,'model_or_context_mismatch');
  assert.equal((await metadata()).context_length,262144);
  assert.equal((await r.request('{}','new-after-downgrade')).headers['x-ds4-node'],'spark2');
});

test('operator context setting is validated, durable, backed up, and does not interrupt streams', async t => {
  const r=await rig(t,2,{control_socket:true});
  const ctl=(route,input)=>workerControl(r.config.control_socket,route,input);
  const set=value=>ctl('/set-context-limit',{context_length:value,expected_context_length:r.gateway.stats().context_length});
  for(const context_length of [0,-1,2.5,'262144',null,Number.MAX_SAFE_INTEGER+1])
    await assert.rejects(set(context_length),/positive whole/);
  await assert.rejects(set(262144),/Enabled servers/);
  assert.equal(r.gateway.stats().context_length,153600);
  r.backends.forEach(b=>{b.context_length=262144;});
  const stream=r.request('{"stream":true,"delay":200}','context-live');
  await until(()=>r.backends[0].active===1);
  const previousSessions=structuredClone(r.gateway.store.data.sessions);
  const result=await set(262144);
  assert.equal(result.minimum_context,262144);assert.equal(result.context_limit_source,'saved');
  assert.deepEqual(r.gateway.store.data.sessions,previousSessions);
  assert.match((await stream).body,/\[DONE\]/);assert.equal(r.backends[0].aborts,0);
  assert.ok(fs.readdirSync(path.dirname(r.config.state_file)).some(f=>f.includes('.context-')&&f.endsWith('.bak')));
  await assert.rejects(ctl('/set-context-limit',{context_length:128000,expected_context_length:153600}),/changed/);
  await r.restart();assert.equal(r.gateway.stats().context_length,262144);
  assert.equal(r.config.context_length,153600); // Startup fallback was not secretly edited.
  // A deliberately lower limit can recover a matching model below the old limit.
  r.backends[1].context_length=153600;
  await set(153600);assert.equal(r.gateway.stats().healthy,2);
  // Paused smaller workers cannot slip through a resume after an increase.
  await ctl('/drain-workers',{workers:['spark2']});
  await set(262144);assert.equal(r.gateway.stats().workers[1].is_healthy,false);
  await assert.rejects(ctl('/resume-workers',{workers:['spark2']}),/fresh compatible/);
  r.backends[1].context_length=262144;
  await ctl('/resume-workers',{workers:['spark2']});
  assert.equal(r.gateway.stats().workers[1].drained,false);
  // A failed durable save must not advertise the proposed value.
  const save=r.gateway.store.save;
  r.gateway.store.save=()=>{throw new Error('simulated storage failure');};
  await assert.rejects(set(200000),/storage failure/);
  assert.equal(r.gateway.stats().context_length,262144);
  r.gateway.store.save=save;
  assert.equal((await r.request('{}',null,{path:'/set-context-limit'})).status,404);
});

test('saved context values fail closed on corruption and unsupported models cannot authorize a change', async t => {
  const r=await rig(t,1,{control_socket:true});
  r.backends[0].health=false;
  await assert.rejects(workerControl(r.config.control_socket,'/set-context-limit',{context_length:100000,expected_context_length:153600}),/Enabled servers/);
  assert.equal(r.gateway.stats().context_length,153600);
  r.gateway.store.setDrained(['spark1'],true);
  await r.gateway.close();
  const data=JSON.parse(fs.readFileSync(r.config.state_file,'utf8'));
  fs.writeFileSync(r.config.state_file,JSON.stringify({...data,pool_context_length:'invalid'}));
  assert.throws(()=>createGateway(r.config),/Invalid saved pool context/);
});

test('failed compatibility checks and duplicate registrations cannot mutate membership', async t => {
  const r=await rig(t,1,{control_socket:true});
  const m=await backend('candidate');r.backends.push(m);m.context_length=128000;
  const ctl=(route,body)=>workerControl(r.config.control_socket,route,body), before=JSON.stringify(r.gateway.store.data);
  await assert.rejects(ctl('/add-worker',{worker:{id:'candidate',url:m.url}}),/Compatibility check failed/);
  assert.equal(JSON.stringify(r.gateway.store.data),before);
  m.context_length=300000;m.health=false;
  await assert.rejects(ctl('/add-worker',{worker:{id:'candidate',url:m.url}}),/Compatibility check failed/);
  m.health=true;
  const outcomes=await Promise.allSettled([ctl('/add-worker',{worker:{id:'candidate',url:m.url}}),ctl('/add-worker',{worker:{id:'candidate',url:m.url}})]);
  assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);assert.equal(r.gateway.nodes.length,2);
  await assert.rejects(ctl('/add-worker',{worker:{id:'other',url:m.url}}),/endpoint already registered/);
  for(const worker of [{id:'bad',url:'http://example.test:8000'},{id:'bad',url:'http://127.0.0.1:39999',ssh:'-oProxyCommand=bad'},{id:'bad',url:'http://127.0.0.1:39999',ssh:'host',remote_port:0},{id:'bad',url:m.url,command:'DO_NOT_RUN'}])
    await assert.rejects(ctl('/add-worker',{worker}));
  assert.equal(r.gateway.nodes.length,2);
});

test('hot removal requires paused and fully idle; existing conversation reassigns only on its next request', async t => {
  const r=await rig(t,2,{control_socket:true}), ctl=(route,body)=>workerControl(r.config.control_socket,route,body);
  const first=r.request('{"delay":250}','home');await until(()=>r.gateway.stats().active===1);
  const second=r.request('{"delay":100}','home');await until(()=>r.gateway.stats().queued===1);
  await assert.rejects(ctl('/remove-worker',{id:'spark1'}),/Drain this worker/);
  await ctl('/drain-workers',{workers:['spark1']});
  await assert.rejects(ctl('/remove-worker',{id:'spark1'}),/Drain this worker/);
  await Promise.all([first,second]);await ctl('/remove-worker',{id:'spark1'});
  assert.equal(r.backends[0].records.length,2);assert.equal(r.backends[0].server.listening,true);
  assert.equal((await r.request('{}','home')).headers['x-ds4-node'],'spark2');
  assert.equal((await r.request('{}',null,{path:'/add-worker'})).status,404);
  assert.equal((await r.request('{}',null,{path:'/remove-worker'})).status,404);
});

test('enabled dashboard controls operate through the real Unix control client without changing model servers', async t => {
  const r=await rig(t,1,{control_socket:true,ui_worker_management:true});
  const candidate=await backend('studio');candidate.context_length=300000;r.backends.push(candidate);
  const configPath=path.join(path.dirname(r.config.state_file),'dashboard-config.json');
  fs.writeFileSync(configPath,JSON.stringify({...r.config,port:r.address.port}));
  const dashboard=await runDashboard(configPath,0);t.after(()=>dashboard.close());
  const url=`http://127.0.0.1:${dashboard.server.address().port}`;
  const session=await (await fetch(`${url}/api/workers`)).json();assert.equal(session.enabled,true);
  const act=async(action,body)=>{
    const response=await fetch(`${url}/api/workers/${action}`,{method:'POST',headers:{origin:url,'content-type':'application/json','x-dsg-csrf':session.csrf_token},body:JSON.stringify(body)});
    assert.equal(response.status,200);return response.json();
  };
  await act('add',{worker:{id:'studio',url:candidate.url}});
  assert.equal(r.gateway.nodes[1].drained,true);assert.equal(candidate.records.length,0);
  await act('resume',{workers:['studio']});assert.equal(r.gateway.stats().available,2);
  await act('drain',{workers:['studio']});await act('remove',{id:'studio'});
  assert.equal(r.gateway.stats().total,1);assert.equal(candidate.server.listening,true);
  assert.equal(candidate.records.length,0);assert.equal(candidate.context_length,300000);
});

test('an empty dynamic registry survives restart and can accept a worker again', async t => {
  const r=await rig(t,1,{control_socket:true}), ctl=(route,body)=>workerControl(r.config.control_socket,route,body);
  await ctl('/drain-workers',{workers:['spark1']});await ctl('/remove-worker',{id:'spark1'});await r.restart();
  assert.equal(r.gateway.stats().total,0);assert.equal((await r.request('{}')).status,503);
  await ctl('/add-worker',{worker:{id:'spark1',url:r.backends[0].url}});await ctl('/resume-workers',{workers:['spark1']});
  assert.equal((await r.request('{}')).status,200);
});

test('health probes have a total deadline even if a worker trickles response bytes', async t => {
  const r=await rig(t,1,{health_interval_ms:30,health_timeout_ms:80,health_failures:1});
  const b=r.backends[0];b.server.removeAllListeners('request');let calls=0;
  b.server.on('request',(_req,res)=>{calls++;res.writeHead(200);res.write('{');const timer=setInterval(()=>res.write(' '),10);res.on('close',()=>clearInterval(timer));});
  await until(()=>!r.gateway.nodes[0].healthy);
  await until(()=>calls>=3);
  assert.equal(r.gateway.nodes[0].healthy,false);
});

test('new sessions spread; existing sessions stay; restart keeps assignments', async t => {
  const r = await rig(t);
  const a = await r.request('{}', 'a'), b = await r.request('{}', 'b');
  assert.notEqual(a.headers['x-ds4-node'], b.headers['x-ds4-node']);
  assert.equal((await r.request('{}', 'a')).headers['x-ds4-node'], a.headers['x-ds4-node']);
  await r.restart();
  assert.equal((await r.request('{}', 'a')).headers['x-ds4-node'], a.headers['x-ds4-node']);
  assert.equal((await r.request('{}', 'b')).headers['x-ds4-node'], b.headers['x-ds4-node']);
});
test('six workers configurable: all used, adding workers does not remap sessions', async t => {
  const r = await rig(t, 6);
  const mappings = [];
  for (let i = 0; i < 6; i++) mappings.push((await r.request('{}', `s${i}`)).headers['x-ds4-node']);
  assert.equal(new Set(mappings).size, 6);
  await r.restart();
  for (let i = 0; i < 6; i++) assert.equal((await r.request('{}', `s${i}`)).headers['x-ds4-node'], mappings[i]);
});
test('N-worker pools (1, 3, 12, 20) distribute new sessions and retain every home', async t => {
  for (const count of [1, 3, 12, 20]) {
    const r = await rig(t, count);
    const results = await Promise.all(Array.from({length:count},(_,i)=>r.request('{"delay":30}',`fleet-${count}-${i}`)));
    assert.equal(r.gateway.stats().total,count); assert.equal(r.gateway.stats().healthy,count);
    assert.equal(new Set(results.map(x=>x.headers['x-ds4-node'])).size,count);
    for (let i=0;i<count;i++) assert.equal((await r.request('{}',`fleet-${count}-${i}`)).headers['x-ds4-node'],results[i].headers['x-ds4-node']);
    assert.ok(r.backends.every(b=>b.peak===1));
  }
});
test('expand from two to six without moving established sessions', async t => {
  const r = await rig(t);
  const original = (await r.request('{}', 'old')).headers['x-ds4-node'];
  const extra = await Promise.all([3, 4, 5, 6].map(i => backend(`spark${i}`)));
  r.backends.push(...extra);
  await r.restart(extra.map(b => ({ id: b.id, url: b.url })));
  assert.equal((await r.request('{}', 'old')).headers['x-ds4-node'], original);
  const used = new Set();
  for (let i = 0; i < 5; i++) used.add((await r.request('{}', `new${i}`)).headers['x-ds4-node']);
  assert.equal(used.size, 5);
});
test('body bytes and arbitrary DS4 fields survive exactly (vision, tools, xhigh, 153600)', async t => {
  const r = await rig(t);
  const body = '{ "model":"deepseek-v4-flash", "thinking":{"type":"disabled"}, "reasoning_effort":"xhigh", "max_tokens":153600, "unknown_future_field":{"a":1}, "messages":[{"role":"user","content":[{"type":"image_url","image_url":{"url":"data:image/png;base64,abcd"}}]}], "tools":[{"type":"function","function":{"name":"test","parameters":{}}}], "tool_choice":"auto", "stop":["END"] }';
  assert.equal((await r.request(body, 'raw')).status, 200);
  assert.equal(r.backends[0].records[0].body.toString(), body);
});
test('two simultaneous sessions execute one on each node', async t => {
  const r = await rig(t);
  await Promise.all([r.request('{"delay":100}', 'a'), r.request('{"delay":100}', 'b')]);
  assert.equal(r.backends[0].peak, 1); assert.equal(r.backends[1].peak, 1);
});
test('busy home queues FIFO, never spills to idle Spark', async t => {
  const r = await rig(t);
  const first = r.request('{"delay":150,"tag":1}', 'a');
  await until(() => r.gateway.stats().active === 1);
  const second = r.request('{"tag":2}', 'a');
  await until(() => r.gateway.stats().queued === 1);
  await Promise.all([first, second]);
  assert.deepEqual(r.backends[0].records.map(v => v.payload.tag), [1, 2]);
  assert.equal(r.backends[0].peak, 1); assert.equal(r.backends[1].records.length, 0);
});
test('cancel active SSE propagates; next queued request proceeds', async t => {
  const r = await rig(t);
  await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: r.address.port, path: '/v1/chat/completions', method: 'POST', headers: { authorization: 'Bearer none', 'x-session-affinity': 'a' } }, res => {
      res.once('data', () => { res.destroy(); req.destroy(); resolve(); });
    }); req.on('error', reject); req.end('{"stream":true,"delay":10000}');
  });
  await until(() => r.backends[0].aborts === 1 && r.gateway.stats().active === 0);
  assert.equal((await r.request('{}', 'a')).status, 200);
});
test('cancel queued request never executes upstream', async t => {
  const r = await rig(t);
  const first = r.request('{"delay":180}', 'a');
  await until(() => r.gateway.stats().active === 1);
  const queued = http.request({ host: '127.0.0.1', port: r.address.port, path: '/v1/chat/completions', method: 'POST', headers: { authorization: 'Bearer none', 'x-session-affinity': 'a' } });
  queued.on('error', () => {}); queued.end('{}');
  await until(() => r.gateway.stats().queued === 1); queued.destroy();
  await first; await delay(30);
  assert.equal(r.backends[0].records.length, 1); assert.equal(r.gateway.stats().queued, 0);
});
test('no retry on upstream 503 or ambiguous disconnect', async t => {
  const r = await rig(t);
  assert.equal((await r.request('{"http_error":true}', 'a')).status, 503);
  assert.equal((await r.request('{"disconnect":true}', 'a')).status, 502);
  assert.equal(r.backends[0].records.length, 2); assert.equal(r.backends[1].records.length, 0);
});
test('unhealthy idle home reassigns durably; recovery does not bounce session back', async t => {
  const r = await rig(t);
  await r.request('{}', 'a'); r.gateway.nodes[0].healthy = false;
  assert.equal((await r.request('{}', 'a')).headers['x-ds4-node'], 'spark2');
  r.gateway.nodes[0].healthy = true;
  assert.equal((await r.request('{}', 'a')).headers['x-ds4-node'], 'spark2');
  await r.restart(); assert.equal((await r.request('{}', 'a')).headers['x-ds4-node'], 'spark2');
});
test('no failover when old home has unresolved work', async t => {
  const r = await rig(t);
  const first = r.request('{"delay":180}', 'a'); await until(() => r.gateway.stats().active === 1);
  r.gateway.nodes[0].healthy = false;
  assert.equal((await r.request('{}', 'a')).status, 503); await first;
  assert.equal(r.backends[1].records.length, 0);
});
test('queue bound rejects without dispatch, queue timeout does not cap generation', async t => {
  const r = await rig(t, 2, { max_queued_per_node: 1, queue_timeout_ms: 50 });
  const first = r.request('{"delay":170}', 'a'); await until(() => r.gateway.stats().active === 1);
  const second = r.request('{}', 'a'); await until(() => r.gateway.stats().queued === 1);
  assert.equal((await r.request('{}', 'a')).status, 429);
  assert.equal((await second).status, 504); assert.equal((await first).status, 200);
  assert.equal(r.backends[0].records.length, 1);
});
test('SSE forwarded with usage and DONE; no Node five-minute or idle request timeout', async t => {
  const r = await rig(t);
  const result = await r.request('{"stream":true}', 'a');
  assert.match(result.body, /reasoning_content/); assert.match(result.body, /8192/); assert.match(result.body, /\[DONE\]/);
  assert.equal(r.gateway.server.requestTimeout, 0); assert.equal(r.gateway.server.timeout, 0);
});
test('health verifies model identity/context, routes and authentication fail closed', async t => {
  const r = await rig(t, 2, { health_interval_ms: 25, health_failures: 1 });
  r.backends[0].health = false; await until(() => !r.gateway.nodes[0].healthy);
  assert.equal((await r.request('{}', 'a')).headers['x-ds4-node'], 'spark2');
  for (const bad of ['/ha/shutdown', '/workers/abc', '/v1/../ha/shutdown', '/v1/%63hat/completions']) assert.equal((await r.request('{}', 'a', { path: bad })).status, 404);
  assert.equal((await r.request('{}', 'a', { headers: { authorization: 'Bearer wrong' } })).status, 401);
  r.gateway.drain(); assert.equal((await r.request('{}', 'a')).status, 503);
  assert.equal((await r.request('', null, { path: '/gateway/status', method: 'GET' })).status, 200);
});
test('model metadata bypasses generation queue; no-header clients still work', async t => {
  const r = await rig(t);
  const first = r.request('{"delay":170}', 'a'); await until(() => r.gateway.stats().active === 1);
  assert.equal((await r.request('', null, { path: '/v1/models', method: 'GET' })).status, 200);
  assert.equal(r.gateway.stats().active, 1); await first;
  assert.equal((await r.request('{}')).headers['x-ds4-affinity'], 'none');
});
test('state lock prevents double ownership; corrupt store never silently resets', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds4-gateway-state-test-'));
  const filename = path.join(dir, 'affinity.json'); const store = new AffinityStore(filename);
  assert.throws(() => new AffinityStore(filename), /locked/); store.close();
  fs.writeFileSync(filename, '{bad'); assert.throws(() => new AffinityStore(filename));
  assert.equal(fs.readFileSync(filename, 'utf8'), '{bad');
});
test('worker drain persists, drains admitted work, reassigns idle sessions and resumes without bouncing', async t => {
  const r = await rig(t);
  const first = r.request('{"delay":140}', 'a'); await until(() => r.gateway.stats().active === 1);
  r.gateway.drainNodes(['spark1'], true);
  assert.equal(r.gateway.stats().workers[0].gateway_drained, false);
  assert.equal((await r.request('{}', 'a')).status, 503);
  assert.equal((await r.request('{}', 'new')).headers['x-ds4-node'], 'spark2');
  await first; assert.equal(r.gateway.stats().workers[0].gateway_drained, true);
  assert.equal((await r.request('{}', 'a')).headers['x-ds4-node'], 'spark2');
  await r.restart(); assert.equal(r.gateway.stats().workers[0].drained, true);
  r.gateway.drainNodes(['spark1'], false);
  assert.equal((await r.request('{}', 'a')).headers['x-ds4-node'], 'spark2');
  r.gateway.drainNodes(['spark1', 'spark2'], true);
  assert.equal((await r.request('{}', 'next')).status, 503);
  assert.throws(() => r.gateway.drainNodes(['spark999'], true), /known worker/);
});
test('six-node fleet can drain four nodes and keep routing on the two remaining', async t => {
  const r = await rig(t, 6);
  for (let i = 0; i < 6; i++) await r.request('{}', `s${i}`);
  r.gateway.drainNodes(['spark1', 'spark2', 'spark3', 'spark4'], true);
  assert.equal(r.gateway.stats().available, 2);
  for (let i = 0; i < 6; i++) assert.ok(['spark5', 'spark6'].includes((await r.request('{}', `s${i}`)).headers['x-ds4-node']));
});
test('operator socket is private and worker control is not available over public HTTP', async t => {
  const r = await rig(t, 2, { control_socket: true });
  assert.equal(fs.statSync(r.config.control_socket).mode & 0o777, 0o600);
  const result = await new Promise((resolve, reject) => {
    const req = http.request({ socketPath: r.config.control_socket, method: 'POST', path: '/drain-workers' }, res => {
      let body = ''; res.on('data', b => { body += b; }); res.on('end', () => resolve(JSON.parse(body)));
    }); req.on('error', reject); req.end('{"workers":["spark1"]}');
  });
  assert.equal(result.workers[0].gateway_drained, true);
  assert.equal((await r.request('{"workers":["spark2"]}', null, { path: '/drain-workers' })).status, 404);
});
test('slow consumer receives the exact multi-megabyte stream without truncation', async t => {
  const r = await rig(t);
  const bytes = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: r.address.port, path: '/v1/chat/completions', method: 'POST', headers: { authorization: 'Bearer none' } }, res => {
      let size = 0; res.pause(); setTimeout(() => res.resume(), 100);
      res.on('data', b => { size += b.length; }); res.on('error', reject); res.on('end', () => resolve(size));
    }); req.on('error', reject); req.end('{"large_stream":true}');
  });
  assert.equal(bytes, 128 * (32768 + 8) + 'data: [DONE]\n\n'.length);
});
