import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import http from 'node:http';
import {once} from 'node:events';
import {execFileSync} from 'node:child_process';
import {HourglassRuns,hourglassRunsForChat} from './hourglass-runs.mjs';
import {hourglassReportSummary} from './hourglass-report.mjs';
import {createDashboard,runDashboard} from './dashboard.mjs';



const config={url:'http://127.0.0.1:4534',targets:[{model:'example',worker_id:'example-worker',route:'direct'}]};
const nativeReport=()=>({format:'hourglass-public-report-v1',model:'Example model',state:'final',score_version:'total-points-v1',hourglass_score:0,benchmark_version:'4.0.0'});
function fixture(t){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'sg-hourglass-runs-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const calls=[],client={prepare:async model=>({id:randomUUID(),model,settings:{max_tokens:262144},window_seconds:3600}),
  submit:async id=>{calls.push('submit');const saved=JSON.parse(fs.readFileSync(path.join(directory,'runs.json')));assert.equal(saved.runs.at(-1).state,'submitting');assert.equal(saved.runs.at(-1).id,id);return {job_id:'d'.repeat(32)};},
  observe:async()=>{calls.push('observe');return {state:'completed',started:1,ended:3601};},
  report:async()=>({report_revision:'a'.repeat(64),summary:hourglassReportSummary(nativeReport())})};
 const make=()=>new HourglassRuns(config,directory,{client,records:()=>({records:[{worker_id:'example-worker',approved:{revision:'b'.repeat(64)}}]})});
 return {directory,client,calls,make};
}
async function start(runs){await runs.change({action:'prepare',model:'example'});const id=runs.status().prepared.id;await runs.change({action:'start',id,owner_confirmed_idle:true});return id;}

test('older saved report projections refresh counts once without replaying a native job',async t=>{
 const f=fixture(t),runs=f.make();t.after(()=>runs.close());await start(runs);await runs.change({action:'refresh'});
 const old=structuredClone(runs.runs);delete old[0].report.summary.timeouts;runs.save(old);
 let reads=0;f.client.report=async()=>{reads++;return {report_revision:'a'.repeat(64),summary:hourglassReportSummary({...nativeReport(),timeouts:1,raw_correct:20})};};
 await runs.change({action:'refresh'});assert.equal(runs.status().runs[0].report.summary.timeouts,1);await runs.change({action:'refresh'});
 assert.equal(runs.toolStatus().runs[0].job_id,'d'.repeat(32));
 assert.equal(reads,1);assert.equal(f.calls.filter(c=>c==='submit').length,1);
});

test('Genie preparation reports the actual future window handling without starting or reserving work',async t=>{
 const f=fixture(t),direct=f.make();t.after(()=>direct.close());
 const ordinary=await direct.tool({action:'prepare',model:'example'});
 assert.equal(ordinary.prepared.window,'owner-confirmed-idle');assert.match(ordinary.prepared.on_owner_start,/does not reserve or drain/);
 let preparations=0;const maintenance={prepare:async()=>{preparations++;return {plan_revision:'a'.repeat(64),record_revision:'b'.repeat(64)};},start:()=>assert.fail('Preparation must not start maintenance'),close:()=>{}};
 const owned=new HourglassRuns({...config,targets:[{...config.targets[0],maintenance:{native_url:'http://127.0.0.1:8001'}}]},f.directory,{client:f.client,maintenance});t.after(()=>owned.close());
 const reviewed=await owned.tool({action:'prepare',model:'example'});
 assert.equal(reviewed.prepared.window,'owned-maintenance');assert.match(reviewed.prepared.on_owner_start,/drain new gateway traffic/);assert.match(reviewed.prepared.on_owner_start,/wait for admitted and direct native work to finish/);assert.match(reviewed.prepared.on_owner_start,/conditionally return/);
 assert.equal((await owned.tool({action:'prepare',model:'example'})).prepared.id,reviewed.prepared.id);assert.equal(preparations,1);assert.deepEqual(f.calls,[]);assert.equal(owned.status().runs.length,0);
});

test('start intent precedes dispatch; duplicate requests preserve the one native receipt',async t=>{
 const f=fixture(t),runs=f.make(),id=await start(runs);
 assert.equal(runs.status().runs[0].state,'accepted');assert.equal(runs.status().runs[0].association.approved_configuration_revision,'b'.repeat(64));
 await runs.change({action:'start',id,owner_confirmed_idle:true});assert.deepEqual(f.calls,['submit']);
 await assert.rejects(runs.change({action:'prepare',model:'example'}),/current Hourglass run/);
 const s=runs.status();s.runs[0].state='invented';assert.equal(runs.status().runs[0].state,'accepted');
 const c=hourglassRunsForChat(runs.status());assert.equal(c.runs[0].state,'accepted');assert.equal(c.runs[0].worker_id,'example-worker');
 assert.doesNotMatch(JSON.stringify(c),/4534|endpoint|models_revision|settings/);
});

test('dashboard reconstruction observes the saved native job and retains its report without another start',async t=>{
 const f=fixture(t);let runs=f.make();await start(runs);runs.close();runs=f.make();
 await runs.change({action:'refresh'});assert.deepEqual(f.calls,['submit','observe']);assert.equal(runs.status().blocked,false);
 assert.equal(runs.reportSnapshot().reports[0].summary.score.value,0);assert.equal(runs.reportSnapshot().reports[0].association.route,'direct');
 runs=f.make();assert.equal(runs.reportSnapshot().reports.length,1);await runs.change({action:'refresh'});assert.deepEqual(f.calls,['submit','observe']);
});

test('an interrupted or uncertain start is never replayed and requires an explicit native-console check',async t=>{
 const f=fixture(t);f.client.submit=async()=>{f.calls.push('submit');throw Object.assign(new Error('lost response'),{uncertain:true});};
 let runs=f.make();const id=await start(runs);runs=f.make();assert.equal(runs.status().runs[0].state,'uncertain');
 await assert.rejects(runs.change({action:'prepare',model:'example'}));await assert.rejects(runs.change({action:'resolve',id,checked_in_hourglass:false}));
 await runs.change({action:'refresh'});assert.deepEqual(f.calls,['submit']);
 await runs.change({action:'resolve',id,checked_in_hourglass:true});assert.equal(runs.status().blocked,false);
 const saved=JSON.parse(fs.readFileSync(runs.file));saved.runs[0].state='submitting';fs.writeFileSync(runs.file,JSON.stringify(saved));
 runs=f.make();assert.equal(runs.status().runs[0].state,'uncertain');assert.equal(runs.status().blocked,true);
});

test('failed persistence cannot start a run or hide a known acknowledgement',async t=>{
 const f=fixture(t),runs=f.make();await runs.change({action:'prepare',model:'example'});let id=runs.status().prepared.id;
 const save=runs.save.bind(runs);runs.save=()=>{throw new Error('disk full');};
 await assert.rejects(runs.change({action:'start',id,owner_confirmed_idle:true}));assert.deepEqual(f.calls,[]);
 let writes=0;runs.save=value=>{if(++writes===2)throw new Error('temporary write failure');return save(value);};
 await runs.change({action:'start',id,owner_confirmed_idle:true});assert.equal(runs.status().runs[0].job_id,'d'.repeat(32));assert.equal(runs.status().runs[0].state,'accepted');
});

test('unavailable observation and changed console retain history; corrupt or pipe histories disable starts',async t=>{
 const f=fixture(t);let runs=f.make();await start(runs);f.client.observe=async()=>{throw new Error('offline');};
 await runs.change({action:'refresh'});assert.equal(runs.status().runs[0].state,'accepted');assert.match(runs.status().runs[0].error,/unavailable/);
  runs=new HourglassRuns({...config,url:'http://127.0.0.1:4535'},f.directory,{client:f.client});await runs.change({action:'refresh'});assert.equal(runs.status().blocked,true);
 await runs.change({action:'resolve',id:runs.status().runs[0].id,checked_in_hourglass:true});assert.equal(runs.status().blocked,false);
 fs.writeFileSync(runs.file,'corrupt');runs=f.make();assert.equal(runs.status().available,false);await assert.rejects(runs.change({action:'prepare',model:'example'}));assert.equal(fs.readFileSync(runs.file,'utf8'),'corrupt');
 fs.unlinkSync(runs.file);execFileSync('mkfifo',[runs.file]);runs=f.make();assert.equal(runs.status().available,false);assert.ok(fs.lstatSync(runs.file).isFIFO());
});

test('same-origin dashboard control requires CSRF and explicit start; refresh only observes',async t=>{
 const f=fixture(t),runs=f.make(),server=createDashboard(()=>({}), {hourglass:runs});
 server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();runs.close();});
 const origin=`http://127.0.0.1:${server.address().port}`,status=()=>fetch(origin+'/api/hourglass').then(r=>r.json());const first=await status();
 assert.equal(f.calls.length,0);const headers={'content-type':'application/json',origin,'x-dsg-csrf':first.csrf_token};
 const post=(body,h=headers)=>fetch(origin+'/api/hourglass',{method:'POST',headers:h,body:JSON.stringify(body)});
 assert.equal((await post({action:'prepare',model:'example'},{...headers,'x-dsg-csrf':'wrong'})).status,403);
 assert.equal((await post({action:'prepare',model:'example'})).status,200);const id=(await status()).prepared.id;
 assert.equal((await post({action:'start',id,owner_confirmed_idle:false})).status,409);assert.equal(f.calls.length,0);
 assert.equal((await post({action:'start',id,owner_confirmed_idle:true})).status,200);
 assert.equal((await post({action:'refresh'})).status,200);assert.equal((await status()).runs[0].state,'completed');assert.deepEqual(f.calls,['submit','observe']);
 assert.match(await(await fetch(origin)).text(),/id="hourglass-controls"/);
 assert.equal((await fetch(origin+'/hourglass.js')).status,200);
});




test('removed custom-bot Hourglass API cannot launch work',async t=>{
 const f=fixture(t),runs=f.make(),server=createDashboard(()=>({}),{hourglass:runs});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(()=>{server.closeAllConnections();server.close();runs.close();});
 const origin=`http://127.0.0.1:${server.address().port}`;
 for(const action of ['status','prepare','start','resolve','refresh','cancel']) {
   const response=await fetch(origin+'/api/genie/hourglass-tools',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action,model:'example'})});
   assert.equal(response.status,410);
 }
 assert.deepEqual(f.calls,[]);
});



test('linked comparison observes one existing operation and retains uncertainty without mutation',async t=>{
 const f=fixture(t),runs=f.make();t.after(()=>runs.close());
 const reports=['a','b'].map(key=>({report_revision:key.repeat(64),summary:hourglassReportSummary(nativeReport())}));runs.externalReports=()=>({reports});
 const id=randomUUID(),input={action:'compare',baseline_revision:'a'.repeat(64),candidate_revision:'b'.repeat(64),operation_id:id};let reads=0;
 runs.operationStatus=async actual=>{assert.equal(actual,id);reads++;throw Error('transport unavailable');};
 const result=await runs.tool(input);assert.equal(result.operation_association.state,'needs_review');assert.equal(reads,1);assert.deepEqual(f.calls,[]);assert.equal(fs.existsSync(runs.file),false);
 for(const operation_id of ['../private',[id],null])await assert.rejects(runs.tool({...input,operation_id}));await assert.rejects(runs.tool({...input,approve:true}));assert.equal(reads,1);
 const ordinary=await runs.tool({action:'compare',baseline_revision:input.baseline_revision,candidate_revision:input.candidate_revision});assert.equal(ordinary.operation_association,undefined);assert.equal(reads,1);
});
