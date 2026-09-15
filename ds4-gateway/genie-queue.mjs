// Chat uses the same current offers and core executor as routine fleet reviews.
import {randomBytes,timingSafeEqual} from 'node:crypto';
const fields=['request_id','source','destination','evidence_id'];
export function queueEvidence(status){
  if(status?.version!==1||!Array.isArray(status.workers)||!status.continuity?.relocation)throw new Error('Current gateway queue status is unavailable.');
  return {observed_at:new Date().toISOString(),enabled:status.continuity.relocation.genie_enabled===true,
    workers:status.workers.map(w=>({id:w.id,is_healthy:w.is_healthy,drained:w.drained,load:w.load,queued:w.queued,max_concurrent_requests:w.max_concurrent_requests})),
    offers:status.continuity.relocation.genie_offers??[],diagnostics:status.continuity.relocation.diagnostics??null,last_move:status.continuity.relocation.last??null,
    scope:'Fresh queue placement and current offers; no prompt contents. Only waiting jobs may move. Active jobs, original sockets and deadlines are preserved. Cache locality after a move is unknown.'};
}
export function createQueueTools({read,move,isTesting=()=>false,isEnabled=()=>true}){
  const toolConfig={url:null,token:randomBytes(32).toString('hex')};
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
  function handle(req,res){
    if(req.url!=='/api/genie/queue-tools')return false;
    const reply=(code,value)=>{res.writeHead(code,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));};
    const token=Buffer.from(req.headers['x-sg-queue-tool']??''),expected=Buffer.from(toolConfig.token);
    if(req.method!=='POST'||token.length!==expected.length||!timingSafeEqual(token,expected)){reply(403,{error:'Authorized queue tool session required.'});return true;}
    if(req.headers['content-type']!=='application/json'){reply(415,{error:'JSON required.'});return true;}
    let body='',ended=false;req.setEncoding('utf8');const timer=setTimeout(()=>{ended=true;reply(408,{error:'Incomplete queue request.'});},5000);
    req.on('error',()=>{ended=true;clearTimeout(timer);});req.on('aborted',()=>{ended=true;clearTimeout(timer);});
    req.on('data',chunk=>{if(ended)return;body+=chunk;if(Buffer.byteLength(body)>2048){ended=true;clearTimeout(timer);reply(413,{error:'Queue request too large.'});}});
    req.on('end',()=>{clearTimeout(timer);if(ended)return;ended=true;let input;try{input=JSON.parse(body);}catch{reply(400,{error:'Invalid JSON.'});return;}
      void tool(input).then(v=>reply(200,v)).catch(e=>reply(409,{error:e.message}));});return true;
  }
  return {toolConfig,tool,handle,bind(port){toolConfig.url=`http://127.0.0.1:${port}/api/genie/queue-tools`;}};
}
