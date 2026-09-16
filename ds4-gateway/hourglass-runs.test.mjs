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
import {hermesProvider} from './genie-hermes.mjs';
import {GenieChat} from './genie-chat.mjs';
import {chatContext} from './genie-chat.mjs';
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
 const f=fixture(t),runs=f.make(),server=createDashboard(()=>({}),undefined,null,null,null,null,null,null,null,runs);
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

test('normal dashboard restart retains native acceptance and adds collected results to Genie context',async t=>{
 const f=fixture(t),jobId='f'.repeat(32);let starts=0,phase='running';
 const native=http.createServer((req,res)=>{
  res.setHeader('content-type','application/json');
  if(req.url==='/api/health')return res.end(JSON.stringify({app:'Hourglass',version:2,controller_instance:'fixture'}));
  if(req.url==='/api/state')return res.end(JSON.stringify({app:'Hourglass',version:2,benchmark_version:'4.0.0',models_revision:'a'.repeat(64),endpoint_hardware:{revision:'b'.repeat(64)},
   model_configs:[{name:'example',model:'native-model',base_url:'http://example.invalid/v1',max_tokens:262144}],tasks:[{id:'fixture',task_bundle_sha:'c'.repeat(64),issues:[]}],
   jobs:{running:starts?[{id:jobId,model:'example',state:phase}]:[],pending:[],done:[]},score_policy:{window_s:3600,metric:'total-points-v1'}}));
  if(req.url==='/api/run'&&req.method==='POST'){let body='';req.on('data',c=>body+=c);req.on('end',()=>{assert.equal(JSON.parse(body).models_revision,'a'.repeat(64));starts++;res.end(JSON.stringify({ok:true,job:jobId}));});return;}
  if(req.url.startsWith('/scores/api/preview?'))return res.end(JSON.stringify({token:'e'.repeat(24)}));
  if(req.url==='/scores/file/'+'e'.repeat(24)+'/report.json')return res.end(JSON.stringify({...nativeReport(),run_key:createHash('sha256').update(jobId).digest('hex').slice(0,24),notes:'PRIVATE_NATIVE_NOTES'}));
  res.statusCode=404;res.end('{}');
 });native.listen(0,'127.0.0.1');await once(native,'listening');t.after(()=>{native.closeAllConnections();native.close();});
 const core=http.createServer((_req,res)=>res.end(JSON.stringify({version:1,model:'example',context_length:262144,workers:[],healthy:0,total:0,active:0,queued:0})));
 core.listen(0,'127.0.0.1');await once(core,'listening');t.after(()=>{core.closeAllConnections();core.close();});
 const file=path.join(f.directory,'config.json');fs.writeFileSync(file,JSON.stringify({port:core.address().port,api_key:'synthetic',nodes:[],genie:false,state_file:path.join(f.directory,'runtime/state.json'),hourglass_console:{...config,url:`http://127.0.0.1:${native.address().port}`}}));
 let app=await runDashboard(file,0);t.after(()=>app.close());
 const origin=()=>`http://127.0.0.1:${app.server.address().port}`;
 const status=()=>fetch(origin()+'/api/hourglass').then(r=>r.json());
 const post=async body=>{const s=await status(),r=await fetch(origin()+'/api/hourglass',{method:'POST',headers:{origin:origin(),'content-type':'application/json','x-dsg-csrf':s.csrf_token},body:JSON.stringify(body)});assert.equal(r.status,200);return r.json();};
 assert.equal(starts,0);let prepared=await post({action:'prepare',model:'example'});await post({action:'start',id:prepared.prepared.id,owner_confirmed_idle:true});
 assert.equal(starts,1);app.close();app=await runDashboard(file,0);assert.equal((await status()).runs[0].state,'accepted');assert.equal(starts,1);
 phase='completed';await post({action:'refresh'});const observed=await(await fetch(origin()+'/api/status')).json();
 assert.equal(observed.hourglass_reports.reports[0].summary.score.value,0);assert.doesNotMatch(JSON.stringify(observed.hourglass_reports),/PRIVATE_NATIVE_NOTES/);
  assert.equal(chatContext(observed).hourglass_reports.reports[0].association.worker_id,'example-worker');assert.equal(starts,1);
 assert.equal(chatContext(observed).hourglass_measurements.runs[0].state,'completed');
});


test('Genie prepares the existing owner review but cannot start, resolve, replace or expose credentials',async t=>{
 const f=fixture(t),runs=f.make(),server=createDashboard(()=>({}),undefined,null,null,null,null,null,null,null,runs);
 server.listen(0,'127.0.0.1');await once(server,'listening');runs.bind(server.address().port);
 t.after(()=>{server.closeAllConnections();server.close();runs.close();});
 const origin=`http://127.0.0.1:${server.address().port}`,headers={'content-type':'application/json','x-sg-hourglass-tool':runs.toolConfig.token};
 const post=(body,h=headers)=>fetch(origin+'/api/genie/hourglass-tools',{method:'POST',headers:h,body:JSON.stringify(body)});
 assert.equal((await post({action:'status'},{...headers,'x-sg-hourglass-tool':'wrong'})).status,403);
 let result=await (await post({action:'prepare',model:'example'})).json();const id=result.prepared.id;
 assert.match(result.scope,/only Star Gate-owned/);assert.match(result.scope,/empty list does not prove/);
 assert.equal(result.prepared.worker_id,'example-worker');assert.equal(runs.status().prepared.id,id);
 assert.equal((await (await post({action:'prepare',model:'example'})).json()).prepared.id,id);
 assert.equal((await post({action:'prepare',model:'different'})).status,409);assert.equal(runs.status().prepared.id,id);
 for(const action of ['start','resolve','refresh','cancel'])assert.equal((await post({action,id,owner_confirmed_idle:true})).status,409);
 const owner=await(await fetch(origin+'/api/hourglass')).json();
 assert.equal((await post({action:'status'},{...headers,'x-sg-hourglass-tool':owner.csrf_token})).status,403);
 assert.equal((await fetch(origin+'/api/hourglass',{method:'POST',headers:{...headers,origin},body:JSON.stringify({action:'start',id,owner_confirmed_idle:true})})).status,403);
 assert.deepEqual(f.calls,[]);assert.equal(fs.existsSync(runs.file),false);
 assert.doesNotMatch(JSON.stringify(result),new RegExp(runs.toolConfig.token));
 assert.doesNotMatch(JSON.stringify(result),/api_key|models_revision|console_url|endpoint/);
 await runs.change({action:'start',id,owner_confirmed_idle:true});
 result=await (await post({action:'status'})).json();assert.equal(result.runs[0].state,'completed');
 assert.deepEqual(f.calls,['submit','observe']);assert.equal(result.runs[0].has_saved_report,true);
 assert.equal(result.reports[0].summary.score.value,0);
});

test('installed Hermes prepares a measurement and persists actual calls without starting native work',{
 skip:!process.env.DSG_TEST_HERMES_SOURCE||!process.env.DSG_TEST_HERMES_PYTHON,timeout:120000
},async t=>{
 const f=fixture(t),runs=f.make(),server=createDashboard(()=>({}),undefined,null,null,null,null,null,null,null,runs);
 server.listen(0,'127.0.0.1');await once(server,'listening');runs.bind(server.address().port);
 const requests=[];let turn=0;
 const upstream=http.createServer((req,res)=>{
  if(req.method==='GET'){res.end(JSON.stringify({data:[{id:'example-model',context_length:131072}]}));return;}
  let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{
   const input=JSON.parse(raw);if(!Array.isArray(input.messages)){res.writeHead(404);res.end('{}');return;}requests.push(input);turn++;
   const message=turn<=2?{role:'assistant',content:null,tool_calls:[{id:'measurement-'+turn,type:'function',function:{name:'tool_call',arguments:JSON.stringify({
    name:turn===1?'prepare_hourglass_measurement':'hourglass_measurement_status',arguments:turn===1?{model:'example'}:{}})}}]}:{role:'assistant',content:'The synthetic measurement is ready in Evidence. No benchmark has started.'};
   const finish=turn<=2?'tool_calls':'stop';
   if(input.stream){res.setHeader('content-type','text/event-stream');const delta={...message,...(message.tool_calls?{tool_calls:message.tool_calls.map((c,index)=>({index,...c}))}:{})};res.end('data: '+JSON.stringify({choices:[{index:0,delta,finish_reason:null}]})+'\n\ndata: '+JSON.stringify({choices:[{index:0,delta:{},finish_reason:finish}]})+'\n\ndata: [DONE]\n\n');}
   else{res.setHeader('content-type','application/json');res.end(JSON.stringify({id:'fixture',choices:[{index:0,message,finish_reason:finish}],usage:{prompt_tokens:100,completion_tokens:30,total_tokens:130}}));}
  });
 });upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
 const directory=path.join(f.directory,'chat'),provider=hermesProvider({python:process.env.DSG_TEST_HERMES_PYTHON,source:process.env.DSG_TEST_HERMES_SOURCE,
  url:`http://127.0.0.1:${upstream.address().port}/v1`,model:'example-model',hourglass:runs.toolConfig},{directory});
 const chat=new GenieChat({directory,provider});
 t.after(()=>{chat.close();server.closeAllConnections();server.close();upstream.closeAllConnections();upstream.close();runs.close();});
 const c=chat.create();chat.submit(c.id,'Prepare the synthetic measurement and check its status.','native-measurement-test');await chat.idle();
 const answer=chat.get(c.id).messages.at(-1);assert.equal(answer.state,'complete',answer.error);
 assert.deepEqual(answer.measurements.events.filter(e=>e.state==='complete').map(e=>e.tool),['prepare_hourglass_measurement','hourglass_measurement_status']);
 assert.equal(answer.measurements.events.at(-1).result.prepared.id,runs.status().prepared.id);
 assert.deepEqual(f.calls,[]);assert.equal(fs.existsSync(runs.file),false);
 assert.doesNotMatch(JSON.stringify(requests),new RegExp(runs.toolConfig.token));
 const reloaded=new GenieChat({directory,provider});assert.deepEqual(reloaded.get(c.id).messages.at(-1).measurements,answer.measurements);
});
