// Small display-only projection. Never include prompts, native graphs or file paths.
const returned = new Set(['returned', 'failed_returned', 'failed_unchanged']);
export function fleetMediaWorkloads(status, observedAt = Date.now()) {
  const operations = new Map();
  for (const job of status.jobs ?? []) {
    const e = job.execution;
    if (!e?.worker_id || returned.has(e.phase)) continue;
    const key = e.operation_id ?? job.id;
    const previous = operations.get(key);
    if (!previous || e.active_job_id === job.id) operations.set(key, job);
  }
  return {observed_at: observedAt, workloads: [...operations.values()].map(job => {
    const e = job.execution;
    return {worker_id:e.worker_id, job_id:e.active_job_id ?? job.id, kind:job.kind,
      state:e.active_job_id && e.active_job_id !== job.id ? 'unknown' : job.state,
      phase:e.phase, started_at:e.started_at ?? null, changed_at:e.changed_at ?? null,
      native_progress:e.native_progress?{connected:e.native_progress.connected===true,at:e.native_progress.at,node:e.native_progress.node,node_type:e.native_progress.node_type,value:e.native_progress.value,max:e.native_progress.max}:null,
      heartbeat_at:e.heartbeat_at ?? null, batch_index:e.batch_index ?? null,
      batch_size:e.batch_size ?? e.batch_job_ids?.length ?? 1,
      ...(e.parallel_members?{parallel_members:true,lanes:(e.lanes??[]).map(l=>{
        const active=status.jobs?.find(j=>j.id===l.active_job_id);
        return {member:l.member,job_id:l.active_job_id,state:active?.state??'unknown',phase:l.phase,
          native_progress:l.native_progress?{connected:l.native_progress.connected===true,at:l.native_progress.at,node:l.native_progress.node,node_type:l.native_progress.node_type,value:l.native_progress.value,max:l.native_progress.max}:null};
      })}:{}),
      outputs_state:e.active_job_id && e.active_job_id !== job.id ? null : job.outputs?.state ?? null};
  })};
}
