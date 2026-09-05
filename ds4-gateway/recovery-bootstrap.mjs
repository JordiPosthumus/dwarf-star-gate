// Private enrollment/verification predicates. Neither diagnostics nor a claimed
// healthy process can substitute for a completed, acknowledged removed-job canary.
export function bootstrapEnrollmentMatches(s,c){
  const b=s?.bootstrap;
  return c?.adapter==='launchd'&&c.bootstrap_removed===true&&b?.version===1&&
    Object.keys(b).sort().join(',')==='callers,definition_sha256,version'&&b.definition_sha256===c.retained_definition_sha256&&
    Array.isArray(b.callers)&&b.callers.every(x=>['loginwindow','runningboardd'].includes(x))&&new Set(b.callers).size===b.callers.length&&
    JSON.stringify([...b.callers].sort())===JSON.stringify([...c.bootstrap_callers].sort());
}
export function bootstrapProofValid(proof,context){
  if(proof?.check!=='two_conversations_cold_to_warm'||proof.context_length!==context||typeof proof.verified_at!=='string'||!Number.isFinite(Date.parse(proof.verified_at))||
    !Array.isArray(proof.samples)||proof.samples.length!==4)return false;
  const labels=['cold-A','cold-B','warm-A','warm-B'];
  if(proof.samples.some((s,i)=>s?.label!==labels[i]||!Number.isSafeInteger(s.prompt_tokens)||s.prompt_tokens<2000||
    !Number.isSafeInteger(s.cached_tokens)||s.cached_tokens<0||s.cached_tokens>s.prompt_tokens||!Number.isFinite(s.elapsed_ms)||s.elapsed_ms<0))return false;
  return proof.samples.slice(0,2).every(s=>s.cached_tokens<=64)&&proof.samples.slice(2).every((s,i)=>s.cached_tokens>=Math.max(2000,proof.samples[i].prompt_tokens-64));
}
