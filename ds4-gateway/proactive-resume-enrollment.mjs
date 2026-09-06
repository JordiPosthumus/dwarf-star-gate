import {randomUUID} from 'node:crypto';
import {piResumeReviewInput,ProactiveResumePi} from './proactive-resume-pi.mjs';

/** Optional local-host flow. Loading it does not enroll or start any session. */
export async function enrollProactiveResume({session,ui,reviewer,taskMessage,gatewayBaseUrl,providers,expiresAt,attemptBudget,createReceipts,signal,start=true,allowUndispatchedOutage=false,allowRecordedToolOutage=false,outageObservation,outageReady}={}){
  if(signal?.aborted)return {state:'declined'};
  if(typeof session?.prepareContinuationEnrollment!=='function')return {state:'blocked',reason:'native_capability_unavailable'};
  if(taskMessage?.role!=='user'||!session.messages.includes(taskMessage))throw new Error('Select an existing user task');
  if(!Number.isSafeInteger(expiresAt)||expiresAt<=Date.now()||!Number.isInteger(attemptBudget)||attemptBudget<1||attemptBudget>10)throw new Error('Invalid enrollment limits');
  if(session.model?.baseUrl!==gatewayBaseUrl)throw new Error('Select the session gateway');
  if(typeof allowUndispatchedOutage!=='boolean'||(allowUndispatchedOutage&&(typeof outageObservation?.inspect!=='function'||typeof outageObservation?.close!=='function'||typeof outageReady!=='function')))throw new Error('Explicit native outage observation and readiness required');
  if(typeof allowRecordedToolOutage!=='boolean'||(allowRecordedToolOutage&&!allowUndispatchedOutage))throw new Error('Recorded-tool recovery requires separate explicit outage enrollment');
  if(allowRecordedToolOutage&&(!session.continuationPolicies?.includes('recorded_tool_outage')||outageObservation.inspect().recordedToolObservation!==true))return {state:'blocked',reason:'recorded_tool_policy_unavailable'};
  if(!Array.isArray(providers)||!providers.length||providers.length>2)throw new Error('Explicit providers required');
  const disclosed=providers.map(({url,model})=>{
    const parsed=new URL(url);
    if(parsed.protocol!=='http:'||parsed.hostname!=='127.0.0.1'||parsed.username||parsed.password||parsed.search||parsed.hash||!['/v1','/v1/'].includes(parsed.pathname)||typeof model!=='string'||!model.trim())throw new Error('Invalid review provider');
    return {url,model};
  });
  const scopeId=randomUUID(),sessionId=session.sessionId;
  const context=piResumeReviewInput(session.messages,session.messages.indexOf(taskMessage),{id:'enrollment-preview',scopeId});
  const taskText=context.messages.find(message=>message.id===context.task_message_id).text;
  context.messages=[];
  const title=['Proactive Resume — optional for this task',
    'Task preview: '+JSON.stringify(taskText.slice(0,240))+(taskText.length>240?'… (full task remains in this conversation)':''),
    'Review provider: '+disclosed.map(p=>JSON.stringify(p.model)+' at '+JSON.stringify(p.url)).join('; '),
    'Share supported conversation text and tool results, up to 24 messages / 32 KiB. Thinking and images are excluded.',
    'Allow Gate Genie courtesy cues only for this authorized task. Human decisions and new input stop automatic continuation.',
    ...(allowUndispatchedOutage?['Also allow continuation after an observed DSG outage only when every attempt was certified not dispatched and no tool work occurred. Unknown execution still blocks. Observation adds a missing DSG correlation ID and hashes the transcript to reject changes; original input and retry settings are preserved.']:[]),
    ...(allowRecordedToolOutage?['Also allow continuation after completed tool work only when native reconciliation matches the recorded tool results, unchanged transcript and model context, and the later failed requests were certified not dispatched. Continue from recorded results; do not replay completed actions. Errors or ambiguous outcomes block this policy. Hashing tool results adds local CPU work.']:[]),
    'Genie also reviews the result to verify new task work. Uncertain results stop further cues.',
    'Expires: '+new Date(expiresAt).toISOString()+' · At most '+attemptBudget+' accepted attempts.',
    'Approval expires after 60 seconds. /proactive-resume-off opts out; ordinary Pi work continues.'
  ].join('\n');
  // Opening the native selector synchronously establishes its own input hold.
  // Capture after that hold so its normal release cannot invalidate approval,
  // while any competing input, stop or session change still does.
  const choice=ui.select(title,['Keep disabled','Enable for this task'],{signal});
  const prepared=session.prepareContinuationEnrollment({gatewayBaseUrl,allowUndispatchedOutage,allowRecordedToolOutage,enrollment:{scopeId,sessionId,expiresAt,attemptBudget}});
  let receipts,bridge;
  const cancel=()=>{prepared.cancel();bridge?.close();};
  signal?.addEventListener('abort',cancel,{once:true});
  try{
    if(await choice!=='Enable for this task'){prepared.cancel();return {state:'declined'};}
    if(signal?.aborted){prepared.cancel();return {state:'declined'};}
    receipts=await createReceipts(sessionId);
    const control=prepared.activate(receipts);
    bridge=new ProactiveResumePi({session,control,reviewer,taskMessage,scopeId,outageReady,consent:{reviewText:true,reviewProgress:true,reviewOutage:allowUndispatchedOutage,reviewRecordedToolOutage:allowRecordedToolOutage,providers:disclosed}});
    const initial=start?await bridge.start():null;
    return {state:'enrolled',bridge,initial,close:async()=>{bridge.close();await receipts.close();}};
  }catch{
    prepared.cancel();bridge?.close();await receipts?.close();
    return {state:'blocked',reason:'enrollment_changed_or_unavailable'};
  }finally{signal?.removeEventListener('abort',cancel);}
}
