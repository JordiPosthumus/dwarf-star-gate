// Share newly registered, fixed inspection targets with the existing chat tools.
export function sparkInspectionSync(config,read){
  if(!config.genie_chat)return null;
  config.genie_chat.inspection??={};config.genie_chat.inspection.workers??={};
  const workers=config.genie_chat.inspection.workers,original=new Set(Object.keys(workers));
  let owned=new Set(),pending=false,last=0;
  return {async refresh(){
    if(pending||Date.now()-last<15000)return;
    pending=true;
    try{
      const value=await read();if(value?.schema!==1||!value.workers||Array.isArray(value.workers))return;
      const next=new Set();
      for(const [id,row] of Object.entries(value.workers)){
        if(original.has(id))continue;
        const t=row.inspection;
        if(!/^[a-zA-Z0-9][\w-]{0,63}$/.test(id)||!t||!/^[a-f0-9]{64}$/.test(t.container)||!Array.isArray(t.ssh)||!t.ssh.length||t.ssh.some(s=>typeof s!=='string'||!/^[a-zA-Z0-9][\w.@-]{0,252}$/.test(s)))throw Error('Invalid registered inspection target');
        next.add(id);
      }
      for(const id of owned)if(!next.has(id))delete workers[id];
      for(const id of next)workers[id]=structuredClone(value.workers[id].inspection);
      owned=next;
    }finally{pending=false;last=Date.now();}
  }};
}
