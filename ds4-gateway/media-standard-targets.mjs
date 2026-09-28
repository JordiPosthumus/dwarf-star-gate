export function mediaStandardTargets(config){
 const standard=config.media_jobs?.standard;
 if(!standard?.enabled)return [];
 if(!Array.isArray(standard.targets)||!standard.targets.length)throw Error('Media standard needs explicit targets.');
 const keys=new Set();
 return standard.targets.map(target=>{
  if(!target||!['engine,member,worker_id','engine,worker_id'].includes(Object.keys(target).sort().join(','))||typeof target.worker_id!=='string'||!target.worker_id||!['h3','ace-step'].includes(target.engine)||(target.member!==undefined&&![0,1].includes(target.member)))throw Error('Choose registered workers, optional pair members and supported standard engines.');
  const key=JSON.stringify([target.worker_id,target.member??null,target.engine]);
  if(keys.has(key))throw Error('Duplicate media standard target.');keys.add(key);
  return {...target,key};
 });
}
