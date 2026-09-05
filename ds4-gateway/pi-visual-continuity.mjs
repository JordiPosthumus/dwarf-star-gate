// Explicitly enrolled Pi companion. Projection changes model input only; it
// never edits Pi's saved messages, image files, provider settings or model limits.
import {createHash} from 'node:crypto';

export const VISUAL_TOOL='dsg_visual_context';
const LIMIT=16, PAGE=24;
const text=value=>({type:'text',text:value});
// Do not invent a narrower format capability list than the configured model.
// Only the known GIF incompatibility requires frame preparation here.
const supported=mime=>mime!=='image/gif';
const result=(value,isError=false)=>({content:[text(value)],details:{},...(isError?{isError:true}:{})});

export function createPiVisualContinuity({provider,baseUrl}){
  const base=new URL(baseUrl);
  if(!provider||!['http:','https:'].includes(base.protocol)||base.username||base.password||base.search||base.hash||!['/v1','/v1/'].includes(base.pathname))throw new Error('Explicit DSG visual continuity provider and /v1 URL required');
  let ids=new Map(),inventory=[],selected=null,known=new Set(),serial=0,pending=false,nudged=false,deferred=false;
  const matches=model=>{
    try{return model?.provider===provider&&model.api==='openai-completions'&&new URL(model.baseUrl).href.replace(/\/$/,'')===base.href.replace(/\/$/,'');}catch{return false;}
  };
  const reset=()=>{ids.clear();inventory=[];selected=null;known.clear();pending=false;nudged=false;deferred=false;};
  const listing=(offset=0)=>inventory.slice(offset,offset+PAGE).map(i=>`${i.id}: ${i.mime}; message ${i.message+1}, image block ${i.block+1}${i.mime==='image/gif'?' (extract PNG frames first)':''}`).join('\n');
  const notice=()=>`DSG request preparation, not a visual answer: this conversation has ${inventory.length} image blocks in its current history. DS4 accepts at most ${LIMIT} image blocks per request, INCLUDING older turns. One contact-sheet PNG counts as ONE image regardless of its tiles. This preparation call cannot inspect omitted images; it does not mean visual QA is unavailable. Saved conversation images and files are unchanged.\nUse ${VISUAL_TOOL} now to select relevant image IDs (at most ${LIMIT}) for the next model call. The tool changes only the outgoing visual context and permits automatic continuation. Select [] explicitly if you need a text-only step to extract GIF frames as PNGs or prepare a contact sheet, then read those files. Reading one more image alone does not clear accumulated history. Continue the original task after inspection; do not substitute this notice for the requested visual work. If user input is genuinely required, use action defer with a reason, then ask.\nImage inventory (newest page; list supports offset):\n${listing(Math.max(0,inventory.length-PAGE))}`;
  function prepare(model,context){
    if(!matches(model)||!context?.tools?.some(t=>t.name===VISUAL_TOOL)||!Array.isArray(context.messages)){pending=false;return context;}
    const occurrences=new Map(),next=[];
    // Hashes remain ephemeral and local; only short IDs/positions enter model
    // context. Repeated images count separately, exactly as serialized by Pi.
    for(const [messageIndex,message] of context.messages.entries()){
      if(!['user','toolResult'].includes(message.role)||!Array.isArray(message.content))continue;
      for(const [blockIndex,block] of message.content.entries()){
        if(block?.type!=='image')continue;
        if(typeof block.data!=='string'||typeof block.mimeType!=='string'||!/^image\/[a-z0-9.+-]{1,64}$/.test(block.mimeType)){pending=false;return context;}
        const hash=createHash('sha256').update(block.mimeType).update('\0').update(block.data).digest('hex');
        const occurrence=occurrences.get(hash)??0;occurrences.set(hash,occurrence+1);
        const key=`${hash}:${occurrence}`,id=ids.get(key)??`v${++serial}`;
        next.push({key,id,mime:block.mimeType,message:messageIndex,block:blockIndex});
      }
    }
    inventory=next;ids=new Map(next.map(i=>[i.key,i.id]));
    const active=next.filter(i=>selected===null||selected.has(i.key)||!known.has(i.key));
    const blocked=active.length>LIMIT||active.some(i=>i.mime==='image/gif');
    pending=blocked;
    if(!blocked&&active.length===next.length)return context;
    const included=new Set((blocked?[]:active).map(i=>`${i.message}:${i.block}`));
    const positions=new Map(next.map(i=>[`${i.message}:${i.block}`,i]));
    const messages=context.messages.map((message,mi)=>!Array.isArray(message.content)?message:{...message,content:message.content.map((block,bi)=>{
      const i=positions.get(`${mi}:${bi}`);
      return !i||included.has(`${mi}:${bi}`)?block:text(`[DSG: image ${i.id} ${blocked?'omitted from this request-preparation call':'not selected for this request by the agent'}. Still available in saved history via ${VISUAL_TOOL}.]`);
    })});
    if(blocked)messages.push({role:'user',content:[text(notice())],timestamp:Date.now()});
    return {...context,messages};
  }
  function execute(params,model){
    if(!matches(model))return result('DSG visual context is available only for the explicitly enrolled DSG provider.',true);
    if(params?.action==='list'){
      const offset=params.offset??Math.max(0,inventory.length-PAGE);
      if(!Number.isSafeInteger(offset)||offset<0)return result('Use a nonnegative image inventory offset.',true);
      return result(`${inventory.length} saved image blocks; ${LIMIT} per outgoing request. One PNG contact sheet = one image.\n${listing(offset)}\nUse select with IDs and a reason to continue; list alone does not repair an over-limit request.`);
    }
    if(!['select','defer'].includes(params?.action)||typeof params.reason!=='string'||!params.reason.trim()||params.reason.length>500)return result('Use select or defer with a short reason. No visual context was changed.',true);
    if(params.action==='defer'){deferred=true;return result('DSG: recovery awaits the input you identified. Ask the user; do not claim visual inspection. Saved images are unchanged.');}
    if(!Array.isArray(params.ids)||params.ids.length>LIMIT||new Set(params.ids).size!==params.ids.length)return result(`Choose up to ${LIMIT} distinct image IDs, or [] for an explicit text-only preparation step.`,true);
    const chosen=params.ids.map(id=>inventory.find(i=>i.id===id));
    if(chosen.some(i=>!i||!supported(i.mime)))return result('Unknown/stale or unsupported image ID. List the current inventory; GIFs need selected PNG frames, not selection as GIFs. No selection was applied.',true);
    selected=new Set(chosen.map(i=>i.key));known=new Set(inventory.map(i=>i.key));pending=false;deferred=false;
    // A new recovery episode may follow newly read images, but an unresolved
    // preparation step cannot auto-prompt indefinitely.
    nudged=false;
    return result(`DSG: agent selected ${chosen.length} image block(s) for the next request: ${params.ids.join(', ')||'none (text-only preparation)'}. Other saved images are unchanged, not deleted. Newly read images will be included unless another selection is needed. ${chosen.length?'Inspect these images now and continue the original task.':'Prepare/read suitable PNG frames or a contact sheet, or continue text-only as you explicitly chose.'} (This is a message from the DSG Pi companion.)`);
  }
  function followUp(model,message){
    if(!matches(model)||!pending||nudged||deferred||message?.role!=='assistant'||message.stopReason!=='stop')return null;
    nudged=true;
    return `DSG: visual recovery is still pending, not completed. Use ${VISUAL_TOOL} to select up to ${LIMIT} images from the FULL conversation (one contact-sheet PNG counts as one), then continue the requested work. If you truly need user input, use defer and ask. This is the single automatic recovery reminder; it does not replay an interrupted request.`;
  }
  return {prepare,execute,followUp,reset,matches,get pending(){return pending;}};
}

export function registerPiVisualContinuity(pi,scope){
  const controller=createPiVisualContinuity(scope);
  pi.registerTool({name:VISUAL_TOOL,label:'DSG visual context',executionMode:'sequential',
    description:'Choose which saved conversation images DSG should send next, without deleting history. List IDs; select at most 16 with a reason (a contact sheet counts as one image), or defer when user input is required. Newly read images remain included. Only for the explicitly enrolled DSG provider.',
    parameters:{type:'object',properties:{action:{type:'string',enum:['list','select','defer']},ids:{type:'array',items:{type:'string'},maxItems:16,uniqueItems:true},reason:{type:'string',minLength:1,maxLength:500},offset:{type:'integer',minimum:0}},required:['action'],additionalProperties:false},
    execute:async(_id,params,signal,_update,ctx)=>{signal?.throwIfAborted();return controller.execute(params,ctx.model);}});
  for(const event of ['session_start','session_shutdown','session_tree','session_compact','model_select'])pi.on(event,()=>{controller.reset();});
  pi.on('turn_end',(event,ctx)=>{
    if(ctx.signal?.aborted)return;
    const content=controller.followUp(ctx.model,event.message);
    if(content)pi.sendMessage({customType:'dsg-visual-recovery',content,display:true},{triggerTurn:true,deliverAs:'followUp'});
  });
  return controller;
}

// Standalone enrollment for installations with their own provider wrapper.
// Pi's documented context event supplies a disposable copy of model messages.
// No provider registration, fetch override, session-file write or tool rewriting.
export function registerPiVisualContextHook(pi,scope){
  const controller=registerPiVisualContinuity(pi,scope);
  pi.on('context',(event,ctx)=>{
    const original={messages:event.messages,tools:pi.getActiveTools().map(name=>({name}))};
    const projected=controller.prepare(ctx.model,original);
    if(projected!==original)return {messages:projected.messages};
  });
  return controller;
}
