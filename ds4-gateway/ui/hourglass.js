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
    const p=state.prepared;$('hourglass-review').hidden=!p;
    if(reviewId!==p?.id){reviewId=p?.id;$('hourglass-idle').checked=false;}
    if(p)$('hourglass-review-summary').textContent=`${p.association.worker_id} · ${p.model} · one active hour.${p.association.approved_configuration_revision?' Approved configuration revision linked.':' No approved configuration recorded for this server.'}`;
    if(p)$('hourglass-review-text').textContent=`${p.association.worker_id} · ${p.model}\nEndpoint: ${p.endpoint}\nRoute: ${p.association.route} (configured association)\n${p.question_count} questions · 3600 active seconds\nHourglass ${p.benchmark_version} · ${p.metric} · ${p.scoring_policy}\nApproved Star Gate revision: ${p.association.approved_configuration_revision??'none recorded'}\nSaved model revision: ${p.models_revision}\nVisible settings: ${JSON.stringify(p.settings)}\nFull settings and overrides remain in Hourglass. No server settings will be changed.`;
    $('hourglass-prepare').disabled=busy||state.busy||state.blocked||!state.available;
    select.disabled=busy||state.busy;$('hourglass-start').disabled=busy||state.busy||state.blocked||!p||!$('hourglass-idle').checked;
    $('hourglass-refresh').disabled=busy||state.busy||!state.available;
    $('hourglass-control-status').textContent=state.error??(busy||state.busy?'Checking Hourglass…':state.blocked?'A measurement is active or needs checking below.':'Measurements start only when you choose Start.');
    const signature=JSON.stringify(state.runs);if(signature===runSignature)return;runSignature=signature;
    const list=$('hourglass-run-list');list.replaceChildren();
    for(const r of state.runs){
      const item=node('article','');item.append(node('p',`${r.review.model} · ${r.state} · ${new Date(r.created_at).toLocaleString()}`));
      if(r.job_id)item.append(node('p',`Hourglass run: ${r.job_id}`));
      if(r.observed_at)item.append(node('p',`Observed: ${new Date(r.observed_at).toLocaleString()}`));
      if(r.error)item.append(node('p',r.error));
      if(r.report)item.append(node('p',`Recorded score: ${r.report.summary.score.value??'unavailable'} · ${r.report.summary.score.version??'unknown metric'} · ${r.report.summary.state}. Details are in Hourglass results below.`));
      if(['uncertain','submitting','unknown'].includes(r.state)||['accepted','pending','running'].includes(r.state)&&r.error){
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
  $('hourglass-start').onclick=()=>act({action:'start',id:reviewId,owner_confirmed_idle:$('hourglass-idle').checked});
  $('hourglass-idle').onchange=render;
  $('hourglass-refresh').onclick=()=>act({action:'refresh'});
  async function poll(){if(busy)return;try{state=await request();token=state.csrf_token;render();}catch{if(!panel.hidden)$('hourglass-control-status').textContent='Dashboard connection unavailable. No start will be retried.';}}
  void poll();setInterval(poll,5000);
}
