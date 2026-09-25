const $=id=>document.getElementById(id);
const el=(tag,value,cls)=>{const node=document.createElement(tag);if(value!==undefined)node.textContent=value;if(cls)node.className=cls;return node;};
const engineNames={music:'ACE-Step',video:'MiniMax H3'};
let state=null,selected='ace-step',busy=false,signature='',submitting=false,pendingVideo=null;
try{const saved=JSON.parse(sessionStorage.getItem('sg-pending-video'));if(typeof saved?.prompt==='string'&&typeof saved?.key==='string'){pendingVideo=saved;$('media-video-prompt').value=saved.prompt;$('media-video-message').textContent='A previous submission was not confirmed. Retry this prompt to check the same job.';}}catch{}
function render(){
  if(!state)return;
  $('media-status').textContent=state.enabled?'Genie media placement is on':'Genie media placement is off — change it under Gate Genie → Capabilities';
  const engines=state.engines??[{id:'ace-step',label:'ACE-Step',kind:'music',supported:true},{id:'h3',label:'MiniMax H3',kind:'video',supported:true},{id:'minimax-m3',label:'MiniMax M3',supported:false},{id:'ltx',label:'LTX',supported:false}];
  $('media-engines').replaceChildren(...engines.map(engine=>{
    const button=el('button',engine.label+(engine.supported?'':' · planned'),'button');button.type='button';button.setAttribute('role','tab');button.setAttribute('aria-selected',String(engine.id===selected));button.addEventListener('click',()=>{selected=engine.id;signature='';render();});return button;
  }));
  const engine=engines.find(e=>e.id===selected);
  $('media-video-form').hidden=selected!=='h3';
  $('media-video-submit').disabled=submitting||!state.controls_enabled||!state.text_video_supported;
  $('media-video-submit').textContent=submitting?'Submitting…':pendingVideo?'Retry submission':'Queue video';
  if(!engine.supported)$('media-hosts').replaceChildren(el('p',`${engine.label} is planned. No verified setup or execution adapter is connected yet.`,'muted'));
  else $('media-hosts').replaceChildren(...(state.hosts?.length?state.hosts.flatMap(host=>host.members?.length?host.members.map(member=>({...host,...member,display_name:`${member.machine} (${host.id})`})): [host]).map(host=>{
    const choice=host.engines.find(e=>e.id===engine.id),card=el('article',undefined,'media-host-card');
    card.append(el('h3',host.display_name??(host.machines&&host.machines.length>1?`${host.machines.join(' + ')} (${host.id})`:host.id)));
    const label=el('label'),toggle=el('input');toggle.type='checkbox';toggle.checked=choice.allowed;toggle.disabled=!state.controls_enabled||state.media_host_controls_version!==1;toggle.setAttribute('role','switch');toggle.setAttribute('aria-label',`Allow ${engine.label} on ${host.id}`);label.append(toggle,document.createTextNode(host.member===undefined?` Allow ${engine.label} here`:` Allow ${engine.label} on this pair`));card.append(label);
    const maintenance=host.maintenance?.filter(Boolean)??[],holds=host.holds?.filter(Boolean)??[];
    const current=host.execution?`${engineNames[state.jobs?.find(j=>j.id===host.execution.job_id)?.kind]??'Media job'} · ${host.execution.phase.replaceAll('_',' ')}`:maintenance.length?`Maintenance · ${maintenance.join(', ')}`:holds.length?`Held · ${holds.join(', ')}`:host.quarantined?'LLM quarantined':host.paused?'LLM paused':host.llm_serving?`Serving LLM${host.llm_model?' · '+host.llm_model:''}`:'LLM unavailable';
    card.append(el('p',`Current: ${current}`,'media-readiness'));
    card.append(el('p',choice.enrolled?'Setup: qualified engine enrolled':'Setup: not enrolled'),el('p',!host.llm_serving&&maintenance.length?`Unavailable for media: ${maintenance.join(', ')}`:(choice.reason??(choice.ready?'Available for Genie to select':choice.enrolled?'Pair availability or placement prevents selection':'Setup and qualification needed')),'muted'));
    card.append(el('p',`LLM: ${host.llm_serving?'available for routing':'not available for new routing'} · ${host.active_requests} active · ${host.queued_requests} queued`,'muted'));
    if(host.execution?.detail)card.append(el('p',host.execution.detail));
    const memory=host.memory,fresh=memory&&Date.now()-memory.time>=0&&Date.now()-memory.time<60000;
    if(fresh&&Number.isFinite(memory.memory_total_bytes)&&Number.isFinite(memory.memory_used_bytes))card.append(el('p',`Memory now: ${((memory.memory_total_bytes-memory.memory_used_bytes)/2**30).toFixed(1)} GiB free of ${(memory.memory_total_bytes/2**30).toFixed(0)} GiB. Current LLM usage is included.`,'muted'));
    const check=state.resource_checks?.[host.member===undefined?host.id:`${host.id}:${host.member}`];
    if(check){
      card.append(el('p',`Resources checked: ${new Date(check.observed_at).toLocaleString()}`,'muted'));
      if(check.state==='unavailable')card.append(el('p',check.error,'media-job-detail'));
      else{
        card.append(el('p',`${check.system} ${check.architecture}${check.gpu_names?.length?' · '+check.gpu_names.join(', '):''}`));
        const recipe=check.recipes?.find(r=>r.engine===engine.id);
        if(recipe)card.append(el('p',`Recipe models: ${(recipe.model_bytes_required/2**30).toFixed(1)} GiB; images, build cache and outputs need extra space.`,'muted'));
        for(const disk of check.disks??[])card.append(el('p',`${[...new Set((disk.locations??[disk.location]).map(location=>String(location).startsWith('existing container mount:')?'existing model storage':location))].join(', ')}: ${Number.isFinite(disk.free_bytes)?(disk.free_bytes/2**30).toFixed(1)+' GiB free':disk.error}`,'muted'));
        card.append(el('p',check.setup,'muted'));
        for(const error of check.errors??[])card.append(el('p',error,'media-job-detail'));
      }
    }
    const inspect=el('button','Check resources','button');inspect.type='button';inspect.disabled=!state.controls_enabled||!state.resource_inspection_connected;inspect.setAttribute('aria-label',`Check media resources on ${host.display_name??host.id}`);card.append(inspect);
    inspect.addEventListener('click',async()=>{
      busy=true;inspect.disabled=true;$('media-message').textContent=`Checking ${host.id}; existing services keep running…`;
      try{const response=await fetch('/api/media/inspect',{method:'POST',headers:{'content-type':'application/json','x-dsg-csrf':state.csrf_token},body:JSON.stringify({worker_id:host.id,...(host.member!==undefined?{member:host.member}:{})})});const result=await response.json();if(!response.ok)throw Error(result.error??'Resource check unavailable.');$('media-message').textContent=`${host.id} resources checked. No service was changed.`;}
      catch(error){$('media-message').textContent=error.message;}finally{busy=false;signature='';await refresh(true);}
    });
    if(choice.enrolled)card.append(el('p','Enrolled engine. This check leaves its setup and qualification unchanged.','muted'));
    const setup=state.setup?.operations?.find(s=>s.worker_id===host.id&&s.engine===engine.id&&(host.member===undefined||s.member===host.member)),setupHost=state.setup?.hosts?.find(s=>s.worker_id===host.id);
    if(setup)card.append(el('p',`Setup: ${setup.phase.replaceAll('_',' ')}${setup.detail?' · '+setup.detail:''}`),...(setup.enrollment_error?[el('p',setup.enrollment_error,'media-job-detail')]:[]));
    if(setup?.preparation?.model_download?.state==='observed'){const d=setup.preparation.model_download;card.append(el('p',`Models: ${(d.bytes_present/1e9).toFixed(1)} / ${(d.bytes_required/1e9).toFixed(1)} GB present, including partial downloads.`,'muted'));if(Number.isFinite(Date.parse(d.last_file_activity_at)))card.append(el('p',`Last model-file activity: ${new Date(d.last_file_activity_at).toLocaleString()}. Unchanged bytes can mean verification is running.`,'muted'));}
    if(setup?.qualification)card.append(el('p',`${setup.qualification.engine??'Media test'}: ${setup.qualification.phase??setup.qualification.state}${setup.qualification.error?' · '+setup.qualification.error:''}`));
    if(setupHost?.error)card.append(el('p',setupHost.error,'media-job-detail'));
    if(!choice.enrolled){
      const button=el('button',setup?.phase==='qualified_returned'?'Finish setup':`Set up ${engine.label}`,'button');button.type='button';button.setAttribute('aria-label',`${button.textContent} on ${host.display_name??host.id}`);
      button.disabled=!state.controls_enabled||!state.setup?.enabled||!setupHost?.available||!choice.allowed||!!(setup&&setup.phase!=='qualified_returned');card.append(button);
      button.addEventListener('click',async()=>{
        busy=true;button.disabled=true;$('media-message').textContent=`Starting ${engine.label} setup on ${host.id}…`;
        try{const response=await fetch('/api/media/setup',{method:'POST',headers:{'content-type':'application/json','x-dsg-csrf':state.csrf_token},body:JSON.stringify({worker_id:host.id,engine:engine.id,...(host.member!==undefined?{member:host.member}:{})})});const result=await response.json();if(!response.ok)throw Error(result.error??'Setup was not confirmed. Refresh its saved status before retrying.');$('media-message').textContent=`${host.id}: ${result.phase.replaceAll('_',' ')}. Progress remains here when you leave this page.`;}
        catch(error){$('media-message').textContent=error.message;}finally{busy=false;signature='';await refresh(true);}
      });
      card.append(el('p','Setup drains existing work, tests the new engine and restores this machine’s LLM. At least one other LLM stays available.','muted'));
    }
    toggle.addEventListener('change',async()=>{
      busy=true;toggle.disabled=true;$('media-message').textContent='Saving placement choice…';
      try{const response=await fetch('/api/media/eligibility',{method:'POST',headers:{'content-type':'application/json','x-dsg-csrf':state.csrf_token},body:JSON.stringify({worker_id:host.id,kind:engine.kind,allowed:toggle.checked})});const result=await response.json();if(!response.ok)throw Error(result.error??'Could not confirm the change.');$('media-message').textContent=`${engine.label} on ${host.id}: ${result.allowed?'allowed':'off'}. Existing work continues.`;}
      catch(error){$('media-message').textContent=error.message;}finally{busy=false;signature='';await refresh(true);}
    });return card;
  }):[el('p',state.configured?'No registered machines are available.':'Connect media services to see enrolled machines and queued jobs.','muted')]));
  const jobs=engine.supported?(state.jobs??[]).filter(j=>j.kind===engine.kind):[];
  renderJobs(jobs,engine.supported);
}
const jobCards=new Map();
function renderJobs(jobs,supported){
  const queue=$('media-queue');
  for(const [id,row] of jobCards)if(!jobs.some(j=>j.id===id)){row.card.remove();jobCards.delete(id);}
  if(!jobs.length){queue.replaceChildren(el('p',supported?'No jobs for this engine yet. Agents can submit through the gateway’s music or video endpoints.':'No jobs for this planned engine.','muted'));return;}
  for(const child of [...queue.children])if(!child.dataset.jobId)child.remove();
  jobs.forEach((job,index)=>{
    let row=jobCards.get(job.id);
    if(!row){
      const card=el('article',undefined,'media-job-card');card.dataset.jobId=job.id;
      row={card,title:el('h3'),id:el('p',job.id,'muted'),assignment:el('p'),detail:el('p',undefined,'media-job-detail'),machine:el('p'),retention:el('p',undefined,'media-job-detail'),files:el('div'),fileIds:new Set()};
      card.append(row.title,row.id,row.assignment,row.detail,row.machine,row.retention,row.files);jobCards.set(job.id,row);
    }
    row.title.textContent=`${engineNames[job.kind]??job.kind} · ${job.state}`;
    row.assignment.textContent=`${job.priority??'normal'} priority · ${job.execution?.worker_id??job.worker??'Waiting for assignment'}`;
    if(job.execution?.batch_job_ids?.length>1)row.assignment.textContent+=` · batch job ${job.execution.batch_job_ids.indexOf(job.id)+1}/${job.execution.batch_job_ids.length}${job.execution.active_job_id&&job.state==='queued'&&job.execution.active_job_id!==job.id?' · waiting for its turn':''}`;
    row.detail.textContent=[job.detail,job.next_step].filter(Boolean).join(' ');row.detail.hidden=!job.detail;
    row.machine.textContent=job.execution?`Machine: ${job.execution.phase}${job.execution.detail?' — '+job.execution.detail:''}`:'';row.machine.hidden=!job.execution;
    row.retention.textContent=job.outputs?.state==='failed'?`Result retention failed: ${job.outputs.detail??'Inspect this job'}`:'';row.retention.hidden=job.outputs?.state!=='failed';
    for(const file of job.outputs?.state==='ready'?job.outputs.files??[]:[]){
      if(row.fileIds.has(file.id)||!/^[a-f0-9-]{36}$/.test(job.id)||!/^[a-f0-9-]{36}$/.test(file.id)||!engineNames[job.kind])continue;
      const url=`/api/media/${job.kind}/jobs/${job.id}/files/${file.id}`;
      if(file.content_type?.startsWith('audio/')||file.content_type?.startsWith('video/')){const player=el(file.content_type.startsWith('audio/')?'audio':'video');player.controls=true;player.preload='none';player.src=url;row.files.append(player);}
      const link=el('a',`Download ${file.filename}`);link.href=url;link.download=file.filename;row.files.append(link);row.fileIds.add(file.id);
    }
    // Ordinary status refreshes keep the exact player node and playback position.
    if(queue.children[index]!==row.card)queue.insertBefore(row.card,queue.children[index]??null);
  });
}
async function refresh(force=false){
  if(busy||(!force&&($('view-media').hidden||document.hidden)))return;
  busy=true;
  try{const response=await fetch('/api/media');if(!response.ok)throw Error('Media status unavailable. Existing work may still be running.');const value=await response.json(),next=JSON.stringify(value);state=value;if(next!==signature){render();signature=next;}}
  catch(error){$('media-status').textContent=error.message;for(const input of $('media-hosts').querySelectorAll('input'))input.disabled=true;signature='';}
  finally{busy=false;}
}
$('media-video-form').addEventListener('submit',async event=>{
  event.preventDefault();if(submitting||!state?.controls_enabled||!state?.text_video_supported)return;
  const field=$('media-video-prompt'),prompt=field.value.trim();if(!prompt)return;
  if(!pendingVideo||pendingVideo.prompt!==prompt)pendingVideo={key:crypto.randomUUID(),prompt};
  // Keep the request key through a lost reply or reload; retrying must not generate twice.
  try{sessionStorage.setItem('sg-pending-video',JSON.stringify(pendingVideo));}catch{}
  submitting=true;field.readOnly=true;render();$('media-video-message').textContent='Submitting video request…';
  try{
    const response=await fetch('/api/media/video/jobs',{method:'POST',headers:{'content-type':'application/json','x-dsg-csrf':state.csrf_token},body:JSON.stringify(pendingVideo)}),job=await response.json();
    if(!response.ok)throw Error(job.error??'No confirmation received.');
    pendingVideo=null;try{sessionStorage.removeItem('sg-pending-video');}catch{}
    field.value='';$('media-video-message').textContent=`Job ${job.id}: ${job.state}. Follow its progress and results below.${state.enabled?'':' Media placement is off; it will wait until enabled.'}`;
  }catch(error){$('media-video-message').textContent=`${error.message} Retry the unchanged prompt to check the same job; editing it starts a different request.`;}
  finally{submitting=false;field.readOnly=false;signature='';render();await refresh(true);}
});
new MutationObserver(()=>{if(!$('view-media').hidden)void refresh();}).observe($('view-media'),{attributes:true,attributeFilter:['hidden']});
void refresh();setInterval(refresh,5000);

// Fleet links select the corresponding engine before opening the Media tab.
document.addEventListener('click',event=>{const link=event.target.closest?.('[data-media-engine]');if(link){selected=link.dataset.mediaEngine;signature='';render();}});
