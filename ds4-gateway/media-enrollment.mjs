// Keep the original default selection while retaining independently qualified
// installations on both physical members of a paired LLM.
export function mediaEngine(config,id,kind,member){
 const target=config.media_jobs?.workers?.[id],fallback=target?.engines?.[kind];
 if(member===undefined)return fallback;
 if(![0,1].includes(member))throw Error('Choose physical pair member 0 or 1');
 const selected=target?.member_engines?.[member]?.[kind];
 if(selected&&selected.member!==member)throw Error('Media enrollment physical member differs');
 return selected??((fallback?.member??0)===member?fallback:undefined);
}
export function mediaMemberInput(input,keys){
 return [keys,[...keys.split(','),'member'].sort().join(',')].includes(Object.keys(input??{}).sort().join(','))&&(input.member===undefined||[0,1].includes(input.member));
}

// Gateway-owned current enrollments, including engines qualified after startup.
// Addresses stay in the consumer's trusted inspection configuration.
export function mediaNativeEnrollments(config){
 return Object.entries(config.media_jobs?.workers??{}).flatMap(([worker_id,value])=>{
  const paired=!!config.media_jobs?.pairs?.[worker_id],rows=[];
  for(const member of paired?[0,1]:[undefined])for(const kind of ['music','video']){
   const e=mediaEngine(config,worker_id,kind,member);if(!e)continue;
   rows.push({worker_id,kind,engine:e.kind,port:e.port,...(member!==undefined?{member}:{}),...(e.container?{container:e.container}:{}),...(e.image?{image:e.image}:{})});
  }
  return rows;
 });
}
