// Explicit paired-LLM enrollment. Media runs on its enrolled pair member;
// both original containers return by ID, with their full Docker settings intact.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {mediaContainerSignature} from './spark-media-cycle.mjs';

export function mediaPair(config,worker){
 const p=config.media_jobs?.pairs?.[worker?.id],inspection=config.genie_chat?.inspection?.workers?.[worker?.id];
 if(!p||!worker||!inspection)return null;
 const route=w=>Object.fromEntries(['id','url','ssh','ssh_fallbacks','remote_port'].filter(k=>w[k]!==undefined).map(k=>[k,w[k]]));
 if(!isDeepStrictEqual(p.worker_binding,route(worker)))return null;
 if(p.kind!=='glm53-docker-pair'||!p.model||!Array.isArray(p.members)||p.members.length!==2)return null;
 if(p.engine_members&&Object.entries(p.engine_members).some(([kind,index])=>!['music','video'].includes(kind)||![0,1].includes(index)))return null;
 if(p.members.some(m=>!/^[A-Za-z0-9][A-Za-z0-9_.@-]*$/.test(m.ssh??'')||!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(m.container??'')))return null;
 if(p.members[0].ssh!==inspection.ssh?.[0]||p.members[0].container!==inspection.container||p.members[0].ssh===p.members[1].ssh)return null;
 return structuredClone(p);
}

export function pairedMediaReturn(pair,{inspectRemote,startRemote,stopRemote,request,save,snapshotRemote}){
 let originals,files;const member=pair.media_member??0;assert.ok([0,1].includes(member));
 const inspectAll=()=>Promise.all(pair.members.map((m,i)=>inspectRemote(m.ssh,originals?.[i]?.Id??m.container)));
 const check=async()=>{
  assert.ok(originals,'Pair must be captured before transition');const current=await inspectAll();
  current.forEach((c,i)=>assert.ok(isDeepStrictEqual(mediaContainerSignature(c),mediaContainerSignature(originals[i])),'Original pair member configuration changed'));
  if(files){const fresh=await Promise.all(pair.members.map((m,i)=>snapshotRemote(m.ssh,current[i],m.recipe_root)));fresh.forEach((v,i)=>assert.ok(isDeepStrictEqual(v,files[i]),'Original pair mounted files or recipe changed'));}
  return current;
 };
 return {
  async capture(){
   assert.ok(!originals,'Capture pair once');const current=await inspectAll();
   current.forEach(c=>{assert.match(c.Id,/^[a-f0-9]{64}$/);assert.equal(c.State.Running,true);});
   assert.equal(current[0].Image,current[1].Image,'Pair images differ');
   if(snapshotRemote){files=await Promise.all(pair.members.map((m,i)=>snapshotRemote(m.ssh,current[i],m.recipe_root)));save('llm-pair-files-before.json',{files});}
   originals=current;save('llm-pair-before.json',{members:pair.members,containers:originals});
  },
  check,
  async stop(head){
   const current=await check();assert.equal(head,originals[member].Id,'Stop exact captured member');
   save('llm-pair-stop-intent.json',{containers:originals.map(c=>c.Id)});
   for(const i of [0,1])if(current[i].State.Running)await stopRemote(pair.members[i].ssh,originals[i].Id);
   (await check()).forEach(c=>assert.equal(c.State.Running,false));
  },
  async restore(head){
   const current=await check();assert.equal(head,originals[member].Id,'Restore exact captured member');
   save('llm-pair-restore-intent.json',{containers:originals.map(c=>c.Id)});
   for(const i of [1,0])if(!current[i].State.Running)await startRemote(pair.members[i].ssh,originals[i].Id);
   (await check()).forEach(c=>assert.equal(c.State.Running,true));
  },
  async recoveryInspect(){
   const current=originals?await check():await inspectAll();let listener=false;
   if(current.every(c=>c.State.Running))try{const data=await request('/v1/models');listener=data.data?.some(m=>m.id===pair.model)===true;}catch{}
   return {profile:'glm53-docker-pair',listener,fault:null,instance:createHash('sha256').update(JSON.stringify([current[member].Id,current[member].State.StartedAt])).digest('hex').slice(0,32)};
  },
  async verify(){
   const current=await check();current.forEach(c=>assert.equal(c.State.Running,true));
   const models=await request('/v1/models'),model=models.data?.find(m=>m.id===pair.model);
   const settings=Object.fromEntries(originals[0].Config.Env.map(v=>{const at=v.indexOf('=');return [v.slice(0,at),v.slice(at+1)];}));
   assert.equal(model?.max_model_len??model?.context_length,Number(settings.MAX_MODEL_LEN),'Restored context differs');
   const result=await request('/v1/chat/completions',{model:pair.model,messages:[{role:'user',content:'Reply with exactly: RESTORED_7319'}],max_tokens:4096,temperature:0});
   assert.equal(result.choices?.[0]?.finish_reason,'stop');assert.ok(result.choices[0].message.content.includes('RESTORED_7319'),'Original pair did not return the readiness answer');
   await check();const proof={state:'verified',containers:originals.map(c=>({id:c.Id,image:c.Image})),configuration_unchanged:true,context_length:Number(settings.MAX_MODEL_LEN),server_concurrency:Number(settings.MAX_NUM_SEQS),readiness:{answer:result.choices[0].message.content,usage:result.usage},scope:'Exact original pair containers and settings returned, plus one native readiness response. This does not measure performance or cache reuse.'};
   save('llm-pair-return.json',proof);return proof;
  }
 };
}
