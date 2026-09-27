// Fresh observations and saved identities for automatic conversation follow-ups.
// Hermes owns execution; these helpers never run an agent or replay native input.
import {randomUUID} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function saveFollowupJournal(filename,value){
  const parent=path.dirname(filename),temporary=filename+'.'+randomUUID()+'.tmp';
  fs.mkdirSync(parent,{recursive:true,mode:0o700});
  try{
    const fd=fs.openSync(temporary,'wx',0o600);
    try{fs.writeFileSync(fd,JSON.stringify(value,null,2)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    fs.renameSync(temporary,filename);
    const dir=fs.openSync(parent,'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}
  }finally{if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
}

export async function followupStatus(chat){
  await chat.refresh?.();
  return chat.status();
}

export function followupReady(summary){
  if(!summary?.available||!Array.isArray(summary.conversations)||summary.conversations.some(c=>c.busy||c.queued))return false;
  if(summary.mode==='native')return summary.native_observation_available===true&&summary.conversations.every(c=>
    c.observation_available===true&&c.busy===false&&c.queued===0&&!c.queue_paused&&c.pending_input_count===0);
  return true;
}

export async function followupConversation(chat,record,save,title){
  if(record.conversation_id)return record.conversation_id;
  const native=chat.status().mode==='native';
  if(native){
    if(!record.conversation_intent)record.conversation_intent={id:randomUUID(),title,purpose:null};
    const intent=record.conversation_intent;
    if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(intent.id??'')||intent.title!==title||intent.purpose!==null)
      throw Error('Saved follow-up conversation identity needs reconciliation.');
    save(); // Persist before native creation; a lost reply retains this exact ID.
    const conversation=await chat.create(intent);
    if(conversation.id!==intent.id)throw Error('Native follow-up conversation identity was not confirmed.');
    record.conversation_id=intent.id;
    delete record.conversation_intent;
  }else record.conversation_id=(await chat.create({title})).id;
  save();
  return record.conversation_id;
}

export function createChatTick({chat,watchers,onError=()=>{}}){
  let running=null,closed=false;
  return {
    tick(){
      if(closed)return Promise.resolve();
      if(running)return running;
      const run=(async()=>{
        try{
          await chat?.tick();
          for(const watcher of watchers){if(closed)return;await watcher?.tick();}
        }catch(error){onError(error);}
      })();
      running=run;
      return run.finally(()=>{if(running===run)running=null;});
    },
    close(){closed=true;},
  };
}
