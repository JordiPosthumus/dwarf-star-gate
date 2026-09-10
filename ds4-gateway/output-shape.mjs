// Count known Chat Completions output fields without retaining their contents.
// Unknown content shapes must not become evidence that an answer was empty.
export function outputShape(message) {
  const shape={thinking_characters:0,answer_characters:0,tool_characters:0,output_present:false,observation_complete:true};
  const count=(value,key)=>{
    if(value==null)return;
    if(typeof value==='string'){shape[key]+=value.length;if(value.length&&key!=='thinking_characters')shape.output_present=true;}
    else shape.observation_complete=false;
  };
  if(!message||typeof message!=='object'||Array.isArray(message)){shape.observation_complete=false;return shape;}
  count(message.reasoning_content??message.reasoning??message.reasoning_text,'thinking_characters');
  if(Array.isArray(message.content)){
    for(const part of message.content){
      if(part?.type==='text')count(part.text,'answer_characters');
      else if(part?.type==='refusal')count(part.refusal,'answer_characters');
      else shape.observation_complete=false;
    }
  }else count(message.content,'answer_characters');
  count(message.refusal,'answer_characters');
  if(message.tool_calls!=null){
    if(Array.isArray(message.tool_calls))for(const call of message.tool_calls){
      shape.output_present=true;count(call?.function?.arguments,'tool_characters');
    }else shape.observation_complete=false;
  }
  if(message.function_call!=null){shape.output_present=true;count(message.function_call?.arguments,'tool_characters');}
  if(message.audio!=null||message.reasoning_details!=null)shape.observation_complete=false;
  return shape;
}
