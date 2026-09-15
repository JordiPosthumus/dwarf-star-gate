import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {createHourglassMaintenance} from './hourglass-maintenance.mjs';
import {HourglassRuns} from './hourglass-runs.mjs';
import {createDashboard} from './dashboard.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
async function until(fn){for(let i=0;i<100;i++){if(await fn())return;await new Promise(r=>setTimeout(r,50));}throw new Error('Fixture did not reach its expected state');}
function fixture(t,{realRunner=false}={}){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'sg-owned-hourglass-')),operations=path.join(directory,'operations');
  const records=path.join(directory,'records');fs.mkdirSync(path.join(records,'approved'),{recursive:true});fs.writeFileSync(path.join(records,'approved/worker.json'),'{}');
  const config={ui_worker_management:true,control_socket:'/fixture.sock',server_records_directory:records,
    genie_chat:{python:execFileSync('python3',['-c','import sys;print(sys.executable)'],{encoding:'utf8'}).trim(),inspection:{workers:{worker:{ssh:['fixture'],container:'fixture'}}}},
    hourglass_console:{url:'http://127.0.0.1:4534',targets:[{model:'example',worker_id:'worker',route:'direct',maintenance:{native_url:'http://127.0.0.1:8001'}}]}};
  const calls=[],services=[],stores=[];let phase='waiting',job=null,result=null;
  const client={async prepare(model){const review={id:randomUUID(),model,model_id:'native',endpoint:'http://127.0.0.1:38011/v1',question_count:1,window_seconds:3600,models_revision:'a'.repeat(64),hardware_revision:'b'.repeat(64),settings:{max_tokens:262144}};this.prepared={review,controller:'fixture',payload:{model,tasks:['fixture'],repeat:1}};return structuredClone(review);},
    async submit(){assert.fail('Owned run must use its independent runner, never the dashboard native submit');},
    async observe(){return {state:'completed'};},async report(){return {summary:{state:'final',score:{value:12,version:'fixture'}}};}};
  const runner={async launch(input){calls.push(['launch',input]);},async observe(){return {state:result?'completed':'running',process_alive:!result,progress:{phase,detail:'Waiting for current work.',heartbeat_at:1},result};}};
  const prepare=async(_python,input)=>{
    calls.push(['prepare',input]);assert.equal(input.prepared.payload.model,'example');
    const source=`import json,time\nfrom pathlib import Path\ndef execute(plan,folder,progress):\n folder=Path(folder)\n progress('waiting','Waiting for fixture completion.')\n (folder/'native-acceptance.json').write_text(json.dumps({'job_id':'${'d'.repeat(32)}'}))\n while not (folder/'finish-fixture').exists(): time.sleep(0.05)\n return {'state':'completed','measurement':{'job_id':'${'d'.repeat(32)}','native_state':'completed','readmission':{'state':'readmitted'}}}\n`;
    const file=path.join(input.directory,'executor.py');fs.writeFileSync(file,source);
    return {plan:{id:input.proposal.id,worker_id:'worker',record_file:path.join(records,'approved/worker.json'),record_revision:input.record_revision,execution:{path:file,sha256:hash(source)}},
      review:{observed:{image:'fixture-image',command:['original']},scope:'Synthetic test execution only.'}};
  };
  const make=()=>{
    const service=createHourglassMaintenance(config,operations,{prepare,...(realRunner?{}:{runner})});services.push(service);
    const originalObserve=service.observe;
    if(!realRunner)service.observe=async id=>({...await originalObserve(id),job_id:job,result});
    const runs=new HourglassRuns(config.hourglass_console,path.join(directory,'history'),{client,maintenance:service});stores.push(runs);
    return {service,runs};
  };
  t.after(async()=>{
    for(const service of services)await service.store.idle();
    if(realRunner&&fs.existsSync(operations))for(const id of fs.readdirSync(operations)){
      const folder=path.join(operations,id);if(!fs.existsSync(path.join(folder,'launch-intent.json')))continue;
      fs.writeFileSync(path.join(folder,'finish-fixture'),'');
      await until(()=>fs.existsSync(path.join(folder,'runner-result.json')));
    }
    for(const runs of stores)runs.close();fs.rmSync(directory,{recursive:true,force:true});
  });
  return {directory,config,client,calls,make,complete(){phase='completed';job='d'.repeat(32);result={state:'completed',measurement:{native_state:'completed',readmission:{state:'readmitted'}}};},
    unknown(){result={state:'requires_reconciliation'};}};
}

test('owned review uses existing exact approval, persists before launch and never submits twice',async t=>{
  const f=fixture(t);let {runs,service}=f.make();
  await runs.change({action:'prepare',model:'example'});const p=runs.status().prepared;
  assert.equal(p.association.contention,'owned-maintenance');assert.ok(p.maintenance.plan_revision);
  assert.equal(service.store.read(p.id,'approved.json'),null);
  await assert.rejects(runs.change({action:'start',id:p.id,plan_revision:'f'.repeat(64)}));
  await assert.rejects(runs.change({action:'start',id:p.id,owner_confirmed_idle:true}));
  await runs.change({action:'start',id:p.id,plan_revision:p.maintenance.plan_revision});await service.store.idle();
  assert.equal(service.store.read(p.id,'approved.json').actor,'owner');
  assert.equal(runs.status().runs[0].owned,true);assert.equal(f.calls.filter(c=>c[0]==='launch').length,1);
  runs.close();({runs,service}=f.make());
  assert.equal(runs.status().available,true);await runs.change({action:'refresh'});
  assert.equal(runs.status().runs[0].progress.phase,'waiting');assert.equal(runs.status().blocked,true);
  await runs.change({action:'start',id:p.id,plan_revision:p.maintenance.plan_revision});
  assert.equal(f.calls.filter(c=>c[0]==='launch').length,1);
  f.complete();await runs.change({action:'refresh'});
  assert.equal(runs.status().runs[0].state,'completed');assert.equal(runs.status().blocked,false);
  assert.equal(runs.status().runs[0].report.summary.score.value,12);
});

test('uncertain owned outcome cannot be cleared by the direct-run checkbox or replayed after restart',async t=>{
  const f=fixture(t);let {runs,service}=f.make();await runs.change({action:'prepare',model:'example'});const p=runs.status().prepared;
  await runs.change({action:'start',id:p.id,plan_revision:p.maintenance.plan_revision});await service.store.idle();
  f.unknown();await runs.change({action:'refresh'});assert.equal(runs.status().blocked,true);
  await assert.rejects(runs.change({action:'resolve',id:p.id,checked_in_hourglass:true}));
  runs.close();({runs}=f.make());await runs.change({action:'refresh'});
  assert.equal(runs.status().available,true);assert.match(runs.status().runs[0].error,/inspection/);
  assert.equal(f.calls.filter(c=>c[0]==='launch').length,1);
});

test('native receipt saving failure does not trigger another owned launch',async t=>{
  const f=fixture(t),{runs,service}=f.make();await runs.change({action:'prepare',model:'example'});const p=runs.status().prepared;
  const save=runs.save.bind(runs);let count=0;runs.save=rows=>{if(++count===2)throw new Error('fixture disk fault');return save(rows);};
  await runs.change({action:'start',id:p.id,plan_revision:p.maintenance.plan_revision});await service.store.idle();
  assert.equal(runs.status().runs[0].state,'uncertain');await runs.change({action:'refresh'});
  assert.equal(runs.status().runs[0].state,'owned');assert.equal(f.calls.filter(c=>c[0]==='launch').length,1);
});

test('changed approved record rejects before launch and permits a fresh review',async t=>{
  const f=fixture(t),{runs,service}=f.make();await runs.change({action:'prepare',model:'example'});const p=runs.status().prepared;
  fs.appendFileSync(path.join(f.directory,'records/approved/worker.json'),'\n');
  await runs.change({action:'start',id:p.id,plan_revision:p.maintenance.plan_revision});
  assert.equal(runs.status().runs[0].state,'rejected');assert.equal(runs.status().blocked,false);
  assert.equal(service.store.read(p.id,'launch-intent.json'),null);
  assert.equal(f.calls.filter(c=>c[0]==='launch').length,0);
  await runs.change({action:'prepare',model:'example'});assert.notEqual(runs.status().prepared.id,p.id);
});

test('owner HTTP Start is required; Genie tool cannot approve an owned measurement',async t=>{
  const f=fixture(t),{runs,service}=f.make(),server=createDashboard(()=>({}),undefined,null,null,null,null,null,null,null,runs);
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});
  const origin=`http://127.0.0.1:${server.address().port}`;
  const status=()=>fetch(origin+'/api/hourglass').then(r=>r.json());let s=await status();
  const post=(route,body,headers)=>fetch(origin+route,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});
  assert.equal((await post('/api/genie/hourglass-tools',{action:'prepare',model:'example'},{'x-sg-hourglass-tool':runs.toolConfig.token})).status,200);
  s=await status();const p=s.prepared,body={action:'start',id:p.id,plan_revision:p.maintenance.plan_revision};
  assert.equal((await post('/api/genie/hourglass-tools',body,{'x-sg-hourglass-tool':runs.toolConfig.token})).status,409);
  assert.equal((await post('/api/hourglass',body,{})).status,403);
  assert.equal(service.store.read(p.id,'approved.json'),null);
  assert.equal((await post('/api/hourglass',body,{origin,'x-dsg-csrf':s.csrf_token})).status,200);
  await service.store.idle();assert.equal(f.calls.filter(c=>c[0]==='launch').length,1);
});

test('the independent process survives dashboard close and is observed after restart',async t=>{
  const f=fixture(t,{realRunner:true});let {runs,service}=f.make();
  await runs.change({action:'prepare',model:'example'});const p=runs.status().prepared;
  await runs.change({action:'start',id:p.id,plan_revision:p.maintenance.plan_revision});await service.store.idle();
  await until(()=>fs.existsSync(path.join(service.store.folder(p.id),'native-acceptance.json')));
  runs.close();({runs,service}=f.make());await runs.change({action:'refresh'});
  assert.equal(runs.status().runs[0].process_alive,true);assert.equal(runs.status().runs[0].job_id,'d'.repeat(32));
  const claim=service.store.read(p.id,'runner-started.json');
  await runs.change({action:'start',id:p.id,plan_revision:p.maintenance.plan_revision});
  assert.deepEqual(service.store.read(p.id,'runner-started.json'),claim);
  fs.writeFileSync(path.join(service.store.folder(p.id),'finish-fixture'),'');
  await until(()=>service.store.read(p.id,'runner-result.json'));
  await runs.change({action:'refresh'});assert.equal(runs.status().runs[0].state,'completed');
  assert.equal(runs.status().blocked,false);
});
