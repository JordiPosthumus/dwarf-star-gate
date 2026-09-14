// A deliberate local handoff: identifiers and status, never chat or notebook prose.
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value)?value:'unavailable';
const date=value=>Number.isSafeInteger(value)&&value>=0&&value<=8640000000000000?new Date(value).toISOString():'unknown';
export function genieHandoff({status=null,session=null,connected=false,observedAt=null,pendingRequest=null,now=Date.now()}={}){
  const reply=session?.messages?.findLast(m=>m.role==='assistant');
  const state=['queued','working','complete','failed','interrupted'].includes(reply?.state)?reply.state:'unknown';
  const model=typeof status?.model==='string'&&/^[\w./:+-]{1,128}$/.test(status.model)?status.model:'not included';
  const lines=['Please diagnose this Star Gate / Gate Genie chat from the existing installation. Start read-only.',
    '',`Mode: ${status?.mode==='rehearsal'?'synthetic rehearsal; no real model qualification':'installation status'}`,`Handoff captured: ${date(now)}`,`Last successful chat observation: ${date(observedAt)}`,
    `Dashboard connection: ${connected?'responding at last observation':'unavailable; cached observations may be stale'}`,
    `Configured model: ${model} (not proof of the worker that served this reply)`,
    `Chat availability at last observation: ${status?.suspended===true?'paused for testing':status?.available===true?'available':status?.available===false?'unavailable':'unknown'}`,
    `Conversation: ${uuid(session?.id)}`,`Last assistant message: ${uuid(reply?.id)}`,
    `Last assistant state: ${state} (saved status, not proof of current upstream activity)`,
    `Last reply finished: ${date(reply?.finished_at)}`];
  if(['scheduled','manual','action'].includes(reply?.waiting_for_review))lines.push(`Waiting for fleet review: ${reply.waiting_for_review}`);
  if(session?.queue_paused)lines.push('Conversation queue is paused after an unfinished reply; following questions remain saved.');
  if(pendingRequest)lines.push('A browser submission has no confirmed acknowledgement. Check the saved conversation before submitting anything again.');
  lines.push('',
    'Inspect the local chat status and the identified saved conversation. Correlate any active request with the gateway and Hermes process before acting. A disconnected dashboard or old working status does not prove the model stopped.',
    'Preserve saved messages, partial output, SOUL.md, private configuration and existing server capabilities. Do not replay an ambiguous request, cancel unrelated work, reset memory, reduce limits or restart services just to clear the screen. Wait for affected work to finish before an authorized restart.',
    'Report the cause and the smallest repair, then verify chat works and the gateway remains available. Host/server changes still require their existing approval and restore procedure.',
    '', 'This handoff contains local reference IDs and status only. Conversation text, drafts, credentials, endpoints and notebook content are omitted. Review before sharing; nothing has been sent to another agent.');
  return lines.join('\n');
}
