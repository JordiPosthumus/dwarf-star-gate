// Offline native provenance audit. A copied log is not recovery authority.
import fs from 'node:fs';
import {isMain} from './config.mjs';

const MAX_BYTES=2*1024*1024,MAX_ROWS=10000;
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
function timestamp(value){
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:?\d{2})$/.test(value))return null;
  const [year,month,day,hour,minute,second]=value.slice(0,19).split(/[-T :]/).map(Number);
  if(year<1970||month<1||month>12||day<1||day>new Date(Date.UTC(year,month,0)).getUTCDate()||hour>23||minute>59||second>59)return null;
  const ms=Date.parse(value.replace(' ','T'));
  return Number.isFinite(ms)?ms:null;
}
function scope(identity){
  if(!identity||typeof identity!=='object'||Array.isArray(identity)||Object.keys(identity).sort().join(',')!=='boot_uuid,label,pid,since,uid,until')throw new Error('Invalid private removal identity');
  const {label,uid,pid,boot_uuid,since,until}=identity,from=timestamp(since),to=timestamp(until);
  if(typeof label!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(label)||!Number.isSafeInteger(uid)||uid<1||uid>2147483647||
    !Number.isSafeInteger(pid)||pid<2||pid>2147483647||!uuid(boot_uuid)||from===null||to===null||from<0||to<from||to-from>4*3600000)throw new Error('Invalid private removal identity');
  return {subsystem:'gui/'+uid+'/'+label+' ['+pid+']',boot:boot_uuid.toLowerCase(),from,to};
}

// The observed native log stores the service/PID in subsystem, not message.
// Only use with independently verified private identity and native log capture.
export function removalPredicate(identity){
  const target=scope(identity).subsystem;
  return 'processID == 1 AND processImagePath == "/sbin/launchd" AND subsystem == "'+target+'"';
}

export function auditLaunchdRemoval(text,identity){
  const expected=scope(identity);
  if(typeof text!=='string'||Buffer.byteLength(text)>MAX_BYTES)throw new Error('Removal log exceeds audit bound');
  const lines=text.split('\n'),truncated=text.length>0&&!text.endsWith('\n');
  if(lines.at(-1)==='')lines.pop();
  if(lines.length>MAX_ROWS+1)throw new Error('Removal log exceeds row bound');
  const observations=[],callers=new Set();let malformed=0,records=0,summary=null,summaryInvalid=false,unverified=0,removed=false;
  for(let i=0;i<lines.length;i++){
    let row;try{row=JSON.parse(lines[i]);}catch{malformed++;continue;}
    if(row&&typeof row==='object'&&!Array.isArray(row)&&Object.hasOwn(row,'finished')){
      if(i!==lines.length-1||summary||Object.keys(row).sort().join(',')!=='count,finished'||row.finished!==1||!Number.isSafeInteger(row.count)||row.count<0)summaryInvalid=true;
      summary=row;continue;
    }
    records++;
    if(!row||typeof row!=='object'||Array.isArray(row)||row.eventType!=='logEvent'||timestamp(row.timestamp)===null){malformed++;continue;}
    if(row.subsystem!==expected.subsystem)continue;
    const at=timestamp(row.timestamp);
    if(row.processID!==1||row.processImagePath!=='/sbin/launchd'||row.senderImagePath!=='/sbin/launchd'||
      !uuid(row.bootUUID)||row.bootUUID.toLowerCase()!==expected.boot||at<expected.from||at>expected.to){unverified++;continue;}
    const message=typeof row.eventMessage==='string'?row.eventMessage:'';
    if(/[\r\n]/.test(message))continue;
    const match=/^removing job: caller = ([A-Za-z0-9_.-]{1,128})$/.exec(message);
    const stop=/^bootout initiated by: launchctl\[([1-9][0-9]{0,9})\](?:<-[^\r\n]{1,1024})?$/.exec(message);
    if(!match&&!(stop&&Number(stop[1])>=2&&Number(stop[1])<=2147483647))continue;
    const caller=match?(['loginwindow','launchctl','runningboardd'].includes(match[1])?match[1]:'other'):'launchctl';
    if(match)removed=true;
    callers.add(caller);observations.push({at:new Date(at).toISOString(),caller});
  }
  const complete=!truncated&&!malformed&&!summaryInvalid&&summary?.count===records;
  const exact=[...new Map(observations.map(row=>[JSON.stringify(row),row])).values()].sort((a,b)=>a.at.localeCompare(b.at));
  return {schema:1,mode:'offline_launchd_removal_audit',authority:'none',
    status:!complete?'source_incomplete':!exact.length?'no_exact_removal_record':callers.size>1?'conflicting_callers':removed?'exact_removal_observed':'exact_stop_request_observed',
    source:{complete,records,malformed,truncated,summary_valid:!!summary&&!summaryInvalid&&summary.count===records,unverified_identity_records:unverified},
    observations:complete?exact.slice(-16):[],observations_omitted:complete?Math.max(0,exact.length-16):0,
    native_stop_caller_observed:complete&&callers.has('launchctl'),
    note:'Exact archived event matching only. A stop request is not proof of completed removal. Caller identity does not explain intent or grant bootstrap/restart authority. Missing records do not prove no removal. No raw messages, labels, PIDs, boot IDs, paths or credentials are returned.'};
}

function readRegular(file,limit){
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
  try{
    const before=fs.fstatSync(fd);if(!before.isFile()||before.size>limit)throw new Error('Invalid bounded audit file');
    const bytes=Buffer.alloc(before.size);let offset=0;
    while(offset<bytes.length){const n=fs.readSync(fd,bytes,offset,bytes.length-offset,offset);if(!n)throw new Error('Audit source changed');offset+=n;}
    const after=fs.fstatSync(fd);
    if(before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)throw new Error('Audit source changed');
    return new TextDecoder('utf-8',{fatal:true}).decode(bytes);
  }finally{fs.closeSync(fd);}
}

export function auditRemovalFiles(logFile,identityFile){
  return auditLaunchdRemoval(readRegular(logFile,MAX_BYTES),JSON.parse(readRegular(identityFile,4096)));
}
if(isMain(import.meta.url)){
  try{
    const args=process.argv.slice(2);
    if(args.length!==4||args[0]!=='--log'||args[2]!=='--identity')throw new Error('Use --log and --identity');
    console.log(JSON.stringify(auditRemovalFiles(args[1],args[3]),null,2));
  }catch{
    // Filesystem/JSON errors can echo private paths or data.
    console.error('Removal audit could not verify bounded regular inputs and private identity; no action was taken.');
    process.exitCode=1;
  }
}
