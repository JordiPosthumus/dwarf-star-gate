import {Transform,PassThrough} from 'node:stream';

// Scan bytes, retaining only a bounded top-level key/model string. Prompts,
// images and tool arguments pass through incrementally, without reserialization.
export function modelAliasTransform(aliases,encoding) {
  aliases=Object.fromEntries(Object.entries(aliases).filter(([a,b])=>a!==b));
  // Opaque encoded uploads remain byte-identical. Alias translation requires JSON.
  if((encoding&&encoding!=='identity')||!Object.keys(aliases).length)return new PassThrough();
  let depth=0,inString=false,escaped=false,keyExpected=false,key=null,role=null,token=[],overflow=false;
  return new Transform({transform(chunk,encoding,done){
    const parts=[];let start=0;
    for(let i=0;i<chunk.length;i++){
      const b=chunk[i];
      if(inString){
        if(role){if(token.length<4096)token.push(b);else if(role==='model'){parts.push(Buffer.from(token));token=[];role=null;start=i;}else overflow=true;}
        if(escaped){escaped=false;continue;}
        if(b===92){escaped=true;continue;}
        if(b!==34)continue;
        inString=false;
        if(role==='key'){try{key=overflow?null:JSON.parse(Buffer.from(token).toString());}catch{key=null;}keyExpected=false;}
        if(role==='model'){
          // Model identifiers beyond the bound are invalid config matches; flush
          // them unchanged, without buffering an arbitrarily large string.
          if(!overflow){let value;try{value=JSON.parse(Buffer.from(token).toString());}catch{}
            parts.push(Object.hasOwn(aliases,value)?Buffer.from(JSON.stringify(aliases[value])):Buffer.from(token));}
          start=i+1;
        }
        role=null;token=[];overflow=false;continue;
      }
      if(b===34){
        inString=true;role=depth===1?(keyExpected?'key':key==='model'?'model':null):null;token=role?[b]:[];overflow=false;
        if(role==='model'){parts.push(chunk.subarray(start,i));start=i;}
      }else if(b===123||b===91){depth++;if(depth===1&&b===123)keyExpected=true;}
      else if(b===125||b===93)depth--;
      else if(depth===1&&b===44){keyExpected=true;key=null;}
    }
    if(inString&&role==='model'){
      // The unfinished model token is retained until its closing quote.
    }else parts.push(chunk.subarray(start));
    for(const part of parts)if(part.length)this.push(part);
    done();
  },flush(done){if(inString&&role==='model'&&token.length)this.push(Buffer.from(token));done();}});
}
