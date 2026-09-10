// DSG's two public names select placement for the same Qwen model family.
// Pi normally treats any model-ID change as a cross-model history conversion.
// Keep plain Qwen reasoning in its original channel for this explicit alias
// pair. This changes only an ephemeral context copy, never saved messages,
// generation settings, request model selection, or foreign model histories.
const PROVIDER='spark-gateway';
const MODELS=new Set(['qwen3.8-flash-next','Qwen3.8-Flash-Next-MLX-8bit-MTP']);
const PLAIN_SIGNATURES=new Set(['reasoning_content','reasoning','reasoning_text']);
export function preserveDsgQwenRouteHistory(messages,model){
  if(!Array.isArray(messages)||model?.provider!==PROVIDER||model.api!=='openai-completions'||!MODELS.has(model.id))return messages;
  let changed=false;
  const result=messages.map(message=>{
    if(message?.role!=='assistant'||message.provider!==PROVIDER||message.api!==model.api||!MODELS.has(message.model)||message.model===model.id||!Array.isArray(message.content))return message;
    const thinking=message.content.filter(block=>block.type==='thinking');
    // Opaque/encrypted/redacted signatures do not establish portability across
    // backend quantizations; leave them to Pi's ordinary compatibility rules.
    if(!thinking.length||thinking.some(block=>block.redacted||typeof block.thinking!=='string'||!PLAIN_SIGNATURES.has(block.thinkingSignature)))return message;
    changed=true;
    return {...message,model:model.id};
  });
  return changed?result:messages;
}
export default function dsgQwenRouteHistory(pi){
  pi.on('context',(event,ctx)=>{
    const messages=preserveDsgQwenRouteHistory(event.messages,ctx.model);
    return messages===event.messages?undefined:{messages};
  });
}
