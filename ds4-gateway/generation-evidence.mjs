// Read-only output-shape evidence. No semantic diagnosis, retry or admission action.
export class GenerationEvidence {
  constructor(){this.rows=new Map();}
  accept(row){
    const g=row?.generation,at=Date.parse(row?.time);
    if(row?.schema!==1||row.kind!=='finish'||row.outcome!=='complete'||row.finish_reason!=='stop'||row.route!=='/v1/chat/completions'||!Number.isFinite(at))return;
    if(!['run_id','request_id','node'].every(k=>typeof row[k]==='string'&&/^[\w-]{1,64}$/.test(row[k])))return;
    if(!g||g.observation_complete!==true||g.output_present!==false||!['thinking_characters','answer_characters','tool_characters'].every(k=>Number.isSafeInteger(g[k])&&g[k]>=0)||g.answer_characters||g.tool_characters)return;
    const key=row.run_id+':'+row.request_id;
    this.rows.set(key,{worker:row.node,at,kind:g.thinking_characters?'reasoning_only_final':'empty_final'});
    if(this.rows.size>128)this.rows.delete(this.rows.keys().next().value);
  }
  snapshot(now=Date.now()){
    return {scope:'observed_chat_completion_output_shape',automatic_action:false,rows:[...this.rows.values()].filter(r=>r.at<=now&&now-r.at<3600000).sort((a,b)=>b.at-a.at).slice(0,10)};
  }
}
