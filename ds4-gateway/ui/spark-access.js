const panel=document.getElementById('spark-access');
if(panel){
  const $=id=>document.getElementById(id);let csrf='',operations=[],busy=false,selectedId=null;
  const pending=new Set(['pending','credentials_required','permission_paused']);
  function selection(){
    const op=operations.find(row=>row.access_id===$('spark-access-request').value);
    $('spark-access-hosts').textContent=op?op.endpoints.map(e=>`${e.host}: ${e.state}${e.reason?' ('+e.reason+')':''}`).join(' · '):'Ask Genie to find and add your new Sparks. He will put any first-access request here.';
    $('spark-access-form').hidden=!op||op.credential_available||op.state==='running'||!op.endpoints.some(e=>pending.has(e.state));
    $('spark-access-revoke').hidden=!op?.credential_available;
    if(op?.access_id!==selectedId){selectedId=op?.access_id??null;$('spark-access-username').value=op?.username??'';$('spark-access-password').value='';}
    if(op?.credential_available&&op.state!=='running')$('spark-access-status').textContent='Password supplied locally. Waiting for Genie to continue the original conversation.';
  }
  async function refresh(){
    if(busy)return;
    try{
      const response=await fetch('/api/genie/spark-access');if(!response.ok)throw Error();const state=await response.json();csrf=state.csrf_token;operations=state.operations??[];
      const select=$('spark-access-request'),previous=select.value,signature=JSON.stringify(operations.map(op=>[op.access_id,op.state]));
      if(select.dataset.signature!==signature){select.replaceChildren();for(const op of operations){const option=document.createElement('option');option.value=op.access_id;option.textContent=`${op.endpoints.map(e=>e.host).join(', ')} · ${op.state}`;select.append(option);}if(operations.some(op=>op.access_id===previous))select.value=previous;select.dataset.signature=signature;}
      $('spark-access-status').textContent=state.error??(!state.available?'Initial access is unavailable.':!state.enabled?'Turn on New Spark setup to allow Genie to add the new machines.':state.busy?'Genie is checking initial access.':'');selection();
    }catch{$('spark-access-status').textContent='Initial-access status is unavailable.';}
  }
  async function change(body){
    busy=true;panel.querySelectorAll('button').forEach(b=>b.disabled=true);
    try{const response=await fetch('/api/genie/spark-access',{method:'POST',headers:{'content-type':'application/json','x-dsg-csrf':csrf},body:JSON.stringify(body)});body.password=undefined;const result=await response.json();if(!response.ok)throw Error(result.error??'Access grant was not saved.');}
    catch(error){$('spark-access-status').textContent=error.message;return;}
    finally{body.password=undefined;busy=false;panel.querySelectorAll('button').forEach(b=>b.disabled=false);}
    await refresh();
  }
  $('spark-access-form').addEventListener('submit',event=>{event.preventDefault();const password=$('spark-access-password').value;$('spark-access-password').value='';void change({action:'authorize',access_id:$('spark-access-request').value,username:$('spark-access-username').value.trim(),password});});
  $('spark-access-request').addEventListener('change',selection);
  $('spark-access-revoke').addEventListener('click',()=>void change({action:'revoke',access_id:$('spark-access-request').value}));
  void refresh();setInterval(()=>{if(!document.hidden)void refresh();},5000);
}
