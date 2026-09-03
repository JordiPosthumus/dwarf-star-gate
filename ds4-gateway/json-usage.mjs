// Bounded observation of non-streaming OpenAI completion responses. This budget
// limits metadata capture only, never forwarded bytes, output or model context.
export const JSON_USAGE_BYTES=4*1024*1024;
const number=x=>Number.isSafeInteger(x)&&x>=0?x:null;
const length=x=>typeof x==='string'?x.length:0;
export class JsonUsageObserver {
  constructor(route,{maxBytes=JSON_USAGE_BYTES}={}){this.route=route;this.maxBytes=maxBytes;this.parts=[];this.bytes=0;this.limited=false;this.supported=['/v1/chat/completions','/v1/completions'].includes(route);}
  accept(chunk){if(!this.supported||this.limited)return;this.bytes+=chunk.length;if(this.bytes>this.maxBytes){this.parts=[];this.limited=true;return;}this.parts.push(Buffer.from(chunk));}
  finish(){
    if(this.result)return this.result;
    const result=status=>this.result={status};
    if(!this.supported)return result('unsupported_route');
    if(this.limited)return result('json_capture_limit');
    try {
      const data=JSON.parse(Buffer.concat(this.parts).toString('utf8'));
      if(!data||typeof data!=='object'||Array.isArray(data)||data.error)return result('not_reported');
      const u=data.usage,usage=u&&typeof u==='object'?{prompt_tokens:number(u.prompt_tokens),completion_tokens:number(u.completion_tokens),cached_tokens:number(u.prompt_tokens_details?.cached_tokens)}:null;
      const status=usage&&usage.prompt_tokens!==null&&usage.completion_tokens!==null?'observed':usage?'partial':'not_reported';
      // Multiple choices have aggregate usage but no single-turn finish/counts.
      const choice=Array.isArray(data.choices)&&data.choices.length===1?data.choices[0]:null;
      const finish_reason=['stop','length','tool_calls','function_call','content_filter'].includes(choice?.finish_reason)?choice.finish_reason:null;
      let generation=null;
      if(this.route==='/v1/chat/completions'&&choice?.message&&typeof choice.message==='object'){
        const m=choice.message;generation={thinking_characters:length(m.reasoning_content),answer_characters:length(m.content),tool_characters:Array.isArray(m.tool_calls)?m.tool_calls.reduce((s,t)=>s+length(t?.function?.arguments),0):length(m.function_call?.arguments),first_semantic_ms:null};
      }else if(this.route==='/v1/completions'&&typeof choice?.text==='string')generation={thinking_characters:0,answer_characters:choice.text.length,tool_characters:0,first_semantic_ms:null};
      return this.result={status,usage,finish_reason,generation};
    }catch{return result('invalid_json');}
    finally{this.parts=[];}
  }
}
