import {Transform, PassThrough} from 'node:stream';
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const sampling = ['temperature','top_p','top_k','min_p','presence_penalty','repetition_penalty'];
export function servingProfiles(raw = {}, workers = []) {
  if (!object(raw)) throw new Error('serving_profiles must be an object');
  for (const [id,p] of Object.entries(raw)) {
    if (!workers.some(w=>w.id===id) || !object(p) || Object.keys(p).some(k=>!['defaults','context_window','max_output_tokens','input','reasoning'].includes(k))) throw new Error('Invalid serving profile worker or field');
    if (p.context_window!==262144 || p.max_output_tokens!==262144 || p.reasoning!==true || JSON.stringify(p.input)!=='["text","image"]') throw new Error('Invalid Qwen serving profile capabilities');
    if (!object(p.defaults) || Object.keys(p.defaults).some(k=>![...sampling,'chat_template_kwargs'].includes(k))) throw new Error('Invalid serving profile defaults');
    for (const k of sampling) if (typeof p.defaults[k]!=='number'||!Number.isFinite(p.defaults[k])) throw new Error('Invalid sampling default');
    const d=p.defaults,c=d.chat_template_kwargs;
    if(d.temperature<0||d.temperature>2||(d.temperature>0&&d.temperature<0.01)||d.top_p<=0||d.top_p>1||!Number.isInteger(d.top_k)||d.top_k<0||d.min_p!==0||d.presence_penalty< -2||d.presence_penalty>2||d.repetition_penalty<=0)throw new Error('Unsupported Spark sampling default');
    if(!object(c)||Object.keys(c).sort().join(',')!=='enable_thinking,preserve_thinking,reasoning_effort'||typeof c.enable_thinking!=='boolean'||typeof c.preserve_thinking!=='boolean'||!['low','medium','xhigh'].includes(c.reasoning_effort))throw new Error('Invalid thinking defaults');
  }
  return structuredClone(raw);
}

// Only opt-in Chat Completions requests are transformed. Message/image/tool
// values stream without capture or reserialization. Retain only small metadata;
// unusually large metadata passes through unchanged, without an upload limit.
export function servingProfileTransform(profile, encoding, route) {
  if (!profile || route!=='/v1/chat/completions' || (encoding && encoding!=='identity')) return new PassThrough();
  const defaults=profile.defaults, seen=new Set();
  let phase='start', keyBytes=[], key=null, depth=0, quoted=false, escaped=false;
  let capture=null, raw=[], written=0, deferred=null, topEffort, hasEffort=false, opaque=false;
  let out=[];
  const emit=b=>{for(const byte of b)out.push(byte);};
  const begin=()=>{if(written++)out.push(44);emit(keyBytes);out.push(58);};
  const finishValue=()=>{
    if(capture==='kwargs')deferred=Buffer.from(raw);
    if(capture==='effort') {hasEffort=true;try{topEffort=JSON.parse(Buffer.from(raw).toString());}catch{}}
    capture=null;raw=[];phase='after';
  };
  const finishObject=()=>{
    const additions={};
    for(const k of sampling)if(!seen.has(k))additions[k]=defaults[k];
    if(!opaque){
      let c={};
      if(deferred){try{c=JSON.parse(deferred.toString());}catch{c=null;}}
      if(object(c)){
        c={...c};const d=defaults.chat_template_kwargs;
        if(!Object.hasOwn(c,'enable_thinking'))c.enable_thinking=hasEffort&&topEffort==='none'?false:d.enable_thinking;
        if(!Object.hasOwn(c,'preserve_thinking'))c.preserve_thinking=d.preserve_thinking;
        if(!Object.hasOwn(c,'reasoning_effort')&&!hasEffort&&c.enable_thinking!==false)c.reasoning_effort=d.reasoning_effort;
        additions.chat_template_kwargs=c;
      }else if(deferred){if(written++)out.push(44);emit(Buffer.from('"chat_template_kwargs":'));emit(deferred);}
    }
    for(const [k,v] of Object.entries(additions)){if(written++)out.push(44);emit(Buffer.from(JSON.stringify(k)+':'+JSON.stringify(v)));}
    out.push(125);phase='end';
  };
  return new Transform({transform(chunk,enc,done){
    try{
      out=[];
      for(const b of chunk){
        if(phase==='start'){out.push(b);if(b===123)phase='key';else if(![9,10,13,32].includes(b))phase='end';continue;}
        if(phase==='end'){out.push(b);continue;}
        if(phase==='key'){
          if(!keyBytes.length&&[9,10,13,32].includes(b))continue;
          if(!keyBytes.length&&b===125){finishObject();continue;}
          keyBytes.push(b);
          if(keyBytes.length===1){quoted=b===34;escaped=false;continue;}
          if(escaped){escaped=false;continue;}
          if(b===92){escaped=true;continue;}
          if(b===34){try{key=JSON.parse(Buffer.from(keyBytes).toString());}catch{key=null;}phase='colon';}
          continue;
        }
        if(phase==='colon'){
          if(b!==58){if(![9,10,13,32].includes(b))throw new Error('Invalid JSON property');continue;}
          seen.add(key);capture=key==='chat_template_kwargs'?'kwargs':key==='reasoning_effort'?'effort':null;
          if(capture!=='kwargs')begin();raw=[];depth=0;quoted=false;escaped=false;phase='value';continue;
        }
        if(phase==='value'){
          if(!quoted&&depth===0&&(b===44||b===125)){
            finishValue();keyBytes=[];if(b===125)finishObject();else phase='key';continue;
          }
          if(capture){raw.push(b);if(raw.length>65536){if(capture==='kwargs'){begin();emit(raw);opaque=true;}else out.push(b);capture=null;raw=[];}else if(capture==='effort')out.push(b);}
          else out.push(b);
          if(quoted){if(escaped)escaped=false;else if(b===92)escaped=true;else if(b===34)quoted=false;}
          else if(b===34)quoted=true;else if(b===123||b===91)depth++;else if(b===125||b===93)depth--;
          continue;
        }
      }
      this.push(Buffer.from(out));done();
    }catch(e){done(e);}
  }});
}
