const panel=document.getElementById('conversation-shell');
if(panel){
  const $=id=>document.getElementById(id);
  let token=null,current=null,status=null,signature='',fetching=false,sending=false,creating=false,request=null,connectionError=null,cachedSession=null;
  const draftKey=id=>`dsg-genie-draft:${id??'new'}`;
  const draft={read:id=>{try{return sessionStorage.getItem(draftKey(id))??'';}catch{return '';}},write:(id,text)=>{try{sessionStorage.setItem(draftKey(id),text);}catch{}}};
  function text(tag,content,className){const e=document.createElement(tag);e.textContent=content;if(className)e.className=className;return e;}
  async function api(url,body){const r=await fetch(url,body?{method:'POST',headers:{'content-type':'application/json','x-dsg-csrf':token},body:JSON.stringify(body)}:{});const value=await r.json();if(!r.ok)throw new Error(value.error??'Chat request failed.');return value;}
  function error(message){$('conversation-error').textContent=message??'';}
  function format(body){
    const fragment=document.createDocumentFragment();
    for(const [i,part]of body.split(/```[^\n]*\n?/).entries()){
      if(i%2){fragment.append(text('pre',part));continue;}
      // Render only emphasis; all other model text remains inert text, never HTML.
      for(const [j,piece]of part.split(/\*\*([^*]+)\*\*/).entries())fragment.append(j%2?text('strong',piece):document.createTextNode(piece));
    }
    return fragment;
  }
  function render(session){
    const key=JSON.stringify([session,status?.available,status?.suspended,sending,creating]);if(key===signature)return;signature=key;
    const list=$('conversation-messages'),scrollTop=list.scrollTop,nearBottom=list.scrollHeight-list.scrollTop-list.clientHeight<90;
    list.replaceChildren();
    if(!session?.messages.length){
      const empty=text('div','','conversation-empty');empty.append(text('h3','Let’s make sense of your setup.'),text('p','Ask a question, then follow it up. Genie keeps this conversation and uses the setup information available to this dashboard.'));
      const buttons=text('div','','conversation-suggestions');
      for(const label of ['What servers can you see?','Explain this setup in plain English.','What can you help me with?']){const b=text('button',label);b.type='button';b.addEventListener('click',()=>{$('conversation-input').value=label;draft.write(current,label);$('conversation-input').focus();});buttons.append(b);}
      empty.append(buttons);list.append(empty);
    }
    for(const m of session?.messages??[]){
      const article=text('article','','conversation-message');article.dataset.role=m.role;article.dataset.messageId=m.id;
      article.append(text('p',m.role==='user'?'You':'Genie','conversation-author'));
      const body=text('div','','conversation-text');body.append(format(m.text));article.append(body);
      if(m.state==='working'&&!m.text)article.append(text('p','Waiting for the model','conversation-thinking'));
      if(m.error)article.append(text('p',m.error,'conversation-error'));
      if(m.context){const d=document.createElement('details');d.append(text('summary','Setup used for this answer'));const c=m.context;d.append(text('p',`${c.source}\n${c.observed_at?new Date(c.observed_at).toLocaleString():'Observation time unavailable'}\n${c.unavailable?'Current setup unavailable':`${c.servers.length} servers in this snapshot`}\n${c.servers.map(w=>`${w.id}: ${w.is_healthy===true?'healthy':w.is_healthy===false?'not healthy':'health unknown'}; context ${w.context_length??'unknown'}`).join('\n')}`));article.append(d);}
      list.append(article);
    }
    $('conversation-send').disabled=sending||creating||Boolean(session?.busy)||!status?.available;
    $('conversation-activity').textContent=session?.busy?'Waiting for Genie’s reply. You can write your next question below.':status?.suspended?'New questions are paused while testing mode is active.':status?.available?'Ready for your next question.':'Chat is not connected to Hermes yet.';
    if(nearBottom)list.scrollTop=list.scrollHeight;else list.scrollTop=scrollTop;
  }
  async function select(id){if(sending)return;draft.write(current,$('conversation-input').value);current=id;try{localStorage.setItem('dsg-genie-conversation',id);}catch{}$('conversation-input').value=draft.read(id);signature='';error();const session=await api(`/api/genie/chat/${id}`);if(current===id){cachedSession=session;render(session);}renderList();}
  function renderList(){const list=$('conversation-list');list.replaceChildren();for(const s of status?.conversations??[]){const b=text('button',s.title);b.type='button';b.setAttribute('aria-current',String(s.id===current));b.addEventListener('click',()=>select(s.id).catch(e=>error(e.message)));list.append(b);}}
  async function refresh(){if(fetching)return;fetching=true;try{
    status=await api('/api/genie/chat');token=status.csrf_token;
    $('conversation-provider').textContent=status.suspended?'Paused for testing':status.mode==='rehearsal'?'Rehearsal · example answers':status.available?`Hermes · ${status.model}`:'Hermes not configured';
    $('conversation-badge').textContent=status.mode==='rehearsal'?'Example setup':'Conversation only';
    if(current&&!sending&&!creating&&!status.conversations.some(s=>s.id===current)){draft.write(current,$('conversation-input').value);current=null;signature='';$('conversation-input').value=draft.read(null);}
    if(!current&&status.conversations.length){let saved;try{saved=localStorage.getItem('dsg-genie-conversation');}catch{}current=status.conversations.some(s=>s.id===saved)?saved:status.conversations[0].id;$('conversation-input').value=draft.read(current);}
    renderList();const id=current,row=status.conversations.find(s=>s.id===id);
    const changed=id&&(cachedSession?.id!==id||row?.busy||cachedSession?.busy||cachedSession?.updated_at!==row?.updated_at);
    const session=id?(changed?await api(`/api/genie/chat/${id}`):cachedSession):null;if(id===current){cachedSession=session;render(session);}
    if(connectionError&&$('conversation-error').textContent===connectionError)error();connectionError=null;
    if(status.unreadable_conversations?.length)error(`${status.unreadable_conversations.length} saved conversation file(s) could not be read and were preserved. Other chats still work.`);
  }catch(e){connectionError=`Connection unavailable. Your draft is kept. ${e.message}`;error(connectionError);signature='';$('conversation-send').disabled=true;}finally{fetching=false;}}
  $('conversation-new').addEventListener('click',async()=>{if(sending||creating)return;creating=true;$('conversation-input').disabled=true;$('conversation-new').disabled=true;$('conversation-send').disabled=true;try{const s=await api('/api/genie/chat',{action:'new'});await refresh();await select(s.id);}catch(e){error(e.message);}finally{creating=false;$('conversation-input').disabled=false;$('conversation-new').disabled=false;signature='';await refresh();$('conversation-input').focus();}});
  $('conversation-input').addEventListener('input',()=>draft.write(current,$('conversation-input').value));
  $('conversation-input').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();$('conversation-form').requestSubmit();}});
  $('conversation-form').addEventListener('submit',async e=>{e.preventDefault();const message=$('conversation-input').value.trim();if(!message||sending||$('conversation-send').disabled)return;sending=true;$('conversation-send').disabled=true;$('conversation-input').disabled=true;$('conversation-new').disabled=true;error();try{
    if(!current){const s=await api('/api/genie/chat',{action:'new'});current=s.id;}
    if(!request||request.text!==message||request.conversation_id!==current)request={action:'send',conversation_id:current,text:message,request_id:crypto.randomUUID()};
    const s=await api('/api/genie/chat',request);request=null;$('conversation-input').value='';draft.write(current,'');signature='';render(s);$('conversation-messages').scrollTop=$('conversation-messages').scrollHeight;
  }catch(e){error(e.message);}finally{sending=false;$('conversation-input').disabled=false;$('conversation-new').disabled=false;await refresh();$('conversation-input').focus();}});
  $('conversation-input').value=draft.read(null);refresh();setInterval(()=>{if(!document.hidden)refresh();},750);
}
