// Read-only metadata audit. No raw text, vectors, session IDs or credentials in
// its report. Worker names/counts are still private operational information.
import fs from 'node:fs';
import path from 'node:path';
import {replay} from '../ds4-gateway/prediction-features.mjs';
import {isMain} from '../ds4-gateway/config.mjs';
import {EVIDENCE_KINDS} from '../ds4-gateway/dataset.mjs';
const kinds=new Set(EVIDENCE_KINDS);
const finite=x=>typeof x==='number'&&Number.isFinite(x);
const identifier=x=>typeof x==='string'&&/^[\w-]{1,64}$/.test(x);
const tally=(map,key)=>{map[key]=(map[key]??0)+1;};
const key=r=>r.run_id+':'+r.request_id;
export function readEvidence(directory,{maxBytes=128*1024**2}={}) {
  const events=[];let bytes=0,incompleteTails=0;
  const files=fs.readdirSync(directory).filter(f=>/^routing-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
  for(const file of files){const fd=fs.openSync(path.join(directory,file),fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
    try{const stat=fs.fstatSync(fd);if(!stat.isFile()||(bytes+=stat.size)>maxBytes)throw new Error('Evidence is nonregular or exceeds the audit byte budget; no silent truncation');
      const b=Buffer.alloc(stat.size);let at=0;while(at<b.length){const n=fs.readSync(fd,b,at,b.length-at,at);if(!n)throw new Error('Evidence shrank during read');at+=n;}
      const text=b.toString('utf8'),end=text.lastIndexOf('\n');if(end!==text.length-1)incompleteTails++;
      for(const line of text.slice(0,end<0?0:end).split('\n').filter(Boolean)){try{events.push(JSON.parse(line));}catch{throw new Error('Malformed complete evidence line; inspect privately');}}
    }finally{fs.closeSync(fd);}}
  return {events,source:{files:files.length,bytes,incomplete_tails:incompleteTails}};
}
export function auditEvidence(input,inventory=null,{maxEvents=200000,maxRequests=20000}={}) {
  if(input.length>maxEvents)throw new Error('Audit event budget exceeded');
  const seen=new Map(),rows=[];let duplicates=0,invalid=0;
  for(const r of input){
    if(r?.schema!==1||!identifier(r.run_id)||!identifier(r.request_id)||!identifier(r.event_id)||!kinds.has(r.kind)||!finite(Date.parse(r.time))||(!identifier(r.node)&&!(['rejection','waiting','queued_cancel','queue_timeout'].includes(r.kind)&&r.node===null))){invalid++;continue;}
    const id=r.run_id+':'+r.event_id,canonical=JSON.stringify(r);
    if(seen.has(id)){if(seen.get(id)!==canonical)throw new Error('Conflicting evidence ID');duplicates++;continue;}
    seen.set(id,canonical);rows.push(r);
  }
  rows.sort((a,b)=>Date.parse(a.time)-Date.parse(b.time));
  const jobs=new Map(),counts=Object.create(null),workers=Object.create(null),embeddingStatus=Object.create(null),featureStatus=Object.create(null),runs=new Set();
  for(const r of rows){tally(counts,r.kind);runs.add(r.run_id);if(['rejection','waiting'].includes(r.kind)||r.node===null)continue;const k=key(r);let job=jobs.get(k);
    if(!job){if(jobs.size>=maxRequests)throw new Error('Audit request budget exceeded');job={decision:[],dispatch:[],finish:[],terminal:[],features:[],embeddings:[],relocations:[]};jobs.set(k,job);}
    if(['decision','dispatch','finish'].includes(r.kind))job[r.kind].push(r);
    if(['queued_cancel','queue_timeout','unavailable_before_dispatch'].includes(r.kind))job.terminal.push(r);
    if(r.kind==='queue_relocation')job.relocations.push(r);
    if(r.kind==='request_features'){job.features.push(r);tally(featureStatus,['ready','unsupported_route','unsupported_body','no_recent_user_text','capture_limit','invalid_json','incomplete_body','encoded_body'].includes(r.status)?r.status:'other');}
    if(r.kind==='embedding'){job.embeddings.push(r);tally(embeddingStatus,r.status==='ready'?'ready':'not_ready');}
  }
  const totals={requests:jobs.size,decisions:0,finishes:0,missing_usage:0,complete_missing_usage:0,no_terminal_observed:0,orphan_events:0,ambiguous_joins:0,noncausal_joins:0,relocated_requests:0,known_relocated_joins:0,wrong_worker_joins:0,ready_feature_requests:0,ready_embedding_requests:0,embedding_before_finish:0,embedding_after_finish:0,ready_features_without_embedding:0,observer_requests:0,latest_embedding_truncated:0,recent_embedding_truncated:0,early_metadata_present:0};
  const missingOutcomes={},missingFeatureStatus={},missingFormats={},durationEvidence={};
  for(const j of jobs.values()){
    const d=j.decision[0],s=j.dispatch[0],f=j.finish[0],features=j.features.find(x=>x.status==='ready'),e=j.embeddings.find(x=>x.status==='ready');
    if(j.finish.length===1&&finite(f.service_ms)&&f.service_ms>0){
      const terminal=f.outcome!=='complete'?'failed_or_cancelled':f.finish_reason==='length'?'output_limited':
        ['stop','tool_calls','function_call'].includes(f.finish_reason)?'normal_terminal':'unverified_terminal';
      const band=f.service_ms>=3600000?'1h_plus':f.service_ms>=300000?'5m_to_1h':'under_5m';
      const group=durationEvidence[terminal]??={};const sample=group[band]??={requests:0,service_seconds:0,max_service_seconds:0};
      sample.requests++;sample.service_seconds+=f.service_ms/1000;sample.max_service_seconds=Math.max(sample.max_service_seconds,f.service_ms/1000);
    }
    if(!d)totals.orphan_events++;else {totals.decisions++;if(d.traffic_class==='genie')totals.observer_requests++;if(d.client_metadata?.status==='ready')totals.early_metadata_present++;}
    if(j.decision.length>1||j.dispatch.length>1||j.finish.length>1||j.terminal.length>1||j.relocations.length>1||j.finish.length&&j.terminal.length)totals.ambiguous_joins++;
    const joined=[...j.dispatch,...j.finish,...j.features,...j.embeddings],moved=d&&joined.some(r=>r.node!==d.node);
    if(j.relocations.length)totals.relocated_requests++;
    if(moved){
      const move=j.relocations.length===1?j.relocations[0]:null,destination=move?.destination;
      const known=move&&move.relocation_schema===1&&move.source===d.node&&move.node===destination&&move.dispatch_state==='not_dispatched'&&move.body_replayed===false&&move.deadline_preserved===true&&move.cache_locality==='unknown'&&
        ['operator','scheduler','genie'].includes(move.actor)&&identifier(destination)&&joined.every(r=>r.node===destination)&&s&&s.node===destination&&Date.parse(d.time)<=Date.parse(move.time)&&Date.parse(move.time)<=Date.parse(s.time);
      if(known)totals.known_relocated_joins++;else totals.wrong_worker_joins++;
    }
    if(d&&s&&Date.parse(s.time)<Date.parse(d.time)||s&&f&&Date.parse(f.time)<Date.parse(s.time))totals.noncausal_joins++;
    if(d&&!f&&!j.terminal.length)totals.no_terminal_observed++;
    if(features)totals.ready_feature_requests++;
    if(e){totals.ready_embedding_requests++;if(f){if(e.available_at<=Date.parse(f.time)&&Date.parse(e.time)<=Date.parse(f.time))totals.embedding_before_finish++;else totals.embedding_after_finish++;}
      if(e.vectors?.latest_user?.truncated===true)totals.latest_embedding_truncated++;if(e.vectors?.recent_conversation?.truncated===true)totals.recent_embedding_truncated++;}
    if(features&&!e)totals.ready_features_without_embedding++;
    if(!f)continue;
    totals.finishes++;const w=workers[f.node]??={finishes:0,missing_usage:0,complete:0,complete_missing_usage:0,failed_or_cancelled:0,with_ready_embedding:0};w.finishes++;if(e)w.with_ready_embedding++;
    const complete=f.outcome==='complete';if(complete)w.complete++;else w.failed_or_cancelled++;
    if(!finite(f.usage?.prompt_tokens)||!finite(f.usage?.completion_tokens)){
      totals.missing_usage++;w.missing_usage++;if(complete){totals.complete_missing_usage++;w.complete_missing_usage++;}
      tally(missingOutcomes,['complete','client_cancelled','upstream_http_error','upstream_engine_error','incomplete_sse','timeout'].includes(f.outcome)?f.outcome:'other');
      tally(missingFormats,['sse','json','other','no_response'].includes(f.response_format)?f.response_format:'historical_unknown');
      const status=j.features[0]?.status;tally(missingFeatureStatus,status===undefined?'no_feature_record':['ready','unsupported_route','capture_limit','no_recent_user_text'].includes(status)?status:'other');
    }
  }
  let training=null;
  if(inventory){const prepared=replay(rows,inventory);training={rows:prepared.rows.length,stages:{}};
    for(const r of prepared.rows){const s=training.stages[r.stage]??={rows:0,requests:new Set(),workers:new Set(),zero_history:0,prior_service:0,prior_thinking_fraction:0,embedding_present:0,user_similarity:0,recent_similarity:0};s.rows++;s.requests.add(r.run_id+':'+r.request_id);s.workers.add(r.node);
      const f=r.features;if(f.history_count===0)s.zero_history++;if(finite(f.prior_service_s))s.prior_service++;if(finite(f.prior_thinking_fraction))s.prior_thinking_fraction++;
      if(f.embedding_present===1)s.embedding_present++;if(finite(f.similarity_previous_user))s.user_similarity++;if(finite(f.similarity_previous_conversation))s.recent_similarity++;}
    for(const s of Object.values(training.stages)){s.requests=s.requests.size;s.workers=s.workers.size;}
  }
  return {schema:1,events:rows.length,runs:runs.size,duplicates,invalid,counts,totals,workers,feature_status:featureStatus,embedding_status:embeddingStatus,missing_usage_outcomes:missingOutcomes,missing_usage_feature_status:missingFeatureStatus,missing_usage_response_format:missingFormats,duration_evidence:durationEvidence,training,
    limitations:['Unresolved requests may be in flight or interrupted; missing terminal records are not invented failures.','Historical response format/usage-request flags were not recorded; missing usage cannot be attributed conclusively to a protocol.','Repeated progress rows are not independent requests. Training weights them per request.','Embedding truncation is bounded encoder input, never truncation of the DS4 request.','Worker names and counts are private operational data; do not publish this report.']};
}
if(isMain(import.meta.url))try{
  const args=process.argv.slice(2),get=k=>{const i=args.indexOf(k);if(i<0)return null;const v=args[i+1];if(!v||v.startsWith('--'))throw new Error('Missing '+k);args.splice(i,2);return v;};
  const data=get('--data'),profiles=get('--profiles');if(!data||args.length)throw new Error('Use --data DIRECTORY [--profiles FILE]');
  const {events,source}=readEvidence(data);const inventory=profiles?JSON.parse(fs.readFileSync(profiles,'utf8')):null;
  if(inventory&&(inventory.schema!==1||!inventory.workers))throw new Error('Versioned worker inventory required');
  console.log(JSON.stringify({...auditEvidence(events,inventory),source},null,2));
}catch(error){console.error(error.message);process.exitCode=1;}
