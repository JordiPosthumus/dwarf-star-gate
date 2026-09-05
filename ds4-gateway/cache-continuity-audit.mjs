#!/usr/bin/env node
// Read-only, privacy-bounded cache-continuity audit over DSG's existing
// numerical evidence. It never reads prompt text, hashes prompts, routes work or
// touches a DS4 cache. Low reuse is an anomaly, not protocol proof of a miss.
import path from 'node:path';
import {isMain} from './config.mjs';
import {readEvidence} from '../predictor/audit.mjs';

const ID=/^[\w-]{1,64}$/;
const SESSION=/^[a-f0-9]{64}$/;
const PROFILE=/^[a-f0-9]{64}$/;
const RELEVANT=new Set(['decision','finish','queue_relocation']);
const TERMINAL=new Set(['stop','tool_calls','function_call']);
const MAX_EVENTS=200000;
const MAX_REQUESTS=50000;
const DEFAULT_MAX_AGE_MS=24*60*60*1000;
const MIN_REFERENCE_TOKENS=256;
const HIGH_REUSE_RATIO=.8;
const LOW_REUSE_RATIO=.2;
const MIN_PROMPT_RETENTION=.8;

const integer=value=>Number.isSafeInteger(value)&&value>=0?value:null;
const at=value=>{const parsed=Date.parse(value);return Number.isFinite(parsed)?parsed:null;};
const tally=(target,key)=>{target[key]=(target[key]??0)+1;};
const median=values=>{if(!values.length)return null;const ordered=[...values].sort((a,b)=>a-b),middle=Math.floor(ordered.length/2);return ordered.length%2?ordered[middle]:(ordered[middle-1]+ordered[middle])/2;};
const rounded=value=>value===null?null:Math.round(value*1000)/1000;

function candidate(decision,node) {
  const rows=Array.isArray(decision?.candidates)?decision.candidates.filter(row=>row?.node===node):[];
  if(rows.length!==1)return null;
  const row=rows[0];
  return {profile:PROFILE.test(row.profile??'')?row.profile:null,observation_epoch:integer(row.observation_epoch)};
}

function metadata(decision) {
  const value=decision?.client_metadata;
  if(value?.schema!==1||value.status!=='ready')return null;
  return {turn_index:integer(value.turn_index),compaction_count:integer(value.compaction_count)};
}

function jobGate(previous,current,maxAgeMs) {
  const fail=reason=>({reason});
  if(previous.ambiguous||current.ambiguous)return fail('ambiguous_request_evidence');
  if(!previous.finish||!current.finish)return fail('terminal_evidence_missing');
  if(previous.finish_at<previous.decision_at||current.finish_at<current.decision_at)return fail('noncausal_request_evidence');
  if(previous.relocated||current.relocated)return fail('queued_relocation_observed');
  if(previous.finish.node!==previous.decision.node||current.finish.node!==current.decision.node)return fail('worker_join_conflict');
  if(previous.finish.outcome!=='complete'||current.finish.outcome!=='complete')return fail('incomplete_or_failed_request');
  if(!TERMINAL.has(previous.finish.finish_reason)||!TERMINAL.has(current.finish.finish_reason))return fail('terminal_semantics_unknown_or_censored');
  if(previous.finish.route!==current.finish.route||!previous.finish.route)return fail('request_route_changed_or_unknown');
  if(current.decision.affinity!=='existing')return fail('current_affinity_not_existing');
  if(previous.finish.node!==current.finish.node)return fail('worker_changed');
  const gap=current.decision_at-previous.finish_at;
  if(!Number.isFinite(gap)||gap<0)return fail('same_session_overlap');
  if(gap>maxAgeMs)return fail('continuity_evidence_stale');
  const previousPrompt=integer(previous.finish.usage?.prompt_tokens),currentPrompt=integer(current.finish.usage?.prompt_tokens);
  const currentCached=integer(current.finish.usage?.cached_tokens);
  if(previousPrompt===null||currentPrompt===null||currentCached===null||currentCached>currentPrompt)return fail('usage_evidence_missing_or_invalid');
  const reference=Math.min(previousPrompt,currentPrompt);
  if(reference<MIN_REFERENCE_TOKENS)return fail('prompt_too_small_to_assess');
  if(currentPrompt<previousPrompt*MIN_PROMPT_RETENTION)return fail('prompt_shrank_or_compacted');
  const oldCandidate=candidate(previous.decision,previous.finish.node),newCandidate=candidate(current.decision,current.finish.node);
  if(!oldCandidate?.profile||!newCandidate?.profile)return fail('worker_profile_missing');
  if(oldCandidate.profile!==newCandidate.profile)return fail('worker_profile_changed');
  const oldMeta=metadata(previous.decision),newMeta=metadata(current.decision);
  const oldCompaction=oldMeta?.compaction_count??null,newCompaction=newMeta?.compaction_count??null;
  const oldTurn=oldMeta?.turn_index??null,newTurn=newMeta?.turn_index??null;
  if(oldCompaction!==null&&newCompaction!==null&&oldCompaction!==newCompaction)return fail('client_compaction_changed');
  if(oldTurn!==null&&newTurn!==null&&newTurn!==oldTurn+1)return fail('client_turn_not_consecutive');
  const epochGuard=oldCandidate.observation_epoch!==null&&newCandidate.observation_epoch!==null&&oldCandidate.observation_epoch===newCandidate.observation_epoch;
  if(oldCandidate.observation_epoch!==null&&newCandidate.observation_epoch!==null&&!epochGuard)return fail('observation_epoch_changed');
  const metadataGuard=oldTurn!==null&&newTurn!==null&&oldCompaction!==null&&newCompaction!==null;
  const ratio=Math.min(1,currentCached/reference),guard=epochGuard&&metadataGuard;
  const classification=ratio>=HIGH_REUSE_RATIO?'reuse_observed':ratio>=LOW_REUSE_RATIO?'partial_reuse':guard?'high_suspicion_low_reuse':'unconfirmed_low_reuse';
  return {classification,ratio,strong_guards:guard};
}

export function auditCacheContinuity(input,{maxAgeMs=DEFAULT_MAX_AGE_MS,maxEvents=MAX_EVENTS,maxRequests=MAX_REQUESTS}={}) {
  if(!Number.isSafeInteger(maxEvents)||maxEvents<1||maxEvents>MAX_EVENTS)throw new Error('Invalid cache-continuity event budget');
  if(!Array.isArray(input)||input.length>maxEvents)throw new Error('Cache-continuity audit event budget exceeded');
  if(!Number.isSafeInteger(maxAgeMs)||maxAgeMs<60000||maxAgeMs>7*24*60*60*1000)throw new Error('maxAgeMs must be one minute through seven days');
  if(!Number.isSafeInteger(maxRequests)||maxRequests<1||maxRequests>MAX_REQUESTS)throw new Error('Invalid cache-continuity request budget');
  const seen=new Map(),events=[];let duplicates=0,invalid_relevant_events=0;
  for(const raw of input){
    if(!RELEVANT.has(raw?.kind))continue;
    const valid=raw.schema===1&&ID.test(raw.run_id??'')&&ID.test(raw.event_id??'')&&ID.test(raw.request_id??'')&&at(raw.time)!==null;
    if(!valid){invalid_relevant_events++;continue;}
    const identity=`${raw.run_id}:${raw.event_id}`,serialized=JSON.stringify(raw);
    if(seen.has(identity)){if(seen.get(identity)!==serialized)throw new Error('Conflicting cache-continuity evidence ID');duplicates++;continue;}
    seen.set(identity,serialized);events.push(raw);
  }
  // Dropping a malformed decision/finish/relocation can erase a competing
  // request or move. Its clock/identity may be unusable, so even scoping the
  // damage to one session would be a guess. Do not certify any pair from it.
  if(invalid_relevant_events)throw new Error('Invalid cache-continuity evidence; consecutive requests cannot be established');
  events.sort((a,b)=>at(a.time)-at(b.time));
  const jobs=new Map();
  for(const event of events){
    const key=`${event.run_id}:${event.request_id}`;let job=jobs.get(key);
    if(!job){if(jobs.size>=maxRequests)throw new Error('Cache-continuity request budget exceeded');job={decisions:[],finishes:[],relocations:[]};jobs.set(key,job);}
    if(event.kind==='decision')job.decisions.push(event);else if(event.kind==='finish')job.finishes.push(event);else job.relocations.push(event);
  }
  const ordered=[];
  for(const job of jobs.values()){
    const decision=job.decisions[0],finish=job.finishes[0];
    if(!decision||!SESSION.test(decision.session??''))continue;
    ordered.push({decision,finish,decision_at:at(decision.time),finish_at:finish?at(finish.time):null,run_id:decision.run_id,session:decision.session,
      ambiguous:job.decisions.length!==1||job.finishes.length>1||job.relocations.length>1,relocated:job.relocations.length>0});
  }
  ordered.sort((a,b)=>a.decision_at-b.decision_at);
  const previousBySession=new Map(),reasons={},classifications={},workers=Object.create(null),ratios=[],strongRatios=[];
  let candidate_pairs=0,assessed_pairs=0,strong_guard_pairs=0;
  for(const current of ordered){
    const previous=previousBySession.get(current.session);previousBySession.set(current.session,current);
    if(!previous){tally(reasons,'no_prior_session_request');continue;}
    candidate_pairs++;
    if(previous.run_id!==current.run_id){tally(reasons,'gateway_run_changed');continue;}
    const result=jobGate(previous,current,maxAgeMs);
    if(result.reason){tally(reasons,result.reason);continue;}
    assessed_pairs++;tally(classifications,result.classification);ratios.push(result.ratio);
    if(result.strong_guards){strong_guard_pairs++;strongRatios.push(result.ratio);}
    const node=ID.test(current.finish.node??'')?current.finish.node:'unknown';
    const worker=workers[node]??={assessed_pairs:0,strong_guard_pairs:0,reuse_observed:0,partial_reuse:0,high_suspicion_low_reuse:0,unconfirmed_low_reuse:0,ratios:[]};
    worker.assessed_pairs++;if(result.strong_guards)worker.strong_guard_pairs++;worker[result.classification]++;worker.ratios.push(result.ratio);workers[node]=worker;
  }
  for(const worker of Object.values(workers)){worker.median_reuse_ratio=rounded(median(worker.ratios));delete worker.ratios;}
  return {schema:1,mode:'read_only_cache_continuity_audit',authority:'none',requests_with_session:ordered.length,candidate_pairs,assessed_pairs,strong_guard_pairs,
    classifications:Object.fromEntries(Object.entries(classifications).sort()),abstention_reasons:Object.fromEntries(Object.entries(reasons).sort()),
    median_reuse_ratio:rounded(median(ratios)),strong_guard_median_reuse_ratio:rounded(median(strongRatios)),workers,
    thresholds:{maximum_pair_age_ms:maxAgeMs,minimum_reference_tokens:MIN_REFERENCE_TOKENS,minimum_prompt_retention_ratio:MIN_PROMPT_RETENTION,high_reuse_ratio:HIGH_REUSE_RATIO,low_reuse_ratio:LOW_REUSE_RATIO},
    evidence_boundary:'Reuse is measured from returned token counts across consecutive same-session requests. High suspicion additionally requires same profile/observation epoch and consecutive unchanged-compaction client metadata. It is not prompt-prefix or engine-protocol proof.',
    privacy:'Aggregate counts, ratios, fixed reason codes and configured worker IDs only. No prompt text, vectors, session IDs, request IDs, event IDs, paths or credentials are returned.',
    limitations:['Missing early client metadata keeps low reuse unconfirmed.','A stable gateway observation epoch is not a backend-process identity.','Branching or prompt edits may look like cache loss without an exact rendered-prefix signal.','The audit observes completed DSG traffic only and never changes routing or cache state.'],
    source_quality:{relevant_events:events.length,duplicates,invalid_relevant_events}};
}

function args(argv) {
  let data=path.resolve('runtime/training'),maxAgeMs=DEFAULT_MAX_AGE_MS;
  for(let i=0;i<argv.length;i++){
    if(argv[i]==='--data'&&argv[i+1])data=path.resolve(argv[++i]);
    else if(argv[i]==='--max-age-hours'&&argv[i+1]){const hours=Number(argv[++i]);if(!Number.isFinite(hours)||hours<1||hours>168)throw new Error('--max-age-hours must be 1 through 168');maxAgeMs=hours*60*60*1000;}
    else if(argv[i]==='--help')return {help:true};
    else throw new Error(`Unknown or incomplete argument: ${argv[i]}`);
  }
  return {data,maxAgeMs};
}

if(isMain(import.meta.url))try{
  const input=args(process.argv.slice(2));
  if(input.help){console.log('Usage: node ds4-gateway/cache-continuity-audit.mjs [--data DIRECTORY] [--max-age-hours 1..168]');process.exit(0);}
  const {events,source}=readEvidence(input.data);
  console.log(JSON.stringify({...auditCacheContinuity(events,{maxAgeMs:input.maxAgeMs}),source},null,2));
}catch(error){console.error(`DSG cache-continuity audit: ${error.message}`);process.exitCode=1;}
