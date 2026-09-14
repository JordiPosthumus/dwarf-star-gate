// Adapter to Hourglass's own console. It never launches a shell or model server.
// UI integration must durably record start intent before calling submit().
import {randomUUID} from 'node:crypto';

const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const label=value=>typeof value==='string'&&value.length>0&&value.length<=256&&!/[\r\n\0]/.test(value);
const settingsKeys=['context_window','max_tokens','reasoning','temperature','top_p','top_k','min_p','repetition_penalty'];
const safeSettings=model=>Object.fromEntries(settingsKeys.filter(k=>typeof model[k]==='boolean'||typeof model[k]==='number'&&Number.isFinite(model[k])||label(model[k])).map(k=>[k,model[k]]));

export class HourglassConsoleError extends Error {
  constructor(message,{uncertain=false,status=null}={}){super(message);this.name='HourglassConsoleError';this.uncertain=uncertain;this.status=status;}
}

export class HourglassConsole {
  constructor(url,{fetchImpl=fetch,timeoutMs=15000,maxBytes=64*1024*1024}={}){
    const u=new URL(url);
    if(u.protocol!=='http:'||u.hostname!=='127.0.0.1'||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw new Error('Use the local Hourglass console origin, http://127.0.0.1:PORT.');
    this.origin=u.origin;this.fetch=fetchImpl;this.timeoutMs=timeoutMs;this.maxBytes=maxBytes;this.prepared=null;
  }
  async request(route,body){
    const mutation=body!==undefined;
    try{
      const r=await this.fetch(this.origin+route,{method:mutation?'POST':'GET',redirect:'error',signal:AbortSignal.timeout(this.timeoutMs),
        headers:mutation?{'content-type':'application/json','origin':this.origin}:{},...(mutation?{body:JSON.stringify(body)}:{})});
      // Native 400 means enqueue validation rejected the request. Other failures
      // may follow acceptance; never retry a submission on transport evidence.
      if(!r.ok){await r.body?.cancel();throw new HourglassConsoleError('Hourglass could not accept the request. Review it in the Hourglass console.',{uncertain:mutation&&r.status!==400,status:r.status});}
      let count=0;const chunks=[];
      for await(const chunk of r.body){count+=chunk.length;if(count>this.maxBytes)throw new Error();chunks.push(Buffer.from(chunk));}
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }catch(e){if(e instanceof HourglassConsoleError)throw e;throw new HourglassConsoleError(mutation?'Hourglass start could not be confirmed. Check its console before attempting another run.':'Hourglass console is unavailable or returned an unreadable response.',{uncertain:mutation});}
  }
  async read(){
    const health=await this.request('/api/health');
    if(health.app!=='Hourglass'||health.version!==2||!label(health.controller_instance)||health.shutting_down)throw new HourglassConsoleError('Connect a running compatible Hourglass console.');
    const state=await this.request('/api/state');
    if(state.app!=='Hourglass'||state.version!==2||!Array.isArray(state.model_configs)||!Array.isArray(state.tasks))throw new HourglassConsoleError('Hourglass returned an unsupported run catalogue.');
    return {health,state};
  }
  async catalogue(){
    const {state}=await this.read();
    return {models:state.model_configs.filter(m=>label(m?.name)).map(m=>({name:m.name})),benchmark_version:state.benchmark_version,
      window_seconds:state.score_policy?.window_s,metric:state.score_policy?.metric};
  }
  async prepare(modelName){
    this.prepared=null;
    const {health,state:s}=await this.read(),model=s.model_configs.find(m=>m?.name===modelName);
    if(!model||!label(model.name)||!label(model.model))throw new HourglassConsoleError('Choose a saved Hourglass model.');
    if(!digest(s.models_revision)||!digest(s.endpoint_hardware?.revision)||s.score_policy?.window_s!==3600||!label(s.score_policy?.metric))throw new HourglassConsoleError('Hourglass must supply reviewed revisions and its one-hour scoring contract.');
    if(!Array.isArray(s.jobs?.running)||!Array.isArray(s.jobs?.pending)||s.jobs.running.length||s.jobs.pending.length)throw new HourglassConsoleError('Hourglass already has active or waiting work. Choose a free measurement window.');
    if(!s.tasks.length||s.tasks.some(t=>!label(t?.id)||!digest(t.task_bundle_sha)||!Array.isArray(t.issues)||t.issues.length)||new Set(s.tasks.map(t=>t.id)).size!==s.tasks.length)throw new HourglassConsoleError('Review the full question bank in Hourglass before starting.');
    let endpoint;try{endpoint=new URL(model.base_url);if(!['http:','https:'].includes(endpoint.protocol)||endpoint.username||endpoint.password||endpoint.search||endpoint.hash)throw new Error();}catch{throw new HourglassConsoleError('Review the saved endpoint in Hourglass.');}
    const review={id:randomUUID(),model:model.name,model_id:model.model,endpoint:endpoint.href,benchmark_version:s.benchmark_version,
      metric:s.score_policy.metric,scoring_policy:s.score_policy.scoring_policy,question_count:s.tasks.length,window_seconds:3600,
      models_revision:s.models_revision,hardware_revision:s.endpoint_hardware.revision,settings:safeSettings(model),
      scope:'Uses the selected Hourglass entry exactly as saved, including native defaults and overrides not summarized here. Review full settings in Hourglass. No server changes, route changes or contention protection. The owner chooses the free measurement window.'};
    this.prepared={review,controller:health.controller_instance,payload:{model:model.name,tasks:s.tasks.map(t=>t.id),repeat:1,
      models_revision:s.models_revision,hardware_revision:s.endpoint_hardware.revision,task_bundles:Object.fromEntries(s.tasks.map(t=>[t.id,t.task_bundle_sha]))}};
    return structuredClone(review);
  }
  async submit(id,{ownerConfirmedIdle=false}={}){
    const p=this.prepared;
    if(!p||p.review.id!==id||ownerConfirmedIdle!==true)throw new HourglassConsoleError('Review the run and explicitly choose its free measurement window.');
    this.prepared=null; // A review can submit at most once, including ambiguous failures.
    const health=await this.request('/api/health');
    if(health.controller_instance!==p.controller||health.shutting_down)throw new HourglassConsoleError('The Hourglass controller changed. Review the run again.');
    const result=await this.request('/api/run',p.payload);
    if(result.ok!==true||typeof result.job!=='string'||!/^[a-f0-9]{32}$/.test(result.job))throw new HourglassConsoleError('Hourglass start returned no valid receipt. Check its console before attempting another run.',{uncertain:true});
    return {job_id:result.job,state:'accepted',review:structuredClone(p.review),contention:'owner-confirmed-idle',scope:'Accepted by Hourglass; not proof that execution started or finished. No automatic retry, cancellation or resume.'};
  }
}
