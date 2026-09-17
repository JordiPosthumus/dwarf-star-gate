import {hourglassForChat} from './hourglass-reports.mjs';

// Compare retained aggregate facts, not raw questions or invented normalized scores.
export function compareHourglassReports(reports,baselineRevision,candidateRevision,operation){
  if(![baselineRevision,candidateRevision].every(v=>/^[a-f0-9]{64}$/.test(v??''))||baselineRevision===candidateRevision)throw Error('Choose two different saved report revisions.');
  const select=revision=>{
    const matches=reports.filter(r=>r.report_revision===revision);
    if(matches.length!==1)throw Error('The selected report is missing or has ambiguous associations. Read measurement status again.');
    const row=hourglassForChat({configured:true,reports:matches}).reports[0];
    if(!row)throw Error('The selected report cannot be read.');return row;
  };
  const baseline=select(baselineRevision),candidate=select(candidateRevision),a=baseline.summary,b=candidate.summary;
  const protocol=[],conditions=[];
  const read=(o,key)=>key.split('.').reduce((v,k)=>v?.[k],o);
  const compare=(list,field,x,y)=>{
    if(x===null||x===undefined||y===null||y===undefined)list.push({field,state:'unknown',baseline:x??null,candidate:y??null});
    else if(x!==y)list.push({field,state:'different',baseline:x,candidate:y});
  };
  for(const field of ['score.version','benchmark_version','scoring_policy','timing_policy','bank_fingerprint','window_seconds','question_timeout_policy','execution.question_timeout_s','execution.repeat','execution.round_policy'])compare(protocol,field,read(a,field),read(b,field));
  if(!a.score.final||!b.score.final||!a.score.recognized||!b.score.recognized)protocol.push({field:'final_recognized_scores',state:'unavailable'});
  for(const field of ['machine_key','execution.stop_after_wrong'])compare(conditions,field,read(a,field),read(b,field));
  compare(conditions,'worker_id',baseline.association.worker_id,candidate.association.worker_id);
  compare(conditions,'route',baseline.association.route==='unknown'?null:baseline.association.route,candidate.association.route==='unknown'?null:candidate.association.route);
  for(const [side,row] of [['baseline',baseline],['candidate',candidate]]){
    if(!['owned-maintenance','owner-confirmed-idle'].includes(row.association.contention))conditions.push({field:`${side}.contention`,state:row.association.contention==='observed-contention'?'contention_recorded':'unknown'});
    if(!row.association.approved_configuration_revision)conditions.push({field:`${side}.approved_configuration_revision`,state:'unknown'});
    if(!row.summary.configuration_key)conditions.push({field:`${side}.configuration_key`,state:'unknown'});
    if(row.summary.clock_adjustment_seconds===null||row.summary.clock_adjustment_seconds!==0)conditions.push({field:`${side}.clock_adjustment_seconds`,state:row.summary.clock_adjustment_seconds===null?'unknown':'adjusted',value:row.summary.clock_adjustment_seconds});
    if(row.summary.repaired||row.summary.caveats.length)conditions.push({field:`${side}.report_caveats`,state:'review',repaired:row.summary.repaired,caveats:row.summary.caveats});
  }
  const compatible=protocol.length===0;
  const delta=compatible?b.score.value-a.score.value:null;
  return {baseline,candidate,state:!compatible?'different_or_unknown_protocol':conditions.length?'conditions_need_review':'recorded_conditions_match',
    protocol_issues:protocol,condition_issues:conditions,
    difference:delta===null?null:{value:delta,unit:a.score.unit,direction:delta>0?'higher':delta<0?'lower':'equal'},
    configuration_key_changed:a.configuration_key&&b.configuration_key?a.configuration_key!==b.configuration_key:null,
    ...(operation!==undefined?{operation_association:operationAssociation(baseline,candidate,operation)}:{}),
    scope:'Two dated aggregate reports. A difference is arithmetic on matching recorded methodology, not proof that a configuration caused it. Worker, route and contention associations retain their stated provenance; matching records do not prove absence of direct traffic or run-to-run variation. No score conversion, benchmark, keep/restore decision or server change was performed.'};
}

function operationAssociation(baseline,candidate,{id,result}){
  const issues=[],evidence=result?.evidence,configuration=evidence?.configuration;
  const expected={worker_id:result?.worker_id??null,
    baseline_configuration_revision:configuration?.previous_record_revision??null,
    candidate_configuration_revision:configuration?.record_revision??null};
  if(!result||result.id!==id)issues.push({field:'operation',state:'unavailable'});
  else if(result.state!=='completed'||evidence?.serving!=='candidate')issues.push({field:'operation',state:'not_completed_candidate'});
  if(evidence?.qualification?.state!=='passed')issues.push({field:'qualification',state:'unverified'});
  for(const [side,row] of [['baseline',baseline],['candidate',candidate]]){
    for(const [field,wanted] of [['worker_id',expected.worker_id],['approved_configuration_revision',expected[side+'_configuration_revision']]]){
      const actual=row.association[field];
      if(!wanted||!actual)issues.push({field:side+'.'+field,state:'unknown'});
      else if(actual!==wanted)issues.push({field:side+'.'+field,state:'different'});
    }
  }
  if(configuration?.record_revision&&configuration.record_revision===configuration.previous_record_revision)issues.push({field:'configuration_revisions',state:'unchanged'});
  return {id,state:issues.length?'needs_review':'recorded_revisions_match',expected,issues,
    scope:'Links dated report associations to the saved operation and qualification receipts. Does not independently prove measured settings, current serving state, performance causation or a keep/restore decision. Protocol and contention checks above still apply.'};
}
