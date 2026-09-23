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

      renderThinking(state);

  }catch(error){message.textContent=error.message;}
}

let thinkingBusy=false;
function renderThinking(state){
  const t=state.genie_thinking;if(!t)return;
  let box=document.getElementById('genie-thinking-box');
  if(!box){box=document.createElement('div');box.id='genie-thinking-box';box.className='genie-thinking';box.innerHTML='<h4>Genie thinking</h4><p class="muted" id="genie-thinking-scope"></p>';list.after(box);}
  const scope=box.querySelector('#genie-thinking-scope');
  scope.textContent='Applies to the next chat reply and fleet review. Saved in the Star Gate store; survives restarts. Current: chat '+t.chat+', reviewer '+t.reviewer+'.';
  for(const key of ['chat','reviewer']){
    const id='genie-thinking-'+key;
    let row=document.getElementById(id);
    if(!row){row=document.createElement('div');row.className='capability-row';row.id=id;
      const label=document.createElement('label');label.textContent=(key==='chat'?'Chat thinking':'Fleet review thinking')+': ';
      const select=document.createElement('select');
      for(const level of t.levels??['none','minimal','low','medium','high','xhigh','max']){const o=document.createElement('option');o.value=level;o.textContent=level;select.append(o);}
      const apply=document.createElement('button');apply.type='button';apply.className='button';apply.textContent='Apply';
      apply.addEventListener('click',async()=>{
        if(thinkingBusy)return;thinkingBusy=true;apply.disabled=true;message.textContent='Saving thinking level…';
        try{
          const result=await fetch('/api/workers/genie-thinking',{method:'POST',headers:{'content-type':'application/json','x-dsg-csrf':state.csrf_token},body:JSON.stringify({[key]:select.value})});
          if(!result.ok)throw new Error((await result.json()).error||'Could not save the thinking level.');
          message.textContent='Genie thinking saved. The next '+(key==='chat'?'chat reply':'fleet review')+' uses '+select.value+'.';
        }catch(error){message.textContent=error.message;}
        finally{thinkingBusy=false;apply.disabled=false;await refresh();}
      });
      label.append(select,apply);row.append(label);box.append(row);
    }
    const select=row.querySelector('select');
    if(document.activeElement!==select)select.value=t[key];
  }
}

void refresh();setInterval(refresh,5000);
