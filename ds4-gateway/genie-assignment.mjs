// New review placement only. This module never cancels, retries or replays a
// dispatched request, changes a provider deadline, or grants a worker hold.
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.replace(/\/$/,'')===b.replace(/\/$/,'');
export const GENIE_ASSIGNMENT_HISTORY_MS=30*60*1000;
export function freeGeniePool(snapshot,endpoint,poolUrl,now=Date.now()){
  const gateway=snapshot?.gateway;
  return same(endpoint?.url,poolUrl)&&gateway?.genie_admission_version===1&&
    (endpoint.model||'deepseek-v4-flash')===gateway.model&&!snapshot.gateway_error&&
    Number.isFinite(snapshot.gateway_at)&&now-snapshot.gateway_at>=0&&now-snapshot.gateway_at<=6000&&!gateway.draining&&
    gateway.workers?.some(worker=>worker.is_healthy===true&&worker.load===0&&worker.queued===0&&!worker.drained&&!worker.quarantine&&!worker.recovery_waiting&&!worker.holds?.length&&!worker.maintenance_locks?.length)===true;
}
export function fastGenieAssignment({config,source,history=[],snapshot,poolUrl,now=Date.now()}={}){
  const primaryPool=same(config?.url,poolUrl);
  const flexible=endpoint=>same(endpoint?.url,poolUrl)&&snapshot?.gateway?.genie_flexible_assignment===true;
  if(source==='pool'||primaryPool){
    const endpoint=source==='pool'?config?.fallback:config;
    return {endpoint,servedBy:'pool',flexible:flexible(endpoint),reason:'pool_selected'};
  }
  const recent=history.find(attempt=>attempt.provider==='dedicated'&&Number.isFinite(attempt.finished_at)&&now-attempt.finished_at>=0&&now-attempt.finished_at<GENIE_ASSIGNMENT_HISTORY_MS);
  const reason=recent?.outcome==='failed'?'recent_dedicated_failure':recent&&recent.finished_at-recent.started_at>=60000?'recent_dedicated_delay':null;
  if(reason&&freeGeniePool(snapshot,config?.fallback,poolUrl,now))return {endpoint:config.fallback,servedBy:'pool_assigned',flexible:flexible(config.fallback),reason};
  return {endpoint:config,servedBy:'dedicated',flexible:false,reason:'dedicated_selected'};
}
