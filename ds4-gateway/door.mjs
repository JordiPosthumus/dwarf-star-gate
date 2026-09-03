// Stable byte-transparent front door for planned DSG core replacement.
// It never parses or persists inference bodies and never retries dispatched work.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {timingSafeEqual} from 'node:crypto';
import {loadConfig,isMain,continuityEnabled,gatewayPort,doorSocket} from './config.mjs';
import {dsgReport,invalidHttp} from './report.mjs';

const hopHeaders=new Set(['connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailer','transfer-encoding','upgrade']);
function headers(input){const excluded=new Set([...hopHeaders,...String(input.connection??'').toLowerCase().split(',').map(x=>x.trim())]);return Object.fromEntries(Object.entries(input).filter(([key])=>!excluded.has(key.toLowerCase())));}
function json(res,status,value){if(res.destroyed||res.headersSent)return;res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));}
function report(res,status,code,message){json(res,status,{error:{type:'gateway_error',code,message:dsgReport(message)}});}

export function createDoor(config,{now=Date.now}={}){
  if(!continuityEnabled(config))throw new Error('continuity_door.enabled must be true');
  const corePort=gatewayPort(config),socketPath=doorSocket(config),limit=config.continuity_door.max_held_requests??Math.max(128,(config.nodes?.length??1)*(config.max_queued_per_node??128));
  if(!Number.isSafeInteger(limit)||limit<1||limit>65536)throw new Error('continuity_door.max_held_requests must be 1–65536');
  const auth=Buffer.from(`Bearer ${config.api_key}`),held=[],state={holding:false,hold_kind:null,reason:null,since:null,last_transition:null,forwarded:0,failed:0,active:0,core_ready:false,core_failures:0};
  let closing=false,monitor;
  const authorized=req=>{const value=Buffer.from(req.headers.authorization??'');return value.length===auth.length&&timingSafeEqual(value,auth);};
  const status=()=>({service:'dwarf-star-gate-continuity-door',version:1,holding:state.holding,hold_kind:state.hold_kind,reason:state.reason,since:state.since,last_transition:state.last_transition,held:held.length,active:state.active,forwarded:state.forwarded,failed:state.failed,core_ready:state.core_ready,core_failures:state.core_failures,body_spooling:false,replay:false,core_port:corePort});
  const remove=item=>{const index=held.indexOf(item);if(index>=0)held.splice(index,1);clearInterval(item.heartbeat);item.req.off('aborted',item.cancel);item.req.off('error',item.cancel);item.res.off('close',item.cancel);};
  function proxy(req,res){
    if(req.destroyed||res.destroyed)return;
    let settled=false,upstreamResponse;
    state.active++;
    const finish=failed=>{if(settled)return;settled=true;state.active--;if(failed)state.failed++;req.off('aborted',cancel);req.off('error',cancel);res.off('close',cancel);};
    const cancel=()=>{upstreamResponse?.destroy();upstream.destroy();finish(false);};
    const upstream=http.request({host:'127.0.0.1',port:corePort,path:req.url,method:req.method,headers:headers(req.headers),agent:false},up=>{
      upstreamResponse=up;state.forwarded++;
      res.writeHead(up.statusCode,headers(up.headers));up.on('error',()=>{res.destroy();finish(true);});up.on('aborted',()=>{res.destroy();finish(true);});up.on('end',()=>finish(false));up.pipe(res);
    });
    upstream.on('error',error=>{automaticHold('core_connection_failed');if(!res.headersSent)report(res,503,'continuity_core_unavailable','Continuity door could not reach the DSG core. The request was dispatched only to the local core connection and was not replayed; retry after DSG reports ready.');else res.destroy();finish(true);});
    req.on('aborted',cancel);req.on('error',cancel);res.on('close',()=>{if(!res.writableFinished)cancel();});req.pipe(upstream);
  }
  const release=()=>{state.holding=false;state.hold_kind=null;state.reason=null;state.since=null;state.last_transition={action:'release',at:new Date(now()).toISOString()};for(const item of [...held]){remove(item);proxy(item.req,item.res);}};
  const hold=(reason,kind='manual')=>{if(state.holding&&state.hold_kind==='manual'&&kind==='automatic')return;state.holding=true;state.hold_kind=kind;state.reason=typeof reason==='string'&&reason.length<=160?reason:'planned_core_change';state.since??=new Date(now()).toISOString();state.last_transition={action:'hold',kind,at:new Date(now()).toISOString(),reason:state.reason};};
  const automaticHold=reason=>hold(reason,'automatic');
  const checkCore=()=>new Promise(resolve=>{
    const req=http.get({host:'127.0.0.1',port:corePort,path:'/health',headers:{authorization:`Bearer ${config.api_key}`},agent:false},res=>{res.resume();res.once('end',()=>resolve(res.statusCode===200));});
    const done=()=>resolve(false);req.setTimeout(config.continuity_door.health_timeout_ms??1500,()=>req.destroy());req.once('error',done);
  }).then(ok=>{state.core_ready=ok;if(ok){state.core_failures=0;if(state.holding&&state.hold_kind==='automatic')release();}else if(++state.core_failures>=(config.continuity_door.health_failures??2))automaticHold('core_not_ready');return ok;});
  const server=http.createServer((req,res)=>{
    if(req.url==='/continuity/status'&&req.method==='GET'){req.resume();return authorized(req)?json(res,200,status()):report(res,401,'unauthorized','Bearer API key required');}
    if(closing){req.resume();return report(res,503,'continuity_stopping','Continuity door is stopping; request was not forwarded.');}
    if(!state.holding||!['POST','PUT','PATCH'].includes(req.method))return proxy(req,res);
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
      else if(!await checkCore())return report(res,409,'continuity_core_not_ready','Replacement DSG core is not ready; the continuity door remains holding.');
      else release();
      json(res,200,status());
    }catch{report(res,400,'invalid_control_request','Invalid continuity control request');}});
  });
  control.on('clientError',invalidHttp);
  return {server,control,status,hold,release,checkCore,async start(){
    fs.mkdirSync(path.dirname(socketPath),{recursive:true,mode:0o700});
    if(fs.existsSync(socketPath)){if(!fs.lstatSync(socketPath).isSocket())throw new Error('Continuity control path is not a socket');fs.unlinkSync(socketPath);}
    await new Promise((resolve,reject)=>{control.once('error',reject);control.listen(socketPath,resolve);});fs.chmodSync(socketPath,0o600);
    try{await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(config.port,config.host,resolve);});}catch(error){await new Promise(resolve=>control.close(resolve));if(fs.existsSync(socketPath))fs.unlinkSync(socketPath);throw error;}
    await checkCore();const interval=config.continuity_door.health_interval_ms??1000;if(!Number.isSafeInteger(interval)||interval<250||interval>60000)throw new Error('continuity_door.health_interval_ms must be 250–60000');monitor=setInterval(()=>void checkCore(),interval);monitor.unref?.();
    return server.address();
  },async close(){if(closing)return;closing=true;clearInterval(monitor);for(const item of [...held]){remove(item);report(item.res,503,'continuity_stopping','Continuity door stopped before this held request was forwarded.');item.req.resume();}await new Promise(resolve=>server.close(resolve));await new Promise(resolve=>control.close(resolve));if(fs.existsSync(socketPath))fs.unlinkSync(socketPath);}};
}

if(isMain(import.meta.url)){
  const {config}=loadConfig(process.argv[2]);const door=createDoor(config);let stopping=false;
  const stop=async()=>{if(stopping)return;stopping=true;await door.close();process.exit(0);};process.on('SIGTERM',stop);process.on('SIGINT',stop);
  door.start().then(address=>process.stdout.write(JSON.stringify({time:new Date().toISOString(),event:'continuity_door_started',address,core_port:gatewayPort(config)})+'\n')).catch(error=>{console.error(error.message);process.exit(1);});
}
