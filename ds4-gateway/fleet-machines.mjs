// One explicit physical-machine mapping for the enrolled fleet. The catalogue,
// power scripts and media placement all read this table instead of keeping
// their own lists. A worker id not listed here is itself a machine (single
// Spark workers and generic test hosts).
export const MACHINE_GROUPS={
  spark1:['spark1'],spark2:['spark2'],spark3:['spark3'],spark4:['spark4'],
  'glm53f-m3':['m3-ultra'],
  'ds41-m3':['m3-ultra'],
  'mimo-m3':['m3-ultra'],
  'qwen-image':['m3-ultra'],
  'glm53f-sparks12':['spark1','spark2'],
  'ds41-sparks12':['spark1','spark2'],
  'glm53f-sparks34':['spark3','spark4'],
  'ds41-sparks34':['spark3','spark4']
};
export const machineGroup=worker=>MACHINE_GROUPS[worker]??null;
export const machinesFor=(worker,config)=>{
 const configured=config?.machine_groups?.[worker];
 if(configured!==undefined){
  if(!Array.isArray(configured)||!configured.length||configured.some(m=>typeof m!=='string'||!m.trim())||new Set(configured).size!==configured.length)throw Error('Configure nonempty distinct physical machine IDs');
  return [...configured];
 }
 if(MACHINE_GROUPS[worker])return MACHINE_GROUPS[worker];
 const pair=config?.media_jobs?.pairs?.[worker];
 if(pair?.kind==='glm53-docker-pair'&&pair.members?.length===2)return pair.members.map(m=>m.machine??m.ssh);
 const inspection=config?.genie_chat?.inspection?.workers?.[worker];
 return [inspection?.ssh?.[0]??worker];
};
