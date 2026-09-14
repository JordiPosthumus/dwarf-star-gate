// Evidence-based activity only. A ticking clock is not proof the model is advancing.
const age=(at,now)=>Math.max(0,Math.floor((now-at)/1000));
const duration=n=>n<60?`${n}s`:`${Math.floor(n/60)}m ${n%60}s`;
export function chatProgress(message,{now=Date.now(),connected=true,suspended=false}={}){
  if(!['working','queued'].includes(message.state))return null;
  const elapsed=duration(age(message.at,now));
  if(!connected)return {label:'Connection lost · progress unknown',detail:`${elapsed} since submission. Reconnecting to the dashboard; the saved request has not been replayed.`};
  if(message.state==='queued')return {label:suspended?'Saved · paused for testing':'Saved · queued behind the earlier answer',detail:`Waiting ${elapsed}. This question has not been sent to the model yet.`};
  if(message.waiting_for_review)return {label:message.waiting_for_review==='scheduled'?'Yielding Genie’s routine review':'Waiting for Genie’s current review',detail:`${elapsed} since submission.`};
  const events=message.research?.events??[],latest=events.at(-1),p=message.progress;
  const latestAt=latest?Date.parse(latest.finished_at??latest.at):NaN;
  const updateAt=Math.max(Number.isFinite(p?.at)?p.at:message.at,Number.isFinite(latestAt)?latestAt:message.at);
  const silent=duration(age(updateAt,now));
  const completed=events.filter(e=>e.state==='complete').length;
  let label=message.text?'Writing the answer':p?.phase==='reasoning'?'Reasoning activity received':p?.phase==='starting'?'Starting Hermes':'Waiting for the model response';
  if(latest&&latestAt>=(p?.at??0))label=latest.state==='reading'?(latest.kind==='search'?'Searching public sources':'Reading a public page'):latest.state==='failed'?'Web request failed · waiting for Genie': 'Sources returned · waiting for Genie’s next step';
  const detail=`${elapsed} elapsed · ${p?.step?`model step ${p.step} · `:''}${completed} web request${completed===1?'':'s'} completed. ${age(updateAt,now)>=30?`No new activity for ${silent}; this alone does not prove a stall.`:`Activity received ${silent} ago.`}`;
  const activity=latest?.query?`Latest search: ${latest.query}`:latest?.kind==='read'&&latest.sources?.[0]?.url?`Latest page: ${latest.sources[0].url}`:p?.reasoning_chars?`${p.reasoning_chars.toLocaleString()} reasoning characters received; reasoning content stays private.`:!p?'The provider may be queued or generating; this request has no finer progress signal.':p.phase==='model_wait'?'Requesting a model response; server queue position is not reported here.':null;
  return {label,detail,activity};
}
