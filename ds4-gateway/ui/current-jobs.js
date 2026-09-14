// Transient local observations and explicit owner queue edits; no inference or browser storage.
const $=id=>document.getElementById(id);
const elapsed=ms=>Number.isFinite(ms)&&ms>=0?(ms<1000?'<1s':ms<60000?`${Math.floor(ms/1000)}s`:`${Math.floor(ms/60000)}m ${Math.floor(ms/1000)%60}s`):'unknown';
const priorities=[['high','High'],['normal','Normal'],['idle-only','Idle only']];
let loading=false,editing=false,csrf=null;
function render(next){
  if(!next.available||next.schema!==1){$('jobs-status').textContent='Current Jobs unavailable';return;}
  csrf=next.csrf_token;
  const root=$('jobs-rows');root.replaceChildren();
  for(const job of (Array.isArray(next.jobs)?next.jobs:[])){
    if(typeof job.request_id!=='string')continue;
    const row=document.createElement('tr');row.dataset.request=job.request_id;
    const preview=typeof job.request_preview?.text==='string'?job.request_preview.text:null;
    const label=job.title||(preview?`Request: ${preview}`:`Request not yet identified · ${job.request_id.slice(0,8)}`);
    for(const value of [label,job.state==='running'?'Running':job.state==='queued'?'Queued':'Blocked',priorities.find(([value])=>value===job.priority)?.[1]??'Normal',job.machine||'Unassigned',job.state==='running'?`Waited ${elapsed(job.waiting_ms)}\nRunning ${elapsed(job.running_ms)}`:`Waiting ${elapsed(job.waiting_ms)}`,job.request_reason==='Request is already running'?'':job.request_reason||'']){
      const cell=document.createElement('td');cell.textContent=value;row.append(cell);
    }
    if(next.priority_edit_enabled&&['queued','blocked'].includes(job.state)&&priorities.some(([value])=>value===job.priority)){
      const select=document.createElement('select');select.setAttribute('aria-label',`Priority for ${label}`);
      for(const [value,label]of priorities){const option=document.createElement('option');option.value=value;option.textContent=label;select.append(option);}
      select.value=job.priority;select.addEventListener('change',()=>void changePriority(job,select));row.children[2].replaceChildren(select);
    }
    row.firstElementChild.title=preview?'Short preview of the observed user request.':job.title?'Supplied task label.':'No supported request text is currently available.';
    root.append(row);
  }
  $('jobs-status').textContent=`${root.children.length}${next.jobs_truncated?'+':''} observed requests`;
  $('jobs-coverage').textContent=`${next.demo?'Synthetic example; no real tasks are connected. ':''}${next.jobs_truncated?'Showing the first 512 requests. ':''}Only Star Gate requests are shown. Direct activity and work inside an unobserved client remain unknown.`;
}
async function changePriority(job,select){
  if(editing)return;editing=true;const priority=select.value;
  for(const control of $('jobs-rows').querySelectorAll('select'))control.disabled=true;
  $('jobs-action').textContent='Updating waiting priority…';
  try{
    const response=await fetch('/api/current-jobs/priority',{method:'POST',headers:{'content-type':'application/json','x-dsg-csrf':csrf},body:JSON.stringify({request_id:job.request_id,expected_priority:job.priority,priority}),signal:AbortSignal.timeout(10000)});
    const result=await response.json();if(!response.ok)throw new Error(result.error||'Priority update failed.');
    $('jobs-action').textContent=`Priority set to ${priorities.find(([value])=>value===result.priority)?.[1]??result.priority}.`;
  }catch(error){$('jobs-action').textContent=error.name==='TimeoutError'?'The reply timed out. Refreshing the current priority; check it before retrying.':error.message||'Priority update failed.';}
  finally{editing=false;select.blur();await load(true);}
}
async function load(force=false){
  if(loading||editing||(!force&&$('jobs-rows').contains(document.activeElement)))return;loading=true;
  try{
    const response=await fetch('/api/current-jobs',{signal:AbortSignal.timeout(5000)});if(!response.ok)throw new Error();const next=await response.json();
    if(!editing&&(force||!$('jobs-rows').contains(document.activeElement)))render(next);
  }
  catch{$('jobs-status').textContent='Current Jobs unavailable · displayed observations are stale';}
  finally{loading=false;}
}
void load();setInterval(()=>void load(),5000);
