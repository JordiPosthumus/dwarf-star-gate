const labels={preparing:'Preparing the proposal',awaiting_approval:'Ready for your review',approved_unsubmitted:'Approved · awaiting submission',
  submitted:'Submitted · checking progress',launch_uncertain:'Submission needs checking',preparation_interrupted:'Preparation interrupted',
  prepare_failed:'Could not prepare this change',declined:'Declined',running:'Working',completed:'Change verified',restored:'Previous version restored',
  failed_unchanged:'Original server unchanged',requires_reconciliation:'Needs attention',observation_unavailable:'Status temporarily unavailable',unreadable:'Saved evidence needs attention'};
export function operationLabel(row){return labels[row.runner?.state??row.state]??'Status unknown';}
export function operationChanges(review){
  const before=review?.settings?.current??{},after=review?.settings?.proposed??{},changes=[];
  if(review?.trial)changes.push(`Measured trial: qualify the candidate, run one hour of Hourglass (${review.trial.benchmark_version}), then restore and qualify the original. This does not adopt the candidate.`);
  const labels={context_length:'Context',max_output_tokens:'Output allowance',server_concurrency:'Concurrent requests',prefill_batch_tokens:'Prefill batch',kv_cache_dtype:'KV cache precision',prefix_caching:'Prefix caching',speculative_decoding:'Speculative decoding'};
  const show=v=>v===undefined?'unknown':typeof v==='object'?JSON.stringify(v):String(v);
  for(const key of new Set([...Object.keys(before),...Object.keys(after)]))if(JSON.stringify(before[key])!==JSON.stringify(after[key])){
    let tradeoff='';if(['context_length','max_output_tokens','server_concurrency'].includes(key)&&Number.isFinite(before[key])&&after[key]<before[key])tradeoff=' — reduces this serving capacity';
    if(key==='prefix_caching'&&before[key]===true&&after[key]===false)tradeoff=' — repeated context may take more work';
    changes.push(`${labels[key]??key}: ${show(before[key])} → ${show(after[key])}${tradeoff}`);
  }
  if(JSON.stringify(review?.settings?.current_thinking)!==JSON.stringify(review?.settings?.proposed_thinking))changes.push(`Thinking defaults: ${show(review?.settings?.current_thinking)} → ${show(review?.settings?.proposed_thinking)} — review the reasoning change`);
  if(review?.before?.image!==review?.after?.image)changes.push('Serving image changes; the exact image IDs are in the review below.');
  if(!changes.length&&JSON.stringify(review?.before?.command)!==JSON.stringify(review?.after?.command))changes.push('Serving arguments change; review the complete recipe below.');
  if(review?.cache_capacity_policy){
    const loss=review.cache_capacity_policy.max_loss_percent;
    changes.push(loss===0?'KV cache capacity: no reduction allowed.':`KV cache capacity: approving this change permits up to ${loss}% fewer cached tokens — less room for cached context.`);
    changes.push('Capacity is measured before changing the server and after candidate checks. Missing measurements prevent adoption. Returning the retained original keeps its existing qualification rules.');
  }
  return changes;
}
export function operationProgress(row,now=Date.now()){
  const p=row.runner?.progress,result=row.runner?.result;
  if(result?.readmission?.state==='left_to_operator')return 'Verification finished. Routing was left to the operator because a separate pause or decision must be preserved.';
  if(p){const seconds=Number.isFinite(p.heartbeat_at)?Math.max(0,Math.floor(now/1000-p.heartbeat_at)):null;return `${p.detail} ${row.runner.process_alive===true?(seconds===null?'Runner alive; heartbeat time unavailable.':`Runner alive; heartbeat ${seconds}s ago.`):'Runner is not currently confirmed alive.'} A heartbeat alone does not prove model progress.`;}
  return row.error??row.runner?.scope??'Preparing or waiting for approval does not change a server.';
}

export function operationQualification(row){
  const q=row.candidate_qualification;if(!q)return null;
  if(q.state==='unreadable')return 'Candidate qualification evidence could not be read.';
  if(q.state!=='failed')return null;
  if(q.reason==='exceeds_reviewed_allowance'){
    const counts=Number.isFinite(q.baseline_cache_tokens)&&Number.isFinite(q.candidate_cache_tokens)?` ${q.baseline_cache_tokens.toLocaleString('en-US')} → ${q.candidate_cache_tokens.toLocaleString('en-US')} cache tokens.`:'';
    const change=Number.isFinite(q.delta_percent)?` Change: ${q.delta_percent.toFixed(2)}%.`:'';
    const allowance=Number.isFinite(q.allowed_loss_percent)?` Allowed loss: ${q.allowed_loss_percent}%.`:'';
    return `Candidate rejected: cache capacity fell beyond the reviewed allowance.${counts}${change}${allowance} See progress for restoration status.`;
  }
  return q.reason==='capacity_unavailable'?'Candidate rejected: cache capacity could not be verified. See progress for restoration status.':'Candidate did not pass its native checks. See progress for restoration status.';
}

const panel=typeof document==='undefined'?null:document.getElementById('server-operations');
if(panel){
  const list=document.getElementById('server-operations-list'),error=document.getElementById('server-operations-error'),summary=document.getElementById('server-operations-summary');
  let token=null,reading=false,signature='',state=null;
  const busy=new Set(),known=new Set();
  function text(tag,value,cls){const e=document.createElement(tag);e.textContent=value;if(cls)e.className=cls;return e;}
  async function action(row,choice){
    if(busy.has(row.id))return;busy.add(row.id);signature='';render();error.textContent='';
    try{
      const response=await fetch('/api/genie/operations',{method:'POST',headers:{'content-type':'application/json','x-dsg-csrf':token},
        body:JSON.stringify({action:choice,id:row.id,plan_revision:row.plan_revision})});
      const result=await response.json();if(!response.ok)throw new Error(result.error??'The decision was not confirmed.');
    }catch(e){error.textContent=`${e.message} Refreshing the saved status; no action is automatically repeated.`;}
    finally{busy.delete(row.id);signature='';await refresh();}
  }
  function render(){
    if(!state)return;panel.hidden=!state.configured;if(panel.hidden)return;
    const rows=state.operations??[];
    const fingerprint=JSON.stringify([rows,state.suspended,[...busy],Math.floor(Date.now()/10000)]);if(fingerprint===signature)return;signature=fingerprint;
    const expanded=new Set([...list.querySelectorAll('details[open]')].map(d=>d.dataset.operationId));
    list.replaceChildren();summary.textContent=rows.length?`· ${rows.length} recorded`:'· no proposals';
    if(!rows.length)list.append(text('p','Ask Genie to inspect a server and propose a specific improvement.','conversation-footnote'));
    for(const row of rows){
      if(!known.has(row.id)&&!['completed','restored','failed_unchanged','declined'].includes(row.runner?.state??row.state))panel.open=true;known.add(row.id);
      const card=text('article','','server-operation');card.append(text('h3',`${row.worker_id??'Saved operation'} · ${operationLabel(row)}`));
      if(row.reason)card.append(text('p',row.reason));
      card.append(text('p',operationProgress(row),'conversation-footnote'));
      const qualification=operationQualification(row);if(qualification)card.append(text('p',qualification));
      if(row.review){
        for(const change of operationChanges(row.review))card.append(text('p',change));
        const details=text('details');details.dataset.operationId=row.id;details.open=expanded.has(row.id);
        details.append(text('summary','Review the exact change and checks'));
        if(row.review.settings)details.append(text('pre',JSON.stringify(row.review.settings,null,2)));
        for(const key of ['before','after']){details.append(text('h4',key==='before'?'Current recipe':'Proposed recipe'));details.append(text('pre',JSON.stringify(row.review[key],null,2)));}
        details.append(text('p',row.review.scope));
        if(row.review.qualification_by_version){
          details.append(text('h4','Checks for each version'));
          for(const [version,checks] of Object.entries(row.review.qualification_by_version))details.append(text('p',`${version==='candidate'?'Proposed version':version==='previous'?'Restored original':version}: ${checks.join(', ')}`));
          details.append(text('p','Container identity and idle-state checks also apply before returning the server to traffic.'));
        }else details.append(text('p',`Checks: ${(row.review.checks??[]).join(', ')}`));
        if(row.review.restoration?.length){
          details.append(text('h4','Recorded restoration evidence'));
          details.append(text('p','A confirmed qualification failure uses the retained original and checks it again. An uncertain operation needs reconciliation; this evidence does not promise recovery from every failure.'));
          details.append(text('pre',JSON.stringify(row.review.restoration,null,2)));
        }
        details.append(text('small',`Plan ${row.plan_revision}`));card.append(details);
      }
      if(['awaiting_approval','approved_unsubmitted'].includes(row.state)){
        const controls=text('div','','genie-controls');
        const approve=text('button',row.state==='approved_unsubmitted'?'Start the approved change':row.review?.trial?'Approve this trial':'Approve this change','button');approve.type='button';approve.disabled=busy.has(row.id)||state.suspended;
        approve.addEventListener('click',()=>action(row,'approve'));controls.append(approve);
        if(row.state==='awaiting_approval'){const decline=text('button','Decline','button');decline.type='button';decline.disabled=busy.has(row.id);decline.addEventListener('click',()=>action(row,'decline'));controls.append(decline);}
        card.append(controls);
      }
      card.append(text('small',`Operation ${row.id}`));list.append(card);
    }
  }
  async function refresh(){
    if(reading)return;reading=true;
    try{const response=await fetch('/api/genie/operations');const value=await response.json();if(!response.ok)throw new Error(value.error??'Operation status unavailable.');token=value.csrf_token;state=value;render();}
    catch(e){panel.hidden=false;error.textContent=e.message+' Existing operations may still be running.';}
    finally{reading=false;}
  }
  refresh();setInterval(()=>{if(!document.hidden&&location.hash==='#genie')refresh();},3000);
  window.addEventListener('hashchange',()=>{if(location.hash==='#genie')refresh();});
}
