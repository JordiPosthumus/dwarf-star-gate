import fs from 'node:fs';
import path from 'node:path';
import {randomBytes,timingSafeEqual,randomUUID} from 'node:crypto';

const tokenPattern=/^[0-9]{5,16}:[A-Za-z0-9_-]{30,80}$/;
const positiveId=n=>Number.isSafeInteger(n)&&n>0;
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
const terminal=new Set(['complete','failed','interrupted']);
const initial=()=>({version:1,enabled:false,bot:null,owner:null,conversation_id:null,offset:0,pairing:null,inbox:{},outbox:{}});

export function telegramChunks(text){
  const result=[];let rest=String(text);
  while(rest){let length=Math.min(3500,rest.length);if(length<rest.length&&/[\uD800-\uDBFF]/.test(rest[length-1]))length--;result.push(rest.slice(0,length));rest=rest.slice(length);}
  return result;
}
export async function telegramAPI(token,method,body={}, {signal}={}){
  if(!tokenPattern.test(token)||!['getMe','getWebhookInfo','getUpdates','sendMessage','sendChatAction'].includes(method))throw Error('Invalid Telegram request.');
  let response,data;
  try{
    response=await fetch(`https://api.telegram.org/bot${token}/${method}`,{method:'POST',redirect:'error',headers:{'content-type':'application/json'},body:JSON.stringify(body),
      signal:signal?AbortSignal.any([signal,AbortSignal.timeout(method==='getUpdates'?35000:15000)]):AbortSignal.timeout(method==='getUpdates'?35000:15000)});
    data=await response.json();
  }catch{throw Object.assign(Error('Telegram connection was not confirmed. No message was replayed.'),{uncertain:true});}
  if(!response.ok||data?.ok!==true){
    const code=data?.error_code??response.status;
    throw Object.assign(Error(code===401?'Telegram rejected the bot token.':code===409?'This bot already has another Telegram receiver.':code===429?'Telegram is rate limiting this bot.':'Telegram rejected the request.'),
      {code,retry_after:Number.isFinite(data?.parameters?.retry_after)?Math.min(3600,Math.max(1,data.parameters.retry_after)):null});
  }
  return data.result;
}

export class GenieTelegram {
  constructor({directory,chat,call=telegramAPI,now=Date.now,snapshot=()=>({})}){
    this.directory=directory;this.chat=chat;this.call=call;this.now=now;this.snapshot=snapshot;
    fs.mkdirSync(directory,{recursive:true,mode:0o700});
    this.file=path.join(directory,'channel.json');this.tokenFile=path.join(directory,'bot-token');
    this.state=fs.existsSync(this.file)?JSON.parse(fs.readFileSync(this.file,'utf8')):initial();
    if(this.state.version!==1||!this.state.inbox||!this.state.outbox)throw Error('Telegram state is unreadable; the original file was preserved.');
    this.token=fs.existsSync(this.tokenFile)?fs.readFileSync(this.tokenFile,'utf8').trim():null;
    this.polling=false;this.flushing=false;this.configuring=false;this.closed=false;this.error=null;this.nextPoll=0;this.timer=null;this.controller=new AbortController();this.generation=0;
    this.typingBusy=false;this.nextTyping=0;this.lastTypingAt=null;this.typingError=null;
    for(const row of Object.values(this.state.outbox))if(row.state==='sending')row.state='uncertain';
    if(this.state.enabled&&!tokenPattern.test(this.token??''))this.error='Saved Telegram credential is missing or invalid.';
  }
  write(file,value){const temp=file+'.'+randomUUID()+'.tmp';const fd=fs.openSync(temp,'wx',0o600);try{fs.writeFileSync(fd,value);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(temp,file);}
  save(){this.write(this.file,JSON.stringify(this.state,null,2)+'\n');}
  backup(){for(const file of [this.file,this.tokenFile])if(fs.existsSync(file))fs.copyFileSync(file,file+`.before-${this.now()}-${randomUUID()}`,fs.constants.COPYFILE_EXCL);}
  status(){
    const pairing=this.state.pairing&&this.state.pairing.expires_at>this.now()?this.state.pairing:null;
    return {available:!!this.chat,configured:!!this.state.bot,enabled:this.state.enabled,bot:this.state.bot,owner:this.state.owner,
      conversation_id:this.state.conversation_id,pairing_url:pairing&&this.state.bot?`https://t.me/${this.state.bot.username}?start=${pairing.code}`:null,
      pairing_expires_at:pairing?.expires_at??null,last_received_at:this.state.last_received_at??null,last_sent_at:this.state.last_sent_at??null,error:this.error,
      pending:Object.values(this.state.inbox).filter(r=>!r.complete).length,uncertain_deliveries:Object.values(this.state.outbox).filter(r=>r.state==='uncertain').length,
      typing:{last_sent_at:this.lastTypingAt,error:this.typingError},
      scope:'One paired private Telegram account; same Genie conversations and capabilities as the dashboard. Telegram carries messages sent through this channel.'};
  }
  async configure(input){
    if(this.configuring)throw Error('Telegram setup is already being checked.');
    if(!this.chat)throw Error('Conversational Genie is not configured.');
    if(!input||Object.keys(input).some(k=>!['bot_token','conversation_id'].includes(k))||!tokenPattern.test(input.bot_token??''))throw Error('Enter the bot token from BotFather in this local field.');
    if(this.state.enabled)throw Error('Disconnect the current Telegram connection before replacing its bot.');
    if(input.conversation_id!==undefined&&input.conversation_id!==null)this.chat.get(input.conversation_id);
    this.configuring=true;
    try{
      const bot=await this.call(input.bot_token,'getMe');
      if(bot?.is_bot!==true||!positiveId(bot.id)||!/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(bot.username??''))throw Error('Telegram did not identify a valid bot.');
      const webhook=await this.call(input.bot_token,'getWebhookInfo');
      if(webhook?.url)throw Error('This bot is connected through a webhook elsewhere. Use a dedicated bot; the existing connection was preserved.');
      this.backup();this.write(this.tokenFile,input.bot_token+'\n');
      const previous=this.state;
      this.state={...initial(),enabled:true,bot:{id:bot.id,username:bot.username},conversation_id:input.conversation_id??null,
        offset:previous.bot?.id===bot.id?previous.offset:0,pairing:{code:randomBytes(24).toString('base64url'),expires_at:this.now()+15*60*1000}};
      // Old channel history is retained in its timestamped backup, never replayed.
      this.save();this.token=input.bot_token;this.error=null;this.nextPoll=0;this.generation++;return this.status();
    }finally{this.configuring=false;}
  }
  pairAgain(){
    if(!this.state.enabled||!this.token)throw Error('Connect a bot first.');
    if(this.state.owner)throw Error('This bot is already paired. Disconnect before changing its owner.');
    this.state.pairing={code:randomBytes(24).toString('base64url'),expires_at:this.now()+15*60*1000};this.save();return this.status();
  }
  selectConversation(id){
    if(typeof id!=='string')throw Error('Choose a saved Genie conversation.');const conversation=this.chat.get(id);
    this.state.conversation_id=id;this.state.subscription={conversation_id:id,cursor:conversation.messages.length};this.save();return this.status();
  }
  disconnect(){if(this.configuring)throw Error('Wait for the current Telegram setup check.');this.backup();this.state.enabled=false;this.state.owner=null;this.state.pairing=null;this.save();this.generation++;this.controller.abort();this.controller=new AbortController();return this.status();}
  conversation(){
    if(!this.state.conversation_id){this.state.conversation_id=this.chat.create({title:'Telegram · Gate Genie'}).id;this.save();}
    return this.chat.get(this.state.conversation_id);
  }
  enqueue(key,text,chatId=this.state.owner?.chat_id){
    if(!positiveId(chatId))return;
    for(const [index,chunk] of telegramChunks(text).entries()){
      const id=`${key}-${index}`;
      if(!this.state.outbox[id])this.state.outbox[id]={id,group:key,chat_id:chatId,text:chunk,state:'pending',created_at:this.now()};
    }
    this.save();
  }
  statusText(){
    const conversation=this.conversation(),fleet=this.snapshot(),gateway=fleet.gateway;
    const reply=[...conversation.messages].reverse().find(m=>m.role==='assistant');
    return ['Gate Genie is connected.',`Conversation: ${conversation.title}`,`Genie: ${conversation.busy?'working':'idle'}; ${conversation.queued??0} queued question(s).`,
      gateway?`Fleet observation: ${(gateway.workers??[]).filter(w=>w.is_healthy&&!w.drained).length} eligible model servers; ${gateway.active??'unknown'} active requests.`:'Fleet observation is currently unavailable.',
      reply?`Latest reply: ${reply.state}.`:'No replies yet.',
      Object.values(this.state.outbox).some(r=>r.state==='uncertain')?'A Telegram delivery was not confirmed. /last retrieves the latest saved answer without rerunning Genie.':null,
      'Ask a normal question for Genie to inspect the fleet or explain his tool receipts.'].filter(Boolean).join('\n');
  }
  async accept(update){
    if(!Number.isSafeInteger(update?.update_id)||update.update_id<0||update.update_id<this.state.offset)return;
    const message=update.message,owner=this.state.owner;
    const privateUser=message?.chat?.type==='private'&&positiveId(message.chat.id)&&positiveId(message.from?.id)&&message.chat.id===message.from.id&&message.from.is_bot!==true;
    const text=typeof message?.text==='string'?message.text.trim():null;
    const key=`tg-${this.state.bot.id}-${update.update_id}`;
    if(privateUser&&!owner){
      const pairing=this.state.pairing,code=text?.match(/^\/start\s+([A-Za-z0-9_-]+)$/)?.[1];
      if(pairing&&pairing.expires_at>this.now()&&same(code,pairing.code)&&!message.forward_origin){
        this.state.owner={chat_id:message.chat.id,user_id:message.from.id,name:String(message.from.first_name??'Owner').slice(0,80)};this.state.pairing=null;
        const conversation=this.conversation();this.state.subscription={conversation_id:conversation.id,cursor:conversation.messages.length};
        this.save();this.enqueue(key,'Connected to Gate Genie. Your messages use the same saved conversation and capabilities as the DSG dashboard. New replies in this conversation also appear here. Send a question, or /status.');
      }
    }else if(privateUser&&owner?.user_id===message.from.id&&owner.chat_id===message.chat.id){
      this.state.last_received_at=this.now();
      if(message.forward_origin)this.enqueue(key,'Send your own instruction alongside any quoted material; forwarded messages are not executed as commands.');
      else if(!text)this.enqueue(key,'This connection currently accepts text messages. Please send your question as text.');
      else if(['/start','/help'].includes(text))this.enqueue(key,'Talk to Gate Genie normally. /status shows connection and conversation status. /last retrieves the latest saved answer without rerunning it. Select a different saved conversation in DSG → Gate Genie → Telegram.');
      else if(text==='/status')this.enqueue(key,this.statusText());
      else if(text==='/last'){
        const last=[...this.conversation().messages].reverse().find(m=>m.role==='assistant'&&terminal.has(m.state));
        this.enqueue(key,last?`${last.state==='complete'?'':'['+last.state+']\n'}${last.text||last.error||'No answer text was saved.'}`:'No finished reply yet.');
      }else if(!this.state.inbox[key]){
        this.state.inbox[key]={request_id:key,conversation_id:this.conversation().id,text,received_at:this.now(),complete:false};this.save();
      }
    }
    // Persist text and its stable request ID before acknowledging Telegram's update.
    this.state.offset=update.update_id+1;this.save();
  }
  async poll(){
    if(this.closed||this.configuring||this.polling||!this.state.enabled||!this.token||this.now()<this.nextPoll)return;
    this.polling=true;const generation=this.generation;
    try{
      const updates=await this.call(this.token,'getUpdates',{offset:this.state.offset,limit:50,timeout:25,allowed_updates:['message']},{signal:this.controller.signal});
      if(!Array.isArray(updates))throw Error('Invalid Telegram update response.');
      if(!this.state.enabled||this.closed||generation!==this.generation)return;
      for(const update of [...updates].sort((a,b)=>a.update_id-b.update_id))await this.accept(update);
      this.error=null;
    }catch(e){if(!this.closed&&this.state.enabled&&generation===this.generation){this.error=e.code===409?'Another process is receiving this bot’s messages.':e.code===401?'The bot token was rejected.':'Telegram receive is unavailable; saved questions are retained.';this.nextPoll=this.now()+(e.retry_after??10)*1000;}}
    finally{this.polling=false;}
  }
  async flush(){
    if(this.closed||this.flushing||this.configuring||!this.state.enabled||!this.state.owner)return;
    this.flushing=true;const generation=this.generation;
    try{
      for(const row of Object.values(this.state.inbox)){
        if(row.complete)continue;
        let conversation=this.chat.get(row.conversation_id),index=conversation.messages.findIndex(m=>m.role==='user'&&m.request_id===row.request_id);
        if(index<0){
          if(!this.chat.status().available)continue;
          conversation=this.chat.submit(row.conversation_id,row.text,row.request_id);index=conversation.messages.findIndex(m=>m.role==='user'&&m.request_id===row.request_id);
        }
        const reply=conversation.messages[index+1];
        if(reply?.role==='assistant'&&terminal.has(reply.state)){
          this.enqueue(`reply-${reply.id}`,`${reply.state==='complete'?'':'['+reply.state+']\n'}${reply.text||reply.error||'Genie finished without a text reply.'}`);
          row.reply_id=reply.id;row.complete=true;this.save();
        }
      }
      const subscription=this.state.subscription;
      if(subscription){
        const conversation=this.chat.get(subscription.conversation_id);
        while(subscription.cursor<conversation.messages.length){
          const message=conversation.messages[subscription.cursor];
          if(message.role==='assistant'){
            if(!terminal.has(message.state))break;
            this.enqueue(`reply-${message.id}`,`${message.state==='complete'?'':'['+message.state+']\n'}${message.text||message.error||'Genie finished without a text reply.'}`);
          }
          subscription.cursor++;this.save();
        }
      }
      if(this.state.next_send_at>this.now())return;
      for(const row of Object.values(this.state.outbox)){
        if(this.closed||!this.state.enabled||generation!==this.generation)break;
        if(row.state!=='pending'||row.chat_id!==this.state.owner?.chat_id||row.retry_at>this.now())continue;
        if(Object.values(this.state.outbox).some(previous=>previous.group===row.group&&['failed','uncertain'].includes(previous.state)))continue;
        row.state='sending';this.save();
        try{
          const sent=await this.call(this.token,'sendMessage',{chat_id:row.chat_id,text:row.text,link_preview_options:{is_disabled:true}},{signal:this.controller.signal});
          if(generation!==this.generation)return;
          if(!positiveId(sent?.message_id))throw Object.assign(Error('Unconfirmed Telegram delivery'),{uncertain:true});
          row.state='sent';row.message_id=sent.message_id;this.state.last_sent_at=this.now();
        }catch(e){
          if(generation!==this.generation)return;
          row.state=e.code===429?'pending':e.uncertain?'uncertain':'failed';
          if(e.code===429)this.state.next_send_at=row.retry_at=this.now()+(e.retry_after??30)*1000;
          this.error=row.state==='uncertain'?'Telegram delivery was not confirmed; /last can retrieve the saved answer.':'Telegram could not deliver a reply. The answer remains in DSG.';
        }
        this.save();break; // Keep this private chat below one new message per second.
      }
    }catch{this.error='Telegram could not advance a saved question. Its receipt and Genie conversation were retained.';}
    finally{this.flushing=false;}
  }
  hasPendingReply(){
    for(const row of Object.values(this.state.inbox)){
      if(row.complete)continue;
      const conversation=this.chat.get(row.conversation_id),index=conversation.messages.findIndex(m=>m.role==='user'&&m.request_id===row.request_id);
      const reply=index>=0?conversation.messages[index+1]:null;
      if(reply?.role==='assistant'&&!terminal.has(reply.state))return true;
    }
    const subscription=this.state.subscription;
    return !!subscription&&this.chat.get(subscription.conversation_id).messages.slice(subscription.cursor)
      .some(m=>m.role==='assistant'&&!terminal.has(m.state));
  }
  async typing(){
    if(this.closed||this.typingBusy||this.configuring||!this.state.enabled||!this.state.owner||!this.token||this.now()<this.nextTyping)return;
    try{if(!this.hasPendingReply())return;}catch{return;}
    this.typingBusy=true;this.nextTyping=this.now()+4000;const generation=this.generation;
    try{
      const result=await this.call(this.token,'sendChatAction',{chat_id:this.state.owner.chat_id,action:'typing'},{signal:this.controller.signal});
      if(generation!==this.generation||this.closed)return;
      if(result!==true)throw Error('Typing acknowledgement missing');
      this.lastTypingAt=this.now();this.typingError=null;
    }catch(e){
      if(generation!==this.generation||this.closed)return;
      this.typingError='Typing indicator unavailable; saved questions and replies are unaffected.';
      this.nextTyping=this.now()+(e.retry_after??10)*1000;
    }finally{this.typingBusy=false;}
  }
  start(){if(this.timer)return;this.timer=setInterval(()=>{void this.poll();void this.flush();void this.typing();},1500);this.timer.unref();void this.poll();}
  close(){this.closed=true;clearInterval(this.timer);this.timer=null;this.controller.abort();}
}

export function handleTelegramSettings(req,res,{telegram,csrf,reply}){
  if(req.url!=='/api/genie/telegram')return false;
  if(req.method==='GET'){reply(200,{...(telegram?.status()??{available:false}),conversations:telegram?.chat?.status().conversations??[],csrf_token:csrf});return true;}
  if(req.method!=='POST'){reply(405,{error:'Use GET or POST.'});return true;}
  if(req.headers.origin!==`http://${req.headers.host}`||!same(req.headers['x-dsg-csrf'],csrf)){reply(403,{error:'Same-origin Telegram setup required.'});return true;}
  if(!telegram){reply(409,{error:'Conversational Genie is not configured.'});return true;}
  if(req.headers['content-type']!=='application/json'){reply(415,{error:'JSON required.'});return true;}
  let body='',ended=false;req.setEncoding('utf8');const timer=setTimeout(()=>{ended=true;reply(408,{error:'Incomplete Telegram setup request.'});},10000);
  req.on('error',()=>{ended=true;clearTimeout(timer);});req.on('aborted',()=>{ended=true;clearTimeout(timer);});
  req.on('data',chunk=>{if(ended)return;body+=chunk;if(Buffer.byteLength(body)>4096){ended=true;clearTimeout(timer);reply(413,{error:'Telegram setup request too large.'});}});
  req.on('end',()=>{clearTimeout(timer);if(ended)return;ended=true;void(async()=>{
    try{
      const input=JSON.parse(body),keys=Object.keys(input).sort().join(',');let result;
      if(input.action==='connect'){
        if(!['action,bot_token','action,bot_token,conversation_id'].includes(keys))throw Error('Invalid Telegram setup fields.');
        const {action,...details}=input;result=await telegram.configure(details);
      }else if(input.action==='disconnect'&&keys==='action')result=telegram.disconnect();
      else if(input.action==='pair'&&keys==='action')result=telegram.pairAgain();
      else if(input.action==='conversation'&&keys==='action,conversation_id')result=telegram.selectConversation(input.conversation_id);
      else throw Error('Invalid Telegram action.');
      reply(200,result);
    }catch(e){reply(400,{error:e instanceof SyntaxError?'Invalid JSON.':e.message});}
  })();});return true;
}
