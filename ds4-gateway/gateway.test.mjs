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
import { AffinityStore, createGateway, UsageObserver, workerRegistrationTimeout } from './gateway.mjs';
import { requestedThinking, RequestedThinkingObserver, THINKING_CAPTURE_BYTES, safeRequestedThinking } from './requested-thinking.mjs';
import { workerControl } from './worker-client.mjs';
import {agentRequest} from './agent-client.mjs';
import {randomUUID,createHash} from 'node:crypto';
import { runDashboard } from './dashboard.mjs';
import { GenerationFaultObserver } from './generation-health.mjs';
import {workerConfig,sshTargets,assertUniqueWorker,replaceSshFallbacks} from './worker-config.mjs';

async function until(fn, timeout = 3000) {
  const end = Date.now() + timeout;
  while (!fn()) { if (Date.now() > end) throw new Error('Condition timed out'); await delay(10); }
}
async function backend(id) {
  const b = { id, records: [], modelHeaders:[], active: 0, peak: 0, aborts: 0, health: true, receivedBytes: 0, context_length:153600 };
  b.server = http.createServer((req, res) => {
    if (req.url === '/v1/models') {
      b.modelHeaders.push(req.headers);
      if(b.blockHealthWhileActive&&b.active){res.on('close',()=>{});return;}
      return res.end(JSON.stringify({ data: [{ id: b.health ? 'deepseek-v4-flash' : 'wrong-model', context_length: b.context_length, top_provider:{context_length:b.context_length,max_completion_tokens:b.context_length} }] }));
    }
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
      const typedImageUrls=(Array.isArray(p.messages)?p.messages:[]).flatMap(message=>Array.isArray(message?.content)?message.content:[]).filter(block=>block?.type==='image_url').map(block=>typeof block.image_url==='string'?block.image_url:block.image_url?.url).filter(value=>typeof value==='string');
      if((b.rejectTooManyImages&&typedImageUrls.length>16)||p.too_many_images_error){ended=true;res.writeHead(400,{'content-type':'application/json','x-backend-proof':'image-limit'});res.end(JSON.stringify({message:'too many images; at most 16 are allowed',type:'invalid_request_error'}));return;}
      if(b.rejectGif&&typedImageUrls.some(value=>value.startsWith('data:image/gif;base64,'))){b.gifRejections=(b.gifRejections??0)+1;ended=true;res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:'invalid JSON request',type:'invalid_request_error'}}));return;}
      if((b.rejectJpeg&&typedImageUrls.some(value=>value.startsWith('data:image/jpeg;base64,')||value.startsWith('data:image/jpg;base64,')))||(b.rejectNormalized&&typedImageUrls.some(value=>value.startsWith('data:image/png;base64,')))){b.jpegRejections=(b.jpegRejections??0)+1;ended=true;res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({message:'invalid or unsupported JPEG image',type:'invalid_request_error'}));return;}
      if(p.generic_json_error){ended=true;res.writeHead(400,{'content-type':'application/json','x-backend-proof':'unchanged'});res.end(JSON.stringify({error:{message:'invalid JSON request',type:'invalid_request_error'}}));return;}
      if(p.client_error) {ended=true;res.writeHead(400,{'content-type':'text/plain'});res.end(typeof p.client_error==='string'?p.client_error:'invalid request');return;}
      if(typeof p.fixture_sse==='string') {ended=true;res.writeHead(200,{'content-type':'text/event-stream'});res.end(p.fixture_sse);return;}
      if(typeof p.fixture_json==='string') {ended=true;res.writeHead(200,{'content-type':'application/json'});res.end(p.fixture_json);return;}
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
        const progress=p.progress?setInterval(()=>res.write('data: {"choices":[{"delta":{"reasoning_content":"working"}}]}\n\n'),15):null;
        res.on('close',()=>clearInterval(progress));
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

test('DSG ingress credentials never cross the unauthenticated stock-DS4 boundary',async t=>{
  const r=await rig(t,1);
  const inference=await r.request(JSON.stringify({messages:[{role:'user',content:'credential boundary'}]}));
  assert.equal(inference.status,200);
  assert.equal(r.backends[0].records.at(-1).headers.authorization,undefined);
  const models=await r.request('',null,{method:'GET',path:'/v1/models'});
  assert.equal(models.status,200);
  assert.ok(r.backends[0].modelHeaders.length>=2,'startup probe and proxied model-list request were observed');
  assert.ok(r.backends[0].modelHeaders.every(headers=>headers.authorization===undefined));
});

test('Agent Watch is an authenticated bounded advisory lane and never reaches DS4',async t=>{
  const r=await rig(t,1),watch=randomUUID(),heartbeat=sequence=>JSON.stringify({schema:1,watch_id:watch,client:'pi',state:'waiting_for_model',sequence,process_alive:true});
  const accepted=await r.request(heartbeat(0),null,{path:'/gateway/client-watch'});assert.equal(accepted.status,200);assert.equal(JSON.parse(accepted.body).accepted,true);
  const unauth=await r.request(heartbeat(1),null,{path:'/gateway/client-watch',headers:{authorization:'Bearer wrong'}});assert.equal(unauth.status,401);
  const malformed=await r.request(JSON.stringify({...JSON.parse(heartbeat(1)),prompt:'PRIVATE'}),null,{path:'/gateway/client-watch'});assert.equal(malformed.status,400);
  const large=await r.request(JSON.stringify({...JSON.parse(heartbeat(1)),padding:'x'.repeat(2200)}),null,{path:'/gateway/client-watch'});assert.equal(large.status,413);
  const result=await r.request('{}','watched',{headers:{'x-dsg-client-watch-id':watch}});assert.equal(result.status,200);
  assert.equal(r.backends[0].records.at(-1).headers['x-dsg-client-watch-id'],undefined);
  const status=await r.request('',null,{path:'/gateway/status',method:'GET'}),body=JSON.parse(status.body),run=body.client_watch.runs[0];
  assert.equal(body.client_watch_version,1);assert.equal(run.client,'pi');assert.equal(run.request.state,'complete');assert.equal(run.diagnosis,'client_processing_after_dsg');
  assert.ok(!JSON.stringify(body.client_watch).includes(watch));assert.ok(!JSON.stringify(body.client_watch).includes('PRIVATE'));
});

test('remote workers accept bounded verified SSH alias fallbacks, never options or duplicate routes',()=>{
  const worker=workerConfig({id:'worker-a',url:'http://127.0.0.1:38001',ssh:'worker-a',ssh_fallbacks:['worker-a-lan','worker-a-tailnet','worker-a-lan'],remote_port:8000});
  assert.deepEqual(sshTargets(worker),['worker-a','worker-a-lan','worker-a-tailnet']);
  assert.deepEqual(worker.ssh_fallbacks,['worker-a-lan','worker-a-tailnet']);
  for(const bad of [
    {...worker,ssh_fallbacks:'worker-b'},
    {...worker,ssh_fallbacks:['-oProxyCommand=bad']},
    {...worker,ssh_fallbacks:['worker-a']},
    {id:'worker-a',url:'http://127.0.0.1:38001',ssh_fallbacks:['worker-a-lan']},
    {...worker,ssh_fallbacks:['a','b','c','d','e']}
  ])assert.throws(()=>workerConfig(bad));
  assert.throws(()=>assertUniqueWorker([worker],workerConfig({id:'worker-b',url:'http://127.0.0.1:38002',ssh:'worker-b',ssh_fallbacks:['worker-a-tailnet'],remote_port:8000})),/SSH endpoint/);
  assert.equal(workerRegistrationTimeout({},worker),45000);
  assert.equal(workerRegistrationTimeout({registration_timeout_ms:9000},worker),9000);
  const changed=replaceSshFallbacks([worker],{id:'worker-a',expected_ssh_fallbacks:['worker-a-lan','worker-a-tailnet'],ssh_fallbacks:['worker-a-wifi']});
  assert.deepEqual(changed[0].ssh_fallbacks,['worker-a-wifi']);assert.equal(changed[0].url,worker.url);assert.equal(changed[0].ssh,worker.ssh);
  assert.throws(()=>replaceSshFallbacks(changed,{id:'worker-a',expected_ssh_fallbacks:[],ssh_fallbacks:[]}),/changed/);
  assert.throws(()=>replaceSshFallbacks([{id:'local',url:'http://127.0.0.1:8000'}],{id:'local',expected_ssh_fallbacks:[],ssh_fallbacks:['remote']}),/remote worker/);
  assert.throws(()=>replaceSshFallbacks([worker,{id:'worker-b',url:'http://127.0.0.1:38002',ssh:'worker-b'}],{id:'worker-b',expected_ssh_fallbacks:[],ssh_fallbacks:['worker-a-lan']}),/SSH endpoint/);
});
async function rig(t, count = 2, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds4-gateway-test-'));
  const backends = await Promise.all(Array.from({ length: count }, (_, i) => backend(`spark${i + 1}`)));
  const {visionTranscode,...configOverrides}=overrides;
  const config = { host: '127.0.0.1', port: 0, api_key: 'none', model: 'deepseek-v4-flash', context_length: 153600,
    state_file: path.join(dir, 'affinity.json'), health_interval_ms: 100000, nodes: backends.map(b => ({ id: b.id, url: b.url })), ...configOverrides };
  if (config.control_socket === true) config.control_socket = path.join(dir, 'control.sock');
  const gatewayOptions=visionTranscode?{visionTranscode}:undefined;
  const r = { config, backends, gateway: createGateway(config,gatewayOptions) };
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
    r.gateway = createGateway(r.config,gatewayOptions); r.address = await r.gateway.start();
  };
  t.after(async () => { await r.gateway.close(); await Promise.all(backends.map(b => b.close())); });
  return r;
}

test('all workers unavailable: one client request waits, then dispatches once with identical body and full settings',async t=>{
  const r=await rig(t,2,{health_interval_ms:25,health_failures:1,dataset_enabled:true});
  for(const b of r.backends)b.health=false;
  await until(()=>r.gateway.stats().available===0);
  const body=JSON.stringify({stream:true,reasoning_effort:'xhigh',max_tokens:262144,messages:[{role:'user',content:'private synthetic prompt'}]});
  let finished=false;const result=r.request(body,'patient').then(x=>{finished=true;return x;});
  await until(()=>r.gateway.stats().continuity.waiting===1);
  await delay(3200);
  assert.equal(finished,false);assert.equal(r.gateway.stats().queued,1);assert.equal(r.gateway.stats().active,0);
  assert.equal(r.gateway.stats().continuity.recent_rejections.length,0);
  assert.equal(r.gateway.stats().continuity.patient_wait,true);assert.ok(r.gateway.stats().continuity.oldest_wait_seconds>=3);
  assert.equal(r.backends.reduce((n,b)=>n+b.receivedBytes,0),0,'no prompt bytes reach any backend during the outage');
  r.backends[1].health=true;
  const out=await result;assert.equal(out.status,200);assert.equal(out.headers['x-ds4-node'],'spark2');
  assert.equal(r.backends[0].records.length,0);assert.equal(r.backends[1].records.length,1);assert.equal(r.backends[1].records[0].body.toString(),body);
  assert.match(out.body,/\[DONE\]/);assert.equal(r.gateway.stats().continuity.waiting,0);
  await until(()=>r.gateway.stats().dataset.finished===1);
  await r.gateway.close();
  const dir=path.join(path.dirname(r.config.state_file),'training'),rows=fs.readdirSync(dir).flatMap(f=>fs.readFileSync(path.join(dir,f),'utf8').trim().split('\n').map(JSON.parse));
  assert.equal(rows.filter(x=>x.kind==='decision').length,1);assert.equal(rows.filter(x=>x.kind==='dispatch').length,1);
  const wait=rows.find(x=>x.kind==='waiting'),finish=rows.find(x=>x.kind==='finish');
  assert.equal(wait.reason,'no_ready_worker');assert.equal(wait.dispatch_state,'not_dispatched');assert.ok(finish.queue_ms>=3200);
  assert.ok(!JSON.stringify(rows).includes('private synthetic prompt'));
});

test('patient upload cancellation removes its reservation and never dispatches later',async t=>{
  const r=await rig(t,1,{health_interval_ms:25,health_failures:1});r.backends[0].health=false;
  await until(()=>r.gateway.stats().available===0);
  const req=http.request({host:'127.0.0.1',port:r.address.port,path:'/v1/chat/completions',method:'POST',headers:{authorization:'Bearer none','x-session-affinity':'cancelled'}});
  req.on('error',()=>{});req.end(JSON.stringify({messages:[{role:'user',content:'x'.repeat(500000)}]}));
  await until(()=>r.gateway.stats().continuity.waiting===1);req.destroy();
  await until(()=>r.gateway.stats().queued===0,15000);r.backends[0].health=true;
  await until(()=>r.gateway.stats().available===1);await delay(1100);
  assert.equal(r.backends[0].records.length,0);assert.equal(r.backends[0].receivedBytes,0);
});

test('patient calls retain same-session ordering across quarantine and cannot displace manual pause',async t=>{
  const r=await rig(t,2,{control_socket:true});
  const failed=r.request('{"fatal_error":true,"delay":80}','a');await until(()=>r.gateway.stats().active===1);
  const one=r.request('{"sequence":1}','a');await until(()=>r.gateway.stats().queued===1);await failed;
  await until(()=>r.gateway.stats().continuity.waiting===1);
  const two=r.request('{"sequence":2}','a');await until(()=>r.gateway.stats().continuity.waiting===2);
  await workerControl(r.config.control_socket,'/drain-workers',{workers:['spark1']});
  await assert.rejects(workerControl(r.config.control_socket,'/remove-worker',{id:'spark1'}),/waiting.*recover/);
  assert.equal((await r.request('{}','independent')).headers['x-ds4-node'],'spark2');
  await delay(1100);assert.equal(r.backends[0].records.length,1);assert.equal(r.gateway.stats().continuity.waiting,2);
  await workerControl(r.config.control_socket,'/resume-workers',{workers:['spark1']});
  assert.equal((await one).headers['x-ds4-node'],'spark1');assert.equal((await two).headers['x-ds4-node'],'spark1');
  assert.deepEqual(r.backends[0].records.filter(x=>x.payload.sequence).map(x=>x.payload.sequence),[1,2]);
  assert.equal(r.backends[0].peak,1);assert.equal(r.backends[1].records.length,1);
});

test('moving an undispatched call into recovery waiting does not reset its original deadline',async t=>{
  const r=await rig(t,1,{queue_timeout_ms:400});
  const failed=r.request('{"fatal_error":true,"delay":250}','a');await until(()=>r.gateway.stats().active===1);
  const start=performance.now(),next=r.request('{}','a');await until(()=>r.gateway.stats().queued===1);await failed;
  await until(()=>r.gateway.stats().continuity.waiting===1);
  const response=await next,error=JSON.parse(response.body).error;
  assert.equal(response.status,504);assert.ok(performance.now()-start<590,'parking must not start a second 400ms allowance');
  assert.match(error.message,/^DSG Report: .*400 milliseconds/);assert.match(error.message,/configurable in DSG/);
  assert.equal(error.continuity.dispatch_state,'not_dispatched');assert.equal(r.backends[0].records.length,1);
});

test('patient waiting is bounded; shutdown returns a certified DSG pre-dispatch error',async t=>{
  const r=await rig(t,1,{max_queued_per_node:1});r.gateway.drainNodes(['spark1'],true);
  const first=r.request('{}','a',{headers:{'x-dsg-call-id':randomUUID()}});await until(()=>r.gateway.stats().continuity.waiting===1);
  const full=await r.request('{}','b');assert.equal(full.status,429);assert.match(JSON.parse(full.body).error.message,/^DSG Report: /);
  assert.equal(r.gateway.stats().continuity.waiting,1);
  await r.gateway.close();const stopped=await first,report=JSON.parse(stopped.body).error;
  assert.equal(stopped.status,503);assert.match(report.message,/^DSG Report: Gateway is stopping/);
  assert.equal(report.continuity.dispatch_state,'not_dispatched');assert.equal(report.continuity.retry_class,'wait_then_retry');assert.equal(r.backends[0].records.length,0);
});

test('recovered readiness cannot bypass failed durable affinity persistence',async t=>{
  const r=await rig(t,1,{health_interval_ms:25,health_failures:1});r.backends[0].health=false;await until(()=>r.gateway.stats().available===0);
  const held=r.request('{}','new');await until(()=>r.gateway.stats().continuity.waiting===1);
  const save=r.gateway.store.save;r.gateway.store.save=()=>{throw new Error('fixture save failure');};
  r.backends[0].health=true;
  const result=await held;r.gateway.store.save=save;
  assert.equal(result.status,503);const e=JSON.parse(result.body).error;
  assert.match(e.message,/^DSG Report: /);assert.equal(e.code,'state_unavailable');assert.equal(e.continuity.retry_class,'operator_required');
  assert.equal(r.backends[0].records.length,0);assert.equal(r.gateway.stats().queued,0);
});

test('DSG identifies its errors without prefixing upstream HTTP or SSE errors',async t=>{
  const r=await rig(t,2,{control_socket:true});
  for(const options of [{headers:{authorization:'Bearer wrong'}},{path:'/unknown'}]){
    const result=await r.request('{}',null,options);assert.match(JSON.parse(result.body).error.message,/^DSG Report: /);
  }
  await assert.rejects(workerControl(r.config.control_socket,'/remove-worker',{id:'absent'}),/^Error: DSG Report: Unknown worker/);
  const own=await r.request('{"disconnect":true}','a');assert.match(JSON.parse(own.body).error.message,/^DSG Report: /);
  assert.equal((await r.request('{"http_error":true}','b')).body,'backend-error');
  const sse='event: error\ndata: {"error":{"message":"engine error"}}\n\ndata: [DONE]\n\n';
  assert.equal((await r.request(JSON.stringify({fixture_sse:sse}),'b')).body,sse);
});

test('scoped agent ingress preserves admitted work, ownership and receipts across gateway restart',async t=>{
  const r=await rig(t,1,{control_socket:true}),ctl=(route,body)=>workerControl(r.config.control_socket,route,body);
  const grant=await ctl('/grant-agent',{agent_id:'tester',workers:['spark1']}),credential={control_socket:r.config.control_socket,token:grant.token};
  const req=JSON.stringify({stream:true,delay:200,reasoning_effort:'xhigh',max_tokens:131072});
  const active=r.request(req,'one');await until(()=>r.backends[0].active===1);
  const waiting=r.request(req,'two');await until(()=>r.gateway.stats().queued===1);
  const input={worker_id:'spark1',reason:'engine test',request_id:randomUUID()};
  const d=await agentRequest(credential,'drain',input);assert.equal(r.gateway.stats().workers[0].operator_paused,false);
  assert.equal((await agentRequest(credential,'status')).workers[0].gateway_drained,false);
  const deferred=r.request('{}','new');await until(()=>r.gateway.stats().continuity.waiting===1);
  assert.equal((await active).status,200);assert.equal((await waiting).status,200);
  assert.equal(r.backends[0].records[0].body.toString(),req);assert.equal(r.backends[0].records[1].body.toString(),req);
  assert.equal((await agentRequest(credential,'status')).workers[0].gateway_drained,true);
  await assert.rejects(ctl('/resume-workers',{workers:['spark1']}),/agent holds/);
  await assert.rejects(ctl('/remove-worker',{id:'spark1'}),/agent holds/);
  await r.restart();assert.equal((await deferred).status,503);assert.equal(r.gateway.stats().workers[0].holds[0].owner_id,'tester');
  assert.deepEqual(await agentRequest(credential,'drain',input),d);
  assert.deepEqual(await agentRequest(credential,'receipt',{request_id:input.request_id}),d);
  const released=await agentRequest(credential,'resume',{hold_id:d.result.hold_id,request_id:randomUUID()});
  assert.equal(released.result.routing_resumed,true);assert.equal(r.gateway.stats().available,1);
  assert.equal(r.backends[0].records.length,2,'readiness checks do not synthesize generation');
  assert.equal((await r.request('{}','new')).status,200);
});
test('agent API uses exact authenticated private routes, not inference or operator ingress',async t=>{
  const r=await rig(t,2,{control_socket:true}),ctl=(route,body)=>workerControl(r.config.control_socket,route,body);
  const grant=await ctl('/grant-agent',{agent_id:'tester',workers:['spark1']}),credential={control_socket:r.config.control_socket,token:grant.token};
  const raw=(route,token=grant.token,method='POST',body=method==='GET'?'':'{}')=>new Promise((resolve,reject)=>{
    const req=http.request({socketPath:r.config.control_socket,path:route,method,agent:false,headers:{'content-length':Buffer.byteLength(body),...(token?{authorization:'Bearer '+token}:{})}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',e=>reject(new Error(`${method} ${route}: ${e.message}`)));req.end(body);
  });
  assert.equal(await raw('/agent/v1/status',null,'GET'),401);
  assert.equal(await raw('/agent/v1/status','invalid','GET'),401);
  for(const route of ['/resume-workers','/recover-worker','/workers','/grant-agent'])assert.equal(await raw(route),403);
  assert.equal(await raw('/agent/v1/recover'),404);
  assert.equal(await raw('/agent/v1/drain',grant.token,'GET'),404);
  assert.equal(await raw('/agent/v1/drain',grant.token,'POST','[]'),400);
  assert.equal((await r.request('',null,{path:'/agent/v1/status',method:'GET'})).status,404);
  await assert.rejects(agentRequest(credential,'drain',{worker_id:'spark2',reason:'test',request_id:randomUUID()}),{code:'forbidden_worker'});
  const status=await agentRequest(credential,'status');assert.equal(status.workers.length,2);assert.equal(status.workers[1].can_manage,false);
  assert.ok(!JSON.stringify(status).includes('http://'));assert.ok(!JSON.stringify(status).includes(grant.token));
  await ctl('/revoke-agent',{agent_id:'tester'});await assert.rejects(agentRequest(credential,'status'),{code:'unauthorized'});
});
test('agent cannot override operator pause, incompatible readiness or accelerator quarantine',async t=>{
  const r=await rig(t,1,{control_socket:true}),ctl=(route,body)=>workerControl(r.config.control_socket,route,body);
  const grant=await ctl('/grant-agent',{agent_id:'tester',workers:['spark1']}),credential={control_socket:r.config.control_socket,token:grant.token};
  const drain=()=>agentRequest(credential,'drain',{worker_id:'spark1',reason:'test',request_id:randomUUID()});
  const release=d=>agentRequest(credential,'resume',{hold_id:d.result.hold_id,request_id:randomUUID()});
  const d=await drain();r.backends[0].context_length=100;
  await assert.rejects(release(d),/readiness/);assert.equal(r.gateway.stats().workers[0].holds.length,1);
  await ctl('/drain-workers',{workers:['spark1']});
  assert.equal((await release(d)).result.routing_resumed,false);assert.equal(r.gateway.stats().workers[0].drained,true);
  r.backends[0].context_length=153600;await ctl('/resume-workers',{workers:['spark1']});
  await r.request('{"fatal_error":true}','fault');assert.ok(r.gateway.stats().workers[0].quarantine);
  const q=await drain();await assert.rejects(release(q),{code:'recovery_required'});
  assert.ok(r.gateway.stats().workers[0].quarantine);assert.equal(r.backends[0].records.length,1);
});
test('named maintenance lock survives restart and vetoes every broad resume path',async t=>{
  const r=await rig(t,1,{control_socket:true}),ctl=(route,body,channel='workers_cli')=>workerControl(r.config.control_socket,route,body,{channel});
  const grant=await ctl('/grant-agent',{agent_id:'tester',workers:['spark1']}),credential={control_socket:r.config.control_socket,token:grant.token};
  const hold=await agentRequest(credential,'drain',{worker_id:'spark1',reason:'agent test',request_id:randomUUID()});
  const request_id=randomUUID(),input={worker_id:'spark1',name:'patched-build-test',reason:'External agent is benchmarking DS4',review_after_hours:2,request_id};
  const locked=await ctl('/maintenance-lock',input,'dashboard');
  assert.equal(locked.result.state,'maintenance_locked');assert.equal(r.gateway.stats().workers[0].maintenance_locks[0].name,'patched-build-test');
  assert.equal(r.gateway.stats().workers[0].drained,true);assert.equal(r.gateway.stats().maintenance_lock_version,1);
  assert.equal((await agentRequest(credential,'resume',{hold_id:hold.result.hold_id,request_id:randomUUID()})).result.routing_resumed,false);
  await assert.rejects(ctl('/resume-workers',{workers:['spark1']}),/maintenance lock/);
  await r.restart();
  assert.equal(r.gateway.stats().workers[0].maintenance_locks[0].id,locked.result.lock_id);assert.equal(r.gateway.stats().workers[0].drained,true);
  assert.deepEqual(await ctl('/maintenance-lock',input),locked);
  assert.deepEqual(await ctl('/maintenance-receipt',{request_id}),locked);
  const releaseInput={lock_id:locked.result.lock_id,reason:'Benchmark complete',request_id:randomUUID()};
  const released=await ctl('/release-maintenance-lock',releaseInput,'dashboard');
  assert.equal(released.result.routing_resumed,false);assert.equal(r.gateway.stats().workers[0].drained,true);assert.equal(r.gateway.stats().workers[0].operator_paused,true);
  assert.deepEqual(await ctl('/release-maintenance-lock',releaseInput),released);
  await ctl('/resume-workers',{workers:['spark1']});assert.equal(r.gateway.stats().available,1);
});
test('operator CLI creates, reconciles and releases exact maintenance locks',async t=>{
  const r=await rig(t,1,{control_socket:true}),dir=path.dirname(r.config.state_file),config=path.join(dir,'config.json');fs.writeFileSync(config,JSON.stringify(r.config));
  const script=fileURLToPath(new URL('./workers.mjs',import.meta.url)),cli=(...args)=>promisify(execFile)(process.execPath,[script,...args]);
  const request_id=randomUUID(),created=await cli('lock','spark1','--name','speed-test','--reason','patched DS4 benchmark','--review-after-hours','2','--request-id',request_id,'--config',config);
  assert.equal(JSON.parse(created.stderr).request_id,request_id);const lock=JSON.parse(created.stdout);assert.equal(lock.result.state,'maintenance_locked');
  assert.deepEqual(JSON.parse((await cli('maintenance-receipt',request_id,'--config',config)).stdout),lock);
  const released=JSON.parse((await cli('unlock',lock.result.lock_id,'--reason','benchmark complete','--config',config)).stdout);
  assert.equal(released.result.state,'maintenance_released_paused');assert.equal(r.gateway.stats().workers[0].drained,true);
});
test('operator CLI creates private scoped credential; agent CLI needs no full gateway config',async t=>{
  const r=await rig(t,1,{control_socket:true}),dir=path.dirname(r.config.state_file),config=path.join(dir,'config.json'),file=path.join(dir,'agent.json');
  fs.writeFileSync(config,JSON.stringify(r.config));
  const script=fileURLToPath(new URL('./agents.mjs',import.meta.url));
  const cli=(...args)=>promisify(execFile)(process.execPath,[script,...args],{env:{...process.env,DSG_AGENT_CREDENTIALS:''}});
  const granted=await cli('grant','tester','--config',config,'--workers','spark1','--out',file);
  const secret=JSON.parse(fs.readFileSync(file,'utf8')).token;
  assert.equal(fs.statSync(file).mode&0o777,0o600);assert.ok(!granted.stdout.includes(secret));
  const before=fs.readFileSync(file,'utf8');await assert.rejects(cli('grant','other','--config',config,'--workers','spark1','--out',file));assert.equal(fs.readFileSync(file,'utf8'),before);
  const status=JSON.parse((await cli('status','--credential-file',file)).stdout);assert.equal(status.agent.agent_id,'tester');
  const request_id=randomUUID(),d=JSON.parse((await cli('drain','spark1','--reason','test','--request-id',request_id,'--credential-file',file)).stdout);
  assert.deepEqual(JSON.parse((await cli('receipt',request_id,'--credential-file',file)).stdout),d);
  assert.equal(JSON.parse((await cli('resume',d.result.hold_id,'--credential-file',file)).stdout).result.routing_resumed,true);
  await cli('revoke','tester','--config',config);await assert.rejects(cli('status','--credential-file',file));
});

test('non-streaming JSON usage is collected while request and response bytes remain unchanged',async t=>{
  const r=await rig(t,1,{dataset_enabled:true});
  const response=JSON.stringify({choices:[{finish_reason:'stop',message:{reasoning_content:'private thinking',content:'private answer'}}],usage:{prompt_tokens:1000,completion_tokens:20,prompt_tokens_details:{cached_tokens:900}}});
  const body=JSON.stringify({fixture_json:response,stream:false,model:'deepseek-v4-flash',reasoning_effort:'xhigh',max_tokens:262144});
  const result=await r.request(body,'json-usage');assert.equal(result.status,200);assert.equal(result.body,response);assert.equal(r.backends[0].records[0].body.toString(),body);
  await until(()=>r.gateway.stats().dataset.finished===1);
  const dir=path.join(path.dirname(r.config.state_file),'training'),rows=fs.readdirSync(dir).flatMap(f=>fs.readFileSync(path.join(dir,f),'utf8').trim().split('\n').map(JSON.parse)),f=rows.find(x=>x.kind==='finish');
  assert.equal(f.response_format,'json');assert.equal(f.route,'/v1/chat/completions');assert.equal(f.request_stream,false);assert.equal(f.http_status,200);assert.equal(f.usage_observation,'observed');assert.equal(f.usage.completion_tokens,20);assert.equal(f.usage.cached_tokens,900);assert.equal(f.finish_reason,'stop');assert.equal(f.generation.first_semantic_ms,null);
  assert.ok(!JSON.stringify(rows).includes('private answer'));assert.equal(r.gateway.stats().workers[0].quarantine,null);
});
test('oversized or invalid JSON observation does not reject or truncate successful upstream responses',async t=>{
  const r=await rig(t,1,{dataset_enabled:true});
  for(const value of ['not valid json',JSON.stringify({padding:'x'.repeat(4*1024*1024)})]){
    const result=await r.request(JSON.stringify({fixture_json:value}));assert.equal(result.status,200);assert.equal(result.body,value);
  }
  await until(()=>r.gateway.stats().dataset.finished===2);
  assert.equal(r.gateway.stats().workers[0].quarantine,null);assert.equal(r.gateway.stats().workers[0].is_healthy,true);
});

test('usage observer skips an entire oversized SSE line, including a DONE-shaped suffix',()=>{
  const o=new UsageObserver();
  o.accept(Buffer.from('data: '+ 'x'.repeat(1048577)));
  o.accept(Buffer.from('data: [DONE]\n'));
  assert.equal(o.done,false,'a suffix inside the discarded line is not a separate SSE event');
  assert.ok(o.pending.length<=1048576);
  o.accept(Buffer.from('data: {"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":3}}\n\ndata: [DONE]\n\n'));
  assert.equal(o.done,true);assert.equal(o.usage.prompt_tokens,12);assert.equal(o.finish_reason,'stop');
});

test('usage observer distinguishes terminal, clean early EOF and truncated SSE events without retaining content',()=>{
  const terminal=new UsageObserver();terminal.accept(Buffer.from('data: {"choices":[{"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'));
  assert.equal(terminal.finishState(),'terminal');assert.equal(terminal.finishState(),'terminal');
  const clean=new UsageObserver();clean.accept(Buffer.from('data: {"choices":[{"delta":{"content":"PRIVATE"}}]}\n\n'));
  assert.equal(clean.finishState(),'clean_eof_no_terminal');assert.ok(!JSON.stringify(clean).includes('PRIVATE'));
  const oneNewline=new UsageObserver();oneNewline.accept(Buffer.from('data: {"choices":[{"delta":{"content":"x"}}]}\n'));
  assert.equal(oneNewline.finishState(),'partial_sse_event');
  const partial=new UsageObserver();partial.accept(Buffer.from('data: {"choices":[{"delta":{"content":"x"}}]'));
  assert.equal(partial.finishState(),'partial_sse_event');
  const failed=new UsageObserver();failed.accept(Buffer.from('data: {"type":"error","error":{"message":"PRIVATE"}}\n\n'));
  assert.equal(failed.finishState(),'engine_error');assert.ok(!JSON.stringify(failed).includes('PRIVATE'));
});

test('gateway records bounded incomplete-stream shape without changing response bytes or replaying',async t=>{
  const r=await rig(t,1,{dataset_enabled:true});
  const clean='data: {"choices":[{"delta":{"content":"PRIVATE_STREAM_ALPHA"}}]}\n\n';
  const partial='data: {"choices":[{"delta":{"content":"PRIVATE_STREAM_BETA"}}]';
  const a=await r.request(JSON.stringify({fixture_sse:clean,stream:true}),'clean-eof');
  const b=await r.request(JSON.stringify({fixture_sse:partial,stream:true}),'partial-eof');
  assert.equal(a.body,clean);assert.equal(b.body,partial);assert.equal(r.backends[0].records.length,2);
  await until(()=>r.gateway.stats().dataset.finished===2);
  await r.gateway.close();
  const dir=path.join(path.dirname(r.config.state_file),'training'),rows=fs.readdirSync(dir).flatMap(f=>fs.readFileSync(path.join(dir,f),'utf8').trim().split('\n').map(JSON.parse));
  const finishes=rows.filter(row=>row.kind==='finish');assert.deepEqual(finishes.map(row=>row.outcome),['incomplete_sse','incomplete_sse']);
  assert.deepEqual(finishes.map(row=>row.stream_end),['clean_eof_no_terminal','partial_sse_event']);
  assert.ok(!JSON.stringify(rows).includes('PRIVATE_STREAM_ALPHA'));assert.ok(!JSON.stringify(rows).includes('PRIVATE_STREAM_BETA'));
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

test('client metadata is recorded while queued, never changes body settings or reaches DS4',async t=>{
  const r=await rig(t,1,{dataset_enabled:true});
  const first=r.request(JSON.stringify({stream:true,delay:400}),'busy');
  await until(()=>r.backends[0].active===1);
  const body=JSON.stringify({stream:true,reasoning_effort:'xhigh',max_tokens:131072});
  const header=JSON.stringify({schema:1,prompt_tokens_estimate:262144,turn_index:4,compaction_count:1,reasoning_effort:'low'});
  const second=r.request(body,'early',{headers:{'x-dsg-client-metadata':header}});
  const read=()=>{const dir=path.join(path.dirname(r.config.state_file),'training');return fs.existsSync(dir)?fs.readdirSync(dir).flatMap(f=>fs.readFileSync(path.join(dir,f),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)):[];};
  await until(()=>read().some(e=>e.kind==='decision'&&e.client_metadata?.status==='ready'));
  const event=read().find(e=>e.client_metadata?.status==='ready');
  assert.ok(!read().some(e=>e.request_id===event.request_id&&e.kind==='dispatch'));
  assert.equal(event.client_metadata.reasoning_effort,'low');
  assert.equal((await first).status,200);assert.equal((await second).status,200);
  assert.equal(r.backends[0].records[1].body.toString(),body);
  assert.equal(r.backends[0].records[1].headers['x-dsg-client-metadata'],undefined);
  assert.equal(r.gateway.stats().context_length,153600,'hint is not capacity authority');
  const invalid=await r.request(body,'bad-hint',{headers:{'x-dsg-client-metadata':'{"schema":1,"secret":"PRIVATE_HINT_FIXTURE"}'}});
  assert.equal(invalid.status,200);await until(()=>r.gateway.stats().dataset.finished===3);
  assert.ok(read().some(e=>e.client_metadata?.status==='invalid'));
  assert.ok(!JSON.stringify(read()).includes('PRIVATE_HINT_FIXTURE'));
});

test('predictor misconfiguration cannot change inference or model limits; split generation counts are metadata only',async t=>{
  const r=await rig(t,1,{dataset_enabled:true,predictor:{enabled:true,python:'/no-such-predictor',profiles:'/no-such-inventory'}});
  const sse='data: {"choices":[{"delta":{"reasoning_content":"think"}}]}\n\ndata: {"choices":[{"delta":{"content":"OK","tool_calls":[{"function":{"arguments":"{}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":100,"completion_tokens":7}}\n\ndata: [DONE]\n\n';
  const body=JSON.stringify({fixture_sse:sse,model:'deepseek-v4-flash',reasoning_effort:'xhigh',max_tokens:131072,messages:[{role:'user',content:'SYNTHETIC PRIVATE TEXT'}]});
  const response=await r.request(body,'pred-fallback');assert.equal(response.body,sse);assert.equal(r.backends[0].records[0].body.toString(),body);
  assert.equal(r.gateway.stats().predictor.configured,false);assert.equal(r.gateway.stats().context_length,153600);
  await until(()=>r.gateway.stats().dataset.finished===1);
  const dir=path.join(path.dirname(r.config.state_file),'training'),events=fs.readdirSync(dir).flatMap(f=>fs.readFileSync(path.join(dir,f),'utf8').trim().split('\n').map(JSON.parse)),finish=events.find(e=>e.kind==='finish');
  assert.equal(finish.generation.thinking_characters,5);assert.equal(finish.generation.answer_characters,2);assert.equal(finish.generation.tool_characters,2);assert.ok(!JSON.stringify(events).includes('SYNTHETIC PRIVATE TEXT'));
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

test('manual routing changes retain a bounded client-channel receipt without claiming human identity',async t=>{
  const r=await rig(t,1,{control_socket:true});
  await workerControl(r.config.control_socket,'/drain-workers',{workers:['spark1']},{channel:'dashboard'});
  let action=r.gateway.stats().workers[0].last_operator_action;
  assert.equal(action.action,'pause');assert.equal(action.control_channel,'dashboard');assert.deepEqual(action.workers,['spark1']);assert.ok(Number.isFinite(Date.parse(action.time)));
  await workerControl(r.config.control_socket,'/resume-workers',{workers:['spark1']},{channel:'workers_cli'});
  action=r.gateway.stats().workers[0].last_operator_action;
  assert.equal(action.action,'resume');assert.equal(action.control_channel,'workers_cli');
  await assert.rejects(workerControl(r.config.control_socket,'/drain-workers',{workers:['spark1']},{channel:'PRIVATE HUMAN NAME'}),/Invalid worker-control channel/);
  assert.equal(r.gateway.store.data.operator_actions.length,2);assert.ok(!JSON.stringify(r.gateway.store.data.operator_actions).includes('PRIVATE HUMAN NAME'));
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

test('quarantine parks undispatched requests without replay and verified readmission unblocks them',async t=>{
  const r=await rig(t,2,{control_socket:true});const first=r.request('{"fatal_error":true,"delay":100}','a');
  await until(()=>r.backends[0].records.length===1);
  const queued=r.request('{}','a');await until(()=>r.gateway.stats().workers[0].queued===1);
  assert.equal((await first).status,500);await until(()=>r.gateway.stats().continuity.waiting===1);
  assert.equal(r.gateway.nodes[0].queue.length,0,'parked uploads must not block recovery verification');
  assert.equal(r.gateway.stats().workers[0].recovery_waiting,1);
  assert.equal(r.backends[0].records.length,1);assert.equal(r.backends[1].records.length,0);
  await workerControl(r.config.control_socket,'/resume-workers',{workers:['spark1']});
  assert.equal((await queued).headers['x-ds4-node'],'spark1');
  assert.equal(r.backends[0].records.length,3,'one failure, one verification, one held request');
  assert.equal(r.backends[1].records.length,0);
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
  assert.deepEqual(rows.map(r=>r.kind),['routing_tiebreak_shadow','decision','dispatch','progress','finish']);assert.equal(new Set(rows.map(r=>r.request_id)).size,1);
  assert.equal(rows[0].mode,'active_with_abstention');assert.equal(rows[0].applied,false);assert.equal(rows[0].verdict,'free_tie');
  assert.equal(rows[1].candidates.length,2);assert.equal(rows[1].candidates[0].assigned_sessions,0);assert.equal(rows[1].candidates[0].active,0);
  assert.equal(rows[3].phase,'awaiting_content');assert.equal(rows[3].semantic_age_ms,null);
  assert.equal(rows[4].usage.cached_tokens,8192);assert.equal(rows[4].requested_thinking.fields.reasoning_effort,'xhigh');
  assert.ok(rows[4].first_body_byte_ms>=0);assert.ok(rows[4].total_ms>=rows[4].service_ms);
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
  const read=()=>{const dir=path.join(path.dirname(r.config.state_file),'training');return fs.existsSync(dir)?fs.readdirSync(dir).flatMap(f=>fs.readFileSync(path.join(dir,f),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)):[];};
  await other;await until(()=>read().some(row=>row.kind==='routing_shadow'&&row.reason==='worker_free'));
  const reassessment=read().find(row=>row.kind==='routing_shadow'&&row.reason==='worker_free');
  assert.equal(reassessment.verdict,'handover_blocked');assert.equal(r.backends[1].records.length,1);
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
  await assert.rejects(ctl('/set-ssh-fallbacks',{id:'spark1',expected_ssh_fallbacks:[],ssh_fallbacks:['remote']}),/remote worker/);
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

test('real dashboard polling exposes maintenance ownership and calibration, without private reasons',async t=>{
  const r=await rig(t,1,{control_socket:true,ui_worker_management:true});
  const granted=await workerControl(r.config.control_socket,'/grant-agent',{agent_id:'tester',workers:['spark1']});
  await agentRequest({control_socket:r.config.control_socket,token:granted.token},'drain',{worker_id:'spark1',reason:'PRIVATE_OPERATOR_REASON',request_id:randomUUID()});
  await workerControl(r.config.control_socket,'/maintenance-lock',{worker_id:'spark1',name:'speed-test',reason:'PRIVATE_MAINTENANCE_REASON',review_after_hours:24,request_id:randomUUID()},{channel:'dashboard'});
  const blocked=r.request('{}','blocked');await until(()=>r.gateway.stats().continuity.waiting===1);
  const configPath=path.join(path.dirname(r.config.state_file),'dashboard-config.json');fs.writeFileSync(configPath,JSON.stringify({...r.config,port:r.address.port}));
  const dashboard=await runDashboard(configPath,0);t.after(()=>dashboard.close());
  const s=dashboard.snapshot();assert.equal(s.gateway.agent_api_version,1);assert.equal(s.gateway.maintenance_lock_version,1);assert.deepEqual(s.gateway.calibration,r.gateway.stats().calibration);
  assert.equal(s.gateway.continuity.waiting,1);assert.equal(s.gateway.queued,1);assert.equal(s.gateway.continuity.waiting_reasons.no_ready_worker,1);
  assert.equal(s.gateway.workers[0].holds[0].owner_id,'tester');assert.equal(s.gateway.workers[0].gateway_drained,true);assert.equal(s.gateway.workers[0].operator_paused,false);
  assert.equal(s.gateway.workers[0].maintenance_locks[0].name,'speed-test');
  assert.ok(!JSON.stringify(s).includes('PRIVATE_OPERATOR_REASON'));assert.ok(!JSON.stringify(s).includes('PRIVATE_MAINTENANCE_REASON'));assert.ok(!JSON.stringify(s).includes(granted.token));
  await r.gateway.close();assert.equal((await blocked).status,503);
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
  assert.equal(r.gateway.stats().total,0);assert.equal((await r.request('',null,{path:'/v1/models',method:'GET'})).status,503);
  const held=r.request('{}');await until(()=>r.gateway.stats().continuity.waiting===1);
  await ctl('/add-worker',{worker:{id:'spark1',url:r.backends[0].url}});await ctl('/resume-workers',{workers:['spark1']});
  assert.equal((await held).status,200);assert.equal((await r.request('{}')).status,200);
});

test('health probes have a total deadline even if a worker trickles response bytes', async t => {
  const r=await rig(t,1,{health_interval_ms:30,health_timeout_ms:80,health_failures:1});
  const b=r.backends[0];b.server.removeAllListeners('request');let calls=0;
  b.server.on('request',(_req,res)=>{calls++;res.writeHead(200);res.write('{');const timer=setInterval(()=>res.write(' '),10);res.on('close',()=>clearInterval(timer));});
  await until(()=>!r.gateway.nodes[0].healthy);
  await until(()=>calls>=3);
  assert.equal(r.gateway.nodes[0].healthy,false);
});

test('model-list timeouts do not contradict fresh inference bytes, without routing shadow enabled',async t=>{
  const r=await rig(t,1,{health_interval_ms:20,health_timeout_ms:50,health_failures:1});
  r.backends[0].blockHealthWhileActive=true;
  const active=r.request(JSON.stringify({stream:true,delay:320,progress:true}),'busy');
  await until(()=>r.backends[0].active===1);
  await delay(140);
  const during=r.gateway.stats().workers[0];
  assert.equal(during.is_healthy,true);
  assert.equal(during.load,1);
  assert.equal(during.health_state_source,'recent_upstream_progress');
  assert.ok(during.health_probe_deferred>0);
  assert.equal((await active).status,200);
  await until(()=>r.gateway.stats().workers[0].health_state_source==='model_probe');
  assert.equal(r.gateway.stats().workers[0].is_healthy,true);
});

test('silent active work never masks a lost or stalled DS4 server',async t=>{
  const r=await rig(t,1,{health_interval_ms:20,health_timeout_ms:50,health_failures:1});
  r.backends[0].blockHealthWhileActive=true;
  const active=r.request(JSON.stringify({stream:true,delay:220}),'silent');
  await until(()=>r.backends[0].active===1);
  await until(()=>!r.gateway.stats().workers[0].is_healthy);
  assert.equal(r.gateway.stats().workers[0].load,1);
  assert.equal(r.gateway.stats().workers[0].probe_error,'PROBE_TIMEOUT');
  assert.equal((await active).status,200,'health checks never abort the active stream');
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
test('exact DS4 JPEG rejection is normalized once on the same server before Pi sees it',async t=>{
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB','base64'),seen=[];
  const r=await rig(t,1,{vision_compatibility:{enabled:true},visionTranscode:async jpeg=>{seen.push(jpeg);return png;}});
  r.backends[0].rejectJpeg=true;
  const jpeg=Buffer.from('/9j/2Q==','base64'),uri=`data:image/jpeg;base64,${jpeg.toString('base64')}`;
  const body=JSON.stringify({model:'deepseek-v4-flash',stream:true,reasoning_effort:'xhigh',max_tokens:153600,note:uri,tools:[{type:'function',function:{name:'keep_me'}}],messages:[{role:'user',content:[{type:'image_url',image_url:{url:uri}}]}]});
  const result=await r.request(body,'vision-rescue');
  assert.equal(result.status,200);assert.match(result.body,/data: \[DONE\]/);assert.equal(result.headers['x-dsg-protection'],undefined);
  assert.equal(r.backends[0].records.length,2);assert.equal(r.backends[0].jpegRejections,1);assert.deepEqual(seen,[jpeg]);
  const original=r.backends[0].records[0].payload,retry=r.backends[0].records[1].payload;
  assert.equal(original.messages[0].content[0].image_url.url,uri);assert.match(retry.messages[0].content[0].image_url.url,/^data:image\/png;base64,/);
  assert.equal(retry.note,uri);assert.equal(retry.reasoning_effort,'xhigh');assert.equal(retry.max_tokens,153600);assert.deepEqual(retry.tools,original.tools);
  assert.equal(r.gateway.stats().protections.vision_jpeg.rescued,1);assert.equal(r.gateway.stats().workers[0].completed,1);assert.equal(r.gateway.stats().workers[0].failed,0);
});
test('DS4 generic GIF rejection starts a model-driven recovery turn without conversion',async t=>{
  const gif=Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==','base64'),seen=[];
  const r=await rig(t,1,{vision_compatibility:{enabled:true},visionTranscode:async(value,kind)=>{seen.push({value,kind});throw new Error('must_not_convert_gif');}});r.backends[0].rejectGif=true;
  const uri=`data:image/gif;base64,${gif.toString('base64')}`,body=JSON.stringify({model:'deepseek-v4-flash',stream:true,thinking:{type:'enabled'},reasoning_effort:'xhigh',max_tokens:153600,note:uri,tools:[{type:'function',function:{name:'keep_me'}}],messages:[{role:'user',content:[{type:'image_url',image_url:{url:uri}}]}]});
  const result=await r.request(body,'gif-rescue');
  assert.equal(result.status,200);assert.equal(result.headers['x-dsg-protection'],'vision-gif-recovery');assert.equal(result.headers['x-dsg-gifs-withheld'],'1');assert.match(result.body,/"content":"OK"/);assert.match(result.body,/data: \[DONE\]/);
  assert.equal(r.backends[0].records.length,2);assert.equal(r.backends[0].gifRejections,1);assert.deepEqual(seen,[]);
  const retry=r.backends[0].records[1].payload;assert.equal(retry.messages[0].content.some(block=>block.type==='image_url'),false);assert.match(retry.messages.at(-1).content[0].text,/extract selected frames from the GIF as PNGs/);assert.match(retry.messages.at(-1).content[0].text,/Decide and take the next valid action now/);
  assert.equal(retry.note,uri);assert.equal(retry.thinking.type,'enabled');assert.equal(retry.reasoning_effort,'xhigh');assert.equal(retry.max_tokens,153600);assert.deepEqual(retry.tools,[{type:'function',function:{name:'keep_me'}}]);
  assert.equal(r.gateway.stats().protections.vision_jpeg.rescued,1);assert.equal(r.gateway.stats().protections.vision_jpeg.guided,0);assert.deepEqual(r.gateway.stats().protections.vision_jpeg.last.formats,['gif']);
});
test('generic invalid JSON response without a proven real GIF passes through byte-for-byte',async t=>{
  const r=await rig(t,1,{vision_compatibility:{enabled:true},visionTranscode:async()=>{throw new Error('must_not_run');}});
  const result=await r.request(JSON.stringify({generic_json_error:true,messages:[{role:'user',content:'ordinary text'}]}),'generic-json');
  assert.equal(result.status,400);assert.equal(result.headers['x-backend-proof'],'unchanged');assert.equal(result.body,JSON.stringify({error:{message:'invalid JSON request',type:'invalid_request_error'}}));
  r.backends[0].rejectGif=true;
  const fake=await r.request(JSON.stringify({messages:[{role:'user',content:[{type:'image_url',image_url:{url:'data:image/gif;base64,RkFLRQ=='}}]}]}),'fake-gif');
  assert.equal(fake.status,400);assert.match(fake.body,/invalid JSON request/);
  assert.equal(r.gateway.stats().protections.vision_jpeg.guided,0);
});
test('a GIF recovery rejected a second time becomes guidance without conversion or a loop',async t=>{
  const gif=Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==','base64');
  const r=await rig(t,1,{vision_compatibility:{enabled:true},visionTranscode:async()=>{throw new Error('transcoder_failed');}});r.backends[0].rejectGif=true;
  const result=await r.request(JSON.stringify({generic_json_error:true,stream:true,messages:[{role:'user',content:[{type:'image_url',image_url:{url:`data:image/gif;base64,${gif.toString('base64')}`}}]}]}),'gif-guidance');
  assert.equal(result.status,200);assert.equal(result.headers['x-dsg-protection'],'vision-gif-guidance');assert.match(result.body,/send selected frames from the GIF as PNGs/);assert.match(result.body,/data: \[DONE\]/);
  assert.equal(r.backends[0].records.length,2);assert.equal(r.gateway.stats().protections.vision_jpeg.guided,1);assert.deepEqual(r.gateway.stats().protections.vision_jpeg.last.formats,['gif']);
});
test('proven DS4 image-count rejection starts a no-selection model-driven recovery turn',async t=>{
  const r=await rig(t,1,{vision_compatibility:{enabled:true}});r.backends[0].rejectTooManyImages=true;
  const images=Array.from({length:18},(_,index)=>({type:'image_url',image_url:{url:`data:image/png;base64,${Buffer.from(String(index)).toString('base64')}`}}));
  const result=await r.request(JSON.stringify({stream:true,reasoning_effort:'xhigh',tools:[{type:'function',function:{name:'work'}}],messages:[{role:'user',content:[{type:'text',text:'keep me'},...images]}]}),'too-many-images');
  assert.equal(result.status,200);assert.equal(result.headers['x-dsg-protection'],'vision-image-limit-recovery');assert.equal(result.headers['x-dsg-images-withheld'],'18');assert.match(result.body,/"content":"OK"/);assert.match(result.body,/data: \[DONE\]/);
  assert.equal(r.backends[0].records.length,2);assert.equal(r.backends[0].records[0].payload.messages[0].content.filter(block=>block.type==='image_url').length,18);
  const repaired=r.backends[0].records[1].payload;
  assert.equal(repaired.reasoning_effort,'xhigh');assert.deepEqual(repaired.tools,[{type:'function',function:{name:'work'}}]);assert.equal(repaired.messages.flatMap(message=>message.content).filter(block=>block.type==='image_url').length,0);
  assert.match(repaired.messages.at(-1).content[0].text,/contained 18 images/);assert.match(repaired.messages.at(-1).content[0].text,/Decide and take the next valid action now/);assert.match(repaired.messages.at(-1).content[0].text,/Do not claim to have inspected/);
  assert.equal(repaired.messages[0].content.some(block=>block.text==='keep me'),true);
  assert.equal(r.gateway.stats().workers[0].completed,1);assert.equal(r.gateway.stats().workers[0].protected,0);assert.equal(r.gateway.stats().workers[0].failed,0);
  assert.equal(r.gateway.stats().protections.vision_jpeg.rescued,1);assert.deepEqual(r.gateway.stats().protections.vision_jpeg.last.formats,['image_limit']);
});
test('an image-limit recovery rejected a second time becomes guidance and never loops',async t=>{
  const r=await rig(t,1,{vision_compatibility:{enabled:true}});
  const images=Array.from({length:17},(_,index)=>({type:'image_url',image_url:{url:`data:image/png;base64,${Buffer.from(String(index)).toString('base64')}`}}));
  const result=await r.request(JSON.stringify({too_many_images_error:true,stream:true,messages:[{role:'user',content:images}]}),'too-many-images-twice');
  assert.equal(result.status,200);assert.equal(result.headers['x-dsg-protection'],'vision-image-limit-guidance');assert.match(result.body,/limit of 16 images/);assert.match(result.body,/This is a message from the DSG gateway/);assert.match(result.body,/data: \[DONE\]/);
  assert.equal(r.backends[0].records.length,2);assert.equal(r.gateway.stats().workers[0].protected,1);assert.equal(r.gateway.stats().workers[0].failed,0);
});
test('an image-limit error without more than sixteen proven typed images remains the original upstream 400',async t=>{
  const r=await rig(t,1,{vision_compatibility:{enabled:true}});
  const result=await r.request(JSON.stringify({too_many_images_error:true,stream:false,messages:[{role:'user',content:[{type:'image_url',image_url:{url:'data:image/png;base64,aQ=='}}]}]}),'false-image-limit');
  assert.equal(result.status,400);assert.equal(result.headers['x-backend-proof'],'image-limit');assert.match(result.body,/too many images/);assert.equal(r.gateway.stats().protections.vision_jpeg.guided,0);
});
test('an unrepairable rejected JPEG becomes a valid in-session guidance turn, not a Pi error',async t=>{
  const r=await rig(t,1,{vision_compatibility:{enabled:true},visionTranscode:async()=>{throw new Error('transcoder_failed');}});r.backends[0].rejectJpeg=true;
  const uri='data:image/jpeg;base64,/9j/2Q==',body=JSON.stringify({stream:true,reasoning_effort:'xhigh',messages:[{role:'user',content:[{type:'image_url',image_url:{url:uri}}]}]});
  const result=await r.request(body,'vision-guidance');
  assert.equal(result.status,200);assert.equal(result.headers['x-dsg-protection'],'vision-jpeg-guidance');assert.match(result.body,/your session remains active/);assert.match(result.body,/data: \[DONE\]/);
  assert.equal(r.backends[0].records.length,1);assert.equal(r.gateway.stats().workers[0].protected,1);assert.equal(r.gateway.stats().workers[0].completed,0);assert.equal(r.gateway.stats().workers[0].failed,0);
  assert.equal(r.gateway.stats().protections.vision_jpeg.guided,1);assert.equal(JSON.stringify(r.gateway.stats()).includes(uri),false);
});
test('guidance-only mode keeps the Pi turn alive when this host has no image converter',async t=>{
  const r=await rig(t,1,{vision_compatibility:{enabled:true,transcoder:'none'}});r.backends[0].rejectJpeg=true;
  const result=await r.request(JSON.stringify({stream:false,messages:[{role:'user',content:[{type:'image_url',image_url:{url:'data:image/jpeg;base64,/9j/2Q=='}}]}]}),'vision-guidance-only');
  assert.equal(result.status,200);assert.equal(result.headers['x-dsg-protection'],'vision-jpeg-guidance');assert.match(JSON.parse(result.body).choices[0].message.content,/resend it as PNG or WebP/);
  assert.equal(r.backends[0].records.length,1);assert.equal(r.gateway.stats().protections.vision_jpeg.available,false);assert.equal(r.gateway.stats().protections.vision_jpeg.guided,1);
});
test('a normalized image rejected again receives guidance once; DSG never loops',async t=>{
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB','base64');
  const r=await rig(t,1,{vision_compatibility:{enabled:true},visionTranscode:async()=>png});r.backends[0].rejectJpeg=true;r.backends[0].rejectNormalized=true;
  const result=await r.request(JSON.stringify({stream:false,messages:[{role:'user',content:[{type:'image_url',image_url:{url:'data:image/jpeg;base64,/9j/2Q=='}}]}]}),'vision-twice');
  assert.equal(result.status,200);assert.equal(JSON.parse(result.body).choices[0].finish_reason,'stop');assert.equal(r.backends[0].records.length,2);assert.equal(r.backends[0].jpegRejections,2);
  assert.equal(r.gateway.stats().protections.vision_jpeg.guided,1);assert.equal(r.gateway.stats().protections.vision_jpeg.rescued,0);
});
test('ordinary and oversized validation errors preserve exact status, headers and bytes; disabled protection never retries',async t=>{
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB','base64'),r=await rig(t,1,{vision_compatibility:{enabled:true},visionTranscode:async()=>png});
  const errorBody='x'.repeat(70*1024),ordinary=await r.request(JSON.stringify({client_error:errorBody}),'large-error');
  assert.equal(ordinary.status,400);assert.equal(ordinary.body,errorBody);assert.equal(r.backends[0].records.length,1);
  const disabled=await rig(t,1,{vision_compatibility:{enabled:false},visionTranscode:async()=>{throw new Error('must_not_run');}});disabled.backends[0].rejectJpeg=true;
  const rejected=await disabled.request(JSON.stringify({messages:[{role:'user',content:[{type:'image_url',image_url:{url:'data:image/jpeg;base64,/9j/2Q=='}}]}]}),'disabled');
  assert.equal(rejected.status,400);assert.match(rejected.body,/invalid or unsupported JPEG image/);assert.equal(disabled.backends[0].records.length,1);assert.equal(disabled.gateway.stats().protections.vision_jpeg.guided,0);
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
test('core rebalances a mature affinity queue without Genie or dashboard',async t=>{
  const r=await rig(t,2,{automatic_affinity_rebalance_min_wait_ms:25});
  await r.request('{"seed":"a"}','a');await r.request('{"seed":"b"}','b');await r.request('{"seed":"c"}','c');
  // The production sweep runs once per second. Keep the home occupied long
  // enough to prove the core-owned sweep, rather than winning a timing race
  // with the ordinary FIFO completion path.
  const active=r.request('{"delay":1500,"active":"c"}','c');await until(()=>r.gateway.nodes[0].active);
  const body='{"queued":"a","reasoning_effort":"xhigh"}',queued=r.request(body,'a');
  await until(()=>r.gateway.nodes[0].queue.length===1);
  assert.equal(r.gateway.stats().continuity.relocation.diagnostics.sources[0].automatic_reason,'automatic_wait_threshold');
  const result=await queued;await active;
  assert.equal(result.headers['x-ds4-node'],'spark2');assert.equal(result.headers['x-ds4-affinity'],'rebalanced');
  assert.equal(r.backends[1].records.at(-1).body.toString(),body);
  assert.equal(r.gateway.stats().continuity.automatic_relocation_scope,'first_unaffined_or_affinity_wait_expired');
  assert.equal(r.gateway.stats().continuity.automatic_affinity_rebalance_min_wait_ms,25);
  assert.equal(r.gateway.stats().continuity.relocation.last.actor,'scheduler');
});
test('strict-affinity opt-out never auto-moves an established session',async t=>{
  const r=await rig(t,2,{automatic_affinity_rebalance_min_wait_ms:false});
  await r.request('{"seed":"a"}','a');await r.request('{"seed":"b"}','b');await r.request('{"seed":"c"}','c');
  const active=r.request('{"delay":100,"active":"c"}','c');await until(()=>r.gateway.nodes[0].active);
  const queued=r.request('{"queued":"a"}','a');await until(()=>r.gateway.nodes[0].queue.length===1);
  assert.equal(r.gateway.stats().continuity.relocation.diagnostics.sources[0].automatic_reason,'affinity_automatic_disabled');
  await Promise.all([active,queued]);assert.equal(r.backends[1].records.filter(x=>x.payload.queued).length,0);
  assert.equal(r.gateway.stats().continuity.automatic_affinity_rebalance_min_wait_ms,null);
});
test('operator-confirmed pre-dispatch handover preserves body, client, deadline and durable ownership',async t=>{
  const r=await rig(t,2,{control_socket:true,dataset_enabled:true});
  await r.request('{"seed":"a"}','a');await r.request('{"seed":"b"}','b');await r.request('{"seed":"c"}','c');
  const active=r.request('{"delay":250,"active":"c"}','c');await until(()=>r.gateway.nodes[0].active);
  const body='{"reasoning_effort":"xhigh","max_tokens":262144,"queued":"a"}',queued=r.request(body,'a');
  await until(()=>r.gateway.nodes[0].queue.length===1);
  const registry=await workerControl(r.config.control_socket,'/workers'),offer=registry.queued_relocation.offers[0];
  assert.deepEqual({source:offer.source,destination:offer.destination,affinity:offer.affinity},{source:'spark1',destination:'spark2',affinity:'existing'});
  const diagnostic=registry.queued_relocation.diagnostics.sources[0];
  assert.deepEqual({source:diagnostic.source,destination:diagnostic.destination,reason:diagnostic.reason,automatic_reason:diagnostic.automatic_reason},{source:'spark1',destination:'spark2',reason:'offer_ready',automatic_reason:'automatic_wait_threshold'});
  assert.equal(registry.queued_relocation.automatic,true);assert.equal(registry.queued_relocation.automatic_scope,'first_unaffined_or_affinity_wait_expired');
  assert.equal(r.gateway.stats().continuity.automatic_relocation,true);
  const receipt=await workerControl(r.config.control_socket,'/relocate-queued',{request_id:offer.request_id,source:offer.source,destination:offer.destination,evidence_id:offer.evidence_id});
  assert.equal(receipt.state,'relocated');assert.equal(receipt.dispatch_state,'not_dispatched');assert.equal(receipt.body_replayed,false);assert.equal(receipt.deadline_preserved,true);
  const result=await queued;await active;
  assert.equal(result.headers['x-ds4-node'],'spark2');assert.equal(result.headers['x-ds4-affinity'],'rebalanced');
  assert.equal(r.backends[1].records.at(-1).body.toString(),body);assert.equal(r.backends[0].records.filter(x=>x.payload.queued==='a').length,0);
  assert.equal(r.gateway.store.get(createHash('sha256').update('a').digest('hex')).node,'spark2');
  await until(()=>r.gateway.stats().dataset.finished>=2);await r.restart();
  assert.equal((await r.request('{}','a')).headers['x-ds4-node'],'spark2');
});
test('Genie can execute only an exact mature pre-dispatch relocation offer',async t=>{
  const r=await rig(t,2,{control_socket:true,genie_rebalance_min_wait_ms:0});
  await r.request('{"seed":"a"}','a');await r.request('{"seed":"b"}','b');await r.request('{"seed":"c"}','c');
  const active=r.request('{"delay":250,"active":"c"}','c');await until(()=>r.gateway.nodes[0].active);
  const queued=r.request('{"queued":"a"}','a');await until(()=>r.gateway.nodes[0].queue.length===1);
  const offer=r.gateway.stats().continuity.relocation.genie_offers[0];assert.equal(offer.destination_immediately_free,true);assert.equal(offer.cache_locality,'unknown');
  await assert.rejects(workerControl(r.config.control_socket,'/genie-relocate-queued',{...offer,destination:'spark1'}),/evidence or policy changed/);
  const input=Object.fromEntries(['request_id','source','destination','evidence_id'].map(key=>[key,offer[key]]));
  const receipt=await workerControl(r.config.control_socket,'/genie-relocate-queued',input);assert.equal(receipt.actor,'genie');assert.equal(receipt.dispatch_state,'not_dispatched');
  assert.equal((await queued).headers['x-ds4-node'],'spark2');await active;
});
test('queued handover refuses stale or unsafe evidence and persistence failure leaves work at home',async t=>{
  const r=await rig(t,2,{control_socket:true});
  await r.request('{}','a');await r.request('{}','b');await r.request('{}','c');
  const active=r.request('{"delay":220}','c');await until(()=>r.gateway.nodes[0].active);
  const queued=r.request('{"kept":"home"}','a');await until(()=>r.gateway.nodes[0].queue.length===1);
  const offer=(await workerControl(r.config.control_socket,'/workers')).queued_relocation.offers[0],save=r.gateway.store.save.bind(r.gateway.store);
  r.gateway.store.save=()=>{throw new Error('disk full');};
  await assert.rejects(workerControl(r.config.control_socket,'/relocate-queued',{request_id:offer.request_id,source:offer.source,destination:offer.destination,evidence_id:offer.evidence_id}),/remains queued/);
  assert.equal(r.gateway.nodes[0].queue.length,1);assert.equal(r.gateway.nodes[1].active,null);r.gateway.store.save=save;
  await Promise.all([active,queued]);assert.equal(r.backends[0].records.at(-1).payload.kept,'home');assert.equal(r.backends[1].records.filter(x=>x.payload.kept).length,0);
  await assert.rejects(workerControl(r.config.control_socket,'/relocate-queued',{request_id:offer.request_id,source:offer.source,destination:offer.destination,evidence_id:offer.evidence_id}),/stale/);
});
test('same-session queue is never offered for handover',async t=>{
  const r=await rig(t,2,{control_socket:true});
  const active=r.request('{"delay":120}','same');await until(()=>r.gateway.nodes[0].active);
  const queued=r.request('{}','same');await until(()=>r.gateway.nodes[0].queue.length===1);
  const relocation=(await workerControl(r.config.control_socket,'/workers')).queued_relocation;
  assert.deepEqual(relocation.offers,[]);assert.deepEqual(relocation.diagnostics.idle_destinations,['spark2']);
  assert.deepEqual({source:relocation.diagnostics.sources[0].source,reason:relocation.diagnostics.sources[0].reason,conflicting_worker:relocation.diagnostics.sources[0].conflicting_worker},{source:'spark1',reason:'same_session_active',conflicting_worker:'spark1'});
  await Promise.all([active,queued]);
});
test('relocation diagnostics explain a busy fleet without exposing session identity',async t=>{
  const r=await rig(t,2,{control_socket:true});
  const first=r.request('{"delay":180}',null);const second=r.request('{"delay":180}',null);await until(()=>r.gateway.stats().active===2);
  const queued=r.request('{}',null);await until(()=>r.gateway.stats().queued===1);
  const d=(await workerControl(r.config.control_socket,'/workers')).queued_relocation.diagnostics;
  assert.deepEqual(d.idle_destinations,[]);assert.equal(d.sources.length,1);assert.equal(d.sources[0].reason,'no_idle_destination');assert.equal(d.sources[0].automatic_reason,'no_idle_destination');
  assert.equal(JSON.stringify(d).includes('session'),false);await Promise.all([first,second,queued]);
});
test('first DSG request automatically takes the first newly free server without a cache-locality tradeoff',async t=>{
  const r=await rig(t,2);
  const slow=r.request('{"delay":1800,"job":"slow"}','a');await until(()=>r.gateway.nodes[0].active);
  const fast=r.request('{"delay":100,"job":"fast"}','b');await until(()=>r.gateway.nodes[1].active);
  const body='{"reasoning_effort":"xhigh","job":"first"}',first=r.request(body,'never-seen');
  await until(()=>r.gateway.nodes[0].queue.length===1);await fast;
  const result=await first;assert.equal(result.headers['x-ds4-node'],'spark2');assert.equal(result.headers['x-ds4-affinity'],'rebalanced');
  assert.equal(r.backends[1].records.at(-1).body.toString(),body);assert.equal(r.gateway.stats().continuity.relocation.completed,1);
  await slow;
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
test('disconnect before response headers cancels DS4 work and releases the gateway slot', async t => {
  const r=await rig(t,1);
  const req=http.request({host:'127.0.0.1',port:r.address.port,path:'/v1/chat/completions',method:'POST',headers:{authorization:'Bearer none','x-session-affinity':'early-close'}});
  req.on('error',()=>{});req.end('{"stream":false,"delay":10000}');
  await until(()=>r.backends[0].active===1&&r.gateway.stats().active===1);
  req.destroy();
  await until(()=>r.backends[0].aborts===1&&r.gateway.stats().active===0);
  assert.equal((await r.request('{}','next')).status,200);
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
test('patient wait cannot fail over while the same conversation is active', async t => {
  const r = await rig(t);
  const first = r.request('{"delay":180}', 'a'); await until(() => r.gateway.stats().active === 1);
  r.gateway.nodes[0].healthy = false;
  const next=r.request('{}','a');await until(()=>r.gateway.stats().continuity.waiting===1);
  assert.equal(r.backends[1].records.length,0);await first;
  assert.equal((await next).status,200);
  assert.equal(r.backends[1].records.length, 1,'a new never-admitted call may reassign after ownership settles');
});
test('unrelated old-home work does not block conversation-scoped reassignment',async t=>{
  const r=await rig(t,2,{dataset_enabled:true});
  await r.request('{}','a');await r.request('{}','b');
  const old=r.gateway.nodes[0];r.gateway.store.set(createHash('sha256').update('b').digest('hex'),old.id);
  const busy=r.request('{"delay":250}','b');await until(()=>old.active);
  old.healthy=false;
  const result=await r.request('{}','a');assert.equal(result.status,200);assert.equal(result.headers['x-ds4-node'],'spark2');assert.equal(result.headers['x-ds4-affinity'],'reassigned');
  const same=r.request('{}','b');await until(()=>r.gateway.stats().continuity.waiting===1);
  assert.equal(r.gateway.stats().continuity.waiting_reasons.same_session_active,1);
  assert.equal(r.backends[1].records.length,2);await busy;assert.equal((await same).status,200);assert.equal(r.backends[1].records.length,3);
});
test('paused same-session queue retains ownership and timeout receipts exclude private headers',async t=>{
  const r=await rig(t,2,{dataset_enabled:true,queue_timeout_ms:150});
  const first=r.request('{"delay":250}','a');await until(()=>r.gateway.nodes[0].active);
  const second=r.request('{}','a');await until(()=>r.gateway.nodes[0].queue.length===1);
  r.gateway.nodes[0].drained=true;
  const call=randomUUID(),rejected=await r.request('{}','a',{headers:{'x-dsg-call-id':call,'x-private':'SECRET'}});
  const e=JSON.parse(rejected.body).error;
  assert.equal(e.continuity.call_id,call);assert.equal(e.continuity.dispatch_state,'not_dispatched');assert.equal(e.continuity.retry_class,'wait_then_retry');assert.equal(rejected.headers['x-request-id'],e.request_id);
  assert.ok(!JSON.stringify(r.gateway.stats().continuity).includes('SECRET'));
  assert.equal((await first).status,200);assert.equal((await second).status,504);assert.equal(r.backends[1].records.length,0);
});
test('queued conversation cannot split behind another active session; failed reassignment does not dispatch',async t=>{
  const r=await rig(t,2,{queue_timeout_ms:150});await r.request('{}','a');
  r.gateway.store.set(createHash('sha256').update('b').digest('hex'),'spark1');
  const first=r.request('{"delay":250}','b');await until(()=>r.gateway.nodes[0].active);
  const second=r.request('{}','a');await until(()=>r.gateway.nodes[0].queue.length===1);
  r.gateway.nodes[0].healthy=false;
  const later=r.request('{}','a');await until(()=>r.gateway.stats().continuity.waiting===1);
  assert.equal(r.backends[1].records.length,0);
  assert.equal((await second).status,504);assert.equal((await later).status,200);await first;
  r.gateway.store.set(createHash('sha256').update('c').digest('hex'),'spark1');
  const save=r.gateway.store.save;r.gateway.store.save=()=>{throw new Error('fixture storage failure');};
  const failed=await r.request('{}','c');assert.equal(JSON.parse(failed.body).error.continuity.retry_class,'operator_required');
  assert.equal(r.backends[1].records.length,1);r.gateway.store.save=save;
});
test('queue bound rejects without dispatch, queue timeout does not cap generation', async t => {
  const r = await rig(t, 2, { max_queued_per_node: 1, queue_timeout_ms: 50 });
  const first = r.request('{"delay":170}', 'a'); await until(() => r.gateway.stats().active === 1);
  const second = r.request('{}', 'a'); await until(() => r.gateway.stats().queued === 1);
  assert.equal((await r.request('{}', 'a')).status, 429);
  const expired=await second;assert.equal(expired.status,504);
  const failure=JSON.parse(expired.body).error;assert.equal(failure.type,'gateway_error');assert.equal(failure.code,'queue_timeout');
  assert.match(failure.message,/limit of 50 milliseconds/);assert.match(failure.message,/was not dispatched to a model server/);
  assert.match(failure.message,/configurable in DSG under Manage DS4 servers → Queue waiting allowance \(hours\)/);
  assert.equal((await first).status, 200);
  assert.equal(r.backends[0].records.length, 1);
});
test('default long queue has no timer overflow and cancellation/dispatch clear its timers',async t=>{
  const r=await rig(t,1);assert.equal(r.gateway.stats().queue_timeout_ms,72000000000);assert.equal(r.gateway.stats().request_timeout_ms,360000000);
  const first=r.request('{"delay":200}','first');await until(()=>r.gateway.stats().active===1);
  const second=r.request('{}','second');await until(()=>r.gateway.stats().queued===1);await delay(40);
  assert.equal(r.gateway.stats().queued,1,'20,000 hours must not overflow into a 1 ms timeout');
  assert.equal((await first).status,200);assert.equal((await second).status,200);assert.equal(r.gateway.stats().queued,0);
  const active=r.request('{"delay":120}','first');await until(()=>r.gateway.stats().active===1);
  const req=http.request({host:'127.0.0.1',port:r.address.port,path:'/v1/chat/completions',method:'POST',headers:{authorization:'Bearer none','content-type':'application/json'}});req.on('error',()=>{});req.end('{}');
  await until(()=>r.gateway.stats().queued===1);req.destroy();await until(()=>r.gateway.stats().queued===0);await active;assert.equal(r.backends[0].records.length,3);
});
test('queue allowance control persists, is operator-only and preserves admitted deadlines',async t=>{
  const r=await rig(t,1,{control_socket:true}),ctl=(b)=>workerControl(r.config.control_socket,'/set-queue-timeout',b);
  const old=r.gateway.stats().queue_timeout_ms;
  const first=r.request('{"delay":220}','a');await until(()=>r.gateway.stats().active===1);
  const second=r.request('{}','b');await until(()=>r.gateway.stats().queued===1);
  const initialJob=r.gateway.nodes[0].queue[0];assert.equal(initialJob.queueTimeoutMs,old);
  const updated=await ctl({queue_timeout_ms:40,expected_queue_timeout_ms:old});assert.equal(updated.queue_timeout_ms,40);assert.equal(updated.queue_timeout_source,'saved');assert.equal(initialJob.queueTimeoutMs,old);
  assert.ok(r.gateway.stats().workers[0].oldest_queue_remaining_seconds>1000000);
  const expiry=await r.request('{}','c');assert.equal(expiry.status,504);assert.equal((await first).status,200);assert.equal((await second).status,200);
  assert.equal(r.backends[0].records.length,2);assert.equal(r.gateway.stats().context_length,153600);assert.equal(r.gateway.stats().request_timeout_ms,360000000);
  assert.ok(fs.readdirSync(path.dirname(r.config.state_file)).some(f=>f.includes('.queue-')));
  await assert.rejects(ctl({queue_timeout_ms:50,expected_queue_timeout_ms:old}),/changed/);
  for(const value of [0,-1,null,'20000',1.5])await assert.rejects(ctl({queue_timeout_ms:value,expected_queue_timeout_ms:40}),/positive whole/);
  await assert.rejects(ctl({queue_timeout_ms:50,expected_queue_timeout_ms:40,model:'no'}),/positive whole/);
  const save=r.gateway.store.save;r.gateway.store.save=()=>{throw new Error('simulated storage failure');};
  await assert.rejects(ctl({queue_timeout_ms:60,expected_queue_timeout_ms:40}),/storage failure/);assert.equal(r.gateway.stats().queue_timeout_ms,40);r.gateway.store.save=save;
  assert.equal((await r.request('{}',null,{path:'/set-queue-timeout'})).status,404);
  await r.restart();assert.equal(r.gateway.stats().queue_timeout_ms,40);assert.equal(r.gateway.stats().workers[0].oldest_queue_seconds,null);
  const grant=await workerControl(r.config.control_socket,'/grant-agent',{agent_id:'queue-tester',workers:['spark1']});
  const forbidden=await new Promise((resolve,reject)=>{const req=http.request({socketPath:r.config.control_socket,path:'/set-queue-timeout',method:'POST',headers:{authorization:`Bearer ${grant.token}`}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.end(JSON.stringify({queue_timeout_ms:80,expected_queue_timeout_ms:40}));});assert.equal(forbidden,403);assert.equal(r.gateway.stats().queue_timeout_ms,40);
});
test('queue timeout reports the admitted limit after the operator changes the allowance',async t=>{
  const r=await rig(t,1,{control_socket:true,queue_timeout_ms:100});
  const first=r.request('{"delay":300}','a');await until(()=>r.gateway.stats().active===1);
  const second=r.request('{}','b');await until(()=>r.gateway.stats().queued===1);
  await workerControl(r.config.control_socket,'/set-queue-timeout',{queue_timeout_ms:72000000000,expected_queue_timeout_ms:100});
  assert.equal(r.gateway.stats().queue_timeout_ms,72000000000);
  const expired=await second;assert.equal(expired.status,504);
  const failure=JSON.parse(expired.body).error;assert.equal(failure.code,'queue_timeout');
  assert.match(failure.message,/limit of 100 milliseconds/);assert.doesNotMatch(failure.message,/20,000 hours/);
  assert.match(failure.message,/changes apply to new requests/);
  assert.equal((await first).status,200);assert.equal(r.backends[0].records.length,1,'expired request was never dispatched');
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
  const held=r.request('{}','a');await until(()=>r.gateway.stats().continuity.waiting===1);
  assert.equal((await r.request('{}', 'new')).headers['x-ds4-node'], 'spark2');
  await first; assert.equal(r.gateway.stats().workers[0].gateway_drained, true);
  assert.equal((await held).headers['x-ds4-node'],'spark2');
  assert.equal((await r.request('{}', 'a')).headers['x-ds4-node'], 'spark2');
  await r.restart(); assert.equal(r.gateway.stats().workers[0].drained, true);
  r.gateway.drainNodes(['spark1'], false);
  assert.equal((await r.request('{}', 'a')).headers['x-ds4-node'], 'spark2');
  r.gateway.drainNodes(['spark1', 'spark2'], true);
  assert.equal((await r.request('',null,{path:'/v1/models',method:'GET'})).status,503);
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
