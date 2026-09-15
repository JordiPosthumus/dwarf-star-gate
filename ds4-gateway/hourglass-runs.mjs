import fs from 'node:fs';
import path from 'node:path';
import {randomUUID,randomBytes} from 'node:crypto';
import {HourglassConsole} from './hourglass-console.mjs';

const UUID=/^[a-f0-9-]{36}$/,JOB=/^[a-f0-9]{32}$/,DIGEST=/^[a-f0-9]{64}$/;
const active=r=>['submitting','uncertain','accepted','pending','running','unknown','owned'].includes(r.state);
const terminal=r=>['completed','stopped','error','cancelled'].includes(r.state);
const needsCheck=r=>['uncertain','submitting','unknown'].includes(r.state)||active(r)&&!!r.error;
const states=new Set(['submitting','uncertain','accepted','pending','running','unknown','owned','completed','stopped','error','cancelled','rejected','owner_checked']);
const scope='Owner-started Hourglass measurements. Hourglass owns execution, clock and results. Each review states its contention handling. No automatic starts, cancellation or changes to serving settings.';
export function hourglassRunsForChat(value){
  if(!value?.configured)return {configured:false};
  return {configured:true,requires_attention:!!value.error,runs:(Array.isArray(value.runs)?value.runs:[]).slice(0,20).map(r=>({
    id:UUID.test(r.id)?r.id:null,worker_id:/^\w[\w-]{0,63}$/.test(r.association?.worker_id??'')?r.association.worker_id:null,
    state:states.has(r.state)?r.state:'unknown',created_at:Number.isSafeInteger(r.created_at)?r.created_at:null,
    observed_at:Number.isSafeInteger(r.observed_at)?r.observed_at:null,requires_attention:!!r.error,has_saved_report:!!r.report,
    ...(r.owned?{window:'owned-maintenance',operation_phase:/^[a-z][a-z0-9_]{0,63}$/.test(r.progress?.phase??'')?r.progress.phase:null,
      process_alive:typeof r.process_alive==='boolean'?r.process_alive:null}:{} )})),
    scope:'Saved owner-started Hourglass receipts and dated observations. Use Evidence → Measure with Hourglass for explicit starts or checks. Chat has no benchmark-start tool. Missing observations do not mean stopped, and owner_checked is an owner statement, not reconstructed acceptance.'};
}

export class HourglassRuns {
  constructor(config,directory,{client,records=()=>({records:[]}),now=Date.now,maintenance=null}={}){
    if(!config||typeof config.url!=='string'||!Array.isArray(config.targets)||!config.targets.length||config.targets.length>50||Object.keys(config).some(k=>!['url','targets'].includes(k)))throw new Error('Configure an Hourglass console URL and explicit targets.');
    this.targets=config.targets.map(t=>{
      if(!t||typeof t.model!=='string'||!t.model.trim()||t.model.length>256||!/^\w[\w-]{0,63}$/.test(t.worker_id)||!['direct','gateway','testing-door'].includes(t.route)||Object.keys(t).some(k=>!['model','worker_id','route','maintenance'].includes(k))||t.maintenance&&(!maintenance||t.route!=='direct'))throw new Error('Invalid Hourglass target association.');
      return {...t};
    });
    if(new Set(this.targets.map(t=>t.model)).size!==this.targets.length)throw new Error('Hourglass target models must be unique.');
    this.client=client??new HourglassConsole(config.url);this.origin=new URL(config.url).origin;this.records=records;this.now=now;
    this.maintenance=maintenance;
    this.directory=directory;this.file=path.join(directory,'runs.json');this.runs=[];this.error=null;this.busy=false;this.prepared=null;this.closed=false;
    this.toolConfig={url:null,token:randomBytes(32).toString('hex'),models:this.targets.map(t=>t.model)};
    fs.mkdirSync(directory,{recursive:true,mode:0o700});
    let fd;try{
      fd=fs.openSync(this.file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
      const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.size>4194304)throw new Error();
      const saved=JSON.parse(fs.readFileSync(fd,'utf8'));
      if(saved.version!==1||!Array.isArray(saved.runs)||saved.runs.some(r=>!UUID.test(r.id)||!states.has(r.state)||!r.review||r.review.id!==r.id||typeof r.review.model!=='string'||typeof r.console_url!=='string'||r.job_id!==null&&!JOB.test(r.job_id)||!['submitting','uncertain','rejected','owner_checked'].includes(r.state)&&!(r.owned===true&&r.state==='owned')&&!JOB.test(r.job_id)))throw new Error();
      this.runs=saved.runs.map(r=>r.state==='submitting'?{...r,state:'uncertain',error:'Dashboard stopped before start acceptance was saved. Check Hourglass; this request will not be replayed.'}:r);
    }catch(e){if(e.code!=='ENOENT')this.error='Hourglass history could not be read. The existing file was preserved; new starts are disabled.';}
    finally{if(fd!==undefined)fs.closeSync(fd);}
  }
  save(runs){
    const data=JSON.stringify({version:1,runs});if(Buffer.byteLength(data)>4194304)throw new Error('Hourglass history is full; preserved history needs attention before another start.');
    const temp=this.file+'.'+randomUUID()+'.tmp';let fd;
    try{fd=fs.openSync(temp,'wx',0o600);fs.writeFileSync(fd,data);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;fs.renameSync(temp,this.file);fd=fs.openSync(this.directory,'r');fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;this.runs=runs;}
    finally{if(fd!==undefined)fs.closeSync(fd);if(fs.existsSync(temp))fs.unlinkSync(temp);}
  }
  status(){return structuredClone({configured:true,available:!this.error&&!this.closed,busy:this.busy,error:this.error,console_url:this.origin,targets:this.targets,
    prepared:this.prepared,runs:this.runs.slice(-20).reverse(),blocked:this.runs.some(active),scope:this.maintenance?'Owner-started measurements. Enrolled owned windows finish current work, measure, and conditionally return the server; other targets use owner-confirmed idle windows. No server settings change.':scope});}
  bind(port){this.toolConfig.url=`http://127.0.0.1:${port}/api/genie/hourglass-tools`;}
  toolStatus(){
    const s=this.status(),p=s.prepared;
    return {...hourglassRunsForChat(s),available:s.available,busy:s.busy,blocked:s.blocked,
      targets:s.targets,reports:this.reportSnapshot().reports,prepared:p?{id:p.id,model:p.model,worker_id:p.association.worker_id,
        route:p.association.route,benchmark_version:p.benchmark_version,metric:p.metric,
        question_count:p.question_count,window_seconds:p.window_seconds}:null,
      scope:'Preparation only. Review the exact measurement and its window handling in Evidence → Measure with Hourglass. The owner chooses Start. Preparation does not start, drain or reserve a server. This history covers only Star Gate-owned measurements: an empty list does not prove that no benchmark ran directly in Hourglass or that no score exists elsewhere. Saved observations are dated; unavailable does not mean stopped.'};
  }
  async tool(input){
    const keys={status:['action'],prepare:['action','model']}[input?.action];
    if(!keys||Object.keys(input).length!==keys.length||!keys.every(k=>Object.hasOwn(input,k)))throw new Error('Genie can only prepare a measurement or read its status.');
    if(input.action==='prepare'){
      if(this.prepared){
        if(this.prepared.model!==input.model)throw new Error('A different measurement is already under review. Resolve it in Evidence before replacing it.');
        return this.toolStatus();
      }
      await this.change(input);
    }else if(!this.busy&&!this.closed&&!this.error)await this.change({action:'refresh'});
    return this.toolStatus();
  }
  reportSnapshot(){return {configured:true,reports:this.runs.filter(r=>r.report).slice(-50).map(r=>({...r.report,association:r.association})),
    unavailable:this.error?[{reason:'measurement_history_unavailable'}]:this.runs.filter(r=>terminal(r)&&!r.report).map(()=>({reason:'run_report_unavailable'})),scope};}
  async change(input){
    if(this.error||this.closed)throw new Error(this.error??'Hourglass controls are closed.');
    if(this.busy)throw new Error('An Hourglass operation is already in progress.');
    const ownedStart=input?.action==='start'&&(this.prepared?.id===input.id&&this.prepared.maintenance||this.runs.some(r=>r.id===input.id&&r.owned));
    const keys={prepare:['action','model'],start:ownedStart?['action','id','plan_revision']:['action','id','owner_confirmed_idle'],refresh:['action'],resolve:['action','id','checked_in_hourglass']}[input?.action];
    if(!keys||Object.keys(input).length!==keys.length||!keys.every(k=>Object.hasOwn(input,k)))throw new Error('Invalid Hourglass action.');
    this.busy=true;
    try{
      if(input.action==='prepare'){
        this.prepared=null;
        if(this.runs.some(active))throw new Error('Finish or reconcile the current Hourglass run first.');
        const target=this.targets.find(t=>t.model===input.model);if(!target)throw new Error('Choose a configured Hourglass target.');
        const review=await this.client.prepare(target.model),record=this.records().records?.find(r=>r.worker_id===target.worker_id);
        const maintenance=target.maintenance?await this.maintenance.prepare(target,this.client.prepared):null;
        this.prepared={...review,association:{worker_id:target.worker_id,route:target.route,contention:'owner-confirmed-idle',
          approved_configuration_revision:DIGEST.test(record?.approved?.revision??'')?record.approved.revision:null,source:'operator-supplied association; not independently verified'}};
        if(maintenance)this.prepared={...this.prepared,maintenance,association:{...this.prepared.association,contention:'owned-maintenance',approved_configuration_revision:maintenance.record_revision,source:'Reviewed gateway mapping and observed native target; full settings equivalence is not implied.'}};
      }else if(input.action==='start'){
        if(this.runs.some(r=>r.id===input.id))return this.status();
        if(this.runs.some(active)||!this.prepared||input.id!==this.prepared.id||(ownedStart?input.plan_revision!==this.prepared.maintenance.plan_revision:input.owner_confirmed_idle!==true))throw new Error('Review the run and confirm its measurement window.');
        const p=this.prepared,row={id:p.id,review:p,association:p.association,console_url:this.origin,created_at:this.now(),state:'submitting',job_id:null,error:null,report:null};
        if(ownedStart)row.owned=true;
        this.save([...this.runs,row]);this.prepared=null;
        if(ownedStart){
          try{
            const receipt=await this.maintenance.start(p.id,p.maintenance.plan_revision);
            this.save(this.runs.map(r=>r.id===p.id?{...r,state:receipt?.state==='rejected_before_launch'?'rejected':'owned',
              error:receipt?.state==='rejected_before_launch'?'The reviewed operation could not be approved. No runner or benchmark was launched; prepare a fresh review.':null}:r));
          }
          catch{this.save(this.runs.map(r=>r.id===p.id?{...r,state:'uncertain',error:'Owned measurement start could not be confirmed. Observe this operation; it will not be started again.'}:r));}
          return this.status();
        }
        let receipt;
        try{receipt=await this.client.submit(p.id,{ownerConfirmedIdle:true});this.save(this.runs.map(r=>r.id===p.id?{...r,state:'accepted',job_id:receipt.job_id}:r));}
        catch(e){
          // An acknowledgement can arrive just before a disk failure. If its
          // receipt was not persisted, preserve uncertainty instead of retrying.
          const uncertain=e.name==='HourglassConsoleError'?e.uncertain:true;
          const next=this.runs.map(r=>r.id===p.id?{...r,job_id:receipt?.job_id??null,state:receipt?'accepted':uncertain?'uncertain':'rejected',error:receipt?null:uncertain?'Start acceptance is uncertain. Check Hourglass before another run.':'Hourglass rejected this start. Review its console before trying again.'}:r);
          try{this.save(next);}catch{this.error='Hourglass receipt could not be saved. New starts are disabled; check the native console.';}
        }
      }else if(input.action==='resolve'){
        const row=this.runs.find(r=>r.id===input.id);if(!row||row.owned||!needsCheck(row)||input.checked_in_hourglass!==true)throw new Error('Check the uncertain request in Hourglass first. Owned operations also require their maintenance outcome to be reconciled.');
        this.save(this.runs.map(r=>r.id===row.id?{...r,state:'owner_checked',resolved_at:this.now(),error:'Owner checked the native console and confirmed that no related work remains active. Acceptance was not reconstructed.'}:r));
      }else await this.refresh();
      return this.status();
    }finally{this.busy=false;}
  }
  async refresh(){
    for(const row of this.runs.filter(r=>r.owned&&active(r))){
      try{
        if(!this.maintenance||row.console_url!==this.origin)throw new Error('Owned measurement enrollment changed');
        const observed=await this.maintenance.observe(row.id),runner=observed.runner,result=observed.result;
        if(observed.job_id!==null&&!JOB.test(observed.job_id))throw new Error('Invalid native receipt');
        const next={...row,state:'owned',job_id:observed.job_id??row.job_id,observed_at:this.now(),
          progress:runner?.progress??null,process_alive:runner?.process_alive??null,error:null};
        if(result?.state==='completed'&&result.measurement?.readmission?.state==='readmitted'){
          const nativeState=result.measurement.native_state;
          if(!['completed','stopped','error','cancelled','rejected'].includes(nativeState))throw new Error('Unrecognized native outcome');
          next.state=nativeState;next.readmission=result.measurement.readmission;
        }else if(result||['requires_reconciliation','observation_unavailable'].includes(runner?.state)||!runner){
          next.error='The owned operation needs inspection. Its native receipt and maintenance state are preserved; no start or release was repeated.';
        }
        this.save(this.runs.map(r=>r.id===row.id?next:r));
      }catch{this.save(this.runs.map(r=>r.id===row.id?{...r,error:'Owned operation observation unavailable. Existing work and maintenance receipts are preserved.'}:r));}
    }
    for(const row of this.runs.filter(r=>r.job_id&&r.state!=='owner_checked'&&(!r.owned||terminal(r))&&(!terminal(r)||!r.report))){
      try{
        if(row.console_url!==this.origin)throw new Error('The configured Hourglass console changed.');
        const observed=await this.client.observe(row.job_id,row.review.model);
        const next={...row,...observed,observed_at:this.now(),error:null};
        if(terminal(next)&&!next.report){try{next.report=await this.client.report(row.job_id);}catch{next.error='The run is stopped, but its aggregate report could not be read. Refresh to try reading it again.';}}
        this.save(this.runs.map(r=>r.id===row.id?next:r));
      }catch{this.save(this.runs.map(r=>r.id===row.id?{...r,error:'Run observation is unavailable. The saved receipt remains; no run was restarted or cancelled.'}:r));}
    }
  }
  startObserving(){this.timer=setInterval(()=>{if(!this.busy&&!this.closed&&!this.error&&this.runs.some(r=>r.owned&&active(r)||r.job_id&&r.state!=='owner_checked'&&(!terminal(r)||!r.report)))void this.change({action:'refresh'}).catch(()=>{});},15000);this.timer.unref();}
  close(){this.closed=true;clearInterval(this.timer);this.maintenance?.close();}
}
