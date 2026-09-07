// Read-only local observations; no inference, mutations or browser persistence.
const $=id=>document.getElementById(id);
const elapsed=ms=>Number.isFinite(ms)&&ms>=0?(ms<1000?'<1s':ms<60000?`${Math.floor(ms/1000)}s`:`${Math.floor(ms/60000)}m ${Math.floor(ms/1000)%60}s`):'unknown';
let loading=false;
function render(next){
  if(!next.available||next.schema!==1){$('jobs-status').textContent='Current Jobs unavailable';return;}
  const root=$('jobs-rows');root.replaceChildren();
  for(const job of (Array.isArray(next.jobs)?next.jobs:[])){
    if(typeof job.request_id!=='string')continue;
    const row=document.createElement('tr');row.dataset.request=job.request_id;
    const preview=typeof job.request_preview?.text==='string'?job.request_preview.text:null;
    for(const value of [job.title||(preview?`Request: ${preview}`:`Request not yet identified · ${job.request_id.slice(0,8)}`),job.state==='running'?'Running':job.state==='queued'?'Queued':'Blocked',job.machine||'Unassigned',job.state==='running'?`Waited ${elapsed(job.waiting_ms)}\nRunning ${elapsed(job.running_ms)}`:`Waiting ${elapsed(job.waiting_ms)}`,job.request_reason==='Request is already running'?'':job.request_reason||'']){
      const cell=document.createElement('td');cell.textContent=value;row.append(cell);
    }
    row.firstElementChild.title=preview?'Short preview of the observed user request.':job.title?'Supplied task label.':'No supported request text is currently available.';
    root.append(row);
  }
  $('jobs-status').textContent=`${root.children.length}${next.jobs_truncated?'+':''} observed requests`;
  $('jobs-coverage').textContent=`${next.demo?'Synthetic example; no real tasks are connected. ':''}${next.jobs_truncated?'Showing the first 512 requests. ':''}Only DSG requests are shown. Direct activity and work inside an unobserved client remain unknown.`;
}
async function load(){
  if(loading)return;loading=true;
  try{const response=await fetch('/api/current-jobs',{signal:AbortSignal.timeout(5000)});if(!response.ok)throw new Error();render(await response.json());}
  catch{$('jobs-status').textContent='Current Jobs unavailable · displayed observations are stale';}
  finally{loading=false;}
}
void load();setInterval(()=>void load(),5000);
