// An isolated conversation preview reading an explicitly selected local gateway.
// No management sockets, background Genie, SSH readers or mutation endpoints.
import fs from 'node:fs';
import path from 'node:path';
import {loadConfig,isMain} from '../ds4-gateway/config.mjs';
import {createDashboard} from '../ds4-gateway/dashboard.mjs';
import {GenieChat,chatContext} from '../ds4-gateway/genie-chat.mjs';
import {hermesProvider} from '../ds4-gateway/genie-hermes.mjs';

export async function createLocalChatPreview(options){
  const {config}=loadConfig(options.gateway_config);
  const base=`http://127.0.0.1:${config.port}`;
  const directory=path.resolve(options.directory??'runtime/genie-chat-local');
  const provider=hermesProvider({...options,url:`${base}/v1`,api_key:config.api_key},{directory});
  const started=Date.now();let gateway=null,gatewayAt=null,gatewayError='Gateway status not yet observed',polling=false;
  const snapshot=()=>({service:'dwarf-star-gate-dashboard',version:1,time:Date.now(),started,
    read_only:true,worker_management:false,gateway,gateway_at:gatewayAt,gateway_error:gatewayError,
    devices:[],events:[],notes:'Conversation preview: live gateway status only. Engine telemetry and management controls are not connected.'});
  async function poll(){
    if(polling)return;polling=true;
    try{
      const response=await fetch(`${base}/gateway/status`,{headers:{authorization:`Bearer ${config.api_key}`},signal:AbortSignal.timeout(5000)});
      if(!response.ok)throw new Error();
      const value=await response.json();if(value.version!==1||!Array.isArray(value.workers))throw new Error();
      // The same whitelist used for model context also keeps private endpoints,
      // raw requests and credentials out of the preview's status response.
      const selected=chatContext({gateway:value});gateway={...selected.gateway,workers:selected.servers};
      gatewayAt=Date.now();gatewayError=null;
    }catch{gatewayError='Gateway status unavailable; any previous observation is stale.';}
    finally{polling=false;}
  }
  await poll();
  const chat=new GenieChat({directory,provider,getSnapshot:snapshot});
  const server=createDashboard(snapshot,undefined,null,null,null,null,null,null,chat);
  const timer=setInterval(poll,5000);
  const close=()=>{clearInterval(timer);chat.close();server.closeAllConnections();server.close();};
  server.once('close',()=>{clearInterval(timer);chat.close();});
  return {server,chat,snapshot,poll,close};
}
if(isMain(import.meta.url)){
  if(!process.argv[2])throw new Error('Supply an explicit private preview configuration; see docs/genie-conversation.md.');
  const options=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
  const {server,close}=await createLocalChatPreview(options);
  server.listen(Number(process.env.DEMO_PORT??0),'127.0.0.1',()=>console.log(`Conversational Genie (real model; observed gateway): http://127.0.0.1:${server.address().port}/#genie`));
  process.once('SIGINT',close);process.once('SIGTERM',close);
}
