import {enrollProactiveResume} from './proactive-resume-enrollment.mjs';

const outcomeLabel=last=>last?.state==='reviewing_progress'?'checking result':last?.state==='progress_review_stale'?'result review superseded':({task_complete:last?.receipt_status==='progress_confirmed'?'task complete; work verified':'task complete',new_task_work:'new task work verified',no_new_task_work:'no new task work',owner_decision:'needs your decision',insufficient_evidence:'review uncertain',progress_unverified:'progress not verified',progress_review_unavailable:'result review unavailable',progress_review_stale:'result review superseded'}[last?.reason]||String(last?.reason||last?.receipt_status||last?.verdict||'waiting').replaceAll('_',' '));

/** Candidate Pi main() options. Native CLI parsing, providers and session switching stay owned by Pi. */
export function proactiveResumeMainOptions({getEnrollmentOptions,observeSession}={}){
  if(typeof getEnrollmentOptions!=='function')throw new Error('Trusted enrollment options required');
  let runtime;
  const observations=new WeakMap();
  const observe=()=>{
    const session=runtime?.session;
    if(!session||typeof observeSession!=='function')return null;
    if(observations.has(session))return observations.get(session);
    let handle;try{handle=observeSession(session);}catch{return null;}
    if(!handle)return null;
    const owned={inspect:()=>handle.inspect(),close:()=>{handle.close();observations.delete(session);}};
    observations.set(session,owned);return owned;
  };
  return {
    onRuntimeCreated:value=>{runtime=value;observe();},
    extensionFactories:[pi=>registerProactiveResumeHost(pi,{
      getSession:()=>{
        if(!runtime)throw new Error('Native runtime unavailable');
        return runtime.session;
      },
      getEnrollmentOptions,getOutageObservation:observe
    })]
  };
}

/** Explicit trusted-host registration; the ordinary installed extension does not call it. */
export function registerProactiveResumeHost(pi,{getSession,getEnrollmentOptions,getOutageObservation}={}){
  let active=null,pending=null,scheduled=null,statusUI=null,observation=null;
  const show=()=>{
    const bridge=active?.bridge;
    const suffix=bridge?(bridge.closed?'off':'on')+' · '+outcomeLabel(bridge.last)+(bridge.closed?'':' · /proactive-resume-off'):'off';
    statusUI?.setStatus('dsg-proactive-resume','Proactive Resume: '+suffix);
  };
  const close=async(stopObservation=true)=>{
    pending?.abort();
    if(scheduled){clearImmediate(scheduled);scheduled=null;}
    const previous=active;active=null;
    previous?.bridge.close();
    await previous?.close();
    if(stopObservation){observation?.close();observation=null;}
    show();
  };
  pi.registerCommand('proactive-resume-off',{description:'Disable Proactive Resume for this task',handler:async(_args,ctx)=>{
    statusUI=ctx.ui;await close();ctx.ui.notify('Proactive Resume is off.','info');
  }});
  pi.registerCommand('proactive-resume',{description:'Review optional task-local Proactive Resume enrollment',handler:async(_args,ctx)=>{
    if(!ctx.hasUI){ctx.ui.notify('Proactive Resume enrollment requires an interactive confirmation.','warning');return;}
    statusUI=ctx.ui;
    if(pending){ctx.ui.notify('Proactive Resume approval is already pending. Press Esc to cancel.','info');return;}
    if(active&&!active.bridge.closed){show();ctx.ui.notify('Proactive Resume is enabled. Use /proactive-resume-off to disable it.','info');return;}
    if(active)await close(false);
    const abort=new AbortController();pending=abort;let newlyObserving=false;
    try{
      const session=getSession();
      const options=await getEnrollmentOptions(session);
      if(abort.signal.aborted)return;
      const alreadyObserving=!!observation;
      if(options.allowUndispatchedOutage)observation??=getOutageObservation?.();
      newlyObserving=!alreadyObserving&&!!observation;
      const result=await enrollProactiveResume({...options,session,ui:ctx.ui,
        outageObservation:observation,taskMessage:session.messages.findLast(message=>message.role==='user'),signal:abort.signal,start:false});
      if(abort.signal.aborted){if(result.state==='enrolled')await result.close();return;}
      if(result.state!=='enrolled'){if(!alreadyObserving){observation?.close();observation=null;}show();ctx.ui.notify(result.state==='declined'?'Proactive Resume remains off.':'Proactive Resume could not enroll: '+result.reason,'info');return;}
      active=result;
      result.bridge.onStatus=last=>{
        if(active!==result)return;
        show();
        if(['progress_confirmed','failed','unknown','progress_review_stale'].includes(last.state))ctx.ui.notify('Proactive Resume: '+outcomeLabel(last),last.state==='progress_confirmed'?'info':'warning');
      };
      show();
      // The command's own native input hold releases before the next event-loop
      // turn. Ordinary user work is never queued behind a Genie review.
      scheduled=setImmediate(()=>{
        scheduled=null;
        if(active===result&&!result.bridge.closed)void result.bridge.start().catch(()=>{
          if(active===result)ctx.ui.notify('Proactive Resume review failed.','warning');
        });
      });
    }catch{if(newlyObserving){observation?.close();observation=null;}ctx.ui.notify('Proactive Resume enrollment is unavailable.','warning');}
    finally{if(pending===abort)pending=null;}
  }});
  pi.on('session_start',(_event,ctx)=>{
    observation=getOutageObservation?.()??null;
    if(observation)ctx.ui.notify('DSG outage observation is on for this session. Continuation still requires task approval with /proactive-resume; /proactive-resume-off stops observation.','info');
  });
  pi.on('model_select',()=>close());
  for(const event of ['session_before_switch','session_before_fork','session_shutdown'])pi.on(event,()=>close());
  return {close};
}
