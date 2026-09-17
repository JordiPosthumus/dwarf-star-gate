import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {hourglassReportSummary} from './hourglass-report.mjs';

const worker=v=>typeof v==='string'&&/^[a-zA-Z0-9][\w-]{0,63}$/.test(v)?v:null;
const digest=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v)?v:null;
const pick=(v,allowed)=>allowed.includes(v)?v:'unknown';
const trialSource='Recorded serving trial job and native candidate identity; original restored afterward.';
const trialAssociation=v=>v?.source===trialSource&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v.trial?.operation_id??'')&&/^[a-f0-9]{32}$/.test(v.trial?.job_id??'')&&digest(v.trial?.candidate_signature_sha256)
  ?{trial:{operation_id:v.trial.operation_id,job_id:v.trial.job_id,candidate_signature_sha256:v.trial.candidate_signature_sha256}}:{};
const association=v=>({worker_id:worker(v?.worker_id),approved_configuration_revision:digest(v?.approved_configuration_revision),
  route:pick(v?.route,['direct','gateway','testing-door']),contention:pick(v?.contention,['owner-confirmed-idle','observed-contention','owned-maintenance']),
  ...trialAssociation(v),
  source:v?.source==='Reviewed gateway mapping and observed native target; full settings equivalence is not implied.'||trialAssociation(v).trial?v.source:'operator-supplied association; not independently verified'});
const scope='Saved Hourglass reports only. No benchmark is started. Imported worker/configuration/route/contention associations are operator supplied, not inferred or verified. Owned-run associations retain their recorded mapping and maintenance-window scope; this does not prove complete settings equivalence or exclude new direct traffic. Preserve each recorded metric and protocol; do not infer current performance or an upgrade.';

export class HourglassReports {
  constructor(entries=[]){
    if(!Array.isArray(entries)||entries.length>50)throw new Error('hourglass_reports must be an array of at most 50 explicit report files');
    this.entries=entries.map(e=>{
      if(!e||typeof e.file!=='string'||!e.file.trim()||Object.keys(e).some(k=>!['file','worker_id','approved_configuration_revision','route','contention'].includes(k))||
        (e.worker_id!==undefined&&!worker(e.worker_id))||(e.approved_configuration_revision!==undefined&&!digest(e.approved_configuration_revision))||
        (e.route!==undefined&&!['direct','gateway','testing-door','unknown'].includes(e.route))||
        (e.contention!==undefined&&!['owner-confirmed-idle','observed-contention','unknown'].includes(e.contention)))throw new Error('Invalid Hourglass report reference');
      return {file:path.resolve(e.file),association:association(e)};
    });
    this.cache=new Map();
  }
  snapshot(){
    const reports=[],unavailable=[];
    for(const [index,entry] of this.entries.entries()){
      let fd;
      try{
        fd=fs.openSync(entry.file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
        const signature=s=>[s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].join(':');
        const stat=fs.fstatSync(fd,{bigint:true});
        if(!stat.isFile()||stat.size>1048576n)throw new Error();
        const key=signature(stat),prior=this.cache.get(index);
        let saved=prior;
        if(prior?.key!==key){
          const bytes=Buffer.alloc(Number(stat.size));let offset=0;
          while(offset<bytes.length){const n=fs.readSync(fd,bytes,offset,bytes.length-offset,offset);if(n<=0)throw new Error();offset+=n;}
          if(signature(fs.fstatSync(fd,{bigint:true}))!==key)throw new Error();
          saved={key,revision:createHash('sha256').update(bytes).digest('hex'),summary:hourglassReportSummary(JSON.parse(bytes))};
          this.cache.set(index,saved);
        }
        reports.push({report_revision:saved.revision,association:{...entry.association},summary:structuredClone(saved.summary)});
      }catch{this.cache.delete(index);unavailable.push({report_index:index+1,reason:'report_unavailable'});}
      finally{if(fd!==undefined)fs.closeSync(fd);}
    }
    return {configured:this.entries.length>0,reports,unavailable,scope};
  }
}

export function hourglassForChat(value){
  if(!value?.configured)return {configured:false,reports:[]};
  const reports=[];
  for(const row of Array.isArray(value.reports)?value.reports.slice(0,50):[]){
    const s=row?.summary;if(s?.source!=='hourglass_aggregate_report')continue;
    try{
      // Reapply the native allowlist to alternate snapshot suppliers as well.
      const summary=hourglassReportSummary({...s,format:'hourglass-public-report-v1',created_at:s.report_created_at,
        score_version:s.score?.version,hourglass_score:s.score?.value,scoring:s.scoring_policy,repair:s.repaired===true});
      reports.push({report_revision:digest(row.report_revision),association:association(row.association),summary});
    }catch{/* Invalid report is unavailable evidence, never an invented zero. */}
  }
  return {configured:true,reports,unavailable_count:Array.isArray(value.unavailable)?value.unavailable.length:0,scope};
}
