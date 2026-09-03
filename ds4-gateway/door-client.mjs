import http from 'node:http';
export function doorControl(socketPath,route,body={}){
  return new Promise((resolve,reject)=>{
    const req=http.request({socketPath,path:route,method:route==='/status'?'GET':'POST',headers:{'content-type':'application/json','content-length':Buffer.byteLength(JSON.stringify(body))},agent:false},res=>{let text='';res.on('data',chunk=>text+=chunk);res.on('error',reject);res.on('end',()=>{try{const value=JSON.parse(text);if(res.statusCode>=400)return reject(new Error(value.error?.message??`Continuity control HTTP ${res.statusCode}`));resolve(value);}catch(error){reject(error);}});});
    req.on('error',reject);req.end(route==='/status'?'':JSON.stringify(body));
  });
}
