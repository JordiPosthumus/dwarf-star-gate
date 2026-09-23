// One explicit physical-machine mapping for the enrolled fleet. The catalogue,
// power scripts and media placement all read this table instead of keeping
// their own lists. A worker id not listed here is itself a machine (single
// Spark workers and generic test hosts).
export const MACHINE_GROUPS={
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
export const machinesFor=worker=>MACHINE_GROUPS[worker]??[worker];
