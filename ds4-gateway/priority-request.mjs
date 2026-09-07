// Select a disposable excerpt from early queued inspection or the dispatched
// request observer. This selector never rewrites or stores the inference body.
function userText(message){
  const blocks=typeof message?.content==='string'?[{type:'text',text:message.content}]:message?.content;
  if(!Array.isArray(blocks))return null;
  let excerpt='',bytes=0;
  for(const block of blocks){
    if(block?.type!=='text'||typeof block.text!=='string')continue;
    if(excerpt&&bytes<1024){excerpt+='\n';bytes++;}
    for(const character of block.text){
      const size=Buffer.byteLength(character);if(bytes+size>1024)return excerpt.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g,' ').trim()||null;
      excerpt+=character;bytes+=size;
    }
    if(bytes>=1024)break;
  }
  return excerpt.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g,' ').trim()||null;
}

const followUp=text=>/^(?:please\s+)?(?:proceed|continue|keep going|go ahead|go on|do it|yes|ok(?:ay)?|resume|carry on|please do)[.!?\s]*$/i.test(text)||/^Background task (?:failed|completed|finished|started):/i.test(text);
const readable=text=>text.replace(/^\/(?:private\/)?var\/folders\/\S+\/(?:pi|codex)-clipboard-\S+\.(?:png|jpe?g|webp|gif)(?:\s+|$)/iu,'[Attached image] ').trim();
function clip(text,max){let value='',bytes=0;for(const char of text){const size=Buffer.byteLength(char);if(bytes+size>max)break;value+=char;bytes+=size;}return value;}

export function requestUserExcerpt(body){
  if(!Array.isArray(body?.messages)||body.messages.length>10000)return null;
  const index=body.messages.findLastIndex(value=>value?.role==='user');
  const observed=userText(body.messages[index]);
  if(!observed)return null;
  const latest=readable(observed);
  if(!followUp(latest))return latest;
  let users=0;
  for(let i=index-1;i>=0&&users<8;i--){
    if(body.messages[i]?.role!=='user')continue;
    users++;
    const previous=userText(body.messages[i]);
    // An image-only or unsupported user turn may be a new task. Do not cross it
    // to attach an unrelated older task to a short continuation reply.
    if(!previous)break;
    if(followUp(previous))continue;
    return `Earlier user request: ${clip(readable(previous),768)}\nLatest user reply: ${clip(latest,192)}`;
  }
  return latest;
}
