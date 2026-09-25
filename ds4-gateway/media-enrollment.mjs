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
