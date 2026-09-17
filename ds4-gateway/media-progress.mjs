// Optional observation only. REST history remains authoritative for completion.
export function watchMediaProgress(backend, jobId, nodes = {}, {socketFactory=url=>new WebSocket(url), now=Date.now} = {}) {
  let socket, closed=false;
  let state={connected:false,at:null,node:null,node_type:null,value:null,max:null};
  const close=()=>{closed=true;state={...state,connected:false};try{socket?.close();}catch{/* Connecting socket is closed on open. */}};
  const result={snapshot:()=>({...state}),close};
  // The current product connection is an authenticated SSH tunnel. Native token
  // endpoints keep REST observation; never place their credentials in a WS URL.
  if(backend.kind!=='comfyui'||backend.token)return result;
  try{
    const url=new URL('/ws',backend.url);url.protocol=url.protocol==='https:'?'wss:':'ws:';url.searchParams.set('clientId',jobId);
    socket=socketFactory(url);
    socket.addEventListener('open',()=>{if(closed){close();return;}state={...state,connected:true};});
    socket.addEventListener('close',()=>{state={...state,connected:false};});
    socket.addEventListener('error',()=>{state={...state,connected:false};});
    socket.addEventListener('message',event=>{
      if(closed||typeof event.data!=='string'||event.data.length>65536)return;
      let value;try{value=JSON.parse(event.data);}catch{return;}
      const d=value?.data;
      if(d?.prompt_id!==jobId||!['executing','progress'].includes(value.type))return;
      const node=typeof d.node==='string'&&d.node.length<=128?d.node:null;
      if(value.type==='executing'){
        state={connected:true,at:now(),node,node_type:nodes[node]?.class_type??null,value:null,max:null};return;
      }
      if(!node||!Number.isSafeInteger(d.value)||!Number.isSafeInteger(d.max)||d.max<=0||d.value<0||d.value>d.max)return;
      state={connected:true,at:now(),node,node_type:nodes[node]?.class_type??null,value:d.value,max:d.max};
    });
  }catch{close();}
  return result;
}
