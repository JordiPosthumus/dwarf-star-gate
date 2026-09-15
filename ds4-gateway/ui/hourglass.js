const $=id=>document.getElementById(id),panel=$('hourglass-controls');
if(panel){
  let state,token,busy=false,reviewId=null,runSignature=null;
  const node=(tag,value)=>{const n=document.createElement(tag);n.textContent=value;return n;};
  async function request(input){
    const r=await fetch('/api/hourglass',input?{method:'POST',headers:{'content-type':'application/json','x-dsg-csrf':token},body:JSON.stringify(input)}:{});
    const value=await r.json();if(!r.ok)throw new Error(value.error??'Hourglass controls unavailable.');return value;
  }
  function render(){
    panel.hidden=!state?.configured;if(!state?.configured)return;
    $('hourglass-console-link').href=state.console_url;
    const select=$('hourglass-target'),targetSignature=JSON.stringify(state.targets);
    if(select.dataset.signature!==targetSignature){select.dataset.signature=targetSignature;select.replaceChildren(...state.targets.map(t=>{const n=node('option',`${t.worker_id} · ${t.model} · ${t.route}`);n.value=t.model;return n;}));}
    $('hourglass-window-help').textContent=state.targets.find(t=>t.model===select.value)?.maintenance
      ?'Start finishes this server’s current work before measuring. New gateway traffic stays off it during the measurement; other servers keep serving.'
      :'Choose the server and a free moment. Hourglass runs its full question bank for one active hour. Other traffic is not blocked.';
    const p=state.prepared,owned=!!p?.maintenance;$('hourglass-review').hidden=!p;
    $('hourglass-idle').closest('label').hidden=owned;
    $('hourglass-start').textContent=owned?'Start when server is free':'Start measurement';
    if(reviewId!==p?.id){reviewId=p?.id;$('hourglass-idle').checked=false;}
    if(p)$('hourglass-review-summary').textContent=`${p.association.worker_id} · ${p.model} · one active hour.${p.association.approved_configuration_revision?' Approved configuration revision linked.':' No approved configuration recorded for this server.'}`;
    if(p)$('hourglass-review-text').textContent=`${p.association.worker_id} · ${p.model}\nEndpoint: ${p.endpoint}\nRoute: ${p.association.route} (configured association)\n${p.question_count} questions · 3600 active seconds\nHourglass ${p.benchmark_version} · ${p.metric} · ${p.scoring_policy}\nApproved Star Gate revision: ${p.association.approved_configuration_revision??'none recorded'}\nSaved model revision: ${p.models_revision}\nVisible settings: ${JSON.stringify(p.settings)}\nFull settings and overrides remain in Hourglass. No server settings will be changed.`;
    if(owned){
      $('hourglass-review-summary').textContent=`${p.association.worker_id} · ${p.model} · Finish current work, measure for one active hour, then return the server to service.`;
      $('hourglass-review-text').textContent+=`\n\nObserved server: ${JSON.stringify(p.maintenance.review.observed,null,2)}\n${p.maintenance.review.scope}\nReviewed operation: ${p.maintenance.plan_revision}`;
    }
    $('hourglass-prepare').disabled=busy||state.busy||state.blocked||!state.available;
    select.disabled=busy||state.busy;$('hourglass-start').disabled=busy||state.busy||state.blocked||!p||!owned&&!$('hourglass-idle').checked;
    $('hourglass-refresh').disabled=busy||state.busy||!state.available;
    $('hourglass-control-status').textContent=state.error??(busy||state.busy?'Checking Hourglass…':state.blocked?'A measurement is active or needs checking below.':'Measurements start only when you choose Start.');
    const signature=JSON.stringify(state.runs);if(signature===runSignature)return;runSignature=signature;
    const list=$('hourglass-run-list');list.replaceChildren();
    for(const r of state.runs){
      const stateLabel=r.owned&&['owned','submitting','uncertain'].includes(r.state)
        ?r.error?'Needs checking':r.progress?.phase==='measuring'?'Measuring':r.progress?.phase?.startsWith('waiting')?'Waiting for current work':'Measurement in progress'
        :r.state;
      const item=node('article','');item.append(node('p',`${r.review.model} · ${stateLabel} · ${new Date(r.created_at).toLocaleString()}`));
      if(r.job_id)item.append(node('p',`Hourglass run: ${r.job_id}`));
      if(r.observed_at)item.append(node('p',`Observed: ${new Date(r.observed_at).toLocaleString()}`));
      if(r.owned){
        if(r.progress)item.append(node('p',`${r.progress.detail} · ${r.process_alive===true?'Runner active':r.process_alive===false?'Runner stopped':'Runner status unavailable'}`));
        if(r.progress?.heartbeat_at)item.append(node('p',`Runner heartbeat: ${new Date(r.progress.heartbeat_at*1000).toLocaleString()} · A heartbeat does not prove model progress.`));
        if(r.readmission)item.append(node('p',r.readmission.state==='readmitted'?'Measurement finished and the server was returned to service.':'The measurement hold was released. The server remains under the operator’s control.'));
        if(r.error&&['submitting','uncertain','accepted','pending','running','unknown','owned'].includes(r.state)){
          const inspect=node('button','Check return to service');inspect.className='button';inspect.type='button';inspect.disabled=busy;
          inspect.onclick=()=>act({action:'inspect-return',id:r.id});item.append(inspect);
        }
        if(r.return_review){
          item.append(node('p',r.return_review.review.scope));
          const confirm=node('button','Return server to service');confirm.className='button';confirm.type='button';confirm.disabled=busy;
          confirm.onclick=()=>act({action:'return',id:r.id,plan_revision:r.return_review.plan_revision,review_revision:r.return_review.review_revision});item.append(confirm);
        }
      }
      if(r.error)item.append(node('p',r.error));
      if(r.report)item.append(node('p',`Recorded score: ${r.report.summary.score.value??'unavailable'} · ${r.report.summary.score.version??'unknown metric'} · ${r.report.summary.state}. Details are in Hourglass results below.`));
      if(!r.owned&&(['uncertain','submitting','unknown'].includes(r.state)||['accepted','pending','running'].includes(r.state)&&r.error)){
        const label=node('label',''),check=document.createElement('input');check.type='checkbox';label.append(check,document.createTextNode(' I checked Hourglass and confirmed no related work remains active.'));
        const resolve=node('button','Record my check');resolve.type='button';resolve.className='button';resolve.disabled=true;
        check.onchange=()=>{resolve.disabled=!check.checked||busy;};resolve.onclick=()=>act({action:'resolve',id:r.id,checked_in_hourglass:true});item.append(label,resolve);
      }
      list.append(item);
    }
  }
  async function act(input){
    if(busy)return;busy=true;render();
    try{await request(input);state=await request();token=state.csrf_token;}
    catch(e){$('hourglass-control-status').textContent=e.message;try{state=await request();token=state.csrf_token;}catch{}busy=false;render();$('hourglass-control-status').textContent=e.message;return;}
    busy=false;render();
  }
  $('hourglass-prepare').onclick=()=>act({action:'prepare',model:$('hourglass-target').value});
  $('hourglass-target').onchange=render;
  $('hourglass-start').onclick=()=>act(state.prepared?.maintenance?{action:'start',id:reviewId,plan_revision:state.prepared.maintenance.plan_revision}:{action:'start',id:reviewId,owner_confirmed_idle:$('hourglass-idle').checked});
  $('hourglass-idle').onchange=render;
  $('hourglass-refresh').onclick=()=>act({action:'refresh'});
  async function poll(){if(busy)return;try{state=await request();token=state.csrf_token;render();}catch{if(!panel.hidden)$('hourglass-control-status').textContent='Dashboard connection unavailable. No start will be retried.';}}
  void poll();setInterval(poll,5000);
}
