// Only retain a short preview on the live request, for at most ten minutes.
// No model review, persistence, or scheduling authority is involved.
export function clearJobPreview(job){
  clearTimeout(job.previewTimer);job.previewTimer=null;job.preview=null;
}
export function observeJobPreview(job,excerpt){
  clearJobPreview(job);
  if(typeof excerpt!=='string'||!excerpt.trim())return;
  const chars=[...excerpt.replace(/\s+/gu,' ').trim()];
  job.preview={text:chars.slice(0,160).join('')+(chars.length>160?'…':''),previous_observation:false};
  job.previewTimer=setTimeout(()=>clearJobPreview(job),600000);job.previewTimer.unref();
}
