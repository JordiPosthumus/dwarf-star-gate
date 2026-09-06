import http from 'node:http';
const undispatched=new WeakSet();
export const genieNotDispatched=error=>!!error&&typeof error==='object'&&undispatched.has(error);

// Node's built-in fetch has a separate five-minute response-header deadline.
// Long DS4 prefills can legitimately exceed that even when the operator has
// configured a much larger Genie deadline. Use the native HTTP client for the
// already-validated loopback endpoint so the explicit AbortSignal remains the
// one authoritative deadline. The response stays streamed and bounded by
// modelAnswer; no request or response content is persisted here.
export function genieLoopbackFetch(url,{method='POST',headers={},body='',signal}={}) {
  return new Promise((resolve,reject)=>{
    let target;
    try {target=new URL(url);} catch(error){reject(error);return;}
    if(target.protocol!=='http:'||target.hostname!=='127.0.0.1'||target.username||target.password){reject(new Error('Genie transport requires a loopback HTTP endpoint'));return;}
    const payload=typeof body==='string'||Buffer.isBuffer(body)?body:String(body??'');
    let response=null,settled=false,observedSocket=false,connected=false;
    const abortError=()=>new DOMException('Aborted','AbortError');
    const request=http.request(target,{method,agent:false,headers:{...headers,'content-length':Buffer.byteLength(payload)}},incoming=>{
      response=incoming;settled=true;
      const node=typeof incoming.headers['x-ds4-node']==='string'&&/^[\w-]{1,64}$/.test(incoming.headers['x-ds4-node'])?incoming.headers['x-ds4-node']:null;
      resolve({ok:incoming.statusCode>=200&&incoming.statusCode<300,status:incoming.statusCode,body:incoming,node});
    });
    const abort=()=>{const error=abortError();response?.destroy(error);request.destroy(error);};
    request.on('socket',socket=>{observedSocket=true;connected=!socket.connecting;socket.once('connect',()=>{connected=true;});});
    request.on('error',error=>{
      if(!settled){
        // agent:false guarantees a new connection. Only a witnessed socket that
        // never connected, then refused TCP, proves no provider received bytes.
        if(observedSocket&&!connected&&request.reusedSocket===false&&error.code==='ECONNREFUSED')undispatched.add(error);
        reject(error);
      }
    });
    request.on('close',()=>signal?.removeEventListener('abort',abort));
    if(signal?.aborted){abort();return;}
    signal?.addEventListener('abort',abort,{once:true});
    request.end(payload);
  });
}
