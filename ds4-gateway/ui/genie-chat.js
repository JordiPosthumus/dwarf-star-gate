import {genieHandoff} from './genie-handoff.js';
const panel=document.getElementById('conversation-shell');
if(panel){
  const $=id=>document.getElementById(id);
  let token=null,current=null,status=null,signature='',fetching=false,sending=false,creating=false,request=null,connectionError=null,cachedSession=null,lastObservedAt=null;
  const draftKey=id=>`dsg-genie-draft:${id??'new'}`;
  const draft={read:id=>{try{return sessionStorage.getItem(draftKey(id))??'';}catch{return '';}},write:(id,text)=>{try{sessionStorage.setItem(draftKey(id),text);}catch{}}};
  function text(tag,content,className){const e=document.createElement(tag);e.textContent=content;if(className)e.className=className;return e;}
  function sourceLink(label,url){try{const u=new URL(url);if(u.protocol!=='https:'||u.username||u.password)throw new Error();const a=text('a',label||u.hostname);a.href=u.href;a.target='_blank';a.rel='noopener noreferrer';return a;}catch{return document.createTextNode(label||url||'Source unavailable');}}
  async function api(url,body){const r=await fetch(url,body?{method:'POST',headers:{'content-type':'application/json','x-dsg-csrf':token},body:JSON.stringify(body)}:{});const value=await r.json();if(!r.ok){const e=new Error(value.error??'Chat request failed.');e.status=r.status;throw e;}return value;}
  function error(message){$('conversation-error').textContent=message??'';}
  function format(body){
    const fragment=document.createDocumentFragment();
    for(const [i,part]of body.split(/```[^\n]*\n?/).entries()){
      if(i%2){fragment.append(text('pre',part));continue;}
      // A small text-node renderer: emphasis, inline code and HTTPS citations. Never HTML.
      for(const [j,piece]of part.split(/\*\*([^*]+)\*\*/).entries()){
        if(j%2){fragment.append(text('strong',piece));continue;}
        let end=0;for(const m of piece.matchAll(/\[([^\]\n]+)\]\((https:\/\/[^\s)]+)\)|`([^`\n]+)`/g)){fragment.append(document.createTextNode(piece.slice(end,m.index)),m[3]!==undefined?text('code',m[3]):sourceLink(m[1],m[2]));end=m.index+m[0].length;}fragment.append(document.createTextNode(piece.slice(end)));
      }
    }
    return fragment;
  }
  function render(session){
    const key=JSON.stringify([session,status?.available,status?.suspended,status?.research_available,status?.notebook_access,sending,creating]);if(key===signature)return;signature=key;
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
      if(m.state==='queued')article.append(text('p','Saved · waiting for earlier answers','conversation-thinking'));
      if(m.state==='working'&&!m.text)article.append(text('p',m.waiting_for_review==='scheduled'?'Genie is yielding his routine review…':m.waiting_for_review?'Waiting for Genie’s current review to finish…':'Waiting for the model','conversation-thinking'));
      if(m.error)article.append(text('p',m.error,'conversation-error'));
      if(m.role==='assistant'&&m.research?.events?.length){
        const events=m.research.events??[],last=events.at(-1);
        if(m.state==='working'&&last?.state==='reading')article.append(text('p','Reading public sources…','conversation-thinking'));
        const d=text('details','','conversation-sources');d.append(text('summary','Web research sources'));
        d.append(text('p',`Public sources checked · ${new Date(events[0].at).toLocaleString()}`));
        const sources=new Map();for(const e of events){for(const s of e.sources??[]){const prior=sources.get(s.url);if(!prior||e.kind==='read')sources.set(s.url,{...s,title:s.title||prior?.title,kind:e.kind,at:e.at});}if(e.error)d.append(text('p',e.error));}
        for(const s of sources.values()){const p=text('p','');p.append(sourceLink(s.title,s.url),document.createTextNode(` · ${s.kind==='read'?'read':'search result'} · ${new Date(s.at).toLocaleString()}`));d.append(p);}article.append(d);
      }
      if(m.context){const d=document.createElement('details');d.append(text('summary','Setup used for this answer'));const c=m.context;d.append(text('p',`${c.source}\n${c.observed_at?new Date(c.observed_at).toLocaleString():'Observation time unavailable'}\n${c.unavailable?'Current setup unavailable':`${c.servers.length} servers in this snapshot`}\n${c.servers.map(w=>`${w.id}: ${w.is_healthy===true?'healthy':w.is_healthy===false?'not healthy':'health unknown'}; context ${w.context_length??'unknown'}`).join('\n')}`));if(c.operational_activity){const a=c.operational_activity;d.append(text('p',a.available?`Operational history: ${a.reviews.length} recent review records; ${a.actions.length} action receipts${a.truncated?' (limited selection)':''}. Historical evidence, not proof of current health. ${c.operational_notebook?.included?'Notebook context is listed below.':'Private notebook prose is not included.'}`:'Operational history was not available for this answer.'));}if(c.hourglass_reports?.configured){d.append(text('p',`Hourglass: ${c.hourglass_reports.reports.length} saved reports used; ${c.hourglass_reports.unavailable_count} unavailable. Historical measurements, not current configuration or upgrade proof.`));for(const row of c.hourglass_reports.reports)d.append(text('p',`${row.summary.model} · ${row.summary.score.value??'score unavailable'} · ${row.summary.score.version??'metric unknown'} · ${row.summary.state}\nReport revision: ${row.report_revision??'unknown'}`));}if(c.operational_notebook){const n=c.operational_notebook;d.append(text('p',n.included?`Operational notebook: ${n.notes.length} record${n.notes.length===1?'':'s'} used${n.truncated?' (limited selection)':''}. Historical context, not approval or current health proof.`:n.configured?`Operational notebook not used: ${n.reason==='memory_disabled'?'memory was off':'notebook was unavailable'}.`:'Operational notebook access was off for this answer.'));for(const note of n.notes??[]){const detail=text('details','');detail.append(text('summary',`${note.kind} · ${note.id} · revision ${note.revision}`),text('p',JSON.stringify(note.data,null,2)));d.append(detail);}}if(c.study_brief)d.append(text('p',`Research brief: ${c.study_brief}`));for(const row of c.configuration_records?.records??[])for(const kind of ['approved','observed','proposed']){const r=row[kind];if(r)d.append(text('p',`${row.worker_id} · ${kind} · ${r.runtime?.name??'runtime unknown'} ${r.runtime?.version??''}\nConfiguration revision: ${r.revision??'unavailable'}`));}article.append(d);}
      list.append(article);
    }
    if(session?.queue_paused){const paused=text('div','','conversation-error');paused.append(text('p','An earlier reply did not finish. Queued questions are saved and paused. Continue after reviewing it; the failed question will not be replayed.'));const resume=text('button','Continue queued questions','button');resume.type='button';resume.disabled=sending||!status?.available;resume.addEventListener('click',async()=>{resume.disabled=true;try{await api('/api/genie/chat',{action:'continue-queue',conversation_id:session.id,expected_reply_id:session.queue_paused});await refresh();}catch(e){error(e.message);resume.disabled=false;}});list.append(paused);paused.append(resume);}
    $('conversation-send').disabled=sending||creating||!status?.available;
    $('conversation-web-status').textContent=status?.research_available?'Genie can search public sources when useful.':'Web search is not configured for this installation.';
    $('conversation-web-status').textContent+=status?.notebook_access?' Operational notebook access is enabled for this chat.':' The operational notebook is not shared with this chat.';
    $('conversation-activity').textContent=session?.queue_paused?'Queued questions are paused for your review.':session?.busy?`Genie is answering${session.queued?`; ${session.queued} waiting`:''}. You can send a follow-up now.`:status?.suspended?'New questions are paused while testing mode is active.':status?.available?'Ready for your next question.':'Chat is not connected to Hermes yet.';
    if(nearBottom)list.scrollTop=list.scrollHeight;else list.scrollTop=scrollTop;
  }
  async function select(id){if(sending)return;draft.write(current,$('conversation-input').value);current=id;try{localStorage.setItem('dsg-genie-conversation',id);}catch{}$('conversation-input').value=draft.read(id);signature='';error();const session=await api(`/api/genie/chat/${id}`);if(current===id){cachedSession=session;render(session);}renderList();}
  function renderList(){const list=$('conversation-list');list.replaceChildren();for(const s of status?.conversations??[]){const b=text('button',s.title);b.type='button';b.setAttribute('aria-current',String(s.id===current));b.addEventListener('click',()=>select(s.id).catch(e=>error(e.message)));list.append(b);}}
  let studyBusy=false,studyRequest=null,studyDue=false;
  function renderStudy(){
    const s=status?.study,box=$('genie-study');if(!box)return;box.hidden=!s;if(!s)return;
    if(s.due&&!studyDue)box.open=true;studyDue=s.due;
    const busy=['queued','working'].includes(s.last_run?.state);
    $('study-summary').textContent=busy?'· studying':s.due?'· ready when you are':s.interval_days?'· reminder set':'· on your request';
    $('study-status').textContent=s.error??(busy?'Genie is studying your setup. Follow his sources and answer in the study conversation.':s.due?'Would you like Genie to look for worthwhile improvements?':s.next_due_at?`Next reminder: ${new Date(s.next_due_at).toLocaleString()}`:'Start a study whenever you want, or choose a reminder interval below.');
    if(!s.available&&!s.error&&!busy)$('study-status').textContent+=' Connect Genie and web search to start; testing mode must be off.';
    if(['failed','interrupted','not_started'].includes(s.last_run?.state))$('study-status').textContent+=' The last study did not finish. Open it to inspect what was saved; it will not restart automatically.';
    $('study-start').textContent=s.due?'Start study':'Research now';$('study-start').disabled=studyBusy||busy||!s.available||sending||creating;
    for(const id of ['study-postpone','study-skip']){$(id).hidden=!s.due;$(id).disabled=studyBusy||!!s.error;}
    $('study-open').hidden=!s.last_run;$('study-open').disabled=sending||creating;
    $('study-save').disabled=studyBusy||!!s.error;
    if(document.activeElement!==$('study-interval')&&!$('study-interval').dataset.edited)$('study-interval').value=String(s.interval_days);
  }
  async function studyChange(action,extra={}){
    if(studyBusy)return;studyBusy=true;$('study-error').textContent='';renderStudy();
    try{
      const input=action==='study-start'?(studyRequest??={action,expected_revision:status.study.revision,request_id:crypto.randomUUID()}):{action,expected_revision:status.study.revision,...extra};
      const result=await api('/api/genie/chat',input);status.study=result;
      if(action==='study-start'){studyRequest=null;await refresh();await select(result.last_run.conversation_id);}
      if(action==='study-schedule')delete $('study-interval').dataset.edited;
    }catch(e){if(e.status>=400&&e.status<500)studyRequest=null;$('study-error').textContent=e.message;}
    finally{studyBusy=false;await refresh();renderStudy();}
  }
  $('study-interval')?.addEventListener('change',()=>{$('study-interval').dataset.edited='true';});
  $('study-schedule-form')?.addEventListener('submit',e=>{e.preventDefault();studyChange('study-schedule',{interval_days:Number($('study-interval').value)});});
  $('study-start')?.addEventListener('click',()=>studyChange('study-start'));
  $('study-postpone')?.addEventListener('click',()=>studyChange('study-postpone'));
  $('study-skip')?.addEventListener('click',()=>studyChange('study-skip'));
  $('study-open')?.addEventListener('click',()=>{if(status?.study?.last_run)select(status.study.last_run.conversation_id).catch(e=>{$('study-error').textContent=e.message;});});
  async function refresh(){if(fetching)return;fetching=true;try{
    status=await api('/api/genie/chat');token=status.csrf_token;renderStudy();
    $('conversation-provider').textContent=status.suspended?'Paused for testing':status.mode==='rehearsal'?'Rehearsal · example answers':status.available?`Hermes · ${status.model}`:'Hermes not configured';
    $('conversation-badge').textContent=status.mode==='rehearsal'?'Example setup':'No server changes';
    if(current&&!sending&&!creating&&!status.conversations.some(s=>s.id===current)){draft.write(current,$('conversation-input').value);current=null;signature='';$('conversation-input').value=draft.read(null);}
    if(!current&&status.conversations.length){let saved;try{saved=localStorage.getItem('dsg-genie-conversation');}catch{}current=status.conversations.some(s=>s.id===saved)?saved:status.conversations[0].id;$('conversation-input').value=draft.read(current);}
    renderList();const id=current,row=status.conversations.find(s=>s.id===id);
    const changed=id&&(cachedSession?.id!==id||row?.busy||cachedSession?.busy||cachedSession?.updated_at!==row?.updated_at);
    const session=id?(changed?await api(`/api/genie/chat/${id}`):cachedSession):null;if(id===current){cachedSession=session;render(session);}
    if(connectionError&&$('conversation-error').textContent===connectionError)error();connectionError=null;lastObservedAt=Date.now();
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
  const handoff=$('conversation-handoff');
  handoff?.addEventListener('toggle',()=>{if(handoff.open){
    $('conversation-handoff-text').value=genieHandoff({status,session:cachedSession?.id===current?cachedSession:null,connected:!connectionError&&lastObservedAt!==null,observedAt:lastObservedAt,pendingRequest:Boolean(request)});
    $('conversation-handoff-result').textContent='Review this status snapshot before sharing. It contains no conversation text.';
  }});
  $('conversation-handoff-copy')?.addEventListener('click',async()=>{
    const field=$('conversation-handoff-text'),result=$('conversation-handoff-result');
    try{await navigator.clipboard.writeText(field.value);result.textContent='Copied. Paste it into your other agent when ready.';}
    catch{field.focus();field.select();result.textContent='Text selected — press Ctrl+C or ⌘C to copy.';}
  });
  $('conversation-input').value=draft.read(null);refresh();setInterval(()=>{if(!document.hidden)refresh();},750);
}
