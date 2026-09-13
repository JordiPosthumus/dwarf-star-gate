import path from 'node:path';
import fs from 'node:fs';
import {createDemoServer} from './dashboard-demo.mjs';
import {GenieChat} from '../ds4-gateway/genie-chat.mjs';
import {hermesProvider} from '../ds4-gateway/genie-hermes.mjs';
import {isMain} from '../ds4-gateway/config.mjs';

// Deliberately simple, openly labelled responses for UI interaction tests.
// This is not a model, nor evidence that Hermes understands a real installation.
export function rehearsalProvider(){return {
  info:{engine:'UI rehearsal',model:'scripted example',mode:'rehearsal',can_act:false},
  async generate({message,history,context,onDelta}){
    let answer;
    const servers=context.servers.map(s=>s.id).join(', ');
    if(/secret|password|credential/i.test(message))answer='I cannot see credentials. This example contains only synthetic setup information.';
    else if(/restart|upgrade|delete|drain/i.test(message))answer='I can explain the steps, but this chat has no server-changing tools. I have not changed anything.';
    else if(/name is /i.test(message))answer=`Got it — I’ll remember that in this conversation. This is a scripted rehearsal answer.`;
    else if(/my name/i.test(message)){const prior=history.find(m=>m.role==='user'&&/name is /i.test(m.content));answer=prior?`You told me your name is ${prior.content.split(/name is /i)[1].replace(/[.!?]+$/,'')}. This follow-up used this conversation’s saved history.`:'You haven’t told me your name in this conversation.';}
    else if(/context|that mean|explain/i.test(message))answer=`The example servers each have a context allowance of ${context.gateway.context_length??'unknown'} tokens. That is how much conversation and other input a request can hold, subject to the model’s output allowance. It is not a speed measurement.\n\nThis is an example setup, not a live inspection.`;
    else answer=`I can see ${context.servers.length} example servers: **${servers}**.\n\nI can help you understand their reported setup and discuss it with you. Ask a follow-up in this chat; its history stays together.\n\nThese are scripted rehearsal answers. Connect Hermes to your chosen model for real conversation.`;
    for(const word of answer.match(/\S+\s*/g)??[]){onDelta(word);await new Promise(r=>setTimeout(r,12));}
    return {text:answer};
  },
};}
export function createChatDemo({directory=path.resolve('runtime/genie-chat-demo'),provider=rehearsalProvider()}={}){
  let chat;
  const server=createDemoServer({chatFactory:getSnapshot=>chat=new GenieChat({directory,provider,getSnapshot})});
  server.once('close',()=>chat.close());return {server,chat};
}
if(isMain(import.meta.url)){
  const directory=path.resolve(process.env.DSG_CHAT_DIRECTORY??'runtime/genie-chat-demo');
  // Configuration is explicit. No discovery of personal Hermes homes or secrets.
  const file=process.argv[2];
  const provider=file?hermesProvider(JSON.parse(fs.readFileSync(file,'utf8')),{directory}):rehearsalProvider();
  const {server}=createChatDemo({directory,provider});
  server.listen(Number(process.env.DEMO_PORT??0),'127.0.0.1',()=>console.log(`Genie chat (${provider.info.mode}; example fleet): http://127.0.0.1:${server.address().port}/#genie`));
  const close=()=>{server.closeAllConnections();server.close();};process.once('SIGINT',close);process.once('SIGTERM',close);
}
