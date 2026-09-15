// Invoked by the isolated native fixture; no live installation is loaded.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createGateway} from '../ds4-gateway/gateway.mjs';
import {runDashboard} from '../ds4-gateway/dashboard.mjs';

const root=process.argv[2],configFile=path.join(root,'stargate.json');
const interrupt=process.argv[3]==='interrupt';
const config=JSON.parse(fs.readFileSync(configFile,'utf8'));
const phase=value=>fs.writeFileSync(path.join(root,'fixture-phase.json'),JSON.stringify({phase:value}));
async function until(check,seconds=90){
  const end=Date.now()+seconds*1000;
  while(Date.now()<end){const result=await check();if(result)return result;await delay(200);}
  throw new Error('Isolated owned measurement did not reach the expected state');
}
let gateway,app,request,operation;
const read=(name)=>{try{return JSON.parse(fs.readFileSync(path.join(operation,name),'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}};
try{
  gateway=createGateway(config);const address=await gateway.start();
  config.port=address.port;fs.writeFileSync(configFile,JSON.stringify(config));
  assert.equal(gateway.nodes.filter(w=>w.healthy).length,2);
  app=await runDashboard(configFile,0);
  const origin=()=>`http://127.0.0.1:${app.server.address().port}`;
  const status=()=>fetch(origin()+'/api/hourglass').then(r=>r.json());
  const post=async body=>{
    const s=await status(),r=await fetch(origin()+'/api/hourglass',{method:'POST',
      headers:{origin:origin(),'content-type':'application/json','x-dsg-csrf':s.csrf_token},body:JSON.stringify(body)});
    const value=await r.json();assert.equal(r.status,200,JSON.stringify(value));return value;
  };
  let ended=false;
  gateway.drainNodes(['spare'],true,'fixture_setup');
  request=fetch(`http://127.0.0.1:${address.port}/v1/chat/completions`,{method:'POST',
    headers:{authorization:'Bearer fixture','content-type':'application/json','x-session-affinity':'held-fixture'},
    body:JSON.stringify({model:'fixture-model',messages:[{role:'user',content:'fixture-hold'}],max_tokens:16})})
    .then(async r=>{assert.equal(r.status,200);const b=await r.json();ended=true;return b;});
  await until(()=>gateway.registry().workers.find(w=>w.id==='worker').load===1);
  gateway.drainNodes(['spare'],false,'fixture_setup');
  const prepared=(await post({action:'prepare',model:'owned-fixture'})).prepared;
  assert.ok(prepared.maintenance?.plan_revision);
  operation=path.join(root,'hourglass/operations',prepared.id);
  assert.equal(read('approved.json'),null);
  await post({action:'start',id:prepared.id,plan_revision:prepared.maintenance.plan_revision});
  await until(()=>gateway.registry().workers.find(w=>w.id==='worker').drained);
  assert.equal(ended,false);assert.equal(read('native-start-intent.json'),null);
  const spare=await fetch(`http://127.0.0.1:${address.port}/v1/chat/completions`,{method:'POST',
    headers:{authorization:'Bearer fixture','content-type':'application/json'},
    body:JSON.stringify({model:'fixture-model',messages:[{role:'user',content:'spare check'}],max_tokens:16})});
  assert.equal(spare.status,200);assert.equal((await spare.json()).choices[0].message.content,'spare');
  assert.equal(ended,false);phase('release_active_request');
  assert.equal((await request).choices[0].message.content,'held request finished');
  const acceptance=await until(()=>read('native-acceptance.json'));
  await post({action:'refresh'});
  assert.equal((await status()).runs[0].job_id,acceptance.job_id);
  const claim=read('runner-started.json');assert.ok(claim.pid);
  app.close();app=await runDashboard(configFile,0);
  await post({action:'refresh'});
  assert.equal((await status()).runs[0].job_id,acceptance.job_id);
  assert.equal((await status()).runs[0].process_alive,true);
  await post({action:'start',id:prepared.id,plan_revision:prepared.maintenance.plan_revision});
  assert.deepEqual(read('runner-started.json'),claim);
  if(interrupt){
    // This PID belongs to the independently launched synthetic fixture only.
    // The copied native job remains intact; no model or benchmark is cancelled.
    process.kill(claim.pid,'SIGTERM');
    await until(()=>{try{process.kill(claim.pid,0);return false;}catch(e){if(e.code==='ESRCH')return true;throw e;}});
    assert.equal(read('runner-result.json'),null);
  }
  phase('complete_synthetic_measurement');
  if(interrupt){
    await until(async()=>{const state=await fetch(config.hourglass_console.url+'/api/state').then(r=>r.json());return state.jobs.done.some(j=>j.id===acceptance.job_id&&j.state==='completed');});
    await post({action:'refresh'});
    const reviewed=(await post({action:'inspect-return',id:prepared.id})).runs[0].return_review;
    assert.equal(reviewed.review.job_id,acceptance.job_id);
    const returning={action:'return',id:prepared.id,plan_revision:reviewed.plan_revision,review_revision:reviewed.review_revision};
    await post(returning);
    assert.equal(read('reconcile-approved.json').actor,'owner');
    assert.equal(read('runner-result.json'),null);
  }
  const result=await until(()=>read(interrupt?'reconcile-result.json':'runner-result.json'));
  assert.equal(result.state,'completed',JSON.stringify(result));
  assert.equal(result.measurement.readmission.state,'readmitted');
  await post({action:'refresh'});
  const final=(await status()).runs[0];
  assert.equal(final.state,'completed');assert.equal(final.report.summary.score.value,0);
  assert.equal(final.report.summary.active_seconds,3600);
  const worker=gateway.registry().workers.find(w=>w.id==='worker');
  assert.equal(worker.drained,false);assert.equal(worker.maintenance_locks.length,0);
  assert.equal(worker.max_concurrent_requests,1);
  fs.writeFileSync(path.join(root,'integration-result.json'),JSON.stringify({passed:true,operation_id:prepared.id,
    native_job:acceptance.job_id,active_request_finished:true,spare_served:true,dashboard_restart_observed_same_runner:true,
    interrupted_runner_returned:interrupt,readmitted:true,score:final.report.summary.score,scope:'Native API and lifecycle integration; model/Docker responses and benchmark completion are synthetic.'},null,2));
}finally{
  // Fixture coordination releases only simulated requests and marks only this
  // copied console's job terminal. It cannot contact a real console or server.
  phase('cleanup');
  if(request)await request.catch(()=>{});
  if(operation&&read('launch-intent.json'))await until(()=>read('runner-result.json')||read('reconcile-result.json'));
  app?.close();await gateway?.close();
}
