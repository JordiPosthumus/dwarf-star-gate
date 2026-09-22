import fs from 'node:fs';
import {validCallId} from './continuity.mjs';
import {deadlineTimer,DEFAULT_QUEUE_TIMEOUT_MS,queueTimeout} from './deadline.mjs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {identityStatus,runtimeProvenance} from './genie-installation.mjs';
import {seedGenieHome} from './genie-identity.mjs';

const bridge=fileURLToPath(new URL('./genie_hermes.py',import.meta.url));
function chatError(code){
  const messages={
    timeout:'This reply reached its configured waiting allowance. Your conversation was kept; the request was not replayed.',
    identity:'Gate Genie could not load its SOUL.md or operating instructions. Check its private identity files. Your question was kept.',
    runtime:'Hermes could not start. Check the dedicated Python environment and source checkout. Your question was kept.',
    reasoning:'This model rejected Genie’s reasoning setting. Check the private chat configuration for a supported setting. Your question was kept.',
    incomplete:'Hermes reported an unfinished reply. Your conversation was kept. Check the model connection or its available context before asking again.',
    provider:'Hermes could not finish the model request. Check the configured model connection. Your conversation was kept.',
    bridge:'The connection to Hermes ended without a usable answer. Your conversation was kept.',
  };
  return Object.assign(new Error('Hermes chat failed.'),{publicMessage:messages[code]??messages.bridge});
}
export function hermesProvider(config,{directory,review=false,isCapabilityEnabled=()=>true}) {
  for(const key of ['python','source','url','model'])if(typeof config?.[key]!=='string'||!config[key])throw new Error(`Genie chat needs ${key}.`);
  const url=new URL(config.url);
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error('Use a provider URL without embedded credentials.');
  if(!path.isAbsolute(config.python)||!path.isAbsolute(config.source))throw new Error('Hermes interpreter and source paths must be absolute.');
  const home=review?path.resolve(directory,'hermes-home'):seedGenieHome(directory);
  // A dedicated clean library checkout cannot import a personal project .env.
  if(fs.existsSync(path.join(config.source,'.env')))throw new Error('Use a dedicated Hermes checkout without a project .env file.');
  if(config.timeout_ms!==undefined)queueTimeout(config.timeout_ms);
  if(review&&(!Number.isSafeInteger(config.timeout_ms)||config.timeout_ms<=0))throw new Error('A review needs its existing provider deadline.');
  if(config.research){for(const key of ['search_url','extract_url']){const u=new URL(config.research[key]);if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.search||u.hash)throw new Error('Use explicit research service URLs without credentials or query parameters.');}}
  const children=new Set(),runtime=runtimeProvenance(config.source);
  return {
    get info(){return {capabilities_configured:{spark_setup:Boolean(config.spark_setup),media:Boolean(config.media),recovery:Boolean(config.recovery),rebalance:Boolean(config.queue),research:Boolean(config.research),inspection:Boolean(config.inspection),server_changes:Boolean(config.operations),hourglass:Boolean(config.hourglass),fleet_power:Boolean(config.power)},identity:identityStatus(home),runtime_provenance:runtime,gateway_tracking:!review&&config.gateway_tracking===true,engine:'Hermes',model:config.model,mode:'provider',can_act:!review&&((Boolean(config.spark_setup)&&isCapabilityEnabled('spark_setup'))||(Boolean(config.media)&&isCapabilityEnabled('media'))||(Boolean(config.queue)&&isCapabilityEnabled('rebalance'))||(Boolean(config.recovery)&&isCapabilityEnabled('recovery'))),recovery_available:!review&&Boolean(config.recovery)&&isCapabilityEnabled('recovery'),queue_available:!review&&Boolean(config.queue)&&isCapabilityEnabled('rebalance'),research_available:Boolean(config.research)&&isCapabilityEnabled('research'),inspection_available:Boolean(config.inspection)&&isCapabilityEnabled('inspection'),operations_available:!review&&Boolean(config.operations)&&isCapabilityEnabled('server_changes'),hourglass_available:!review&&Boolean(config.hourglass)&&isCapabilityEnabled('hourglass')};},
    generate(input){return new Promise((resolve,reject)=>{
      const env={PATH:process.env.PATH??'',HOME:home,HERMES_HOME:home,HERMES_WRITE_SAFE_ROOT:home,HERMES_DISABLE_LAZY_INSTALLS:'1',PYTHONDONTWRITEBYTECODE:'1',PYTHONUNBUFFERED:'1',PYTHONIOENCODING:'utf-8',LANG:'en_US.UTF-8'};
      if(input.signal?.aborted){reject(new DOMException('Aborted','AbortError'));return;}
      let reviewHome=null;
      if(review){try{
        reviewHome=fs.mkdtempSync(path.join(home,'review-'));
        for(const name of ['SOUL.md','AGENTS.md'])fs.copyFileSync(path.join(home,name),path.join(reviewHome,name));
        const seconds=config.timeout_ms/1000;
        fs.writeFileSync(path.join(reviewHome,'config.yaml'),JSON.stringify({model:{streaming:false},agent:{api_max_retries:1},providers:{custom:{request_timeout_seconds:seconds,stale_timeout_seconds:seconds}}}),{flag:'wx',mode:0o600});
        env.HOME=env.HERMES_HOME=env.HERMES_WRITE_SAFE_ROOT=reviewHome;
      }catch{if(reviewHome)fs.rmSync(reviewHome,{recursive:true,force:true});reject(chatError('identity'));return;}}
      const child=spawn(config.python,['-B',bridge,config.source],{cwd:reviewHome??home,env,stdio:['pipe','pipe','pipe']});children.add(child);
      let pending='',final=null,failed=null,bytes=0,killTimer;
      // Match the observed gateway allowances; do not introduce a shorter chat limit.
      const timeout=config.timeout_ms??((input.context?.gateway?.queue_timeout_ms??DEFAULT_QUEUE_TIMEOUT_MS)+(input.context?.gateway?.request_timeout_ms??360000000));
      const deadline=deadlineTimer(()=>{failed=chatError('timeout');child.kill();killTimer=setTimeout(()=>child.kill('SIGKILL'),2000);killTimer.unref();},timeout);
      const abort=()=>{failed=new DOMException('Aborted','AbortError');child.kill();killTimer=setTimeout(()=>child.kill('SIGKILL'),2000);killTimer.unref();};
      input.signal?.addEventListener('abort',abort,{once:true});if(input.signal?.aborted)abort();
      const cleanup=()=>{deadline.cancel();clearTimeout(killTimer);children.delete(child);input.signal?.removeEventListener('abort',abort);if(reviewHome)fs.rmSync(reviewHome,{recursive:true,force:true});};
      child.stdout.setEncoding('utf8');
      child.stdout.on('data',chunk=>{
        bytes+=Buffer.byteLength(chunk);if(bytes>16*1024*1024){failed=chatError('bridge');child.kill();return;}
        pending+=chunk;let n;
        while((n=pending.indexOf('\n'))>=0){const line=pending.slice(0,n);pending=pending.slice(n+1);try{const event=JSON.parse(line);if(event.type==='delta')input.onDelta(event.text);else if(event.type==='research')input.onResearch?.(event.event);else if(event.type==='progress')input.onProgress?.(event.event);else if(event.type==='inspection')input.onInspection?.(event.event);else if(event.type==='queue')input.onQueue?.(event.event);else if(event.type==='spark_setup')input.onSparkSetup?.(event.event);else if(event.type==='media')input.onMedia?.(event.event);else if(event.type==='recovery')input.onRecovery?.(event.event);else if(event.type==='operation')input.onOperation?.(event.event);else if(event.type==='power')input.onPower?.(event.event);else if(event.type==='measurement')input.onMeasurement?.(event.event);else if(event.type==='done')final=event;else if(event.type==='error')failed=chatError(event.code);}catch{failed=chatError('bridge');}}
      });
      // Never relay library logs, provider bodies or credentials into browser errors.
      child.stderr.resume();child.stdin.on('error',()=>{});
      child.on('error',()=>{cleanup();reject(chatError('runtime'));});
      child.on('close',code=>{cleanup();if(failed||code!==0||!final)reject(failed??chatError('bridge'));else resolve({text:final.text});});
      child.stdin.end(JSON.stringify({profile:review?'fleet-review':'chat',instructions:review?input.instructions:null,message:input.message,history:input.history,context:input.context,session_id:input.sessionId,call_id:!review&&config.gateway_tracking===true?validCallId(input.callId):null,
        research:input.research&&config.research&&isCapabilityEnabled('research')?{search_url:config.research.search_url,extract_url:config.research.extract_url,requested_at:new Date().toISOString()}:null,
        inspection:review||!isCapabilityEnabled('inspection')?null:config.inspection??null,
        operations:!review&&config.operations&&isCapabilityEnabled('server_changes')?{...config.operations,origin:{conversation_id:input.sessionId,reply_id:input.replyId??null}}:null,
        spark_setup:review?null:config.spark_setup??null,
        media:review?null:config.media??null,
        power:review?null:config.power??null,
        recovery:review?null:config.recovery??null,
        queue:review||!isCapabilityEnabled('rebalance')?null:config.queue??null,
        hourglass:review||!isCapabilityEnabled('hourglass')?null:config.hourglass??null,
        provider:{url:config.url,model:config.model,api_key:config.api_key??'',max_tokens:config.max_tokens??8192,reasoning_effort:config.reasoning_effort===null?null:config.reasoning_effort??'xhigh'}}));
    });},
    close(){for(const child of children)child.kill();},
  };
}
