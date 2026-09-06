import {createPiPriorityIntent} from './pi-priority-intent.mjs';

// Explicit optional installation for an existing DSG provider. This adapter
// leaves inference transport/retry policy with Pi and supplies only intent.
export function registerPiPriorityLens(pi,{provider,baseUrl,streamSimple,enabled=true,fetchImpl=fetch}={}){
  if(typeof streamSimple!=='function'||typeof enabled!=='boolean')throw new Error('Compatible Pi serializer and explicit enable state required');
  const priority=createPiPriorityIntent({provider,baseUrl,fetchImpl});
  let context=null;
  const status=()=>context?.ui?.setStatus('dsg-priority-lens',`Priority Lens titles: ${enabled?'on · /priority-lens off':'off · /priority-lens on'}`);
  pi.on('session_start',(event,ctx)=>{context=ctx;if(enabled){priority.start(event,ctx);ctx.ui.notify('Priority Lens shares this session title and up to 1 KiB of user request text (including earlier task context for short replies) with configured Genie capacity. /priority-lens off stops new sharing.','info');}status();});
  pi.on('session_shutdown',()=>{priority.stop();context=null;});
  pi.registerCommand('priority-lens',{description:'Show or change DSG title/priority text sharing: on, off, status',handler:async(args,ctx)=>{
    const action=args.trim()||'status';
    if(!['on','off','status'].includes(action)){ctx.ui.notify('Use /priority-lens on, off, or status.','warning');return;}
    if(action!=='status'){
      enabled=action==='on';priority.stop();context=ctx;
      if(enabled)priority.start({},ctx);
    }
    status();
    ctx.ui.notify(enabled?'Priority Lens shares the session title and up to 1 KiB of user request text (including earlier task context for short replies) with configured Genie capacity. /priority-lens off stops new sharing.':'Priority Lens is off for this client. DSG will skip task naming and priority excerpts for these requests.','info');
  }});
  pi.registerProvider(provider,{api:'openai-completions',streamSimple:(model,context,options={})=>{
    // Other model definitions on this provider keep Pi's original serializer.
    const intent=enabled?priority.snapshot(model,options):null;
    if(!enabled&&model.provider===provider){
      const originalFetch=options.fetch??fetch;
      return streamSimple(model,context,{...options,fetch:(input,init)=>originalFetch(input,priority.optOut(input,init))});
    }
    if(!intent)return streamSimple(model,context,options);
    const originalFetch=options.fetch??fetch;
    return streamSimple(model,context,{...options,fetch:(input,init)=>originalFetch(input,priority.decorate(input,init,intent))});
  }});
}
