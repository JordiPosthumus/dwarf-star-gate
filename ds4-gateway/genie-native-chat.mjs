// Thin client for the native gateway. No agent loop, transcript writes or poller.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

const sections={
  inspection:['read_server_configuration','inspect_server','read_server_artifact'],
  research:['stargate_web_search','stargate_web_extract'],
  spark_setup:['request_spark_access','bootstrap_spark_access','spark_access_status','discover_sparks','spark_discovery_status','resume_spark_preparation','enroll_spark','enroll_discovered_spark','qualify_spark_media','setup_spark','spark_setup_status','prepare_spark','qualify_spark_llm','register_spark_llm'],
  recovery:['recovery_status','recover_server','prepare_pair_recovery','enroll_pair_recovery','qualify_pair_recovery','qualify_omlx_recovery','enroll_omlx_recovery'],
  power:['fleet_power_status','inspect_fleet_service','fleet_power','fleet_routing','fleet_recipe_trial','fleet_recipe_rollout'],
  media:['media_job_status','start_media_job','inspect_media_host','inspect_media_inputs','setup_media_host','repair_media_setup','audit_media_standard'],
  admission:['admission_status','admission_inspect','admission_admit','verify_serving'],
  operations:['propose_server_change','server_change_status'],
  measurements:['prepare_hourglass_measurement','hourglass_measurement_status','compare_hourglass_reports'],
  queue:['queue_balance_status','move_waiting_job'],
};
const sectionFor=new Map(Object.entries(sections).flatMap(([section,names])=>names.map(name=>[name,section])));
const parse=value=>{try{return typeof value==='string'?JSON.parse(value):value;}catch{return null;}};
const textContent=value=>typeof value==='string'?value:Array.isArray(value)?value.filter(v=>v?.type==='text').map(v=>v.text??'').join('\n'):'';
const stamp=value=>typeof value==='number'?value*1000:Date.parse(value);

export function nativeRequestId(conversationId,requestId){
  if(typeof requestId!=='string'||!/^[a-zA-Z0-9-]{8,80}$/.test(requestId))throw Error('A message identifier is required.');
  const b=createHash('sha256').update(JSON.stringify(['dsg-native-input-v1',conversationId,requestId])).digest().subarray(0,16);
  b[6]=(b[6]&15)|0x50;b[8]=(b[8]&63)|0x80;
  const h=b.toString('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}

export function readNativeGatewayDescriptor(file){
  if(!path.isAbsolute(file))throw Error('Use an absolute private native gateway descriptor.');
  const st=fs.lstatSync(file);
  if(!st.isFile()||st.isSymbolicLink()||(st.mode&0o077)||st.uid!==process.getuid()||st.size>8192)throw Error('Native gateway descriptor must be private and owned by this account.');
  const value=JSON.parse(fs.readFileSync(file,'utf8')),url=new URL(value.url);
  if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||!url.port||url.pathname!=='/'||url.username||url.password||url.search||url.hash)throw Error('Use the local native gateway origin.');
  if(['api_key','control_token'].some(k=>typeof value[k]!=='string'||value[k].length<16))throw Error('Native gateway credentials are missing.');
  return {...value,url:url.origin};
}

export function projectNativeConversation({id,title='Gate Genie',session,messages,pagination}){
  if(session?.state!=='observed'||!Array.isArray(messages))throw Error('Fresh native session evidence is unavailable.');
  const result=[],calls=new Map();let reply=null;
  const ensureReply=row=>{
    if(!reply){reply={id:`native-${session.session_id}-${row.id}`,role:'assistant',text:'',state:'working',at:stamp(row.timestamp)};result.push(reply);}
    return reply;
  };
  for(const row of messages){
    if(row.role==='user'){
      reply=null;const text=textContent(row.content),marker=text.match(/^\[DSG request ([a-f0-9-]{36})\]\n\n/);
      result.push({id:`native-${session.session_id}-${row.id}`,role:'user',text:marker?text.slice(marker[0].length):text,state:'complete',at:stamp(row.timestamp),...(marker?{request_id:marker[1]}:{})});
    }else if(row.role==='assistant'){
      const current=ensureReply(row),text=textContent(row.content);
      if(text)current.text+=(current.text?'\n\n':'')+text;
      for(const call of row.tool_calls??[]){
        const fn=call.function??{},args=parse(fn.arguments);let name=fn.name,request=args;
        if(name==='tool_call'&&args){name=args.name;request=parse(args.arguments)??args.arguments;}
        if(typeof call.id==='string')calls.set(call.id,{name,request,reply:current,at:row.timestamp});
      }
      // Only a native final assistant message proves that a reply finished.
      if(row.finish_reason==='stop'&&!row.tool_calls?.length){current.state='complete';current.finished_at=stamp(row.timestamp);}
      else if(['length','content_filter','error'].includes(row.finish_reason)){current.state='failed';current.error=`Native reply ended with ${row.finish_reason}.`;}
    }else if(row.role==='tool'){
      const call=calls.get(row.tool_call_id),name=call?.name??row.tool_name,current=call?.reply??ensureReply(row),section=sectionFor.get(name);
      const body=textContent(row.content),value=parse(body),failed=Boolean(value?.error)||value?.is_error===true;
      const event={tool:name??'native_tool',tool_call_id:row.tool_call_id,state:failed?'failed':'complete',at:new Date(stamp(row.timestamp)).toISOString(),request:call?.request??null,result:value??{raw_text:body},...(failed?{error:typeof value.error==='string'?value.error:'Native tool reported an error.'}:{})};
      if(section==='inspection')Object.assign(event,{operation:name,kind:name==='inspect_server'?'live':'records',worker_id:call?.request?.worker_id??value?.worker_id,...(call?.request?.selected_default!==undefined?{selected_default:call.request.selected_default}:{}),...(value?.diagnostic?{diagnostic:value.diagnostic}:{})});
      if(section==='research')Object.assign(event,{kind:name==='stargate_web_search'?'search':'read',...(name==='stargate_web_search'?{query:call?.request?.query,sources:Array.isArray(value?.results)?value.results:[]}:{sources:typeof value?.url==='string'?[{url:value.url}]:[],content_sha256:value?.content_sha256,truncated:value?.truncated})});
      current.native_tools??={events:[]};current.native_tools.events.push(event);
      if(section){current[section]??={events:[]};current[section].events.push(event);}
    }
  }
  return {id,title,messages:result,native_session_id:session.session_id,native_session_key:session.session_key,
    busy:session.busy,queued:session.queued,observed_at:session.observed_at,updated_at:Math.max(0,...result.map(m=>Number.isFinite(m.at)?m.at:0)),
    pagination,history_complete:pagination?.offset===0&&Number.isSafeInteger(pagination?.total)&&pagination.returned===pagination.total,
    scope:'Native Hermes transcript. A completed reply or tool call does not prove the requested fleet outcome.'};
}

export class NativeHermesChatClient{
  constructor({descriptor,bindings,fetchImpl=fetch}){
    this.descriptor=descriptor;this.fetch=fetchImpl;
    if(!Array.isArray(bindings)||bindings.some(b=>typeof b?.id!=='string'||typeof b?.session_key!=='string'||!b.id||!b.session_key)||new Set(bindings.map(b=>b.id)).size!==bindings.length)throw Error('Configure explicit native conversation bindings.');
    this.bindings=new Map(bindings.map(b=>[b.id,{...b}]));
  }
  binding(id){const b=this.bindings.get(id);if(!b)throw Error('Conversation is not connected to native Hermes.');return b;}
  async request(route,{body,control=false}={}){
    const descriptor=readNativeGatewayDescriptor(this.descriptor);
    try{
      const response=await this.fetch(descriptor.url+route,{method:body?'POST':'GET',redirect:'error',headers:{authorization:'Bearer '+descriptor[control?'control_token':'api_key'],...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000)});
      if(!response.ok)throw Error('Native gateway request failed.');
      const reader=response.body.getReader();let bytes=0;const chunks=[];
      while(true){const {value,done}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>8*1024*1024){await reader.cancel();throw Error('Native gateway observation exceeds one page.');}chunks.push(Buffer.from(value));}
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }catch{throw Error('Native gateway response could not be confirmed. Do not replay an uncertain instruction.');}
  }
  async control(payload){return this.request('/api/platforms/stargate_control/events',{body:payload,control:true});}
  async session(id){const b=this.binding(id);const s=await this.control({action:'session',session_key:b.session_key});if(s.session_key!==b.session_key||s.state!=='observed'||typeof s.session_id!=='string'||typeof s.busy!=='boolean'||!Number.isInteger(s.queued))throw Error('Fresh native session evidence is unavailable.');return s;}
  async read(id,{offset=0,limit=500,all=false}={}){
    if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>500)throw Error('Invalid native transcript page.');
    if(typeof all!=='boolean'||(all&&offset!==0))throw Error('Complete native history starts at the first page.');
    const b=this.binding(id),session=await this.session(id);
    let page,revision=null,resolved=null,total=null,cursor=offset;const messages=[];
    do{
      page=await this.control({action:'transcript',session_key:b.session_key,session_id:session.session_id,offset:cursor,limit,revision});
      const p=page.pagination;
      if(page.state!=='observed'||page.session_key!==b.session_key||!Array.isArray(page.data)||typeof page.session_id!=='string'||!page.session_id||!p||p.offset!==cursor||p.limit!==limit||p.returned!==page.data.length||p.returned>limit||p.order!=='oldest'||!Number.isSafeInteger(p.total)||p.total<0||p.returned!==Math.min(limit,Math.max(0,p.total-cursor))||typeof page.revision!=='string'||!/^[a-f0-9]{64}$/.test(page.revision))throw Error('Native transcript evidence is unavailable.');
      if(revision!==null&&(page.revision!==revision||page.session_id!==resolved||p.total!==total))throw Error('Native history changed during observation; read it again.');
      revision=page.revision;resolved=page.session_id;total=p.total;messages.push(...page.data);cursor+=p.returned;
    }while(all&&cursor<total);
    // Recheck the native routing entry after all pages; a concurrent compression
    // or reset must not silently stitch different conversations together.
    const after=await this.session(id);
    if(after.session_id!==session.session_id)throw Error('Native session changed during observation; read it again.');
    return {...projectNativeConversation({id,title:b.title,session:{...after,session_id:resolved},messages,pagination:{offset,limit:all?messages.length:limit,returned:messages.length,total,order:'oldest'}}),native_history_revision:revision};
  }
  async submit(id,text,requestId){
    const b=this.binding(id);
    if(typeof text!=='string'||!text.trim()||text.length>32000)throw Error('Enter a message of up to 32,000 characters.');
    const identity=nativeRequestId(id,requestId);
    const receipt=await this.control({action:'send',request_id:identity,session_key:b.session_key,message:text.trim()});
    if(receipt.request_id!==identity||receipt.state!=='accepted_unverified')throw Error('Native dispatch acceptance is unconfirmed. Keep the same request identity for reconciliation.');
    return receipt;
  }
  async receipt(id,requestId){this.binding(id);return this.control({action:'status',request_id:nativeRequestId(id,requestId)});}
}
