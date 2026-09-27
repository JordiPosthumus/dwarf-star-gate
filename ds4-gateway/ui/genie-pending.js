export function pendingInputPresentation(input,{observedAt,connected=true,now=Date.now()}={}){
  const labels={queued:'Queued',buffered:'Received · collecting input',held:'Saved · paused',uncertain:'Delivery unconfirmed',accepted_unverified:'Received · awaiting confirmation',not_accepted:'Not accepted'};
  const details={queued:'Waiting in Hermes’s native queue.',buffered:'Hermes is collecting this input before processing it.',held:'This question is saved until you continue the conversation.',uncertain:'The text is retained, but its delivery is uncertain. Do not resend it while the original request is being reconciled.',accepted_unverified:'Hermes saved this request. It has not yet appeared in conversation history; execution is not confirmed.',not_accepted:'Hermes reported that it did not accept this request. Its text is retained here.'};
  const age=now-Date.parse(observedAt),fresh=connected&&Number.isFinite(age)&&age>=0&&age<=15000;
  return {label:fresh?(labels[input.state]??'Status unavailable'):`Last observed: ${labels[input.state]??'status unavailable'}`,
    detail:fresh?(details[input.state]??'Current input status is unavailable.'):'Current input status is unavailable. The last observed question is retained below.'};
}

export function nativeObservationChanged(summary,conversation){
  return Boolean(summary?.native_observation_revision)&&(
    summary.observation_available!==true||summary.native_observation_revision!==conversation?.native_observation_revision);
}

export function renewNativeObservation(summary,conversation){
  return summary?.observation_available===true&&summary.native_observation_revision&&
    summary.native_observation_revision===conversation?.native_observation_revision
      ?{...conversation,observed_at:summary.observed_at}:conversation;
}
