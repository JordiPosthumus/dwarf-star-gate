// One local lifecycle: immutable candidates, bounded trainer, future shadow gate,
// reversible activation. Neither the trainer nor the Genie can edit these gates.
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {PredictionHistory} from './prediction-features.mjs';
import {validateCandidate,predictTreeModel,supported,reference} from './xgb-runtime.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const hash=b=>createHash('sha256').update(b).digest('hex');
const finite=x=>typeof x==='number'&&Number.isFinite(x)&&x>=0;
const id=x=>typeof x==='string'&&/^[a-zA-Z0-9][\w-]{0,95}$/.test(x);
export const PREDICTION_POLICY={version:1,min_future_requests:30,min_future_sessions:5,required_mae_gain:.10,max_mean_bias:.30,rollback_ratio:1.25,rollback_window:20,training_interval_ms:6*3600000,min_new_requests:50,training_timeout_ms:120000};
export function score(rows) {
  if(!rows.length)return {requests:0,sessions:0,mae_s:null,baseline_mae_s:null,mean_ratio:null};
  const mean=k=>rows.reduce((s,r)=>s+r[k],0)/rows.length;
  return {requests:rows.length,sessions:new Set(rows.map(r=>r.session)).size,mae_s:mean('error'),baseline_mae_s:mean('baseline_error'),mean_ratio:mean('prediction')/Math.max(.001,mean('actual')),
    long_requests:rows.filter(r=>r.long).length,long_mae_s:rows.some(r=>r.long)?rows.filter(r=>r.long).reduce((s,r)=>s+r.error,0)/rows.filter(r=>r.long).length:null};
}
export function promotionEligible(model,rows) {
  const s=score(rows),p=PREDICTION_POLICY;
  if(!model.holdout_passed||s.requests<p.min_future_requests||s.sessions<p.min_future_sessions||s.mae_s>s.baseline_mae_s*(1-p.required_mae_gain)||Math.abs(s.mean_ratio-1)>p.max_mean_bias)return false;
  // Require observed coverage per worker before its forecast is considered
  // calibrated. A paused/removed worker need not generate artificial traffic.
  for(const node of new Set(rows.map(r=>r.node))){const r=rows.filter(x=>x.node===node),m=score(r);if(r.length<5||m.mae_s>m.baseline_mae_s*1.1)return false;}
  if((model.holdout?.long_requests??0)>0&&s.long_requests<3)return false;
  return true;
}
export class Predictor {
  constructor(config,{directory,dataDirectory,record,now=Date.now,spawnImpl=spawn}={}) {
    Object.assign(this,{config,directory,dataDirectory,record,now,spawnImpl});this.configured=config?.enabled===true;this.error=null;this.busy=false;this.child=null;this.closed=false;this.pending=new Map();this.live=new Map();this.bundles=new Map();this.shadow=null;this.inventory={};this.history=new PredictionHistory();
    this.state={schema:1,automatic_training:config?.automatic_training===true,automatic_promotion:config?.automatic_promotion===true,placement:config?.placement===true,active:{},previous:{},rejected:{},evaluations:{},new_requests:0,last_train_at:0,receipts:[]};
    const initialState=structuredClone(this.state);
    if(!this.configured)return;
    try{
      if(!path.isAbsolute(config.python||'')||!path.isAbsolute(config.profiles||''))throw new Error('Absolute private predictor python/profiles paths required');
      fs.accessSync(config.python,fs.constants.X_OK);this.inventory=JSON.parse(fs.readFileSync(config.profiles));if(this.inventory.schema!==1||!this.inventory.workers)throw new Error('Versioned predictor inventory required');
      this.history=new PredictionHistory(this.inventory);fs.mkdirSync(path.join(directory,'candidates'),{recursive:true,mode:0o700});
      const file=path.join(directory,'state.json');if(fs.existsSync(file)){if(!fs.lstatSync(file).isFile()||fs.statSync(file).size>8*1024**2)throw new Error('Invalid state file');const saved=JSON.parse(fs.readFileSync(file));if(saved.schema!==1||!Array.isArray(saved.receipts)||['active','previous','evaluations'].some(k=>!saved[k]||typeof saved[k]!=='object'||Array.isArray(saved[k]))||Object.values(saved.evaluations).some(v=>!Array.isArray(v))||['automatic_training','automatic_promotion','placement'].some(k=>typeof saved[k]!=='boolean'))throw new Error('Unsupported predictor state');this.state={...this.state,...saved};}
      if(this.state.training){this.state.training=null;this.receipt('system','train','interrupted','Previous gateway exited before training completed');}
      this.restoreHistory();this.loadCandidates();
    }catch{this.state=initialState;this.error='Predictor configuration/state unavailable; deterministic routing is unchanged';this.configured=false;}
  }
  persist(){const file=path.join(this.directory,'state.json'),tmp=file+'.'+randomUUID();const fd=fs.openSync(tmp,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(this.state)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(tmp,file);}
  receipt(actor,action,status,reason,extra={}) {
    const row={id:randomUUID(),time:this.now(),actor,action,status,reason,...extra};this.state.receipts.unshift(row);this.state.receipts=this.state.receipts.slice(0,30);
    fs.appendFileSync(path.join(this.directory,'actions.jsonl'),JSON.stringify(row)+'\n',{mode:0o600});this.persist();return row;
  }
  restoreHistory() {
    if(!fs.existsSync(this.dataDirectory))return;
    const events=[];for(const file of fs.readdirSync(this.dataDirectory).filter(f=>/^routing-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort().slice(-2)){
      const full=path.join(this.dataDirectory,file);if(!fs.lstatSync(full).isFile())continue;const fd=fs.openSync(full,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const size=fs.fstatSync(fd).size,start=Math.max(0,size-8*1024**2),b=Buffer.alloc(size-start);fs.readSync(fd,b,0,b.length,start);const text=b.toString('utf8'),lines=text.split('\n');if(start){lines.shift();this.partialHistory=true;}lines.pop();for(const line of lines)try{const row=JSON.parse(line);if(row.schema===1)events.push(row);}catch{this.partialHistory=true;}}finally{fs.closeSync(fd);}}
    for(const row of events.sort((a,b)=>Date.parse(a.time)-Date.parse(b.time)))this.history.observe(row);
  }
  loadCandidates() {
    const directory=path.join(this.directory,'candidates');
    const names=[...new Set([...fs.readdirSync(directory).filter(id).sort().slice(-32),...Object.values(this.state.active),...Object.values(this.state.previous).filter(id)])];
    this.bundles.clear();this.candidateRejections=0;
    for(const name of names.filter(id)){try{
      const file=path.join(directory,name,'candidate.json'),reportFile=path.join(directory,name,'report.json');if(!fs.existsSync(file)||!fs.existsSync(reportFile))continue;
      if(!fs.lstatSync(file).isFile()||fs.statSync(file).size>8*1024**2)throw new Error('Invalid candidate file');const bytes=fs.readFileSync(file),report=JSON.parse(fs.readFileSync(reportFile));if(hash(bytes)!==report.candidate_sha256)throw new Error('Candidate checksum mismatch');
      const bundle=validateCandidate(JSON.parse(bytes));if(bundle.snapshot.feature_builder_sha256!==hash(fs.readFileSync(path.join(root,'ds4-gateway/prediction-features.mjs'))))throw new Error('Feature builder changed; retrain before use');
      this.bundles.set(name,{...bundle,directory_id:name});
    }catch{this.candidateRejections++;}}
    this.shadow=[...this.bundles.values()].filter(b=>Object.keys(b.models).length).sort((a,b)=>Date.parse(b.created_at)-Date.parse(a.created_at))[0]??null;
    for(const [kind,name] of Object.entries(this.state.active))if(!this.bundles.get(name)?.models[kind]){delete this.state.active[kind];this.error='An active model is unavailable; deterministic fallback remains in use';}
  }
  model(kind,{active=false}={}) {
    const deployed=this.bundles.get(this.state.active[kind]);return active?deployed?.models[kind]:this.shadow?.models[kind]??deployed?.models[kind];
  }
  trainingOffer() {
    if(!this.configured||this.busy||this.closed||this.history.completed<50)return null;
    if(this.now()-this.state.last_train_at<600000)return null;
    if(this.shadow&&this.state.new_requests<PREDICTION_POLICY.min_new_requests)return null;
    // Give an offline-qualified shadow candidate time to collect its release
    // evidence instead of replacing it on every busy burst. Manual training
    // remains explicit; automatic/Genie retraining waits at most six hours.
    if(this.shadow&&this.now()-Date.parse(this.shadow.created_at)<PREDICTION_POLICY.training_interval_ms&&Object.values(this.shadow.models).some(m=>m.holdout_passed&&((this.state.evaluations[m.id]?.length??0)<30||score(this.state.evaluations[m.id]??[]).sessions<5)))return null;
    return hash(`${this.state.last_train_at}:${this.state.new_requests}:${this.shadow?.created_at??'first'}`).slice(0,24);
  }
  baseline(point) {
    return ['worker_service_median','hardware_service_median','fleet_service_median'].some(k=>finite(point.features[k]))?reference(point.features):null;
  }
  activeSupported(model,point){
    const rows=(this.state.evaluations[model.id]??[]).filter(r=>r.node===point.node&&r.profile===point.profile),s=score(rows);
    return supported(model,point)&&rows.length>=5&&s.mae_s<=s.baseline_mae_s*1.1;
  }
  rollbackOffer(){
    if(!this.state.automatic_promotion)return null;
    const bad=Object.keys(this.state.active).filter(kind=>{const m=this.model(kind,{active:true}),r=(this.state.evaluations[m?.id]??[]).slice(-20),s=score(r);return r.length>=20&&s.sessions>=3&&s.mae_s>s.baseline_mae_s*1.1;});
    return bad.length?hash(JSON.stringify(bad.map(k=>[k,this.model(k,{active:true}).id,this.state.evaluations[this.model(k,{active:true}).id].at(-1)?.key]))).slice(0,24):null;
  }
  observe(row) {
    if(!this.configured||this.closed||row.kind==='model_prediction')return;
    try{
      const result=this.history.observe(row),key=row.run_id+':'+row.request_id;
      for(const point of result.points){
        const candidates=new Map();const experimental=this.model(point.kind),active=this.model(point.kind,{active:true});if(experimental)candidates.set(experimental.id,experimental);if(active)candidates.set(active.id,active);
        for(const model of candidates.values()){
          if(!supported(model,point))continue;
          const seconds=predictTreeModel(model,point.features),baseline=this.baseline(point),experimental=model.id!==active?.id||!this.activeSupported(model,point);
          this.record('model_prediction',{request_id:row.request_id,node:row.node,predictor_schema:2,model_id:model.id,model_kind:point.kind,prediction_stage:point.stage,seconds,baseline_seconds:baseline,elapsed_s:point.features.elapsed_s,experimental,available_at:point.at});
          const samples=this.pending.get(key)??[];
          // Bounded forecast evidence; never score this request more heavily
          // merely because it produced many progress updates.
          samples.push({model,point,seconds,baseline,experimental});if(samples.length>140)samples.splice(4,1);this.pending.set(key,samples);if(this.pending.size>4096)this.pending.delete(this.pending.keys().next().value);
          const current=this.live.get(row.request_id)??{};current[point.kind]={seconds,at:point.at,experimental,stage:point.stage,model_id:model.id};this.live.set(row.request_id,current);if(this.live.size>4096)this.live.delete(this.live.keys().next().value);
        }
      }
      if(result.finished){this.state.new_requests++;this.scoreFinished(row,result.finished.job,this.pending.get(key)??[]);this.pending.delete(key);this.live.delete(row.request_id);this.persist();}
      else if(['finish','queued_cancel','queue_timeout','unavailable_before_dispatch'].includes(row.kind)){this.pending.delete(key);this.live.delete(row.request_id);}
    }catch(e){this.error='Predictor observation failed; inference unchanged';}
  }
  scoreFinished(finish,job,samples) {
    const d=job.decision;
    for(const modelId of new Set(samples.map(s=>s.model.id))){
      const group=samples.filter(s=>s.model.id===modelId&&finite(s.baseline));if(!group.length)continue;
      const model=group[0].model,bundle=[...this.bundles.values()].find(b=>b.models[model.kind]?.id===modelId);
      // Only forecasts for requests admitted AFTER artifact creation can count
      // toward future promotion. Replay and training holdout are never reused.
      if(!bundle||Date.parse(d.time)<=Date.parse(bundle.created_at))continue;
      const g=model.kind==='remaining'?group:[group.at(-1)],n=g.length;
      const row={key:`${finish.run_id}:${finish.request_id}`,session:d.session??'unknown-session',node:finish.node,profile:group[0].point.profile,at:Date.parse(finish.time),long:finish.service_ms>=300000,
        error:0,baseline_error:0,prediction:0,actual:0};
      for(const s of g){const actual=model.kind==='remaining'?Math.max(0,finish.service_ms/1000-s.point.features.elapsed_s):finish.service_ms/1000;row.error+=Math.abs(actual-s.seconds)/n;row.baseline_error+=Math.abs(actual-s.baseline)/n;row.prediction+=s.seconds/n;row.actual+=actual/n;}
      const history=this.state.evaluations[modelId]??[];if(!history.some(x=>x.key===row.key))history.push(row);this.state.evaluations[modelId]=history.slice(-200);
      const keep=new Set([...this.bundles.values()].flatMap(b=>Object.values(b.models).map(m=>m.id)));for(const k of Object.keys(this.state.evaluations))if(!keep.has(k))delete this.state.evaluations[k];
      if(this.state.active[model.kind]===bundle.directory_id){const window=history.slice(-PREDICTION_POLICY.rollback_window),m=score(window);if(window.length>=PREDICTION_POLICY.rollback_window&&m.sessions>=3&&m.mae_s>m.baseline_mae_s*PREDICTION_POLICY.rollback_ratio)this.rollback('watchdog',model.kind,'Recent prediction error exceeded fixed fallback threshold');}
      else if(this.state.automatic_promotion&&!this.state.rejected[model.id]&&promotionEligible(model,history))this.activate(bundle,model.kind,'validator');
    }
  }
  activate(bundle,kind,actor) {
    const model=bundle.models[kind];if(this.state.rejected[model.id]||!promotionEligible(model,this.state.evaluations[model.id]??[]))throw new Error('Model has not passed the fixed future evidence gate');
    this.state.previous[kind]=this.state.active[kind]??null;this.state.active[kind]=bundle.directory_id;
    return this.receipt(actor,'activate','verified','Fixed holdout and future-shadow gates passed',{kind,model_id:model.id});
  }
  rollback(actor,kind=null,reason='Operator requested rollback') {
    const kinds=kind?[kind]:Object.keys(this.state.active);if(!kinds.length)throw new Error('No active predictor');
    for(const k of kinds){const current=this.model(k,{active:true});if(current)this.state.rejected[current.id]=this.now();const previous=this.state.previous[k],old=this.bundles.get(previous)?.models[k];if(old&&!this.state.rejected[old.id])this.state.active[k]=previous;else delete this.state.active[k];delete this.state.previous[k];}
    return this.receipt(actor,'rollback','verified',reason,{kinds});
  }
  control(input,actor='operator') {
    if(!this.configured)throw new Error('Predictor is not configured');
    if(actor==='genie'){
      if(Object.keys(input).sort().join(',')!=='action,evidence_id')throw new Error('Unsupported Genie action');
      if(input.action==='train'&&this.state.automatic_training&&this.trainingOffer()&&input.evidence_id===this.trainingOffer())return this.train(actor);
      if(input.action==='rollback'&&this.rollbackOffer()&&input.evidence_id===this.rollbackOffer())return this.rollback(actor,null,'Genie requested rollback against a fresh measured regression offer');
      throw new Error('Predictor offer is absent or stale');
    }
    if(input.action==='train'&&Object.keys(input).length===1)return this.train(actor);
    if(input.action==='rollback'&&Object.keys(input).length===1)return this.rollback(actor);
    if(['automatic_training','automatic_promotion','placement'].includes(input.action)&&Object.keys(input).sort().join(',')==='action,enabled'&&typeof input.enabled==='boolean'){
      this.state[input.action]=input.enabled;return this.receipt(actor,input.action,'verified',input.enabled?'Enabled by operator':'Disabled by operator');
    }throw new Error('Unsupported predictor action');
  }
  train(actor='operator') {
    if(this.busy||this.closed||!this.configured)throw new Error('Predictor trainer is unavailable or busy');
    if(this.now()-this.state.last_train_at<60000)throw new Error('Training cooldown; no duplicate job started');
    const name='candidate-'+this.now()+'-'+randomUUID().slice(0,8),destination=path.join(this.directory,'candidates',name);
    this.busy=true;this.state.last_train_at=this.now();this.state.training={id:name,actor,started_at:this.now(),new_requests:this.state.new_requests};this.receipt(actor,'train','running','Frozen data, fixed feature/round search and two CPU threads',{candidate_id:name});
    const initial={id:name,actor,state:'running',started_at:this.state.training.started_at};void this.runTraining(destination,name,actor);return initial;
  }
  async runProcess(executable,args,timeout) {
    return new Promise((resolve,reject)=>{
      const child=this.spawnImpl(executable,args,{cwd:root,stdio:['ignore','pipe','pipe'],env:{...process.env,OMP_NUM_THREADS:'2',OPENBLAS_NUM_THREADS:'1'}});this.child=child;let output='',bytes=0;
      const failure=message=>Object.assign(new Error(message),{privateOutput:output});
      const timer=setTimeout(()=>{child.kill('SIGKILL');reject(failure('Training time budget exceeded'));},timeout);timer.unref?.();
      for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{bytes+=chunk.length;if(bytes>1024*1024){child.kill('SIGKILL');return;}output+=chunk;});
      child.on('error',()=>{clearTimeout(timer);reject(failure('Trainer could not start'));});child.on('close',code=>{clearTimeout(timer);if(this.child===child)this.child=null;code===0&&bytes<=1024*1024?resolve(output):reject(failure('Trainer failed; inspect private candidate log'));});
    });
  }
  async runTraining(destination,name,actor) {
    try{
      const start=this.now();await this.runProcess(process.execPath,[path.join(root,'predictor/prepare.mjs'),'--data',this.dataDirectory,'--profiles',this.config.profiles,'--output',destination],30000);
      if(this.closed)throw new Error('Gateway stopped; training interrupted');
      const output=await this.runProcess(this.config.python,[path.join(root,'predictor/fit_v2.py'),'--prepared',path.join(destination,'prepared.json')],Math.max(1000,PREDICTION_POLICY.training_timeout_ms-(this.now()-start)));
      if(this.closed)throw new Error('Gateway stopped; training interrupted');fs.writeFileSync(path.join(destination,'trainer.log'),output,{flag:'wx',mode:0o600});this.loadCandidates();
      this.state.new_requests=Math.max(0,this.state.new_requests-(this.state.training?.new_requests??0));
      this.receipt(actor,'train','completed','Candidate evaluated; no model bypasses future-shadow validation',{candidate_id:name});this.error=null;
    }catch(e){this.error='Predictor training failed; last working model retained';try{if(fs.existsSync(destination))fs.writeFileSync(path.join(destination,'failure.log'),String(e.privateOutput??e.message).slice(0,1024*1024),{flag:'wx',mode:0o600});}catch{}if(!this.closed)try{this.receipt(actor,'train','failed',this.error,{candidate_id:name});}catch{}}
    finally{this.busy=false;if(!this.closed){this.state.training=null;try{this.persist();}catch{this.error='Predictor state could not be persisted';}}}
  }
  tick(){if(this.configured&&!this.closed&&this.state.automatic_training&&this.trainingOffer()&&this.now()-this.state.last_train_at>=PREDICTION_POLICY.training_interval_ms)try{this.train('scheduler');}catch{}}
  forecasts(requestId){const f=this.live.get(requestId);return f?Object.fromEntries(Object.entries(f).map(([kind,v])=>[kind,{...v,experimental:v.experimental||this.model(kind,{active:true})?.id!==v.model_id}])):null;}
  choose(nodes,key,fallback,candidate) {
    if(!this.configured||!this.state.placement||this.error)return fallback;
    const model=this.model('admission',{active:true});if(!model?.new_session_validated)return fallback;
    try{
      const at=this.now(),costs=[];
      for(const n of nodes){
        const c=candidate(n,key),job={decision:{node:n.id,session:key,affinity:'new',candidates:nodes.map(x=>candidate(x,key))}};
        const point=this.history.snapshot(job,'admission',at,null,c),support=model.support[n.id];
        // New sessions need first-observed-call evidence, not a claim of actual
        // cold cache. No counterfactual hot-cache
        // assumption is smuggled in from a different conversation or machine.
        if(!this.activeSupported(model,point)||(support.first_observed_requests??0)<5)return fallback;
        let wait=0;
        if(n.active){const r=this.forecasts(n.active.id)?.remaining,remaining=this.model('remaining',{active:true});if(!r||r.experimental||r.model_id!==remaining?.id||at-r.at>60000||r.seconds<=(at-r.at)/1000||!finite(n.active.dispatched)||(at-n.active.dispatched)/1000>(remaining.support[n.id]?.max_elapsed_s??-1))return fallback;wait+=r.seconds-(at-r.at)/1000;}
        for(const q of n.queue){const f=this.forecasts(q.id)?.admission;if(!f||f.experimental||f.model_id!==model.id)return fallback;wait+=f.seconds;}
        costs.push({node:n,cost:wait+predictTreeModel(model,point.features)});
      }
      costs.sort((a,b)=>a.cost-b.cost||a.node.id.localeCompare(b.node.id));return costs[0]?.node??fallback;
    }catch{return fallback;}
  }
  status() {
    const candidate=this.shadow,offers=this.state.automatic_training&&this.trainingOffer()?[{action:'train',evidence_id:this.trainingOffer()}]:[];
    if(this.rollbackOffer())offers.push({action:'rollback',evidence_id:this.rollbackOffer()});
    return {configured:this.configured,error:this.error,candidate_rejections:this.candidateRejections??0,mode:this.state.placement?'validated-new-session-placement':'forecasts-only',automatic_training:this.state.automatic_training,automatic_promotion:this.state.automatic_promotion,placement:this.state.placement,busy:this.busy,training:this.state.training??null,new_requests:this.state.new_requests,history_partial:!!this.partialHistory,policy:PREDICTION_POLICY,offers,
      models:['admission','updated','remaining'].map(kind=>{const m=candidate?.models[kind],active=this.model(kind,{active:true});return {kind,active_model_id:active?.id??null,candidate_model_id:m?.id??null,status:candidate?.reports[kind]?.status??'not_trained',selected:candidate?.reports[kind]?.selected?{family:candidate.reports[kind].selected.family,rounds:candidate.reports[kind].selected.rounds,transform:candidate.reports[kind].selected.transform}:null,
        holdout:candidate?.reports[kind]?.holdout??null,baselines:candidate?.reports[kind]?.baselines??null,future:m?score(this.state.evaluations[m.id]??[]):null};}),actions:this.state.receipts.slice(0,10)};
  }
  close(){this.closed=true;this.child?.kill('SIGTERM');}
}
