const $=id=>document.getElementById(id);
const fields={provider:$('brain-provider'),base_url:$('brain-endpoint'),model:$('brain-model'),reasoning:$('brain-reasoning')};
let loaded=null,busy=false;
const draft=()=>Object.fromEntries(Object.entries(fields).map(([key,node])=>[key,node.value]));
const dirty=()=>loaded&&JSON.stringify(draft())!==JSON.stringify(Object.fromEntries(Object.keys(fields).map(key=>[key,loaded.settings[key]??''])));
function controls(){
  $('brain-save').disabled=busy||!loaded||!dirty();$('brain-test').disabled=busy||!loaded;
  $('brain-reload').disabled=busy;$('brain-dirty').textContent=dirty()?'Unsaved changes':'';
  for(const field of Object.values(fields))field.disabled=!loaded;
}
function runtime(value){
  const active=value.active_agents;
  $('brain-runtime').textContent=`${value.state==='running'?'Genie running':value.state??'Status unavailable'} · Telegram ${value.telegram??'unknown'}${Number.isInteger(active)?` · ${active} active turn${active===1?'':'s'}`:''}`;
  $('brain-runtime').dataset.live=String(value.state==='running');
}
async function request(url,method,input){
  const response=await fetch(url,{method,headers:input?{'content-type':'application/json','x-dsg-csrf':loaded.csrf_token}:undefined,body:input?JSON.stringify(input):undefined,signal:AbortSignal.timeout(40000)});
  const data=await response.json();if(!response.ok)throw Error(data.error||'Request failed.');return data;
}
async function load(){
  if(busy||dirty()&&!confirm('Discard your unsaved brain settings and reload from disk?'))return;
  busy=true;controls();
  try{loaded=await request('/api/brain','GET');for(const [key,field] of Object.entries(fields))field.value=loaded.settings[key]??'';
    $('brain-path').textContent=loaded.path;runtime(loaded.runtime);$('brain-message').textContent='Using native Hermes settings.';
  }catch(error){$('brain-message').textContent=error.message;}finally{busy=false;controls();}
}
$('brain-form').addEventListener('input',controls);
$('brain-reload').addEventListener('click',()=>void load());
$('brain-form').addEventListener('submit',async event=>{
  event.preventDefault();if(busy||!dirty())return;
  const submitted=draft();busy=true;controls();$('brain-message').textContent='Saving…';
  try{loaded=await request('/api/brain','PUT',{settings:submitted,revision:loaded.revision});for(const [key,field] of Object.entries(fields))if(field.value===submitted[key])field.value=loaded.settings[key]??'';runtime(loaded.runtime);$('brain-message').textContent='Saved to native Hermes. His current turn has not been interrupted.';}
  catch(error){$('brain-message').textContent=error.name==='TimeoutError'?'Save reply timed out. Reload saved settings to check the result before retrying. Your draft is retained.':error.message;}
  finally{busy=false;controls();}
});
$('brain-test').addEventListener('click',async()=>{
  if(busy||!$('brain-form').reportValidity())return;busy=true;controls();$('brain-message').textContent='Checking the provider’s model list…';
  try{const value=await request('/api/brain/test','POST',{settings:draft()});$('brain-message').textContent=value.message;
    $('brain-models').replaceChildren(...(value.models??[]).map(id=>{const option=document.createElement('option');option.value=id;return option;}));
  }catch(error){$('brain-message').textContent=error.message;}finally{busy=false;controls();}
});
window.addEventListener('beforeunload',event=>{if(dirty()){event.preventDefault();event.returnValue='';}});
async function refreshRuntime(){if(document.hidden||$('view-brain').hidden)return;try{runtime(await request('/api/brain/status','GET'));}catch{runtime({state:'Status unavailable'});}}
new MutationObserver(()=>{if(!$('view-brain').hidden){if(!loaded)void load();else void refreshRuntime();}}).observe($('view-brain'),{attributes:true,attributeFilter:['hidden']});
setInterval(()=>void refreshRuntime(),5000);controls();if(!$('view-brain').hidden)void load();
