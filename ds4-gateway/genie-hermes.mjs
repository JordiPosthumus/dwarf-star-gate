import fs from 'node:fs';
import {deadlineTimer,DEFAULT_QUEUE_TIMEOUT_MS,queueTimeout} from './deadline.mjs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const bridge=fileURLToPath(new URL('./genie_hermes.py',import.meta.url));
function chatError(code){
  const messages={
    timeout:'This reply reached its configured waiting allowance. Your conversation was kept; the request was not replayed.',
    runtime:'Hermes could not start. Check the dedicated Python environment and source checkout. Your question was kept.',
    reasoning:'This model rejected Genie’s reasoning setting. Check the private chat configuration for a supported setting. Your question was kept.',
    incomplete:'Hermes reported an unfinished reply. Your conversation was kept. Check the model connection or its available context before asking again.',
    provider:'Hermes could not finish the model request. Check the configured model connection. Your conversation was kept.',
    bridge:'The connection to Hermes ended without a usable answer. Your conversation was kept.',
  };
  return Object.assign(new Error('Hermes chat failed.'),{publicMessage:messages[code]??messages.bridge});
}
export function hermesProvider(config,{directory}) {
  for(const key of ['python','source','url','model'])if(typeof config?.[key]!=='string'||!config[key])throw new Error(`Genie chat needs ${key}.`);
  const url=new URL(config.url);
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error('Use a provider URL without embedded credentials.');
  if(!path.isAbsolute(config.python)||!path.isAbsolute(config.source))throw new Error('Hermes interpreter and source paths must be absolute.');
  const home=path.resolve(directory,'hermes-home');fs.mkdirSync(home,{recursive:true,mode:0o700});
  // A dedicated clean library checkout cannot import a personal project .env.
  if(fs.existsSync(path.join(config.source,'.env')))throw new Error('Use a dedicated Hermes checkout without a project .env file.');
  if(config.timeout_ms!==undefined)queueTimeout(config.timeout_ms);
  if(config.research){for(const key of ['search_url','extract_url']){const u=new URL(config.research[key]);if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.search||u.hash)throw new Error('Use explicit research service URLs without credentials or query parameters.');}}
  const children=new Set();
  return {
    info:{engine:'Hermes',model:config.model,mode:'provider',can_act:false,research_available:Boolean(config.research)},
    generate(input){return new Promise((resolve,reject)=>{
      const env={PATH:process.env.PATH??'',HOME:home,HERMES_HOME:home,HERMES_WRITE_SAFE_ROOT:home,HERMES_DISABLE_LAZY_INSTALLS:'1',PYTHONDONTWRITEBYTECODE:'1',PYTHONUNBUFFERED:'1',PYTHONIOENCODING:'utf-8',LANG:'en_US.UTF-8'};
      const child=spawn(config.python,['-B',bridge,config.source],{cwd:home,env,stdio:['pipe','pipe','pipe']});children.add(child);
      let pending='',final=null,failed=null,bytes=0,killTimer;
      // Match the observed gateway allowances; do not introduce a shorter chat limit.
      const timeout=config.timeout_ms??((input.context?.gateway?.queue_timeout_ms??DEFAULT_QUEUE_TIMEOUT_MS)+(input.context?.gateway?.request_timeout_ms??360000000));
      const deadline=deadlineTimer(()=>{failed=chatError('timeout');child.kill();killTimer=setTimeout(()=>child.kill('SIGKILL'),2000);killTimer.unref();},timeout);
      const cleanup=()=>{deadline.cancel();clearTimeout(killTimer);children.delete(child);};
      child.stdout.setEncoding('utf8');
      child.stdout.on('data',chunk=>{
        bytes+=Buffer.byteLength(chunk);if(bytes>16*1024*1024){failed=chatError('bridge');child.kill();return;}
        pending+=chunk;let n;
        while((n=pending.indexOf('\n'))>=0){const line=pending.slice(0,n);pending=pending.slice(n+1);try{const event=JSON.parse(line);if(event.type==='delta')input.onDelta(event.text);else if(event.type==='research')input.onResearch?.(event.event);else if(event.type==='done')final=event;else if(event.type==='error')failed=chatError(event.code);}catch{failed=chatError('bridge');}}
      });
      // Never relay library logs, provider bodies or credentials into browser errors.
      child.stderr.resume();child.stdin.on('error',()=>{});
      child.on('error',()=>{cleanup();reject(chatError('runtime'));});
      child.on('close',code=>{cleanup();if(failed||code!==0||!final)reject(failed??chatError('bridge'));else resolve({text:final.text});});
      child.stdin.end(JSON.stringify({message:input.message,history:input.history,context:input.context,session_id:input.sessionId,
        research:input.research&&config.research?{search_url:config.research.search_url,extract_url:config.research.extract_url,requested_at:new Date().toISOString()}:null,
        provider:{url:config.url,model:config.model,api_key:config.api_key??'',max_tokens:config.max_tokens??8192,reasoning_effort:config.reasoning_effort??'xhigh'}}));
    });},
    close(){for(const child of children)child.kill();},
  };
}
