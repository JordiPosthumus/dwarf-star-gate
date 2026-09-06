// Consume an already parsed request from the gateway's existing passive observer.
// No extra body capture, queue reads, upload limits or durable content storage.
export function requestUserExcerpt(body){
  if(!Array.isArray(body?.messages)||body.messages.length>10000)return null;
  const message=body.messages.findLast(value=>value?.role==='user');
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
