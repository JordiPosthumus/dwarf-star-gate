import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import {createGateway} from './gateway.mjs';
import {workerControl} from './worker-client.mjs';
import {sparkServiceBinding,validateServiceAddition,applyServiceAddition,restoreSparkServices} from './spark-services.mjs';
import {sparkInspectionSync} from './spark-inspection.mjs';

const worker={id:'new-spark',url:'http://127.0.0.1:39888',ssh:'new-spark',remote_port:8001,context_length:262144,max_concurrent_requests:1};
const services={schema:1,container:'a'.repeat(64),recovery:{helper:'/srv/setup/recovery/recovery-docker.py',config:'/srv/setup/recovery/config.json',machine:'b'.repeat(64),profile:'c'.repeat(64)},media:{music:{kind:'ace-step',container:'d'.repeat(64),image:'sha256:'+'e'.repeat(64),port:8002}},qualification:{checks_passed:['context_boundary','fault_counters','model_context','prefix_cache','reasoning_eos','text','tools','vision'],native_result_sha256:'f'.repeat(64),recovery_restart:'passed'}};

test('new bindings preserve existing policy and restore without changing caller config',()=>{
 const config={media_jobs:{enabled:true,execution_enabled:false,workers:{}},recovery:{workers:[]},genie_chat:{inspection:{workers:{personal:{ssh:['personal'],container:'personal'}}}}};
 const binding=sparkServiceBinding(worker,services);validateServiceAddition(config,binding);applyServiceAddition(config,binding);
 assert.equal(config.media_jobs.execution_enabled,false);assert.equal(config.recovery.workers[0].start_stopped,undefined);assert.deepEqual(config.genie_chat.inspection.workers.personal,{ssh:['personal'],container:'personal'});
 const restored={};restoreSparkServices(restored,{'new-spark':binding},[worker]);assert.deepEqual(restored.recovery.workers,config.recovery.workers);
 assert.throws(()=>validateServiceAddition(config,binding),/Existing service bindings/);
 assert.throws(()=>sparkServiceBinding(worker,{...services,qualification:{...services.qualification,recovery_restart:'unproven'}}),/restart proof/);
 const sameMachine=sparkServiceBinding({...worker,id:'another',url:'http://127.0.0.1:39889'},services);assert.throws(()=>validateServiceAddition(config,sameMachine),/physical machine/);
});

test('dynamic inspection reaches the existing provider object while preserving personal targets',async()=>{
 const config={genie_chat:{inspection:{workers:{personal:{container:'keep-me'}}}}};
 const sync=sparkInspectionSync(config,async()=>({schema:1,workers:{'new-spark':{inspection:{container:'a'.repeat(64),ssh:['new-spark']}},personal:{inspection:{container:'b'.repeat(64),ssh:['replace']}}}}));
 const providerConfig={...config.genie_chat.inspection};await sync.refresh();
 assert.deepEqual(providerConfig.workers['new-spark'],{container:'a'.repeat(64),ssh:['new-spark']});assert.deepEqual(providerConfig.workers.personal,{container:'keep-me'});
});

test('actual core atomically registers service bindings, keeps toggles off, and restores them after restart',async t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'sg-new-services-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const backend=http.createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{id:'fixture',context_length:262144}]}));});
 await new Promise(resolve=>backend.listen(0,'127.0.0.1',resolve));t.after(()=>backend.close());
 const config={nodes:[],model:'fixture',api_key:'test',context_length:262144,state_file:path.join(directory,'state.json'),control_socket:path.join(directory,'control.sock'),host:'127.0.0.1',port:0,media_jobs:{enabled:true,execution_enabled:false},health_interval_ms:60000};
 // In-process TCP forwarding supplies only the transport; the gateway itself
 // owns actual registration, persistence, recovery registry and media selection.
 const tunnels=[];
 const tunnelFactory=node=>{const server=net.createServer(socket=>{const upstream=net.connect(backend.address().port,'127.0.0.1');socket.pipe(upstream).pipe(socket);socket.on('error',()=>{});upstream.on('error',()=>socket.destroy());socket.on('close',()=>upstream.destroy());});server.listen(Number(new URL(node.url).port),'127.0.0.1');tunnels.push(server);return ()=>server.close();};
 const portServer=net.createServer();await new Promise(r=>portServer.listen(0,'127.0.0.1',r));const port=portServer.address().port;await new Promise(r=>portServer.close(r));
 const newWorker={...worker,url:`http://127.0.0.1:${port}`};
 fs.writeFileSync(config.state_file,JSON.stringify({version:1,sessions:{}}));
 let gateway=createGateway(config,{tunnelFactory});gateway.recovery.call=async()=>({active:false,listener:false});await gateway.start();
 try{
  const added=await workerControl(config.control_socket,'/add-worker',{worker:newWorker,services});assert.equal(added.workers[0].drained,true);
  assert.equal(added.genie_capabilities.media,false);assert.equal(added.recovery.automatic,false);
  assert.equal((await workerControl(config.control_socket,'/media-jobs')).workers[0].kinds[0],'music');
  await workerControl(config.control_socket,'/media-host-eligibility',{worker_id:'new-spark',kind:'music',allowed:false});
  assert.deepEqual((await workerControl(config.control_socket,'/media-jobs')).workers[0].kinds,[]);
  assert.equal((await workerControl(config.control_socket,'/spark-services')).workers['new-spark'].recovery,true);
  const saved=JSON.parse(fs.readFileSync(config.state_file));assert.equal(saved.workers[0].id,'new-spark');assert.equal(saved.spark_services['new-spark'].recovery.profile,'c'.repeat(64));assert.equal(saved.drained['new-spark'],true);assert.equal(saved.media_host_eligibility['new-spark'].music,false);
  assert.ok(fs.readdirSync(directory).some(name=>name.includes('.enrollment-')));
  await gateway.close();await new Promise(r=>setTimeout(r,30));gateway=createGateway(config,{tunnelFactory});gateway.recovery.call=async()=>({active:false,listener:false});await gateway.start();
  assert.equal((await workerControl(config.control_socket,'/media-jobs')).hosts[0].engines.find(e=>e.kind==='music').allowed,false);
  const after=await workerControl(config.control_socket,'/workers');assert.equal(after.workers[0].drained,true);assert.equal(after.recovery.workers[0].enrollment.configured,true);
  assert.equal((await workerControl(config.control_socket,'/media-jobs')).workers[0].id,'new-spark');
  assert.equal(config.recovery,undefined,'caller configuration was not mutated');
 }finally{await gateway.close();}
});
