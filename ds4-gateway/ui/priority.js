// Optional local controls. Never submit inference, retry a mutation, or store
// request content in browser storage. The core owns all scheduling decisions.
const $=id=>document.getElementById(id);
const levels=['High','Medium','Low'];
let state=null,busy=false,loading=false,stale=true,rulesDirty=false,settingsDirty=false,rulesRevision=null,settingsRevision=null;
const elapsed=ms=>Number.isFinite(ms)&&ms>=0?(ms<1000?'<1s':ms<60000?`${Math.floor(ms/1000)}s`:`${Math.floor(ms/60000)}m ${Math.floor(ms/1000)%60}s`):'unknown';
const permitted=()=>state?.schema===1&&typeof state.enabled==='boolean'&&Number.isSafeInteger(state.revision)&&!!state.available&&!!state.controls&&!state.error&&!stale;
function buttons(){
  for(const id of ['priority-toggle','priority-rules-save','priority-settings-save'])$(id).disabled=busy||!permitted();
  for(const select of $('priority-jobs').querySelectorAll('select'))select.disabled=busy||!permitted()||!select.dataset.chat;
  $('priority-correction-confirm').disabled=busy||!permitted()||state?.corrections?.proposal?.revision!==state?.revision;
  $('priority-correction-dismiss').disabled=busy||!permitted();
}
function correction(next){
  const root=$('priority-correction'),proposal=next.corrections?.proposal;
  root.hidden=!proposal;if(!proposal)return;
  const general=proposal.scope==='general',clarify=proposal.scope==='clarify';
  if(root.dataset.proposal!==proposal.id){
    root.dataset.proposal=proposal.id;
    $('priority-correction-title').textContent=clarify?'Genie needs a clarification':general?'Review general preference changes':'Review this conversation’s priority';
    $('priority-correction-explanation').textContent=proposal.message;
    const changes=$('priority-correction-changes');changes.replaceChildren();
    if(proposal.scope==='chat'){
      const text=document.createElement('p');text.textContent=`${proposal.title||`Conversation ${proposal.chat?.slice(0,12)}`} → ${proposal.priority}. Other conversations keep their priorities.`;changes.append(text);
    }else if(general){
      for(const [label,lines] of [['Remove',proposal.remove_rules],['Add',proposal.add_rules]])if(lines?.length){
        const heading=document.createElement('h4');heading.textContent=label;const list=document.createElement('ul');
        for(const line of lines){const item=document.createElement('li');item.textContent=line;list.append(item);}changes.append(heading,list);
      }
      const text=document.createElement('p');text.textContent=`${proposal.unchanged_rules} existing preference rules remain unchanged.`;changes.append(text);
    }
    $('priority-correction-confirm').hidden=clarify;
    $('priority-correction-confirm').textContent=general?'Confirm these preference changes':'Apply to this conversation';
    $('priority-correction-reply').hidden=!clarify;
  }
  $('priority-correction-status').textContent=proposal.revision!==next.revision?'Priority settings changed after this proposal. Ask Genie to revise it against the current settings.':clarify?'Answer the question in Genie chat. No priority or preference has changed.':'Nothing has changed yet. Confirm only if this scope and exact change match your intent.';
}
function render(next){
  state=next;stale=false;
  const ready=next.available&&next.schema===1;
  correction(next);
  $('priority-toggle').textContent=ready?`Priority Lens · ${next.enabled?'on':'off'}`:'Priority Lens · unavailable';
  $('priority-toggle').setAttribute('aria-pressed',String(ready&&next.enabled===true));
  $('priority-status').textContent=!ready?'Priority Lens needs a compatible DSG core':next.error||next.activation==='active'?next.error||`${next.jobs?.length??0}${next.jobs_truncated?'+':''} observed requests · ${next.selections??0} selections`:next.activation==='off'?'Off · ordinary scheduling': 'On · waiting for an agreed aging threshold before queue priority activates';
  if(!ready){buttons();return;}
  const root=$('priority-jobs'),existing=new Map([...root.children].map(row=>[row.dataset.request,row])),keep=new Set();
  for(const job of (Array.isArray(next.jobs)?next.jobs:[])){
    if(typeof job.request_id!=='string')continue;
    keep.add(job.request_id);let row=existing.get(job.request_id);
    if(!row){
      row=document.createElement('tr');row.dataset.request=job.request_id;
      for(let i=0;i<6;i++)row.append(document.createElement('td'));
      const select=document.createElement('select');select.setAttribute('aria-label',`Priority for ${job.title||'untitled conversation'} ${job.request_id.slice(0,8)}`);
      for(const value of ['automatic',...levels]){const option=document.createElement('option');option.value=value;option.textContent=value;select.append(option);}
      row.children[1].append(select);root.append(row);
    }
    const cells=row.children,select=cells[1].firstElementChild;
    cells[0].textContent=job.title||`Title not supplied · ${job.request_id.slice(0,8)}`;
    select.dataset.chat=job.chat||'';select.options[0].textContent=`Automatic (${job.source==='user'?'return to Genie':job.priority||'Medium'})`;
    if(document.activeElement!==select)select.value=job.source==='user'?job.priority:'automatic';
    cells[2].textContent=[job.reason,job.request_reason].filter(Boolean).join(' · ');
    cells[3].textContent=job.state==='running'?'Running':job.state==='queued'?'Queued':'Blocked';
    cells[4].textContent=job.machine||'Unassigned';
    cells[5].textContent=`${elapsed(job.waiting_ms)} waiting${job.state==='running'?` · ${elapsed(job.running_ms)} running`:''}`;
  }
  for(const row of [...root.children])if(!keep.has(row.dataset.request))row.remove();
  $('priority-coverage').textContent=`${next.demo?'Synthetic example; no real tasks are connected. ':''}${keep.size?'':'No requests currently observed. '}${next.jobs_truncated?'Showing the first 512 requests; additional requests are not displayed. ':''}Only DSG requests are shown. Direct activity and work inside an unobserved client remain unknown.`;
  if(next.classifier||next.demo){
    const classifier=next.classifier;
    $('priority-provider').textContent=next.demo?'Synthetic priorities; no model is called.':classifier.connected&&classifier.enabled?`Genie classifies optional Pi user excerpts asynchronously · ${classifier.busy?'reviewing':`${classifier.completed} accepted`}. Inference never waits for advice.`:'Genie classification is unavailable or disabled. Manual priorities remain available; absent advice uses ordinary scheduling.';
  }
  if(!rulesDirty&&document.activeElement!==$('priority-rules')){$('priority-rules').value=(next.rules||[]).join('\n');rulesRevision=next.revision;}
  $('priority-preference-count').textContent=`${$('priority-rules').value.split('\n').filter(line=>line.trim()).length} / 30 lines`;
  if(!settingsDirty&&!$('priority-settings-form').contains(document.activeElement)){
    for(const level of levels)$(`priority-weight-${level.toLowerCase()}`).value=next.weights?.[level]??'';
    $('priority-aging').value=Number.isFinite(next.max_eligible_wait_ms)?next.max_eligible_wait_ms/60000:'';settingsRevision=next.revision;
  }
  buttons();
}
async function load(){
  if(loading||busy)return;loading=true;
  try{const response=await fetch('/api/priority',{signal:AbortSignal.timeout(5000)});if(!response.ok)throw new Error();render(await response.json());}
  catch{stale=true;$('priority-status').textContent='Priority state unavailable · displayed observations are stale';buttons();}
  finally{loading=false;}
}
async function act(action,input,target='priority-message'){
  if(busy||!permitted())return;busy=true;buttons();$(target).textContent='Saving…';
  try{
    const response=await fetch('/api/priority',{method:'POST',headers:{'content-type':'application/json','x-dsg-csrf':state.csrf_token},body:JSON.stringify({action,...input}),signal:AbortSignal.timeout(15000)});
    const next=await response.json();if(!response.ok)throw new Error(next.error||'Save rejected; refresh before editing again');
    if(action==='rules')rulesDirty=false;if(action==='settings'&&target==='priority-settings-message')settingsDirty=false;
    render(next);$(target).textContent=action==='manual'?'Conversation priority saved; active work continues.':action==='rules'?'Priority preferences saved.':action==='confirm-correction'?'Confirmed priority correction saved; active work continues.':action==='dismiss-correction'?'Proposed correction dismissed.':'Priority scheduling settings saved.';
  }catch(error){$(target).textContent=error.name==='TimeoutError'||error.name==='TypeError'?'Save response unavailable. Check current state before retrying; the change may have been saved.':error.message;}
  finally{busy=false;buttons();void load();}
}
$('priority-jobs').addEventListener('change',event=>{
  const select=event.target;if(select.tagName!=='SELECT'||!select.dataset.chat)return;
  void act('manual',{chat:select.dataset.chat,priority:select.value==='automatic'?null:select.value,expected_revision:state.revision});
});
$('priority-toggle').addEventListener('click',()=>{
  if(!state)return;
  void act('settings',{expected_revision:state.revision,enabled:!state.enabled,weights:state.weights,max_eligible_wait_ms:state.max_eligible_wait_ms});
});
$('priority-rules').addEventListener('input',()=>{
  if(!rulesDirty)rulesRevision=state?.revision;rulesDirty=true;
  $('priority-preference-count').textContent=`${$('priority-rules').value.split('\n').filter(line=>line.trim()).length} / 30 lines`;
});
$('priority-preferences-form').addEventListener('submit',event=>{
  event.preventDefault();if(!permitted())return;
  const rules=$('priority-rules').value.split('\n').map(line=>line.trim()).filter(Boolean);
  if(rules.length>30){$('priority-message').textContent='Keep at most 30 preference lines; your draft has not been shortened.';return;}
  void act('rules',{expected_revision:rulesRevision??state?.revision,rules});
});
$('priority-settings-form').addEventListener('input',()=>{if(!settingsDirty)settingsRevision=state?.revision;settingsDirty=true;});
$('priority-settings-form').addEventListener('submit',event=>{
  event.preventDefault();if(!permitted())return;const minutes=Number($('priority-aging').value),max_eligible_wait_ms=Math.round(minutes*60000);
  if(!$('priority-aging').value||!Number.isSafeInteger(max_eligible_wait_ms)||max_eligible_wait_ms<1000||max_eligible_wait_ms>86400000){$('priority-settings-message').textContent='Choose an eligible-wait backstop between 1 second and 24 hours.';return;}
  void act('settings',{expected_revision:settingsRevision??state?.revision,enabled:state.enabled,weights:Object.fromEntries(levels.map(level=>[level,Number($(`priority-weight-${level.toLowerCase()}`).value)])),max_eligible_wait_ms},'priority-settings-message');
});
$('priority-rules-reload').addEventListener('click',()=>{rulesDirty=false;void load();});
$('priority-settings-reload').addEventListener('click',()=>{settingsDirty=false;document.activeElement?.blur();void load();});
$('priority-correction-confirm').addEventListener('click',()=>{const proposal=state?.corrections?.proposal;if(proposal)void act('confirm-correction',{proposal_id:proposal.id});});
$('priority-correction-dismiss').addEventListener('click',()=>{const proposal=state?.corrections?.proposal;if(proposal)void act('dismiss-correction',{proposal_id:proposal.id});});
$('priority-correction-reply').addEventListener('click',()=>{$('genie-question').focus();$('genie-question').scrollIntoView({block:'center'});});
void load();setInterval(()=>void load(),5000);
