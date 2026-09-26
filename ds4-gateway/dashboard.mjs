import {OmlxSetupWatch} from './omlx-setup-watch.mjs';
import {MediaStandardWatch} from './media-standard-watch.mjs';
import {createNativeMediaStatus} from './native-media-status.mjs';
import {fleetMediaWorkloads} from './media-workloads.mjs';
import {createMediaResources} from './media-resources.mjs';
import {createSparkMediaQualification} from './spark-media-qualification.mjs';
import {sparkInspectionSync} from './spark-inspection.mjs';
import {createSparkEnrollment} from './spark-enrollment.mjs';
import {SparkSetupWatch} from './spark-setup-watch.mjs';
import {createSparkRegistration} from './spark-registration.mjs';
import {createSparkSetupTools,setupTransport} from './genie-spark-setup.mjs';
import {MediaWatch} from './media-watch.mjs';
import {createMediaTools} from './genie-media.mjs';
import {createQueueTools} from './genie-queue.mjs';
import {createRecoveryTools} from './genie-recovery.mjs';
import {createPairPreparation} from './recovery-pair-preparation.mjs';
import {PairPreparationWatch} from './recovery-pair-watch.mjs';
import {createFleetPowerTools} from './genie-power.mjs';
import {createRecipeTrials} from './recipe-trials.mjs';
import {createAdmissionTools} from './genie-admission.mjs';
import {createPowerRunner,createReadinessVerifier,powerWorkers,machineGroup} from './power-scripts.mjs';
import {buildCatalogue} from './ui/fleet-catalogue.js';
import {endpointHeaders} from './endpoint.mjs';
import {readService} from './service-control.mjs';
import {capabilityStatus,safeGenieThinking} from './genie-capability-status.mjs';
import {testingModeFile,testingSuspended} from './testing-mode.mjs';
import {HourglassReports} from './hourglass-reports.mjs';
import {HourglassRuns} from './hourglass-runs.mjs';
import {createHourglassMaintenance} from './hourglass-maintenance.mjs';
import {doorControl} from './door-client.mjs';
import http from 'node:http';
import {EndpointTelemetry} from './endpoint-telemetry.mjs';
import {MonitoringHistory} from './monitoring-history.mjs';
import {lanSharingDetails} from './lan-sharing.mjs';
import fs from 'node:fs';
import {withGatewayProgress} from './genie-request-progress.mjs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { safeGatewayEvent, DeviceTelemetry, JournalReader } from './telemetry.mjs';
import { safeRequestedThinking } from './requested-thinking.mjs';
import { workerControl } from './worker-client.mjs';
import { FileLogReader, telemetryFiles } from './file-telemetry.mjs';
import { Activity } from './ui/activity.js';
import { Genie } from './genie.mjs';
import {GenieChat} from './genie-chat.mjs';
import {ServerRecords} from './server-records.mjs';
import {createOperationService} from './operation-service.mjs';
import {hermesProvider} from './genie-hermes.mjs';
import {hermesReviewFetch} from './genie-hermes-review.mjs';
import {GenieMemory} from './genie-memory.mjs';
import {GenieProviderLedger} from './genie-provider-ledger.mjs';
import { genieTunnel } from './genie-tunnel.mjs';
import { safeQuarantine } from './generation-health.mjs';
import { RequestHistoryReader } from './request-history.mjs';
import {FleetSpeedReader,endpointFleetSamples} from './fleet-speed.mjs';
import {PerformanceReader,performanceProfile,performanceActive} from './performance-lights.mjs';
import {RatePeaks} from './rate-peaks.mjs';
import {HardwareTelemetry} from './hardware-telemetry.mjs';
import { estimateCacheCost } from './cache-cost.mjs';
import {CacheInventoryReader,cacheInventoryDirectories,loadCacheInventoryKey} from './cache-inventory.mjs';
import { loadConfig, dashboardPort, isMain, continuityEnabled, doorSocket } from './config.mjs';
import {continuityForDisplay,continuityDoorForDisplay} from './continuity.mjs';
import {dsgReport,invalidHttp} from './report.mjs';
import {EngineAttribution} from './attribution.mjs';
import {clientWatchForDisplay} from './client-watch.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const managementStates=new Set(['local','pending','connecting','ssh_process_active','verified','ssh_error','retrying']);
const managementReasons=new Set(['adapter_timeout','adapter_output_limit','adapter_spawn_failed','adapter_dns_failure','adapter_host_key_failure','adapter_auth_failure','adapter_connect_timeout','adapter_connection_refused','adapter_route_unreachable','adapter_connection_reset','adapter_unreachable','adapter_check_failed']);
function safeManagementPath(raw){
  if(!raw||!['local','ssh_tunnel'].includes(raw.transport)||!managementStates.has(raw.state))return null;
  return {transport:raw.transport,state:raw.state,reason:managementReasons.has(raw.reason)?raw.reason:null,
    attempts:Number.isSafeInteger(raw.attempts)&&raw.attempts>=0?raw.attempts:0,
    route_count:Number.isSafeInteger(raw.route_count)&&raw.route_count>=0&&raw.route_count<=5?raw.route_count:0,
    changed_at:typeof raw.changed_at==='string'&&Number.isFinite(Date.parse(raw.changed_at))?raw.changed_at:null,
    last_verified_at:typeof raw.last_verified_at==='string'&&Number.isFinite(Date.parse(raw.last_verified_at))?raw.last_verified_at:null};
}
const assets = new Map([['/', ['index.html', 'text/html']], ['/ui.css', ['ui.css', 'text/css']], ['/brand.css', ['brand.css', 'text/css']], ['/ui.js', ['ui.js', 'text/javascript']], ['/logo.png', ['logo.png', 'image/png']]]);
assets.set('/hourglass.js',['hourglass.js','text/javascript']);
assets.set('/activity.js',['activity.js','text/javascript']);
assets.set('/fleet-catalogue.js',['fleet-catalogue.js','text/javascript']);
assets.set('/logo.svg',['logo.svg','image/svg+xml']);
assets.set('/media.js',['media.js','text/javascript']);
assets.set('/current-jobs.js',['current-jobs.js','text/javascript']);
assets.set('/genie-handoff.js',['genie-handoff.js','text/javascript']);
assets.set('/genie-progress.js',['genie-progress.js','text/javascript']);
assets.set('/genie-chat.js',['genie-chat.js','text/javascript']);
assets.set('/genie-chat.css',['genie-chat.css','text/css']);
assets.set('/server-operations.js',['server-operations.js','text/javascript']);
assets.set('/genie-capabilities.js',['genie-capabilities.js','text/javascript']);
for(const [route,file,mime] of [
  ['favicon.ico','favicon.ico','image/x-icon'],['favicon-v2.ico','favicon.ico','image/x-icon'],
  ['favicon-v1.svg','favicon-v1.svg','image/svg+xml'],['favicon-v2.svg','favicon-v1.svg','image/svg+xml'],
  ['dsg-pinned-v1.svg','dsg-pinned-v1.svg','image/svg+xml'],['dsg-pinned-v2.svg','dsg-pinned-v1.svg','image/svg+xml'],
  ['favicon-v1.png','favicon-v1.png','image/png'],['favicon-v2.png','favicon-v1.png','image/png'],
  ['apple-touch-icon.png','apple-touch-icon.png','image/png'],['apple-touch-icon-v2.png','apple-touch-icon.png','image/png'],
])assets.set('/'+route,[file,mime]);
export function genieRuntimeConfig(config){
  if(config.genie===false)return null;
  const pool={url:`http://127.0.0.1:${config.port}/v1`,model:config.model,api_key:config.api_key};
  const thinking=endpoint=>{
    const chat=config.genie_chat;
    if(Object.hasOwn(endpoint,'reasoning_effort')||!chat||!Object.hasOwn(chat,'reasoning_effort')||chat.model!==endpoint.model||chat.url?.replace(/\/$/,'')!==endpoint.url?.replace(/\/$/,''))return endpoint;
    // The same configured connection must use its working reasoning contract.
    // A separate provider or an explicit reviewer choice keeps its own setting.
    return {...endpoint,reasoning_effort:chat.reasoning_effort};
  };
  if(config.genie?.url)return {...thinking(config.genie),enabled:config.genie.enabled!==false,fallback:thinking(config.genie.fallback??pool)};
  return {...thinking(pool),enabled:config.genie?.enabled!==false,fallback:thinking(pool),default_source:'pool'};
}
// Reuse the gateway credential only for this installation's exact local pool.
export function genieChatConfig(config){
  const chat=config.genie_chat;if(!chat)return null;
  if(chat.operational_notebook!==undefined&&typeof chat.operational_notebook!=='boolean')throw new Error('genie_chat.operational_notebook must be boolean.');
  const local=new URL(chat.url).href===`http://127.0.0.1:${config.port}/v1`;
  return {...chat,gateway_tracking:local,...(chat.inspection?{inspection:{...chat.inspection,records_directory:config.server_records_directory}}:{}),...(local&&chat.api_key===undefined?{api_key:config.api_key}:{})};
}
export async function submitVideoFromDashboard(config,input){
  if(!input||Object.keys(input).sort().join(',')!=='key,prompt'||typeof input.key!=='string'||typeof input.prompt!=='string')throw Error('A video prompt and request key are required.');
  const status=await workerControl(config.control_socket,'/media-jobs');
  if(!status.text_video_supported)throw Error('Text video submission is not connected to this gateway yet.');
  const response=await fetch(`http://127.0.0.1:${config.port}/v1/video/jobs`,{method:'POST',redirect:'error',headers:{authorization:`Bearer ${config.api_key}`,'content-type':'application/json','idempotency-key':input.key},body:JSON.stringify({prompt:input.prompt}),signal:AbortSignal.timeout(15000)});
  const result=await response.json();
  if(!response.ok)throw Error(result.error??'Video submission was not confirmed.');
  return result;
}
export function proxyMediaFile(config,req,res,route){
      const upstream=http.request({hostname:'127.0.0.1',port:config.port,path:route,method:'GET',headers:{authorization:`Bearer ${config.api_key}`,...(req.headers.range?{range:req.headers.range}:{}),...(req.headers['if-range']?{'if-range':req.headers['if-range']}:{})}},response=>{
        res.statusCode=response.statusCode;
        for(const name of ['content-type','content-length','content-range','accept-ranges','content-disposition'])if(response.headers[name])res.setHeader(name,response.headers[name]);
        response.on('error',()=>res.destroy());response.pipe(res);
      });
      upstream.on('error',()=>{if(!res.headersSent){res.writeHead(503,{'content-type':'text/plain'});res.end('Media file unavailable; retry when the gateway is ready.');}else res.destroy();});
      res.on('close',()=>upstream.destroy());upstream.end();
    }

export function createDashboard(getSnapshot, assetsDirectory = path.join(here, 'ui'), management = null, genie = null, requestHistory = null, currentJobs = null, testing = null, lanSharing = null, chat = null, hourglass = null, operations = null, queueTools = null, recoveryTools = null, mediaTools = null, sparkSetup = null, powerTools = null, admissionTools = null) {
  const csrf = randomBytes(32).toString('base64url');
  // Freeze one complete release in memory: edits on disk cannot expose half an
  // update to a live browser. Only the dashboard needs a reload to promote it.
  const bundle = new Map([...assets].map(([route, [file, mime]]) => [route, { bytes:fs.readFileSync(path.join(assetsDirectory,file)), mime }]));
  for (const match of bundle.get('/').bytes.toString('utf8').matchAll(/(?:src|href)="(\/[^"#]*)"/g))
    if (!bundle.has(match[1]) && !['/api/status', '/api/diagnostics'].includes(match[1])) throw new Error(`Unserved dashboard asset: ${match[1]}`);
  // Share a single in-flight read; a slow core must not stall chat or multiply polls.
  let workloadRead=null;
  let progressRead=null;
  const readProgress=async()=>{
    if(!currentJobs)return null;
    progressRead??=Promise.resolve().then(()=>currentJobs.read()).catch(()=>null).finally(()=>{progressRead=null;});
    let timer;
    try{return await Promise.race([progressRead,new Promise(resolve=>{timer=setTimeout(()=>resolve(null),1500);})]);}
    finally{clearTimeout(timer);}
  };
  return http.createServer((req, res) => {
    const port = res.socket.localPort;
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" };
    // Loopback binding alone doesn't fence a browser's cross-origin/DNS-rebinding access.
    if (!hosts.includes(req.headers.host) || (req.headers.origin && !hosts.some(h => req.headers.origin === `http://${h}`)) || req.headers['sec-fetch-site'] === 'cross-site') {
      res.writeHead(403, headers); return res.end(dsgReport('Local same-origin dashboard only'));
    }
    const reply = (status, value) => { if (!res.destroyed && !res.headersSent) { res.writeHead(status,{...headers,'content-type':'application/json'}); res.end(JSON.stringify(status>=400&&typeof value.error==='string'?{...value,error:dsgReport(value.error)}:value)); } };
    if(req.method==='GET'&&/^\/api\/media\/(music|video)\/jobs\/[a-f0-9-]{36}\/files\/[a-f0-9-]{36}$/.test(req.url??'')){
      if(!management?.mediaFile)return reply(409,{error:'Media downloads are not connected.'});
      for(const [name,value] of Object.entries(headers))res.setHeader(name,value);
      management.mediaFile(req,res,req.url.replace('/api/media/','/v1/'));return;
    }
    if(req.url==='/api/fleet-workloads'&&req.method==='GET'){
      // Share in-flight I/O, but do not let it stall the separate Fleet telemetry endpoint.
      workloadRead??=Promise.resolve().then(()=>management?.media?.()??{jobs:[]}).then(value=>({...fleetMediaWorkloads(value),native_engines:management?.nativeMedia?.(value)??[]})).finally(()=>{workloadRead=null;});
      const timer=setTimeout(()=>reply(503,{error:'Media status unavailable; existing work may still be running.'}),1500);
      void workloadRead.then(value=>reply(200,value)).catch(()=>reply(503,{error:'Media status unavailable; existing work may still be running.'})).finally(()=>clearTimeout(timer));return;
    }
    if(req.url==='/api/media'&&req.method==='GET'){
      void (mediaTools?mediaTools.tool({action:'status'}):management?.media?.()??Promise.resolve({configured:false,enabled:false,jobs:[],hosts:[]})).then(value=>{const snapshot=getSnapshot(),devices=snapshot.devices??[];reply(200,{...value,hosts:(value.hosts??[]).map(host=>{const h=devices.find(d=>d.id===host.id)?.hardware,w=snapshot.gateway?.workers?.find(w=>w.id===host.id);return {...host,memory:h?.state==='connected'?h.current:null,llm_model:snapshot.gateway?.model??null,maintenance:(w?.maintenance_locks??[]).map(lock=>lock.name),holds:(w?.holds??[]).map(hold=>hold.name),paused:w?.drained===true,quarantined:!!w?.quarantine};}),controls_enabled:!!management,csrf_token:csrf});}).catch(()=>reply(503,{error:'Media status is unavailable. Existing work may still be running.'}));return;
    }
    if(req.url==='/api/genie/capabilities'&&req.method==='GET'){
      void Promise.all([operations?.status()??{},mediaTools?.tool({action:'status'}).catch(()=>({unavailable:true}))??{},sparkSetup?.status()??{},powerTools?powerTools.tool({action:'status'}).catch(()=>({unavailable:true})):Promise.resolve(null)]).then(([op,media,sparkSetup,power])=>reply(200,{...capabilityStatus(getSnapshot(),{media,sparkSetup,genie:genie?.status(),chat:chat?.status(),activity:chat?.capabilityActivity?.(),operations:op,hourglass:hourglass?.status(),management:!!management,fleet_power:power}),csrf_token:csrf})).catch(()=>reply(503,{error:'Capability status unavailable; existing work continues.'}));return;
    }
    if(req.url==='/api/genie/operations'&&req.method==='GET'){
      void Promise.resolve(operations?.status()??{configured:false,operations:[]}).then(value=>reply(200,{...value,csrf_token:csrf})).catch(()=>reply(503,{error:'Operation status unavailable; existing operations may still be running.'}));return;
    }
    if(['/api/genie/operations','/api/genie/operation-tools'].includes(req.url)&&req.method==='POST'){
      const tool=req.url.endsWith('operation-tools');
      const token=Buffer.from(req.headers[tool?'x-sg-operation-tool':'x-dsg-csrf']??''),expected=Buffer.from(tool?(operations?.toolConfig.token??''):csrf);
      if(!expected.length||token.length!==expected.length||!timingSafeEqual(token,expected)||(!tool&&req.headers.origin!==`http://${req.headers.host}`))return reply(403,{error:'An authorized operation session is required.'});
      if(!operations)return reply(409,{error:'Server operations are not enrolled for this installation.'});
      if(req.headers['content-type']!=='application/json')return reply(415,{error:'JSON required.'});
      let body='',ended=false;req.setEncoding('utf8');
      const timer=setTimeout(()=>{ended=true;reply(408,{error:'Incomplete operation request.'});},15000);
      req.on('error',()=>{ended=true;clearTimeout(timer);});req.on('aborted',()=>{ended=true;clearTimeout(timer);});
      req.on('data',chunk=>{if(ended)return;body+=chunk;if(Buffer.byteLength(body)>(tool?80000:2048)){ended=true;clearTimeout(timer);reply(413,{error:'Operation request too large.'});}});
      req.on('end',()=>{clearTimeout(timer);if(ended)return;ended=true;let input;try{input=JSON.parse(body);}catch{return reply(400,{error:'Invalid JSON.'});}
        void (tool?operations.tool(input):operations.change(input)).then(value=>reply(200,value)).catch(e=>reply(409,{error:e.message}));});return;
    }
    if(req.url==='/api/hourglass'&&req.method==='GET')return reply(200,{...(hourglass?.status()??{configured:false}),csrf_token:csrf});
    if(['/api/hourglass','/api/genie/hourglass-tools'].includes(req.url)&&req.method==='POST'){
      const tool=req.url.endsWith('hourglass-tools');
      const token=Buffer.from(req.headers[tool?'x-sg-hourglass-tool':'x-dsg-csrf']??''),expected=Buffer.from(tool?(hourglass?.toolConfig.token??''):csrf);
      if(!expected.length||(!tool&&req.headers.origin!==`http://${req.headers.host}`)||token.length!==expected.length||!timingSafeEqual(token,expected))return reply(403,{error:'An authorized Hourglass session is required.'});
      if(!hourglass)return reply(409,{error:'Hourglass console is not configured.'});
      if(req.headers['content-type']!=='application/json')return reply(415,{error:'JSON required.'});
      let body='',ended=false;req.setEncoding('utf8');
      const timer=setTimeout(()=>{ended=true;reply(408,{error:'Incomplete Hourglass request.'});},5000);
      req.on('error',()=>{ended=true;clearTimeout(timer);});req.on('aborted',()=>{ended=true;clearTimeout(timer);});
      req.on('data',chunk=>{if(ended)return;body+=chunk;if(Buffer.byteLength(body)>2048){ended=true;clearTimeout(timer);reply(413,{error:'Hourglass request too large.'});}});
      req.on('end',()=>{clearTimeout(timer);if(ended)return;ended=true;let input;try{input=JSON.parse(body);}catch{return reply(400,{error:'Invalid JSON.'});}
        if(['prepare','start'].includes(input.action)&&getSnapshot().gateway?.genie_capabilities?.hourglass===false)return reply(409,{error:'Hourglass measurements are switched off. Existing runs continue.'});
        void (tool?hourglass.tool(input):hourglass.change(input)).then(value=>reply(200,tool?value:hourglass.status())).catch(e=>reply(409,{error:e.message}));});return;
    }
    if(sparkSetup?.handle(req,res))return;
    if(mediaTools?.handle(req,res))return;
    if(queueTools?.handle(req,res))return;
    if(recoveryTools?.handle(req,res))return;
    if(powerTools?.handle(req,res))return;
    if(req.url==='/api/genie/admission'&&req.method==='GET'){void Promise.resolve(admissionTools?.tool({action:'status'})??{configured:false,busy:false}).then(value=>reply(200,value)).catch(()=>reply(503,{error:'Admission activity unavailable'}));return;}
    if(admissionTools?.handle(req,res))return;
    if(req.url==='/api/genie/chat'&&req.method==='GET')return reply(200,{...(chat?.status()??{available:false,conversations:[]}),csrf_token:csrf});
    if(req.url?.startsWith('/api/genie/chat/')&&req.method==='GET'){
      const id=req.url.slice('/api/genie/chat/'.length);
      try{
        const conversation=chat.get(id);
        if(!conversation.messages.some(m=>m.state==='working'&&m.gateway_call_id))return reply(200,conversation);
        void readProgress().then(state=>reply(200,withGatewayProgress(chat.get(id),state))).catch(()=>reply(200,conversation));return;
      }catch{return reply(404,{error:'Conversation not found.'});}
    }
    if(req.url==='/api/genie/chat'&&req.method==='POST'){
      const token=Buffer.from(req.headers['x-dsg-csrf']??''),expected=Buffer.from(csrf);
      if(req.headers.origin!==`http://${req.headers.host}`||token.length!==expected.length||!timingSafeEqual(token,expected))return reply(403,{error:'Same-origin chat session required.'});
      if(!chat)return reply(409,{error:'Conversational Genie is not configured.'});
      if(req.headers['content-type']!=='application/json')return reply(415,{error:'JSON required.'});
      req.setEncoding('utf8');
      let body='',ended=false;
      const timer=setTimeout(()=>{ended=true;reply(408,{error:'Incomplete chat request.'});},15000);
      req.on('error',()=>{ended=true;clearTimeout(timer);});req.on('aborted',()=>{ended=true;clearTimeout(timer);});
      req.on('data',chunk=>{if(ended)return;body+=chunk;if(Buffer.byteLength(body)>160000){ended=true;clearTimeout(timer);reply(413,{error:'Chat message too large.'});}});
      req.on('end',()=>{clearTimeout(timer);if(ended)return;try{
        const input=JSON.parse(body);
        if(input.action?.startsWith('study-'))return reply(200,chat.study.change(input));
        if(input.action==='new')return reply(201,chat.create());
        if(input.action==='stop-reply'){if(Object.keys(input).sort().join(',')!=='action,conversation_id,reply_id')throw new Error('Invalid reply control.');return reply(202,chat.stop(input.conversation_id,input.reply_id));}
        if(input.action==='continue-queue'){if(Object.keys(input).sort().join(',')!=='action,conversation_id,expected_reply_id')throw new Error('Invalid queue control.');return reply(202,chat.resume(input.conversation_id,input.expected_reply_id));}
        if(input.action==='send')return reply(202,chat.submit(input.conversation_id,input.text,input.request_id,{research:input.research}));
        return reply(400,{error:'Unknown chat action.'});
      }catch(e){return reply(400,{error:e instanceof SyntaxError?'Invalid JSON.':e.message});}});return;
    }
    // Content-bearing previews belong only on this same-origin local surface.
    if(req.url==='/api/current-jobs'&&req.method==='GET'){
      if(!currentJobs)return reply(200,{available:false});
      void currentJobs.read().then(state=>reply(200,{...state,available:true,priority_edit_enabled:!!management&&state.queue_priority_version===1,csrf_token:csrf})).catch(()=>reply(503,{error:'Current Jobs core status unavailable'}));return;
    }
    if(req.url==='/api/lan-sharing'&&req.method==='GET'){
      if(!lanSharing)return reply(200,{available:false});
      void lanSharing.read().then(value=>reply(200,{available:true,...value,csrf_token:csrf})).catch(()=>reply(503,{error:'LAN sharing controls unavailable'}));return;
    }
    if(req.url==='/api/lan-sharing'&&req.method==='POST'){
      if(!lanSharing)return reply(409,{error:'LAN sharing requires the Continuity Door'});
      const token=Buffer.from(req.headers['x-dsg-csrf']||''),expected=Buffer.from(csrf);
      if(req.headers.origin!==`http://${req.headers.host}`||token.length!==expected.length||!timingSafeEqual(token,expected))return reply(403,{error:'Same-origin LAN sharing control session required'});
      if(req.headers['content-type']!=='application/json')return reply(415,{error:'JSON required'});
      let body='',ended=false;const timer=setTimeout(()=>{ended=true;reply(408,{error:'Incomplete LAN sharing request'});req.destroy();},5000);
      req.on('error',()=>{ended=true;clearTimeout(timer);});req.on('aborted',()=>{ended=true;clearTimeout(timer);});
      req.on('data',chunk=>{if(ended)return;body+=chunk;if(Buffer.byteLength(body)>1024){ended=true;clearTimeout(timer);reply(413,{error:'LAN sharing request too large'});req.destroy();}});
      req.on('end',()=>{clearTimeout(timer);if(ended)return;ended=true;let input;try{input=JSON.parse(body);}catch{return reply(400,{error:'Invalid JSON'});}
        if(!input||Object.keys(input).join(',')!=='enabled'||typeof input.enabled!=='boolean')return reply(400,{error:'Only boolean enabled is accepted'});
        void lanSharing.set(input.enabled).then(value=>reply(200,{available:true,...value,csrf_token:csrf})).catch(()=>reply(503,{error:'LAN sharing change could not be confirmed; refresh its status before retrying'}));
      });return;
    }
    if(req.url==='/api/testing'&&req.method==='GET'){
      if(!testing)return reply(200,{available:false});
      void testing.read().then(value=>reply(200,{available:true,...value,csrf_token:csrf})).catch(()=>reply(503,{error:'Testing controls unavailable'}));return;
    }
    if(req.url==='/api/testing'&&req.method==='POST'){
      if(!testing)return reply(409,{error:'Testing requires the Continuity Door'});
      const token=Buffer.from(req.headers['x-dsg-csrf']||''),expected=Buffer.from(csrf);
      if(req.headers.origin!==`http://${req.headers.host}`||token.length!==expected.length||!timingSafeEqual(token,expected))return reply(403,{error:'Same-origin testing control session required'});
      if(req.headers['content-type']!=='application/json')return reply(415,{error:'JSON required'});
      let body='',ended=false;const timer=setTimeout(()=>{ended=true;reply(408,{error:'Incomplete testing request'});req.destroy();},5000);
      req.on('error',()=>{ended=true;clearTimeout(timer);});req.on('aborted',()=>{ended=true;clearTimeout(timer);});
      req.on('data',chunk=>{if(ended)return;body+=chunk;if(Buffer.byteLength(body)>1024){ended=true;clearTimeout(timer);reply(413,{error:'Testing request too large'});req.destroy();}});
      req.on('end',()=>{clearTimeout(timer);if(ended)return;ended=true;let input;try{input=JSON.parse(body);}catch{return reply(400,{error:'Invalid JSON'});}
        if(!input||Object.keys(input).join(',')!=='enabled'||typeof input.enabled!=='boolean')return reply(400,{error:'Only boolean enabled is accepted'});
        void testing.set(input.enabled).then(value=>reply(200,{available:true,...value,csrf_token:csrf})).catch(()=>reply(503,{error:'Testing change could not be confirmed; refresh its status before retrying'}));
      });return;
    }
    if(req.url==='/api/genie' && req.method==='GET')return reply(200,{...(genie?.status()||{configured:false}),csrf_token:csrf});
    if(req.url==='/api/genie' && req.method==='POST' && genie) {
      const token=Buffer.from(req.headers['x-dsg-csrf']||''), expected=Buffer.from(csrf);
      if(req.headers.origin!==`http://${req.headers.host}` || token.length!==expected.length || !timingSafeEqual(token,expected))return reply(403,{error:'Same-origin Genie control session required'});
      if(req.headers['content-type']!=='application/json')return reply(415,{error:'JSON required'});
      let body='',ended=false;
      const timer=setTimeout(()=>{ended=true;reply(408,{error:'Incomplete request'});req.destroy();},5000);
      const stop=()=>{ended=true;clearTimeout(timer);};req.on('error',stop);req.on('aborted',stop);
      req.on('data',chunk=>{body+=chunk;if(Buffer.byteLength(body)>8192){stop();reply(413,{error:'Question too large'});req.destroy();}});
      req.on('end',()=>{clearTimeout(timer);if(ended)return;
        try {const input=JSON.parse(body);
          if(input.action==='enable')return reply(200,genie.setEnabled(input.enabled));
          if(input.action==='source')return reply(200,genie.setSource(input.source));
          if(input.action==='memory'&&genie.memory){genie.memory.setEnabled(input.enabled);return reply(200,genie.status());}
          if(input.action==='memory-note'&&genie.memory){const receipt=genie.memory.saveOperatorNote(input.note,getSnapshot());return reply(200,{...genie.status(),memory_receipt:receipt});}
          if(input.action!=='ask')return reply(400,{error:'Unknown Genie action'});
          if(!genie.enabled)return reply(409,{error:'Gate Genie is off. Enable him before asking; the question was not queued.'});
          if(input.question!==undefined && (typeof input.question!=='string'||input.question.length>2000))return reply(400,{error:'Question too long'});
          try{return reply(202,{accepted:true,question:genie.submit(input.question)});}
          catch(e){return reply(409,{error:e.message});}
        } catch {reply(400,{error:'Invalid Genie request'});}
      });return;
    }
    if (req.url === '/api/workers' && req.method === 'GET') {
      if (!management) return reply(200, { enabled:false });
      void management.read().then(registry => reply(200,{enabled:true,csrf_token:csrf,...registry})).catch(() => reply(503,{error:'Worker controls unavailable'}));
      return;
    }
    if (req.url === '/api/workers/power' && req.method === 'GET') {
      if (!powerTools) return reply(200, { enabled:false });
      void Promise.resolve(powerTools.tool({action:'status'})).then(value => reply(200,{enabled:getSnapshot().gateway?.genie_capabilities?.fleet_power!==false,csrf_token:csrf,...value})).catch(e => reply(503,{error:e.message}));
      return;
    }
    if (req.url === '/api/fleet/catalogue' && req.method === 'GET') {
      void (management?.catalogue?.()??Promise.resolve({unavailable:true,entries:[],warnings:[]})).then(value => reply(200,value)).catch(e => reply(503,{error:e.message}));
      return;
    }
    const actions = { '/api/media/video/jobs':'media-video-submit', '/api/media/setup':'media-setup', '/api/media/inspect':'media-inspect', '/api/media/eligibility':'media-eligibility', '/api/current-jobs/priority':'job-priority', '/api/workers/concurrency':'concurrency', '/api/workers/add':'add', '/api/workers/endpoint':'endpoint', '/api/workers/test':'test', '/api/workers/remove':'remove', '/api/workers/drain':'drain', '/api/workers/resume':'resume','/api/workers/lock':'lock','/api/workers/unlock':'unlock','/api/workers/fallbacks':'fallbacks', '/api/workers/context':'context','/api/workers/conversation-turns':'conversation-turns','/api/workers/queue-timeout':'queue-timeout','/api/workers/protection':'protection','/api/workers/direct-reserve':'direct-reserve','/api/workers/relocate':'relocate', '/api/workers/recover':'recover', '/api/workers/genie-capability':'genie-capability','/api/workers/genie-thinking':'genie-thinking','/api/workers/recovery-policy':'recovery-policy','/api/workers/recovery-handback-policy':'recovery-handback-policy','/api/workers/recovery-recheck':'recovery-recheck','/api/workers/power':'power' };
    if (management && req.method === 'POST' && Object.hasOwn(actions,req.url)) {
      const token = Buffer.from(req.headers['x-dsg-csrf'] || ''), expected = Buffer.from(csrf);
      if (req.headers.origin !== `http://${req.headers.host}` || token.length !== expected.length || !timingSafeEqual(token,expected)) return reply(403,{error:'Same-origin worker-control session required; refresh and retry'});
      if (req.headers['content-type'] !== 'application/json') return reply(415,{error:'JSON required'});
      let body = '', ended = false;
      const timer = setTimeout(() => { ended=true; reply(408,{error:'Incomplete worker-control request'}); req.destroy(); },5000);
      req.on('data', chunk => { if (ended) return; body += chunk; if (Buffer.byteLength(body)>8192) { ended=true;clearTimeout(timer);reply(413,{error:'Worker configuration too large'}); } });
      req.on('error',()=>{ended=true;clearTimeout(timer);});
      req.on('aborted',()=>{ended=true;clearTimeout(timer);});
      req.on('end',()=>{
        clearTimeout(timer); if(ended)return; ended=true;
        let input; try { input=JSON.parse(body); } catch { return reply(400,{error:'Invalid JSON'}); }
        void management.act(actions[req.url],input).then(value=>reply(200,value)).catch(e=>reply(400,{error:e.message}));
      });
      return;
    }
    if (req.method !== 'GET') { res.writeHead(405, headers); return res.end(dsgReport('Read-only')); }
    if(req.url?.split('?')[0]==='/api/cache-cost') {
      try {
        const p=new URL(req.url,'http://localhost').searchParams;
        if([...p.keys()].some(k=>!['worker','tier','cached_tokens','prompt_tokens'].includes(k))||[...p.keys()].length!==4)throw new Error();
        if(!/^\d+$/.test(p.get('cached_tokens'))||!/^\d+$/.test(p.get('prompt_tokens')))throw new Error();
        const s=getSnapshot(),worker=s.gateway?.workers.find(w=>w.id===p.get('worker')),device=s.devices?.find(d=>d.id===p.get('worker'));
        if(!worker||!device)return reply(404,{error:'Unknown worker'});
        if(s.gateway_error||!worker.is_healthy||!device.connected)return reply(503,{error:'Fresh healthy-worker telemetry required'});
        if(Number.isSafeInteger(worker.context_length)&&Number(p.get('prompt_tokens'))>worker.context_length)return reply(400,{error:'Scenario exceeds the worker context capacity'});
        return reply(200,estimateCacheCost(device.cache_cost,{tier:p.get('tier'),cached_tokens:Number(p.get('cached_tokens')),prompt_tokens:Number(p.get('prompt_tokens'))}));
      }catch{return reply(400,{error:'Specify worker, tier, integer cached_tokens and prompt_tokens'});}
    }
    if (req.url === '/api/request-history') return reply(200,requestHistory?requestHistory():{enabled:false,status:'disabled',rows:[]});
    if (req.url === '/api/status' || req.url === '/api/diagnostics') {
      if (req.url === '/api/diagnostics') headers['content-disposition'] = 'attachment; filename="spark-gateway-diagnostics.json"';
      res.writeHead(200, { ...headers, 'content-type': 'application/json' }); return res.end(JSON.stringify(getSnapshot()));
    }
    const asset = bundle.get(req.url);
    if (!asset) { res.writeHead(404, headers); return res.end(dsgReport('Not found')); }
    res.writeHead(200, { ...headers, 'content-type': asset.mime.startsWith('text/') ? `${asset.mime}; charset=utf-8` : asset.mime });
    res.end(asset.bytes);
  }).on('clientError',invalidHttp);
}

export async function runDashboard(configPath, port) {
  const {config} = loadConfig(configPath);
  let operations=null;
  const hourglassReports=new HourglassReports(config.hourglass_reports);
  const hourglassDirectory=path.join(path.dirname(config.state_file),'hourglass');
  const hourglass=config.hourglass_console?new HourglassRuns(config.hourglass_console,hourglassDirectory,{
    reports:()=>{const saved=hourglassReports.snapshot();return {...saved,reports:[...saved.reports,...(operations?.trialReports().reports??[])]};},
    operationStatus:id=>operations?.tool({action:'status',id})??null,
    maintenance:createHourglassMaintenance(config,path.join(hourglassDirectory,'operations')),
    records:()=>serverRecords.snapshot(gateway?.workers?.map(w=>w.id)??[])}):null;
  port ??= dashboardPort(config);
  const fileSources = telemetryFiles(config.telemetry_files);
  const cacheSources=cacheInventoryDirectories(config.cache_directories);
  const endpointTelemetry=new EndpointTelemetry({onSample:(id,value,now,previous)=>{
    const device=devices.get(id),worker=gateway?.workers?.find(row=>row.id===id);
    if(device&&worker)activity.observe({...device,endpoint_metrics:value},worker,now);
    for(const row of endpointFleetSamples(id,value,previous))appendMetric(row);
  }});
  const devices = new Map(), readers = new Map(),cacheReaders=new Map();
  const activity=new Activity();
  for (const node of config.nodes) {
    if (node.ssh && (!/^[\w.@-]+$/.test(node.ssh) || node.ssh.startsWith('-'))) throw new Error('Unsupported SSH alias');
    if (node.telemetry_service !== null && !/^[\w@.-]+\.service$/.test(node.telemetry_service || 'ds4-vision-q2.service')) throw new Error('Unsupported journal unit');
  }
  const runtime = path.join(path.dirname(config.state_file), 'dashboard');
  const requestHistory=new RequestHistoryReader(path.join(path.dirname(config.state_file),'requests'),{enabled:config.dataset_enabled===true});
  fs.mkdirSync(runtime, { recursive: true, mode: 0o700 });
  const monitoringHistory=new MonitoringHistory(path.join(runtime,'monitoring-history.json'));
  const fleetSpeed=new FleetSpeedReader(runtime);
  const performanceHistory=new PerformanceReader(runtime,config.performance_lights??{});
  const ratePeaks=new RatePeaks(runtime);
  let cacheInventoryKey=null,cacheInventoryError=null;
  if(cacheSources.size)try{cacheInventoryKey=loadCacheInventoryKey(runtime);}catch{cacheInventoryError='Cache inventory key unavailable';}
  let closed = false, gateway = null, gatewayAt = null, gatewayError = 'Waiting for gateway', writeError = null;
  let continuityDoor = null, continuityDoorError = continuityEnabled(config)?'Waiting for continuity door':null;
  let events = [], offset = null, inode = null, fragment = '', polling = false;
  const children = new Set(), timers = new Set();
  const appendMetric = entry => {
    try { fs.appendFileSync(path.join(runtime, `metrics-${new Date().toISOString().slice(0, 10)}.jsonl`), JSON.stringify(entry) + '\n', { mode: 0o600 }); }
    catch { writeError = 'Telemetry file could not be written; live monitoring continues'; }
  };
  const hardware=new HardwareTelemetry(config.hardware_telemetry,row=>appendMetric(row));
  const attribution=new EngineAttribution(appendMetric);
  const save = entry => {
    // Never stamp today's configuration onto journal backfill. Profiles are
    // optional operator attestations, not inferred live hardware/build proof.
    const profile=performanceProfile(config.performance_lights?.worker_profiles?.[entry.node]);
    if(profile&&entry.kind==='start'&&Date.now()-entry.time>=0&&Date.now()-entry.time<=15000)entry={...entry,performance_profile:profile};
    appendMetric(entry);ratePeaks.accept(entry);attribution.acceptEngine(entry);
  };
  function follow(node, device, reader, resetCursor = false) {
    if (closed || !node.ssh || readers.get(node.id)?.node !== node) return;
    if (!/^[\w.@-]+$/.test(node.ssh) || node.ssh.startsWith('-')) throw new Error('Unsupported SSH alias');
    const service = node.telemetry_service || 'ds4-vision-q2.service';
    if (!/^[\w@.-]+\.service$/.test(service)) throw new Error('Unsupported journal unit');
    const resume = reader.cursor && !resetCursor ? `--after-cursor='${reader.cursor}'` : reader.last_time ? `--since=@${Math.floor(reader.last_time / 1000)}` : '--since=-15min';
    const remote = `journalctl --user -u ${service} -f -n 2000 --no-pager -o json --output-fields=MESSAGE,__REALTIME_TIMESTAMP,__CURSOR,_SYSTEMD_INVOCATION_ID,_BOOT_ID,_PID ${resume}`;
    const child = spawn('/usr/bin/ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2', node.ssh, remote], { stdio: ['ignore', 'pipe', 'ignore'] });
    child.workerNode = node;
    children.add(child); let buffer = '', skipping = false;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', data => {
      device.connected = true;
      buffer += data;
      let i;
      while ((i = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
        if (skipping) { skipping = false; continue; }
        try {
          const j = JSON.parse(line);
          const e = reader.accept(j);
          if (e) save({ sample_id: createHash('sha256').update(`${node.id}:${j.__CURSOR}`).digest('hex'), observed_at: Date.now(), node: node.id, ...e });
        } catch { /* An unfamiliar journal record cannot affect the model or UI. */ }
      }
      if (buffer.length > 1048576) { buffer = ''; skipping = true; }
    });
    child.on('error', () => { device.connected = false; });
    child.on('close', code => {
      children.delete(child); device.connected = false;
      if (!closed && readers.get(node.id)?.node === node) {
        // A vacuumed cursor may be invalid: reconnect from now, without replaying counted history.
        const t = setTimeout(() => { timers.delete(t); follow(node, device, reader, code !== 0 && code !== 255); }, 10000);
        timers.add(t);
      }
    });
  }
  function syncDevices(workers) {
    let definitions = config.nodes;
    try { definitions = JSON.parse(fs.readFileSync(config.state_file,'utf8')).workers ?? definitions; }
    catch { /* Keep initial journal configuration; gateway status owns membership. */ }
    const ids = new Set(workers.map(w=>w.id));
    hardware.sync(definitions,workers);
    endpointTelemetry.sync(definitions.filter(n=>workers.some(w=>w.id===n.id)));
    monitoringHistory.sync(definitions.filter(n=>workers.some(w=>w.id===n.id)),activity,endpointTelemetry,fileSources);
    const signature = id => JSON.stringify({node:definitions.find(n=>n.id===id),file:fileSources.get(id)});
    for (const [id,entry] of readers) if (!ids.has(id) || signature(id)!==entry.signature) {
      readers.delete(id);
      devices.delete(id);
      for(const child of children) if(child.workerNode===entry.node) child.kill();
    }
    for (const id of devices.keys()) if(!ids.has(id)) devices.delete(id);
    for(const [id,reader] of cacheReaders)if(!ids.has(id)||reader.directory!==cacheSources.get(id))cacheReaders.delete(id);
    for(const w of workers) {
      if(!devices.has(w.id)) devices.set(w.id,new DeviceTelemetry(w.id));
      const device=devices.get(w.id), node=definitions.find(n=>n.id===w.id);
      device.backend=node?.backend==='openai'?'openai':'ds4';
      const file=device.backend==='openai'?null:fileSources.get(w.id);
      const cacheDirectory=cacheSources.get(w.id);
      device.cache_inventory_configured=!!cacheDirectory;
      if(cacheDirectory&&cacheInventoryKey){
        if(!cacheReaders.has(w.id))cacheReaders.set(w.id,new CacheInventoryReader(w.id,cacheDirectory,cacheInventoryKey));
        device.cache_inventory=cacheReaders.get(w.id).poll();
      }else device.cache_inventory={schema:1,worker:w.id,status:cacheDirectory?'unavailable':'not_configured',accepted:0,cohorts:[],...(cacheDirectory&&cacheInventoryError?{error:'key_unavailable'}:{})};
      device.telemetry_configured=device.backend!=='openai'&&(!!file || !!(node?.ssh && node.telemetry_service!==null));
      device.telemetry_source=file?'file':device.telemetry_configured?'journal':null;
      if(file) {
        if(!readers.has(w.id)) readers.set(w.id,{node,signature:signature(w.id),reader:new FileLogReader(device,file,save)});
        readers.get(w.id).reader.poll();
        continue;
      }
      if(device.telemetry_configured && !readers.has(w.id)) {
        // Validate before any dynamic journal-reader command is constructed.
        if(!/^[a-zA-Z0-9][\w.@-]{0,252}$/.test(node.ssh) || !/^[\w@.-]+\.service$/.test(node.telemetry_service || 'ds4-vision-q2.service')) {device.telemetry_configured=false;continue;}
        const reader=new JournalReader(device);
        readers.set(w.id,{node,signature:signature(w.id),reader}); follow(node,device,reader);
      }
    }
  }
  function readEvents() {
    const log = path.join(path.dirname(config.state_file), 'gateway.log');
    let fd;
    try {
      fd = fs.openSync(log, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      const s = fs.fstatSync(fd);
      if (!s.isFile()) throw new Error('Gateway event source is not a regular file');
      if (offset === null || inode !== s.ino || s.size < offset) {
        offset = Math.max(0, s.size - 262144); inode = s.ino; fragment = '';
        // Initial tail starts mid-line; skip that first fragment.
        if (offset) fragment = '!';
      }
      const length = Math.min(262144, s.size - offset);
      if (!length) return;
      const buf = Buffer.alloc(length);
      const bytes = fs.readSync(fd, buf, 0, length, offset);
      offset += bytes;
      const lines = (fragment + buf.subarray(0, bytes).toString('utf8')).split('\n'); fragment = lines.pop();
      for (const line of lines) {
        try { const e = safeGatewayEvent(JSON.parse(line)); if (e) {events.push(e);attribution.acceptGateway(e);} } catch { /* partial line */ }
      }
      events = events.slice(-100);
      if (fragment.length > 1048576) fragment = '!';
    } catch { /* Status works even before a safe local gateway log exists. */ }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  async function poll() {
    if (polling) return;
    polling = true; readEvents();requestHistory.poll();fleetSpeed.poll();performanceHistory.poll();ratePeaks.poll();
    if(continuityEnabled(config))try{
      const response=await fetch(`http://127.0.0.1:${config.port}/continuity/status`,{headers:{authorization:`Bearer ${config.api_key}`},signal:AbortSignal.timeout(3000)});
      if(!response.ok)throw new Error();continuityDoor=continuityDoorForDisplay(await response.json());continuityDoorError=continuityDoor?null:'Unsupported continuity door';
    }catch{continuityDoorError='Continuity door status unavailable';}
    try {
      const r = await fetch(`http://127.0.0.1:${config.port}/gateway/status`, { headers: { authorization: `Bearer ${config.api_key}` }, signal: AbortSignal.timeout(3000) });
      if (!r.ok) throw new Error('Status unavailable');
      const s = await r.json();
      if (s.version !== 1 || !Array.isArray(s.workers)) throw new Error('Unsupported gateway');
      gateway = { genie_thinking:safeGenieThinking(s.genie_thinking),genie_capabilities:s.genie_capabilities,genie_flexible_assignment:s.genie_flexible_assignment===true,genie_admission_version:s.genie_admission_version===1?1:null,model: s.model,model_routes:s.model_routes&&typeof s.model_routes==='object'?s.model_routes:null, context_length: s.context_length,direct_reserve_control:s.direct_reserve!==undefined,direct_reserve_enabled:s.direct_reserve?.enabled===true,direct_reserve_reserved:s.direct_reserve?.reserved??[],queue_timeout_ms:s.queue_timeout_ms,conversation_turns:s.conversation_turns,conversation_turn_idle_ms:s.conversation_turn_idle_ms,request_timeout_ms:s.request_timeout_ms, total: s.total, healthy: s.healthy, available: s.available, active: s.active, queued: s.queued, draining: s.draining, dataset:s.dataset,recovery:s.recovery,protections:s.protections,agent_api_version:s.agent_api_version,maintenance_lock_version:s.maintenance_lock_version,client_watch_version:s.client_watch_version,client_watch:clientWatchForDisplay(s.client_watch),
        continuity:continuityForDisplay(s.continuity),
        workers: s.workers.map(w => ({ id: w.id, is_healthy: w.is_healthy, drained: w.drained, quarantine:safeQuarantine(w.quarantine), load: w.load, max_concurrent_requests:Number.isSafeInteger(w.max_concurrent_requests)&&w.max_concurrent_requests>0?w.max_concurrent_requests:1, queued: w.queued, active_seconds: w.active_seconds, completed: w.completed, failed: w.failed, assigned_sessions: w.assigned_sessions,
          gateway_drained:w.gateway_drained,recovery_waiting:Number.isSafeInteger(w.recovery_waiting)?w.recovery_waiting:0,operator_paused:w.operator_paused,holds:Array.isArray(w.holds)?w.holds.slice(0,1024).map(h=>({id:h.id,owner_id:h.owner_id,created_at:h.created_at})):[],maintenance_locks:Array.isArray(w.maintenance_locks)?w.maintenance_locks.slice(0,1024).flatMap(l=>typeof l.id==='string'&&typeof l.name==='string'&&Number.isFinite(l.created_at)?[{id:l.id,name:l.name.slice(0,64),created_at:l.created_at,review_at:Number.isFinite(l.review_at)?l.review_at:null,control_channel:typeof l.control_channel==='string'?l.control_channel:null}]:[]):[],
          last_operator_action:w.last_operator_action&&['pause','resume'].includes(w.last_operator_action.action)&&typeof w.last_operator_action.time==='string'&&Number.isFinite(Date.parse(w.last_operator_action.time))&&typeof w.last_operator_action.control_channel==='string'&&/^[a-z][a-z0-9_]{0,31}$/.test(w.last_operator_action.control_channel)?{action:w.last_operator_action.action,time:w.last_operator_action.time,control_channel:w.last_operator_action.control_channel}:null,
          oldest_queue_seconds:w.oldest_queue_seconds??null,oldest_queue_remaining_seconds:w.oldest_queue_remaining_seconds??null,
          context_length:Number.isSafeInteger(w.context_length)?w.context_length:null, served_model:typeof w.served_model==='string'?w.served_model:null, requested_thinking: safeRequestedThinking(w.requested_thinking), last_requested_thinking: safeRequestedThinking(w.last_requested_thinking), direct_reserved:w.direct_reserved===true,
          health_probe_deferred:Number.isSafeInteger(w.health_probe_deferred)?w.health_probe_deferred:0,
          health_state_source:['model_probe','recent_upstream_progress'].includes(w.health_state_source)?w.health_state_source:null,
          management_path:safeManagementPath(w.management_path),
          probe_error:['PROBE_TIMEOUT','busy_probe_deferred','ECONNREFUSED','ECONNRESET','EHOSTUNREACH','ENETUNREACH','model_or_context_mismatch','invalid_model_response'].includes(w.probe_error)?w.probe_error:null,
          last_probe:typeof w.last_probe==='string'&&Number.isFinite(Date.parse(w.last_probe))?w.last_probe:null,
          last_request_finished_at: typeof w.last_request_finished_at === 'string' && Number.isFinite(Date.parse(w.last_request_finished_at)) ? w.last_request_finished_at : null })) };
      gatewayAt = Date.now(); gatewayError = null;
      syncDevices(s.workers);
      hardware.poll();
      // Keep installed static targets intact. Only the local core supplies new
      // setup enrollments; an older core can continue without this endpoint.
      void sparkInspection?.refresh().catch(()=>{});
      applyGenieThinking(gateway?.genie_thinking);
    } catch { gatewayError = 'Gateway status unavailable; last snapshot is stale'; }
    finally { activity.update([...devices.values()].map(d=>({...d,endpoint_metrics:endpointTelemetry.snapshot(d.id)})),gateway?.workers||[],Date.now(),!!gatewayError);if(config.control_socket&&gateway?.direct_reserve?.enabled){const rows=(gateway?.workers??[]).filter(w=>!w.drained&&!w.quarantine).map(w=>{const e=endpointTelemetry.snapshot(w.id);return {id:w.id,connected:e?.connected===true,running:e?.running??0,at:e?.at??0};}).filter(r=>r.running>0||r.connected);void workerControl(config.control_socket,'/direct-activity',{rows:rows.filter(r=>r.running>0).length?rows:[]},{channel:'dashboard'}).catch(()=>{});}try{if(!isTesting())memory.observe(snapshot());}catch{/* A notebook fault cannot stop fleet polling. */}polling = false; }
  }
  const started = Date.now();
  const managementEnabled = config.ui_worker_management === true && !!config.control_socket;
  const sparkInspection=managementEnabled?sparkInspectionSync(config,()=>workerControl(config.control_socket,'/spark-services')):null;
  const serverRecords=new ServerRecords(config.server_records_directory);
  const combinedHourglass=()=>{const saved=hourglassReports.snapshot(),runs=hourglass?.reportSnapshot(),trials=operations?.trialReports().reports??[];return {...saved,configured:saved.configured||!!runs||trials.length>0,reports:[...saved.reports,...(runs?.reports??[]),...trials],unavailable:[...saved.unavailable,...(runs?.unavailable??[])]};};
  const snapshot = () => ({ hourglass_measurements:hourglass?.status()??{configured:false},hourglass_reports:combinedHourglass(),server_records:serverRecords.snapshot(gateway?.workers?.map(w=>w.id)??[]),service:'dwarf-star-gate-dashboard', version: 1, time: Date.now(), started, read_only: !managementEnabled, worker_management:managementEnabled, gateway, gateway_at: gatewayAt, gateway_error: gatewayError, telemetry_error: writeError,monitoring_history:monitoringHistory.snapshot(),
    continuity_door:continuityDoor,continuity_door_error:continuityDoorError,rate_peaks:ratePeaks.snapshot(),cache_continuity:requestHistory.cacheSnapshot(),generation_alerts:requestHistory.generationEvidence.snapshot(),
    performance_lights:performanceHistory.snapshot(Date.now(),[...devices.values()].map(d=>({...d.snapshot(),connected:d.connected&&!gatewayError,active:performanceActive(d,gateway?.workers?.find(w=>w.id===d.id))}))),
    fleet_power:powerTools?{enabled:isCapabilityEnabled('fleet_power'),control:true}:null,
    fleet_machines:powerWorkers().map(id=>({id,machine:machineGroup(id),scripts:['status','start','stop']})),
    devices: [...devices.values()].map(d => ({...d.snapshot(),rolling_rates:fleetSpeed.workerRates(d.id),activity:activity.get(d.id),activity_markers:activity.getMarkers(d.id),hardware:hardware.snapshot(d.id),endpoint_metrics:endpointTelemetry.snapshot(d.id)})), events, attribution:attribution.snapshot(), notes: 'Engine-log rates are measurements from configured log collectors; OpenAI endpoint rates have separately labeled scopes. Cache counts cover observed prompt starts, not lifetime requests. Raw prompts and responses are excluded.' });
  const memory=new GenieMemory(path.join(path.dirname(config.state_file),'genie','memory'));
  const providerLedger=new GenieProviderLedger(path.join(path.dirname(config.state_file),'genie','actions'));
  const assignmentLedger=new GenieProviderLedger(path.join(path.dirname(config.state_file),'genie','actions'),{kind:'pool_assigned'});
  const isTesting=()=>continuityEnabled(config)&&testingSuspended(testingModeFile(config));
  const chatDirectory=path.join(path.dirname(config.state_file),'genie','chat');
  const runtimeGenie=genieRuntimeConfig(config);
  const reviewer=config.genie_chat?hermesReviewFetch(config.genie_chat,{directory:chatDirectory}):undefined;
  const genie=new Genie(runtimeGenie,snapshot,{fetchImpl:reviewer,isTesting,memory,providerLedger,assignmentLedger,poolUrl:`http://127.0.0.1:${config.port}/v1`,recover:managementEnabled?input=>workerControl(config.control_socket,'/genie-recover-worker',input,{channel:'gate_genie'}):null,rebalance:managementEnabled?input=>workerControl(config.control_socket,'/genie-relocate-queued',input,{channel:'gate_genie'}):null});
  const stopGenieTunnel=genieTunnel(config.genie);
  const isCapabilityEnabled=key=>gateway?.genie_capabilities?.[key]!==false;
  let sparkSetupWatch=null,mediaStandardWatch=null,pairPreparationWatch=null,pairEnrollmentWatch=null,pairQualificationWatch=null,omlxEnrollmentWatch=null,omlxQualificationWatch=null,omlxSetupWatch=null;
  const sparkSetup=managementEnabled?createSparkSetupTools(config,{enrollment:config.spark_setup?.enabled?createSparkEnrollment({directory:path.join(path.dirname(config.state_file),'genie','spark-enrollment'),targets:config.spark_setup.targets??{},workers:async()=>{const state=await workerControl(config.control_socket,'/workers');return state.workers;}}):null,mediaQualification:config.spark_setup?.enabled?createSparkMediaQualification({directory:path.join(path.dirname(config.state_file),'genie','spark-media-qualification'),transport:setupTransport}):null,continuation:{resumePreparation:id=>sparkSetupWatch?.resumePreparation(id),status:id=>sparkSetupWatch?.status(id)??null,request:id=>{if(!sparkSetupWatch)throw new Error('Setup continuation requires Genie chat.');return sparkSetupWatch.request(id);}},isTesting,isEnabled:()=>gateway?.genie_capabilities?.spark_setup===true,registration:config.spark_setup?.enabled?createSparkRegistration({directory:path.join(path.dirname(config.state_file),'genie','spark-registration'),recordsDirectory:config.server_records_directory,control:(route,input)=>workerControl(config.control_socket,route,input,{channel:'gate_genie'})}):null}):null;
  operations=createOperationService(config,{directory:path.join(path.dirname(config.state_file),'genie','operations'),isTesting,isEnabled:()=>isCapabilityEnabled('server_changes')});
  const queueTools=managementEnabled?createQueueTools({read:()=>readService('gateway',config),move:input=>workerControl(config.control_socket,'/genie-relocate-queued',input,{channel:'gate_genie'}),isTesting,isEnabled:()=>isCapabilityEnabled('rebalance')}):null;
  const mediaTools=managementEnabled&&config.media_jobs?.enabled?createMediaTools({audit:input=>workerControl(config.control_socket,'/genie-media-audit',input,{channel:'gate_genie'}),repair:input=>workerControl(config.control_socket,'/genie-media-repair',input,{channel:'gate_genie'}),inspectInputs:input=>workerControl(config.control_socket,'/genie-media-inputs',input,{channel:'gate_genie'}),setup:input=>workerControl(config.control_socket,'/genie-media-setup',input,{channel:'gate_genie'}),resources:createMediaResources(config,{isEnabled:()=>isCapabilityEnabled('inspection')}),read:async()=>{const [media,fleet]=await Promise.all([workerControl(config.control_socket,'/media-jobs'),workerControl(config.control_socket,'/workers')]);return {...media,standard_setup:mediaStandardWatch?.status()??null,fleet:fleet.workers.map(w=>({id:w.id,is_healthy:w.is_healthy,drained:w.drained,load:w.load,queued:w.queued}))};},start:input=>workerControl(config.control_socket,'/genie-media-start',input,{channel:'gate_genie'}),isTesting}):null;
  const pairPreparation=managementEnabled&&config.genie_chat?.python?createPairPreparation({config,readWorkers:()=>workerControl(config.control_socket,'/workers')}):null;
  const recoveryTools=managementEnabled?createRecoveryTools({read:()=>readService('gateway',config),recover:input=>workerControl(config.control_socket,'/genie-recover-worker',input,{channel:'gate_genie'}),
    qualifyOmlx:input=>workerControl(config.control_socket,'/qualify-omlx-recovery',input,{channel:'gate_genie'}),omlxQualificationContinuation:()=>omlxQualificationWatch?.status()??null,omlxSetupContinuation:()=>omlxSetupWatch?.status()??null,enrollOmlx:input=>workerControl(config.control_socket,'/enroll-omlx-recovery',input,{channel:'gate_genie'}),omlxEnrollmentContinuation:()=>omlxEnrollmentWatch?.status()??null,qualify:input=>workerControl(config.control_socket,'/qualify-pair-recovery',input,{channel:'gate_genie'}),preparation:pairPreparation,enroll:input=>workerControl(config.control_socket,'/enroll-pair-recovery',input,{channel:'gate_genie'}),isChangesEnabled:()=>isCapabilityEnabled('server_changes'),continuation:()=>pairPreparationWatch?.status()??null,enrollmentContinuation:()=>pairEnrollmentWatch?.status()??null,qualificationContinuation:()=>pairQualificationWatch?.status()??null,
    isInspectionEnabled:()=>isCapabilityEnabled('inspection'),isTesting,isEnabled:()=>isCapabilityEnabled('recovery')}):null;
  const powerResolveEndpoint=managementEnabled?async worker=>{
    const registry=await workerControl(config.control_socket,'/workers',undefined,{channel:'dashboard'});
    const row=(registry?.workers??[]).find(w=>w.id===worker);
    if(!row?.url)return null;
    let headers={};try{headers=endpointHeaders(row);}catch{headers={};}
    return {url:row.url,headers,model:row.served_model};
  }:null;
  const rawPowerRunner=managementEnabled?createPowerRunner({verify:createReadinessVerifier({resolveEndpoint:powerResolveEndpoint})}):null;
  const recipeTrials=managementEnabled?createRecipeTrials({config,powerBusy:id=>rawPowerRunner.busy(id)}):null;
  const powerRunner=rawPowerRunner?{...rawPowerRunner,busy:id=>rawPowerRunner.busy(id)||recipeTrials.busy(id)}:null;
  const powerTools=managementEnabled?createFleetPowerTools({runner:powerRunner,recipes:recipeTrials,read:()=>readService('gateway',config),isTesting,isEnabled:()=>isCapabilityEnabled('fleet_power'),directRunning:id=>{const s=endpointTelemetry.snapshot(id);return s?.connected&&Date.now()-s.at<10000&&Number.isFinite(s.running)&&Number.isFinite(s.waiting)?s.running+s.waiting:null;},catalogue:()=>fleetCatalogue(),control:(route,body)=>workerControl(config.control_socket,route,body,{channel:'gate_genie'})}):null;
  const chatProviderConfig={...genieChatConfig(config)};
  const applyGenieThinking=value=>{if(!value)return {applied:false};const applied={};if(value.chat){chatProviderConfig.reasoning_effort=value.chat;applied.chat=value.chat;}if(value.reviewer){runtimeGenie.reasoning_effort=value.reviewer;if(runtimeGenie.fallback&&typeof runtimeGenie.fallback==='object')runtimeGenie.fallback.reasoning_effort=value.reviewer;applied.reviewer=value.reviewer;}return {applied:true,...applied};};
  const admissionTools=managementEnabled?createAdmissionTools({config,resolveNativeWorker:async id=>(await workerControl(config.control_socket,'/workers',undefined,{channel:'dashboard'})).workers?.find(w=>w.id===id),control:(route,body)=>workerControl(config.control_socket,route,body,{channel:'dashboard'}),read:()=>readService('gateway',config),readDoor:async()=>doorControl(doorSocket(config),'/status'),isTesting,isEnabled:()=>isCapabilityEnabled('server_changes')}):null;
  const chat=config.genie_chat?new GenieChat({directory:chatDirectory,notebook:config.genie_chat.operational_notebook===true?memory:null,getSnapshot:()=>({...snapshot(),genie:genie.status(),genie_handovers:requestHistory.snapshot().handovers}),isSuspended:isTesting,runQuestion:(answer,onWait)=>genie.answerChat(answer,onWait),provider:hermesProvider({...chatProviderConfig,spark_setup:sparkSetup?.toolConfig,operations:operations?.toolConfig,hourglass:hourglass?.toolConfig,queue:queueTools?.toolConfig,recovery:recoveryTools?.toolConfig,media:mediaTools?.toolConfig,power:powerTools?.toolConfig,admission:admissionTools?.toolConfig},{directory:chatDirectory,isCapabilityEnabled})}):null;
  const nativeMedia=createNativeMediaStatus(config);
  const fleetCatalogue=async()=>{const s=snapshot();let media={workloads:[],native_engines:[]};try{if(managementEnabled&&config.control_socket){const value=await workerControl(config.control_socket,'/media-jobs',undefined,{channel:'dashboard'});media={...fleetMediaWorkloads(value),native_engines:nativeMedia?.(value)??[]};}}catch{/* Media evidence stays empty; the catalogue stays truthful about what it could observe. */}return buildCatalogue({members:s.fleet_machines??[],workers:s.gateway?.workers??[],devices:s.devices??[],media,routes:s.gateway?.model_routes??{},now:Date.now()});};
  const server = createDashboard(snapshot, path.join(here,'ui'), managementEnabled ? {
    read:()=>workerControl(config.control_socket,'/workers',undefined,{channel:'dashboard'}),
    catalogue:()=>fleetCatalogue(),
    media:async()=>({...await workerControl(config.control_socket,'/media-jobs'),standard_setup:mediaStandardWatch?.status()??null}),
    nativeMedia,
    mediaFile:(req,res,route)=>proxyMediaFile(config,req,res,route),
    act:async(action,input)=>{if(action==='power'){if(input?.mode==='check')return powerTools.tool({...input,action:'power'});if(input?.power_action==='status'){void powerTools.tool({action:'power',worker:input.worker,power_action:'status',action_id:input.action_id}).catch(()=>{});return {started:true,worker:input.worker,power_action:'status'};}const check=await powerTools.tool({action:'power',mode:'check',worker:input.worker,power_action:input.power_action,action_id:input.action_id});void powerTools.tool({action:'power',worker:input.worker,power_action:input.power_action,action_id:input.action_id}).catch(()=>{});return {started:true,...check};}if(action==='media-video-submit')return submitVideoFromDashboard(config,input);if(action==='media-inspect'||action==='media-setup'){if(!mediaTools)throw Error('Media inspection is not connected.');return mediaTools.tool({...input,action:action==='media-setup'?'setup':'inspect'});}const value=await workerControl(config.control_socket,({'media-eligibility':'/media-host-eligibility','job-priority':'/set-job-priority',concurrency:'/set-worker-concurrency','direct-reserve':'/set-direct-reserve',add:'/add-worker',endpoint:'/edit-endpoint',test:'/check-endpoint',remove:'/remove-worker',drain:'/drain-workers',resume:'/resume-workers',lock:'/maintenance-lock',unlock:'/release-maintenance-lock',fallbacks:'/set-ssh-fallbacks',context:'/set-context-limit','conversation-turns':'/set-conversation-turns','queue-timeout':'/set-queue-timeout',protection:'/set-protection',relocate:'/relocate-queued',recover:'/recover-worker','genie-capability':'/genie-capability','genie-thinking':'/set-genie-thinking','recovery-policy':'/recovery-policy','recovery-handback-policy':'/recovery-handback-policy','recovery-recheck':'/recovery-recheck'})[action],input,{channel:'dashboard'});if(action==='genie-capability'&&gateway)gateway.genie_capabilities=value;if(action==='genie-thinking')applyGenieThinking(value?.genie_thinking??value);return value;},
  } : null,genie,()=>({...requestHistory.snapshot(),fleet_speed:fleetSpeed.snapshot(Date.now(),gateway?.workers?.map(worker=>worker.id)??[])}),config.control_socket?{
    read:()=>workerControl(config.control_socket,'/current-jobs',undefined,{channel:'dashboard'}),
  }:null,continuityEnabled(config)?{
    read:async()=>{const value=await doorControl(doorSocket(config),'/status');if(!value.testing)throw new Error('Testing mode not deployed');return {testing:value.testing,genie_draining:genie.busy,endpoint:`http://127.0.0.1:${config.port}/testing/v1`};},
    set:async enabled=>{const value=await doorControl(doorSocket(config),'/testing',{enabled});return {testing:value.testing,genie_draining:genie.busy,endpoint:`http://127.0.0.1:${config.port}/testing/v1`};},
  }:null,managementEnabled&&continuityEnabled(config)?{
    read:async()=>lanSharingDetails(await doorControl(doorSocket(config),'/lan-sharing'),config.port),
    set:async enabled=>lanSharingDetails(await doorControl(doorSocket(config),'/set-lan-sharing',{enabled}),config.port),
  }:null,chat,hourglass,operations,queueTools,recoveryTools,mediaTools,sparkSetup,powerTools,admissionTools);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  sparkSetup?.bind(server.address().port);
  powerTools?.bind(server.address().port);
  admissionTools?.bind(server.address().port);
  mediaTools?.bind(server.address().port);
  queueTools?.bind(server.address().port);
  recoveryTools?.bind(server.address().port);
  operations?.bind(server.address().port);
  hourglass?.bind(server.address().port);
  hourglass?.startObserving();
  sparkSetupWatch=chat&&sparkSetup?new SparkSetupWatch({filename:path.join(path.dirname(config.state_file),'genie','spark-setup-requests.json'),targets:sparkSetup.targets,chat,read:()=>sparkSetup.tool({action:'status'}),isEnabled:()=>!isTesting()&&gateway?.genie_capabilities?.spark_setup===true}):null;
  const mediaWatch=chat&&mediaTools?new MediaWatch({filename:path.join(path.dirname(config.state_file),'genie','media-watch.json'),chat,read:()=>mediaTools.tool({action:'status'}),isEnabled:()=>!isTesting()&&config.media_jobs?.automatic_dispatch!==false&&isCapabilityEnabled('media')}):null;
  mediaStandardWatch=chat&&mediaTools?new MediaStandardWatch({filename:path.join(path.dirname(config.state_file),'genie','media-standard.json'),config,chat,read:()=>mediaTools.tool({action:'status'}),isEnabled:()=>!isTesting()&&isCapabilityEnabled('media')}):null;
  pairPreparationWatch=chat&&pairPreparation?new PairPreparationWatch({filename:path.join(path.dirname(config.state_file),'genie','pair-preparation-watch.json'),chat,read:()=>pairPreparation.status(),isEnabled:()=>!isTesting()&&isCapabilityEnabled('inspection')}):null;
  pairEnrollmentWatch=chat&&recoveryTools?new PairPreparationWatch({kind:'enrollment',filename:path.join(path.dirname(config.state_file),'genie','pair-enrollment-watch.json'),chat,read:async()=>(await recoveryTools.tool({action:'status'})).pair_enrollment?.operations??[],isEnabled:()=>!isTesting()&&isCapabilityEnabled('inspection')}):null;
  omlxQualificationWatch=chat&&recoveryTools?new PairPreparationWatch({kind:'omlx-qualification',filename:path.join(path.dirname(config.state_file),'genie','omlx-qualification-watch.json'),chat,read:async()=>(await recoveryTools.tool({action:'status'})).operations.filter(o=>o.omlx_qualification===true).map(o=>({...o,action_id:o.id})),isEnabled:()=>!isTesting()&&isCapabilityEnabled('inspection')}):null;
  omlxEnrollmentWatch=chat&&recoveryTools?new PairPreparationWatch({kind:'omlx-enrollment',filename:path.join(path.dirname(config.state_file),'genie','omlx-enrollment-watch.json'),chat,read:async()=>(await recoveryTools.tool({action:'status'})).omlx_enrollment?.operations??[],isEnabled:()=>!isTesting()&&isCapabilityEnabled('inspection')}):null;
  pairQualificationWatch=chat&&recoveryTools?new PairPreparationWatch({kind:'qualification',filename:path.join(path.dirname(config.state_file),'genie','pair-qualification-watch.json'),chat,read:async()=>(await recoveryTools.tool({action:'status'})).operations.filter(o=>o.pair_qualification===true).map(o=>({...o,action_id:o.id})),isEnabled:()=>!isTesting()&&isCapabilityEnabled('inspection')}):null;
  omlxSetupWatch=chat&&recoveryTools?new OmlxSetupWatch({filename:path.join(path.dirname(config.state_file),'genie','omlx-setup-watch.json'),config,chat,read:()=>recoveryTools.tool({action:'status'}),isEnabled:()=>!isTesting()&&isCapabilityEnabled('inspection')&&isCapabilityEnabled('server_changes')&&isCapabilityEnabled('recovery')}):null;
  await poll(); endpointTelemetry.poll(); const interval = setInterval(poll, 2000), endpointTimer=setInterval(()=>endpointTelemetry.poll(),2000), historyTimer=setInterval(()=>monitoringHistory.save(activity,endpointTelemetry),10000), genieTimer=setInterval(()=>{genie.tick();chat?.tick();void (async()=>{await mediaStandardWatch?.tick();await mediaWatch?.tick();await sparkSetupWatch?.tick();await pairPreparationWatch?.tick();await pairEnrollmentWatch?.tick();await pairQualificationWatch?.tick();await omlxEnrollmentWatch?.tick();await omlxQualificationWatch?.tick();await omlxSetupWatch?.tick();})();},10000);
  const close = () => { monitoringHistory.save(activity,endpointTelemetry);endpointTelemetry.close(); closed = true; clearInterval(interval);clearInterval(endpointTimer);clearInterval(historyTimer);clearInterval(genieTimer);mediaStandardWatch?.close();mediaWatch?.close();sparkSetupWatch?.close();pairPreparationWatch?.close();pairEnrollmentWatch?.close();pairQualificationWatch?.close();omlxEnrollmentWatch?.close();omlxQualificationWatch?.close();omlxSetupWatch?.close();genie.close();chat?.close();operations?.close();hourglass?.close();hardware.close();stopGenieTunnel(); for (const t of timers) clearTimeout(t); for (const child of children) child.kill(); server.closeAllConnections(); server.close(); process.removeListener('SIGTERM', close); process.removeListener('SIGINT', close); };
  process.once('SIGTERM', close); process.once('SIGINT', close);
  console.log(`Star Gate: http://127.0.0.1:${server.address().port} (${managementEnabled ? 'local worker controls' : 'read-only'})`);
  return { server, snapshot, close };
}
if (isMain(import.meta.url))
  runDashboard(process.argv[2]).catch(e => { console.error(e.message); process.exitCode = 1; });
