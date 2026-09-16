// Read-only projection of Hourglass's aggregate report, not its private run data.
// Preserve recorded metric versions; never calculate or convert a benchmark score.
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const text=value=>typeof value==='string'&&value.trim()?value.slice(0,256):null;
const finite=value=>typeof value==='number'&&Number.isFinite(value)?value:null;
const nonnegative=value=>finite(value)!==null&&value>=0?value:null;
const count=value=>Number.isSafeInteger(value)&&value>=0?value:null;
const date=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T/.test(value)&&Number.isFinite(Date.parse(value))?value:null;
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)?value:null;

export function hourglassReportSummary(report){
  if(!object(report)||report.format!=='hourglass-public-report-v1'||!text(report.model))throw new Error('Invalid Hourglass aggregate report');
  const version=text(report.score_version),value=finite(report.hourglass_score);
  const unit=version==='total-points-v1'?'points':version==='linear-auc-100-v1'?'legacy AUC score':null;
  const state=['final','partial','unavailable'].includes(report.state)&&!(report.state==='final'&&report.is_current_run===true)?report.state:'unknown';
  return {
    source:'hourglass_aggregate_report',model:text(report.model),run_key:text(report.run_key),run_date:date(report.run_date),
    report_created_at:date(report.created_at),state,is_current_run:typeof report.is_current_run==='boolean'?report.is_current_run:null,
    score:{value,version,unit,recognized:unit!==null,final:state==='final'&&value!==null},
    benchmark_version:text(report.benchmark_version),scoring_policy:text(report.scoring),timing_policy:text(report.timing_policy),
    bank_fingerprint:digest(report.bank_fingerprint),configuration_key:digest(report.configuration_key),machine_key:digest(report.machine_key),
    active_seconds:nonnegative(report.active_seconds),window_seconds:nonnegative(report.window_seconds),
    raw_correct:count(report.raw_correct),completed_questions:count(report.completed_questions),total_questions:count(report.total_questions),
    timeouts:count(report.timeouts),incorrect_questions:count(report.incorrect_questions),abstained_questions:count(report.abstained_questions),
    unsupported_vision_questions:count(report.unsupported_vision_questions),
    efficiency:{accuracy:finite(report.efficiency?.accuracy),scored_answers:count(report.efficiency?.scored_answers),
      median_output_tokens:nonnegative(report.efficiency?.median_output_tokens),answers_per_active_minute:nonnegative(report.efficiency?.answers_per_active_minute)},
    clock_adjustment_seconds:finite(report.clock_adjustment_seconds),
    question_timeout_policy:text(report.question_timeout_policy),
    execution:{question_timeout_s:nonnegative(report.execution?.question_timeout_s),
      stop_after_wrong:nonnegative(report.execution?.stop_after_wrong),repeat:nonnegative(report.execution?.repeat),round_policy:text(report.execution?.round_policy)},
    hardware:{label:text(report.hardware?.label),source:text(report.hardware?.source)},
    // Retain structured caveat labels/counts, never free-form notes or traces.
    caveats:Array.isArray(report.caveats)?report.caveats.slice(0,20).filter(object).map(c=>({label:text(c.label),attempts:nonnegative(c.attempts)})):[],
    repaired:Boolean(report.repair),
    scope:'Dated, source-reported benchmark evidence. Metric versions and recorded protocols may differ. No score conversion, forecast or automatic comparison. Hourglass configuration and machine keys are not Star Gate approval or worker identities; route and contention are not established by this report.',
  };
}
