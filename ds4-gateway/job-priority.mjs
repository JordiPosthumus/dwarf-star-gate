// Explicit caller metadata only. Never infer urgency from request content.
import {timingSafeEqual} from 'node:crypto';
export const PRIORITY_HEADER='x-dsg-priority';
export const GENIE_KEY_HEADER='x-stargate-genie-key';
// Identification only: does not change API authorization or grant management powers.
export function isGenieRequest(config, headers){
  const key=config.genie_priority_key,value=headers[GENIE_KEY_HEADER];
  if(typeof key!=='string'||!key||typeof value!=='string')return false;
  const expected=Buffer.from(key),actual=Buffer.from(value);
  return expected.length===actual.length&&timingSafeEqual(expected,actual);
}
const ranks=Object.freeze({'idle-only':0,normal:1,high:2});
export const priorityRank=job=>job?.geniePriority===true?3:ranks[job?.priority??'normal'];
export function requestPriority(value){
  if(value===undefined)return 'normal';
  if(typeof value!=='string'||!Object.hasOwn(ranks,value))throw new Error('Priority must be high, normal or idle-only.');
  return value;
}
// Only the earliest waiting request in each conversation is eligible. Priority
// cannot reverse dependent turns. Unaffined jobs are independent of one another.
export function priorityIndex(queue){
  const seen=new Set();let best=-1;
  for(let i=0;i<queue.length;i++){
    const job=queue[i];if(job.cancelled)continue;
    if(job.key&&seen.has(job.key))continue;if(job.key)seen.add(job.key);
    if(best<0||priorityRank(job)>priorityRank(queue[best]))best=i;
  }
  return best;
}
export function priorityOrder(queue){
  const pending=queue.filter(job=>!job.cancelled),ordered=[];
  while(pending.length)ordered.push(pending.splice(priorityIndex(pending),1)[0]);
  return ordered;
}
