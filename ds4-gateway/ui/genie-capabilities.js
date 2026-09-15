const panel=document.getElementById('genie-capabilities');
const list=document.getElementById('genie-capability-list');
const message=document.getElementById('genie-capability-message');
let busy=false;
async function refresh(){
  if(busy)return;
  try{
    const response=await fetch('/api/genie/capabilities');
    if(!response.ok)throw new Error('Capability status is unavailable. Existing work continues.');
    const state=await response.json();
    panel.hidden=false;
    list.replaceChildren(...state.capabilities.map(row=>{
      const item=document.createElement('div');item.className='capability-row';
      const label=document.createElement('label');const toggle=document.createElement('input');
      toggle.type='checkbox';toggle.setAttribute('role','switch');toggle.checked=row.enabled;
      toggle.disabled=!row.available;toggle.setAttribute('aria-label',row.label);
      label.append(toggle,document.createTextNode(' '+row.label));
      const status=document.createElement('span');status.textContent=row.status;
      const detail=document.createElement('p');detail.className='muted';detail.textContent=row.detail;
      toggle.addEventListener('change',async()=>{
        busy=true;toggle.disabled=true;message.textContent='Saving…';
        try{
          const result=await fetch('/api/workers/genie-capability',{method:'POST',headers:{'content-type':'application/json','x-dsg-csrf':state.csrf_token},body:JSON.stringify({key:row.key,enabled:toggle.checked})});
          if(!result.ok)throw new Error((await result.json()).error||'Could not confirm the change.');
          message.textContent=`${row.label} ${toggle.checked?'on':'off'}. Work already in progress continues.`;
        }catch(error){message.textContent=error.message;}
        finally{busy=false;await refresh();}
      });
      item.append(label,status,detail);return item;
    }));
    const failures=document.getElementById('genie-service-failures');
    failures.replaceChildren(...state.services.map(service=>{
      const p=document.createElement('p');p.textContent=`${service.id}: ${service.status}${service.detail?' — '+service.detail:''}`;return p;
    }));
  }catch(error){message.textContent=error.message;}
}
void refresh();setInterval(refresh,5000);
