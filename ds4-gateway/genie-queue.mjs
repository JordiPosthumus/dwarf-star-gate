// Chat uses the same current offers and core executor as routine fleet reviews.
import {createToolEndpoint} from './genie-tool-endpoint.mjs';
const fields=['request_id','source','destination','evidence_id'];
export function queueEvidence(status){
  if(status?.version!==1||!Array.isArray(status.workers)||!status.continuity?.relocation)throw new Error('Current gateway queue status is unavailable.');
  return {observed_at:new Date().toISOString(),enabled:status.continuity.relocation.genie_enabled===true,
    workers:status.workers.map(w=>({id:w.id,is_healthy:w.is_healthy,drained:w.drained,load:w.load,queued:w.queued,max_concurrent_requests:w.max_concurrent_requests})),
    offers:status.continuity.relocation.genie_offers??[],diagnostics:status.continuity.relocation.diagnostics??null,last_move:status.continuity.relocation.last??null,
    scope:'Fresh queue placement and current offers; no prompt contents. Only waiting jobs may move. Active jobs, original sockets and deadlines are preserved. Cache locality after a move is unknown.'};
}
export function createQueueTools({read,move,isTesting=()=>false,isEnabled=()=>true}){
  async function tool(input){
    if(isTesting())throw new Error('Queue balancing is suspended for testing.');
    if(input?.action==='status'&&Object.keys(input).length===1)return queueEvidence(await read());
    if(input?.action!=='move'||Object.keys(input).sort().join(',')!=='action,destination,evidence_id,request_id,source'||fields.some(k=>typeof input[k]!=='string'))throw new Error('Use one exact current queue offer.');
    if(!isEnabled())throw new Error('Queue balancing is switched off.');
    // The core revalidates eligibility and the switch atomically when it acts.
    const exact=Object.fromEntries(fields.map(k=>[k,input[k]]));
    const receipt=await move(exact);
    if(!receipt||!['request_id','source','destination'].every(k=>receipt[k]===exact[k])||receipt.actor!=='genie')throw new Error('Move outcome could not be confirmed. Read queue status; do not repeat this offer.');
    return {state:'relocated',receipt};
  }
  return createToolEndpoint('/api/genie/queue-tools','x-sg-queue-tool',tool);
}
