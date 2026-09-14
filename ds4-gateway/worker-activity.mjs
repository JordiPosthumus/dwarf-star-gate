// All active requests matter to ownership, drain checks and capacity accounting.
// The fallback keeps read-only helpers usable with single-request test fixtures.
export const requestCapacity=node=>node.max_concurrent_requests??1;
export const activeJobs=node=>node.slots?node.slots.flatMap(slot=>slot.active?[slot.active]:[]):node.active?[node.active]:[];
export const activeCount=node=>activeJobs(node).length;
export const hasCapacity=node=>activeCount(node)<requestCapacity(node);
export const oldestActive=node=>activeJobs(node).reduce((oldest,job)=>!oldest||job.dispatchedMono<oldest.dispatchedMono?job:oldest,null);
