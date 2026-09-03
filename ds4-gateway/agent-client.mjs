import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

export function readAgentCredential(file) {
  if(!file||!path.isAbsolute(file))throw new Error('Use an absolute --credential-file path or DSG_AGENT_CREDENTIALS');
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try {
    const stat=fs.fstatSync(fd);
    if(!stat.isFile()||stat.size>4096||(stat.mode&0o077)!==0||(process.getuid&&stat.uid!==process.getuid()))throw new Error('Credential file must be private, owned by this user and at most 4096 bytes');
    const data=JSON.parse(fs.readFileSync(fd,'utf8'));
    if(data.schema!==1||!path.isAbsolute(data.control_socket??'')||typeof data.token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(data.token))throw new Error('Invalid agent credential file');
    return data;
  }finally{fs.closeSync(fd);}
}

export function agentRequest(credential,action,body) {
  if(!['status','drain','resume','receipt'].includes(action))return Promise.reject(new Error('Unsupported agent action'));
  return new Promise((resolve,reject)=>{
    const req=http.request({socketPath:credential.control_socket,path:'/agent/v1/'+action,
      method:action==='status'?'GET':'POST',agent:false,headers:{authorization:'Bearer '+credential.token,'content-type':'application/json'}},res=>{
      let data='';res.on('data',chunk=>{data+=chunk;if(Buffer.byteLength(data)>1048576)req.destroy(new Error('Agent response too large'));});
      res.on('error',reject);res.on('end',()=>{
        try{const value=JSON.parse(data);if(res.statusCode>=400)return reject(Object.assign(new Error(value.error?.message??'Agent request failed'),{code:value.error?.code,status:res.statusCode}));resolve(value);}
        catch{reject(new Error('Invalid agent response'));}
      });
    });
    const timer=setTimeout(()=>req.destroy(new Error('Agent request timed out; look up its request_id receipt before retrying')),30000);
    req.on('close',()=>clearTimeout(timer));req.on('error',reject);
    req.end(body===undefined?undefined:JSON.stringify(body));
  });
}
