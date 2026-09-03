// Node clamps delays above 2^31-1 ms to 1 ms. Chain bounded timers against a
// monotonic deadline instead. This does not persist HTTP requests over a restart.
export const MAX_TIMER_MS=2147483647;
export const DEFAULT_QUEUE_TIMEOUT_MS=20000*60*60*1000;
export function queueTimeout(value){
  const ms=value??DEFAULT_QUEUE_TIMEOUT_MS;
  if(!Number.isSafeInteger(ms)||ms<1)throw new Error('queue_timeout_ms must be a positive safe integer');
  return ms;
}
export function deadlineTimer(callback,ms,{now=()=>performance.now(),setTimer=setTimeout,clearTimer=clearTimeout}={}){
  queueTimeout(ms);
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
