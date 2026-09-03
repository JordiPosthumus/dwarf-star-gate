// Read-only preflight, deliberately NOT an execution authorization. No supported
// non-displacing calibration adapter exists yet. Idle never means empty KV.
export function calibrationPreflight(workers=[],{draining=false}={}) {
  return {schema:1,state:'skipped',execution_available:false,
    reason:'no_verified_non_displacing_adapter',
    workers:workers.slice(0,128).map(w=>({worker_id:w.id,eligible:false,
      reasons:[...(!w.healthy?['unhealthy']:[]),...(w.drained?['operator_paused']:[]),
        ...(w.quarantine?['quarantined']:[]),...(draining?['gateway_draining']:[]),
        ...(w.active||w.queue?.length?['gateway_work_present']:[]),
        'warm_cache_preservation_unverified','direct_client_exclusion_unverified',
        'no_verified_non_displacing_adapter']}))};
}
