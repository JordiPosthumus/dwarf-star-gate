// Stable byte-transparent front door for planned DSG core replacement.
// It never parses or persists inference bodies and never retries dispatched work.
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import {timingSafeEqual,randomUUID} from 'node:crypto';
import {loadConfig,isMain,continuityEnabled,gatewayPort,doorSocket} from './config.mjs';
import {dsgReport,invalidHttp} from './report.mjs';

const hopHeaders=new Set(['connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailer','transfer-encoding','upgrade']);
function headers(input){const excluded=new Set([...hopHeaders,...String(input.connection??'').toLowerCase().split(',').map(x=>x.trim())]);return Object.fromEntries(Object.entries(input).filter(([key])=>!excluded.has(key.toLowerCase())));}
function json(res,status,value){if(res.destroyed||res.headersSent)return;res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));}
function report(res,status,code,message){json(res,status,{error:{type:'gateway_error',code,message:dsgReport(message)}});}

async function listenControlSocket(control,socketPath){
  const stat=()=>{try{return fs.lstatSync(socketPath,{bigint:true});}catch(error){if(error.code==='ENOENT')return null;throw error;}};
  const before=stat();if(!before)return listen(control,socketPath);
  if(!before.isSocket())throw new Error('Continuity control path is not a socket');
  // A successful connection proves ownership even if the peer is not HTTP.
  // Timeout/permission errors are uncertainty, never permission to unlink.
  const outcome=await new Promise((resolve,reject)=>{
    const peer=net.createConnection(socketPath);let settled=false;
    const finish=(error,code)=>{if(settled)return;settled=true;clearTimeout(timer);peer.destroy();error?reject(error):resolve(code);};
    const timer=setTimeout(()=>finish(new Error('Continuity control socket ownership is unknown; existing path preserved')),1000);
    peer.once('connect',()=>finish(new Error('Continuity control socket is already in use; existing Door preserved')));
    peer.once('error',error=>finish(['ECONNREFUSED','ENOENT'].includes(error.code)?null:error,error.code));
  });
  const current=stat();if(!current)return listen(control,socketPath);
  if(outcome!=='ECONNREFUSED')throw Object.assign(new Error('Continuity control socket reappeared during startup; existing path preserved'),{code:outcome});
  if(!current.isSocket()||current.dev!==before.dev||current.ino!==before.ino||current.ctimeNs!==before.ctimeNs)throw new Error('Continuity control socket changed during startup; existing path preserved');
  // No asynchronous gap between the identity check, unlink and subsequent bind.
  fs.unlinkSync(socketPath);
  return listen(control,socketPath);
}
function listen(server,...args){
  return new Promise((resolve,reject)=>{
    const failed=error=>{server.off('listening',ready);reject(error);};
    const ready=()=>{server.off('error',failed);resolve();};
    server.once('error',failed);server.once('listening',ready);server.listen(...args);
  });
}

// Fixed classes only: never retain caller paths, queries, bodies or headers.
function requestClass(req){
  const route=(req.url??'').split('?',1)[0];
  if(req.method==='GET'&&route==='/v1/models')return 'model_discovery';
  if(req.method==='POST'&&['/v1/chat/completions','/v1/completions','/v1/responses','/v1/messages'].includes(route))return 'inference';
  if(req.method==='GET'&&['/health','/gateway/status'].includes(route))return 'status';
  return 'other';
}

export function createDoor(config,{now=Date.now}={}){
  if(!continuityEnabled(config))throw new Error('continuity_door.enabled must be true');
  const corePort=gatewayPort(config),socketPath=doorSocket(config),limit=config.continuity_door.max_held_requests??Math.max(128,(config.nodes?.length??1)*(config.max_queued_per_node??128));
  if(!Number.isSafeInteger(limit)||limit<1||limit>65536)throw new Error('continuity_door.max_held_requests must be 1–65536');
  const interval=config.continuity_door.health_interval_ms??1000;if(!Number.isSafeInteger(interval)||interval<250||interval>60000)throw new Error('continuity_door.health_interval_ms must be 250–60000');
  const auth=Buffer.from(`Bearer ${config.api_key}`),held=[],state={holding:false,hold_id:null,hold_kind:null,reason:null,since:null,last_transition:null,forwarded:0,failed:0,active:0,core_ready:false,core_failures:0};
  const failureCounts={inference:0,model_discovery:0,status:0,other:0},failures=[];
  let closing=false,starting=false,monitor,probe=null,probeGeneration=0;
  const invalidateProbe=()=>{probeGeneration++;const previous=probe;probe=null;previous?.cancel();};
  const authorized=req=>{const value=Buffer.from(req.headers.authorization??'');return value.length===auth.length&&timingSafeEqual(value,auth);};
  const status=()=>({service:'dwarf-star-gate-continuity-door',version:1,holding:state.holding,hold_kind:state.hold_kind,reason:state.reason,since:state.since,last_transition:state.last_transition,held:held.length,active:state.active,forwarded:state.forwarded,failed:state.failed,core_ready:state.core_ready,core_failures:state.core_failures,body_spooling:false,replay:false,core_port:corePort,
    hold_ownership:1,hold_id:state.hold_id,model_discovery_hold:true,failure_evidence:{schema:1,scope:'door_process',by_request_class:{...failureCounts},recent:failures.map(row=>({...row}))}});
  const remove=item=>{const index=held.indexOf(item);if(index>=0)held.splice(index,1);clearInterval(item.heartbeat);item.req.off('aborted',item.cancel);item.req.off('error',item.cancel);item.res.off('close',item.cancel);};
  function proxy(req,res){
    if(req.destroyed||res.destroyed)return;
    let settled=false,upstreamResponse;
    state.active++;
    const finish=failed=>{
      if(settled)return;settled=true;state.active--;
      if(failed){
        state.failed++;const request_class=requestClass(req);failureCounts[request_class]++;
        failures.unshift({sequence:state.failed,at:new Date(now()).toISOString(),request_class,
          phase:upstreamResponse?'after_response_headers':'before_response_headers',holding:state.holding,hold_kind:state.hold_kind,backend_dispatch:'unknown'});
        if(failures.length>30)failures.pop();
      }
      req.off('aborted',cancel);req.off('error',cancel);res.off('close',clientClosed);
    };
    // Settle before destroying either leg: destruction can emit an aborted/error
    // event synchronously. A client cancellation is not a failed core or a reason
    // to hold unrelated arrivals.
    const cancel=()=>{if(settled)return;finish(false);upstreamResponse?.destroy();upstream.destroy();};
    const clientClosed=()=>{if(!res.writableFinished)cancel();};
    const responseFailed=()=>{if(settled)return;finish(true);res.destroy();};
    const upstream=http.request({host:'127.0.0.1',port:corePort,path:req.url,method:req.method,headers:headers(req.headers),agent:false},up=>{
      if(settled){up.destroy();return;}
      upstreamResponse=up;state.forwarded++;
      res.writeHead(up.statusCode,headers(up.headers));up.on('error',responseFailed);up.on('aborted',responseFailed);up.on('end',()=>finish(false));up.pipe(res);
    });
    upstream.on('error',()=>{if(settled)return;finish(true);automaticHold('core_connection_failed');if(!res.headersSent)report(res,503,'continuity_core_unavailable','Continuity door could not reach the DSG core. The request was dispatched only to the local core connection and was not replayed; retry after DSG reports ready.');else res.destroy();});
    req.on('aborted',cancel);req.on('error',cancel);res.on('close',clientClosed);req.pipe(upstream);
  }
  const release=()=>{invalidateProbe();state.holding=false;state.hold_id=null;state.hold_kind=null;state.reason=null;state.since=null;state.last_transition={action:'release',at:new Date(now()).toISOString()};for(const item of [...held]){remove(item);proxy(item.req,item.res);}};
  const hold=(reason,kind='manual')=>{invalidateProbe();if(state.holding&&state.hold_kind==='manual'&&kind==='automatic')return;state.holding=true;state.hold_id=randomUUID();state.hold_kind=kind;state.reason=typeof reason==='string'&&reason.length<=160?reason:'planned_core_change';state.since??=new Date(now()).toISOString();state.last_transition={action:'hold',kind,at:new Date(now()).toISOString(),reason:state.reason};};
  const automaticHold=reason=>{state.core_ready=false;hold(reason,'automatic');};
  const checkCore=()=>{
    if(closing)return Promise.resolve(false);
    if(probe)return probe.promise;
    let resolve,request,response,timer,settled=false;
    const current={generation:probeGeneration,promise:new Promise(r=>resolve=r),cancel:()=>finish(false,false)};
    probe=current;
    const finish=(ok,apply=true)=>{
      if(settled)return;settled=true;clearTimeout(timer);
      if(probe===current)probe=null;
      // Settle before destroying either half. Abort/error/close can race, and
      // a cancelled or pre-transition observation must not affect readiness.
      if(!ok){response?.destroy();request?.destroy();}
      const fresh=apply&&!closing&&current.generation===probeGeneration;
      if(fresh){
        state.core_ready=ok;
        if(ok){state.core_failures=0;if(state.holding&&state.hold_kind==='automatic')release();}
        else if(++state.core_failures>=(config.continuity_door.health_failures??2))automaticHold('core_not_ready');
      }
      resolve(fresh&&ok);
    };
    // This deadline is only for the small readiness probe, never inference.
    // A partial/dripping health body must not keep startup or release pending.
    timer=setTimeout(()=>finish(false),config.continuity_door.health_timeout_ms??1500);timer.unref?.();
    try{
      request=http.get({host:'127.0.0.1',port:corePort,path:'/health',headers:{authorization:`Bearer ${config.api_key}`},agent:false},res=>{
        response=res;if(settled){res.destroy();return;}
        res.once('error',()=>finish(false));res.once('aborted',()=>finish(false));
        res.once('end',()=>finish(res.statusCode===200&&res.complete));
        res.once('close',()=>{if(!res.complete)finish(false);});res.resume();
      });
      request.once('error',()=>finish(false));request.once('close',()=>{if(!response||!response.complete)finish(false);});
    }catch{finish(false);}
    return current.promise;
  };
  const server=http.createServer((req,res)=>{
    if(req.url==='/continuity/status'&&req.method==='GET'){req.resume();return authorized(req)?json(res,200,status()):report(res,401,'unauthorized','Bearer API key required');}
    if(closing){req.resume();return report(res,503,'continuity_stopping','Continuity door is stopping; request was not forwarded.');}
    if(!state.holding||(!['POST','PUT','PATCH'].includes(req.method)&&requestClass(req)!=='model_discovery'))return proxy(req,res);
    if(held.length>=limit){req.resume();return report(res,429,'continuity_hold_full','Continuity door hold capacity is full; request was not forwarded.');}
    const item={req,res};item.cancel=()=>{remove(item);};
    req.pause();req.on('aborted',item.cancel);req.on('error',item.cancel);res.on('close',item.cancel);
    item.heartbeat=setInterval(()=>{if(!res.destroyed&&!res.headersSent)res.writeProcessing();},15000);item.heartbeat.unref?.();held.push(item);
  });
  server.requestTimeout=0;server.timeout=0;server.headersTimeout=60000;server.keepAliveTimeout=5000;server.on('clientError',invalidHttp);
  const control=http.createServer((req,res)=>{
    if(req.method==='GET'&&req.url==='/status')return json(res,200,status());
    if(req.method!=='POST'||!['/hold','/release'].includes(req.url))return report(res,404,'not_found','Unknown continuity control action');
    let body='',ended=false;
    req.on('data',chunk=>{if(ended)return;body+=chunk;if(Buffer.byteLength(body)>4096){ended=true;report(res,413,'control_request_too_large','Continuity control request exceeded 4 KiB');req.resume();}});
    req.on('error',()=>{ended=true;});
    req.on('end',async()=>{if(ended)return;ended=true;try{
      const input=body?JSON.parse(body):{};
      if(req.url==='/hold'){
        if(input.if_unheld===true&&state.holding)return report(res,409,'continuity_already_holding','Continuity Door already has a hold; it was preserved.');
        hold(input.reason);
      }
      else {
        // A receipt is a transition fence, not authentication. The private
        // control socket still grants authority. Explicit operator releases
        // may omit it; lifecycle automation must name its exact observed hold.
        const conditional=Object.hasOwn(input,'if_hold_id');
        if(conditional&&(typeof input.if_hold_id!=='string'||!input.if_hold_id))return report(res,400,'invalid_hold_receipt','A nonempty hold receipt is required for conditional release.');
        const matches=()=>!conditional||(state.holding&&state.hold_id===input.if_hold_id);
        if(!matches())return report(res,409,'continuity_hold_changed','Continuity Door hold changed; the current hold was preserved.');
        const ready=await checkCore();
        if(!matches())return report(res,409,'continuity_hold_changed','Continuity Door hold changed; the current hold was preserved.');
        if(!ready)return report(res,409,'continuity_core_not_ready','Replacement DSG core is not ready; the continuity door remains holding.');
        release();
      }
      json(res,200,status());
    }catch{report(res,400,'invalid_control_request','Invalid continuity control request');}});
  });
  control.on('clientError',invalidHttp);
  return {server,control,status,hold,release,checkCore,async start(){
    if(starting||closing||server.listening||control.listening)throw new Error('Continuity Door already started, starting or closing');
    starting=true;
    try{
      fs.mkdirSync(path.dirname(socketPath),{recursive:true,mode:0o700});
      // Claim only an unused control socket. A duplicate launcher must not
      // sever the running Door's maintenance path on its way to EADDRINUSE.
      await listenControlSocket(control,socketPath);
      if(closing)throw new Error('Continuity Door is closing during startup');
      fs.chmodSync(socketPath,0o600);
      await listen(server,config.port,config.host);
      if(closing)throw new Error('Continuity Door is closing during startup');
      await checkCore();
      if(closing)throw new Error('Continuity Door is closing during startup');
      monitor=setInterval(()=>void checkCore(),interval);monitor.unref?.();
      return server.address();
    }catch(error){
      await new Promise(resolve=>control.close(resolve));
      await new Promise(resolve=>server.close(resolve));
      throw error;
    }finally{starting=false;}
  },async close(){if(closing)return;closing=true;clearInterval(monitor);invalidateProbe();for(const item of [...held]){remove(item);report(item.res,503,'continuity_stopping','Continuity door stopped before this held request was forwarded.');item.req.resume();}await new Promise(resolve=>server.close(resolve));await new Promise(resolve=>control.close(resolve));}};
}

if(isMain(import.meta.url)){
  const {config}=loadConfig(process.argv[2]);const door=createDoor(config);let stopping=false;
  const stop=async()=>{if(stopping)return;stopping=true;await door.close();process.exit(0);};process.on('SIGTERM',stop);process.on('SIGINT',stop);
  door.start().then(address=>process.stdout.write(JSON.stringify({time:new Date().toISOString(),event:'continuity_door_started',address,core_port:gatewayPort(config)})+'\n')).catch(error=>{console.error(error.message);process.exit(1);});
}
