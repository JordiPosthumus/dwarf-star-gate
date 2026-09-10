export const MODEL_ROUTE_HEADER='x-dsg-model';
// Explicit client model selection, sent by each Pi model entry. Routing before
// body consumption preserves arbitrarily large incremental uploads.
export function modelRoutes(raw,workers){
  if(raw===undefined)return null;
  if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).length>128)throw new Error('model_routes must be a map of model IDs to worker IDs');
  const result=new Map();
  for(const [name,ids] of Object.entries(raw)){
    if(!name||name.length>256||!Array.isArray(ids)||!ids.length||ids.some(id=>typeof id!=='string'||!workers.some(w=>w.id===id)))throw new Error('Each model route must name existing workers');
    result.set(name,new Set(ids));
  }
  return result;
}
export function routeSelection(routes,header){
  if(header===undefined)return null;
  if(typeof header!=='string'||!routes?.has(header))throw new Error('Unknown DSG model route');
  return {model:header,workers:routes.get(header)};
}
export const allowsWorker=(route,worker)=>!route||route.workers.has(worker.id);
