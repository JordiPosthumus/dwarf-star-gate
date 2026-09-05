// Native-helper diagnostics only. Never an action offer or a raw-log passthrough.
const successes=new Set(['exact_removal_observed','exact_stop_request_observed','no_exact_removal_record','conflicting_callers']);
const failures=new Set(['prior_identity_unverified','machine_changed','boot_unverified_or_changed','service_profile_changed','job_not_absent',
  'identity_changed_during_capture','capture_timeout','capture_output_limit','capture_unavailable','capture_incomplete']);
const fields=['authority','checked_at','native_stop_caller_observed','observations','observations_omitted','records','source','source_complete','status','version'];
const callers=new Set(['loginwindow','launchctl','runningboardd','other']);
export function safeNativeRemoval(value,{now=Date.now(),after=0}={}){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!==fields.join(',')||value.version!==1||
    value.source!=='native_launchd'||value.authority!=='none'||!Number.isSafeInteger(value.checked_at)||value.checked_at<Math.max(0,after-10000)||value.checked_at>now+10000||
    typeof value.source_complete!=='boolean'||typeof value.native_stop_caller_observed!=='boolean'||!Number.isSafeInteger(value.records)||value.records<0||value.records>10000||
    !Number.isSafeInteger(value.observations_omitted)||value.observations_omitted<0||value.observations_omitted>10000||
    !Array.isArray(value.observations)||value.observations.length>16)return null;
  const observations=[];
  for(const row of value.observations){
    if(!row||typeof row!=='object'||Object.keys(row).sort().join(',')!=='at,caller'||!Number.isSafeInteger(row.at)||row.at<value.checked_at-4*3600000||row.at>value.checked_at||!callers.has(row.caller))return null;
    observations.push({at:row.at,caller:row.caller});
  }
  if(new Set(observations.map(row=>JSON.stringify(row))).size!==observations.length||observations.length+value.observations_omitted>value.records)return null;
  if(successes.has(value.status)){
    const kinds=new Set(observations.map(row=>row.caller));
    if(!value.source_complete||((value.status==='no_exact_removal_record')!==(observations.length===0))||
      (value.status==='no_exact_removal_record'&&value.observations_omitted)||
      (value.status==='exact_removal_observed'&&kinds.size!==1)||
      (value.status==='exact_stop_request_observed'&&(kinds.size!==1||!kinds.has('launchctl')||!value.native_stop_caller_observed))||
      (value.status==='conflicting_callers'&&value.observations_omitted===0&&kinds.size<2)||
      (kinds.has('launchctl')&&!value.native_stop_caller_observed)||
      (value.observations_omitted===0&&value.native_stop_caller_observed!==observations.some(row=>row.caller==='launchctl')))return null;
  }else if(!failures.has(value.status)||value.source_complete||value.records||observations.length||value.observations_omitted||value.native_stop_caller_observed)return null;
  return {...value,observations};
}
export function unavailableNativeRemoval(at){return {version:1,source:'native_launchd',authority:'none',checked_at:at,status:'capture_unavailable',source_complete:false,
  records:0,observations:[],observations_omitted:0,native_stop_caller_observed:false};}
