import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {HourglassConsole} from './hourglass-console.mjs';

const credentialUrl=()=>{const u=new URL('http://127.0.0.1:4534');u.username='synthetic-user';u.password='synthetic-password';return u.href;};
const health=()=>({app:'Hourglass',version:2,controller_instance:'controller-one',shutting_down:false});
const state=()=>({app:'Hourglass',version:2,benchmark_version:'4.0.0',models_revision:'a'.repeat(64),endpoint_hardware:{revision:'b'.repeat(64)},
  model_configs:[{name:'example',model:'example-native-id',base_url:'http://127.0.0.1:8001/v1',max_tokens:262144,context_window:262144,reasoning:'xhigh',temperature:0,
    api_key:'PRIVATE_CREDENTIAL',extra:{top_k:20},notes:'PRIVATE_NOTES'}],
  tasks:[{id:'question-one',task_bundle_sha:'c'.repeat(64),issues:[],title:'PRIVATE_QUESTION'}],jobs:{running:[],pending:[],done:[]},
  score_policy:{window_s:3600,metric:'total-points-v1',scoring_policy:'net-hour-v3'},results:[{answer:'PRIVATE_ANSWER'}]});
function fixture({modify=()=>{},reply=()=>Response.json({ok:true,job:'d'.repeat(32)})}={}){
  const calls=[],s=state(),h=health();modify(s,h);
  const client=new HourglassConsole('http://127.0.0.1:4534',{fetchImpl:async(url,options)=>{
    calls.push({url,options});return url.endsWith('/api/health')?Response.json(h):url.endsWith('/api/state')?Response.json(s):reply();
  }});return {client,calls,s,h};
}

test('catalogue and preparation do not start work or expose raw model documents and question data',async()=>{
  const {client,calls}=fixture();assert.deepEqual((await client.catalogue()).models,[{name:'example'}]);
  const p=await client.prepare('example');assert.equal(p.settings.temperature,0);assert.equal(p.settings.max_tokens,262144);assert.equal(p.settings.reasoning,'xhigh');
  assert.equal(p.window_seconds,3600);assert.equal(p.question_count,1);assert.match(p.scope,/not summarized here/);
  assert.doesNotMatch(JSON.stringify(p),/PRIVATE_|question-one|api_key|task_bundle/);assert.ok(calls.every(c=>c.options.method==='GET'));
});

test('explicit start sends the full reviewed native contract once and never rewrites model settings',async()=>{
  const {client,calls}=fixture();const p=await client.prepare('example');p.models_revision='edited-client-value';p.settings.max_tokens=1;
  await assert.rejects(client.submit(p.id),/explicitly/);assert.equal(calls.filter(c=>c.options.method==='POST').length,0);
  const receipt=await client.submit(p.id,{ownerConfirmedIdle:true});assert.equal(receipt.job_id,'d'.repeat(32));assert.equal(receipt.review.settings.max_tokens,262144);
  const post=calls.find(c=>c.options.method==='POST');assert.deepEqual(JSON.parse(post.options.body),{model:'example',tasks:['question-one'],repeat:1,
    models_revision:'a'.repeat(64),hardware_revision:'b'.repeat(64),task_bundles:{'question-one':'c'.repeat(64)}});
  assert.equal(post.options.redirect,'error');assert.equal(post.options.headers.origin,'http://127.0.0.1:4534');
  await assert.rejects(client.submit(p.id,{ownerConfirmedIdle:true}));assert.equal(calls.filter(c=>c.options.method==='POST').length,1);
});

test('unavailable revision, changed controller, busy bench and broken banks cannot dispatch a new run',async()=>{
  for(const modify of [s=>s.models_revision=null,s=>s.endpoint_hardware.revision=null,s=>s.score_policy.window_s=60,
    s=>s.jobs.running.push({id:'active'}),s=>s.jobs.pending.push({id:'waiting'}),s=>s.tasks[0].issues.push('missing'),
    s=>s.tasks.push({...s.tasks[0]}),s=>s.tasks[0].task_bundle_sha=null,s=>s.model_configs[0].base_url=credentialUrl()]){
    const f=fixture({modify});await assert.rejects(f.client.prepare('example'));assert.ok(f.calls.every(c=>c.options.method==='GET'));
  }
  const f=fixture(),p=await f.client.prepare('example');f.h.controller_instance='replacement';
  await assert.rejects(f.client.submit(p.id,{ownerConfirmedIdle:true}),/controller changed/);assert.ok(f.calls.every(c=>c.options.method==='GET'));
});

test('ambiguous submission and rejection responses never replay or reveal native error bodies',async()=>{
  for(const [reply,uncertain] of [[()=>{throw new Error('PRIVATE_NETWORK');},true],
    [()=>Response.json({error:'PRIVATE_BODY'},{status:500}),true],[()=>Response.json({error:'PRIVATE_BODY'},{status:400}),false],
    [()=>Response.json({ok:true}),true],[()=>new Response('PRIVATE_NOT_JSON'),true]]){
    const f=fixture({reply}),p=await f.client.prepare('example');
    await assert.rejects(f.client.submit(p.id,{ownerConfirmedIdle:true}),e=>{assert.equal(e.uncertain,uncertain);assert.doesNotMatch(e.message,/PRIVATE_/);return true;});
    await assert.rejects(f.client.submit(p.id,{ownerConfirmedIdle:true}));assert.equal(f.calls.filter(c=>c.options.method==='POST').length,1);
  }
});

test('transport is loopback-only, bounded and refuses redirects without contacting their destination',async t=>{
  for(const url of ['https://127.0.0.1:4534','http://example.invalid','http://localhost:4534','http://127.0.0.1:4534/path',credentialUrl(),'http://127.0.0.1:4534/?key=secret'])assert.throws(()=>new HourglassConsole(url));
  let requests=0;const server=http.createServer((_req,res)=>{requests++;res.writeHead(302,{location:'http://127.0.0.1:1/PRIVATE_DESTINATION'});res.end();});
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});
  const c=new HourglassConsole(`http://127.0.0.1:${server.address().port}`);await assert.rejects(c.catalogue(),/unavailable/);assert.equal(requests,1);
  const oversized=new HourglassConsole('http://127.0.0.1:4534',{maxBytes:5,fetchImpl:async()=>Response.json(health())});
  await assert.rejects(oversized.catalogue(),/unavailable/);
});
