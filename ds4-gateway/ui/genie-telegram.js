const panel=document.getElementById('genie-telegram');
if(panel){
  const $=id=>document.getElementById(id);let csrf=null,busy=false,polling=false,lastOptions='';
  async function request(body){
    const response=await fetch('/api/genie/telegram',body?{method:'POST',headers:{'content-type':'application/json','x-dsg-csrf':csrf},body:JSON.stringify(body)}:{});
    const result=await response.json();if(!response.ok)throw Error(result.error??'Telegram setup could not be confirmed.');return result;
  }
  function render(s){
    $('telegram-summary').textContent=s.owner?`Connected to @${s.bot.username}`:s.enabled?'Waiting for pairing':s.available?'Connect Gate Genie':'Genie chat is unavailable';
    $('telegram-connect-form').hidden=!!s.enabled||!s.available;
    $('telegram-steps').hidden=!!s.owner;
    $('telegram-disconnect').hidden=!s.enabled;
    $('telegram-pairing').hidden=!s.pairing_url;
    const link=$('telegram-pair-link');
    if(s.pairing_url){const url=new URL(s.pairing_url);if(url.origin==='https://t.me')link.href=url.href;else link.removeAttribute('href');}else link.removeAttribute('href');
    $('telegram-pair-again').hidden=!s.enabled||!!s.owner||!!s.pairing_url;
    $('telegram-owner').textContent=s.owner?`Paired private chat: ${s.owner.name}. Text messages only. Send /status to check progress, or /last to retrieve the latest saved answer.`:'';
    $('telegram-status').textContent=s.error??(s.pending?`${s.pending} question(s) waiting for a reply.`:s.owner?'Ready to talk.':'');
    $('telegram-conversation-form').hidden=!s.enabled;
    const rows=s.conversations??[],signature=JSON.stringify(rows.map(r=>[r.id,r.title]));
    if(signature!==lastOptions){
      lastOptions=signature;const selected=$('telegram-conversation').value;$('telegram-conversation').replaceChildren();
      for(const row of rows){const option=document.createElement('option');option.value=row.id;option.textContent=row.title;$('telegram-conversation').append(option);}
      $('telegram-conversation').value=s.conversation_id??selected;
    }else if(s.conversation_id&&document.activeElement!==$('telegram-conversation'))$('telegram-conversation').value=s.conversation_id;
  }
  async function refresh(){if(polling||busy)return;polling=true;try{const s=await request();csrf=s.csrf_token;render(s);}catch{$('telegram-status').textContent='Telegram status is unavailable. Refresh after the dashboard reconnects.';}finally{polling=false;}}
  async function change(body){
    if(busy||!csrf)return;busy=true;for(const button of panel.querySelectorAll('button'))button.disabled=true;
    try{await request(body);$('telegram-token').value='';busy=false;await refresh();}
    catch(e){$('telegram-token').value='';$('telegram-status').textContent=e.message;}
    finally{busy=false;for(const button of panel.querySelectorAll('button'))button.disabled=false;}
  }
  $('telegram-connect-form').addEventListener('submit',event=>{event.preventDefault();const bot_token=$('telegram-token').value.trim();$('telegram-token').value='';void change({action:'connect',bot_token});});
  $('telegram-disconnect').addEventListener('click',()=>void change({action:'disconnect'}));
  $('telegram-pair-again').addEventListener('click',()=>void change({action:'pair'}));
  $('telegram-conversation-form').addEventListener('submit',event=>{event.preventDefault();void change({action:'conversation',conversation_id:$('telegram-conversation').value});});
  void refresh();setInterval(()=>{if(!document.hidden)void refresh();},3000);
}
