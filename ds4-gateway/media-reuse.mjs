import assert from 'node:assert/strict';
import path from 'node:path';

// An operator may point setup at a retained preparation on the selected host.
// This is a candidate for fresh qualification, never an enrollment shortcut.
export function mediaReuse(config,id,engine,member){
 const saved=config.media_jobs?.reuse?.[id]?.[member??0]?.[engine];
 if(!saved)return null;
 assert.ok(['container,directory,image,kind,port','container,image,kind,port,source'].includes(Object.keys(saved).sort().join(',')));
 if(saved.source!==undefined)assert.equal(saved.source,'docker');
 else assert.ok(path.isAbsolute(saved.directory)&&saved.directory!=='/'&&!saved.directory.split('/').includes('..'));
 assert.match(saved.container,/^[a-f0-9]{64}$/);assert.match(saved.image,/^sha256:[a-f0-9]{64}$/);
 assert.equal(saved.kind,engine==='h3'?'comfyui':'ace-step');assert.ok(Number.isSafeInteger(saved.port)&&saved.port>0&&saved.port<=65535);
 return {engine,...structuredClone(saved)};
}

export function mediaPreparationRequest(reuse,requireIdle){
 if(reuse?.source==='docker')return {action:'existing_media',engine:reuse.engine,llm_container:reuse.llm_container,require_idle:requireIdle,expected:Object.fromEntries(['container','image','kind','port'].map(k=>[k,reuse[k]]))};
 if(reuse)return {action:'retained_media',engine:reuse.engine,llm_container:reuse.llm_container,require_idle:requireIdle};
 return {action:requireIdle?'media_plan':'media_state'};
}

export function selectedMediaPreparation(current,reuse){
 if(!reuse)return current;
 assert.equal(current.state,'prepared_stopped');assert.match(reuse.llm_container,/^[a-f0-9]{64}$/);
 const candidate=current.engines?.[reuse.engine];assert.ok(candidate,'Retained preparation lacks the selected engine');
 for(const key of ['container','image','kind','port'])assert.equal(candidate[key],reuse[key],`Retained media ${key} changed`);
 // The source preparation's old LLM remains untouched. The current operation
 // owns and verifies its current LLM through the normal drain/return lifecycle.
 return {...current,source_llm_container:current.source_llm_container??current.llm_container,llm_container:reuse.llm_container,engines:{[reuse.engine]:candidate}};
}
