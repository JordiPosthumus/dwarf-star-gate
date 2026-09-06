import {DISPATCH_HEADER,validCallId} from './continuity.mjs';

// Positive evidence about one HTTP attempt, never a native turn or earlier call.
export function certifiedNotDispatched(response,error,callId){
  const c=error?.continuity;
  if(!validCallId(callId)||![429,503,504].includes(response.status)||response.headers.get(DISPATCH_HEADER)!=='not_dispatched'||
    error?.type!=='gateway_error'||c?.schema!==1||c.dispatch_state!=='not_dispatched'||c.retry_class!=='wait_then_retry'||c.call_id!==callId||
    !validCallId(c.request_id)||c.request_id!==response.headers.get('x-request-id')||
    !(['draining','home_unavailable','no_healthy_workers','queue_full','queue_timeout'].includes(error.code)||
      (c.source==='continuity_door'&&['continuity_stopping','continuity_hold_full'].includes(error.code)&&c.reason===error.code)))return null;
  return {call_id:callId,request_id:c.request_id,code:error.code};
}
