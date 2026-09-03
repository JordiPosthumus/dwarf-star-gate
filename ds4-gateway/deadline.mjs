// Node clamps delays above 2^31-1 ms to 1 ms. Chain bounded timers against a
// monotonic deadline instead. This does not persist HTTP requests over a restart.
export const MAX_TIMER_MS=2147483647;
export const DEFAULT_QUEUE_TIMEOUT_MS=20000*60*60*1000;
export function queueTimeout(value){
  const ms=value??DEFAULT_QUEUE_TIMEOUT_MS;
  if(!Number.isSafeInteger(ms)||ms<1)throw new Error('queue_timeout_ms must be a positive safe integer');
  return ms;
}
export function queueTimeoutMessage(value){
  const ms=queueTimeout(value);
  // Keep custom/sub-hour limits exact; report the request's admission-time value.
  const [unitMs,unit]=[[3600000,'hour'],[60000,'minute'],[1000,'second'],[1,'millisecond']].find(([size])=>ms%size===0);
  const count=ms/unitMs,limit=`${count.toLocaleString('en-US')} ${unit}${count===1?'':'s'}`;
  return `This request reached its DSG queue waiting limit of ${limit} and was not dispatched to a model server. This limit is configurable in DSG under Manage DS4 servers → Queue waiting allowance (hours); changes apply to new requests.`;
}
export function deadlineTimer(callback,ms,{now=()=>performance.now(),setTimer=setTimeout,clearTimer=clearTimeout}={}){
  ms=queueTimeout(ms);
  const start=now();let timer,done=false;
  function step(){
    if(done)return;
    const remaining=ms-(now()-start);
    if(remaining<=0){done=true;callback();return;}
    timer=setTimer(step,Math.max(1,Math.min(MAX_TIMER_MS,Math.ceil(remaining))));
  }
  step();
  return {cancel(){if(done)return;done=true;clearTimer(timer);}};
}
