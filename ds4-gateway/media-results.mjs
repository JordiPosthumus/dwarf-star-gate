import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {Readable,Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';

const types={'.wav':'audio/wav','.mp3':'audio/mpeg','.flac':'audio/flac','.ogg':'audio/ogg','.opus':'audio/ogg','.m4a':'audio/mp4','.aac':'audio/aac','.mp4':'video/mp4','.webm':'video/webm','.mov':'video/quicktime','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif'};
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

// Only fetch result files through the originally enrolled engine. Native
// receipts must not send the gateway or its credentials to another host.
export function mediaOutputFiles(backend,result){
  const files=[];
  const add=(url,name)=>{
    const filename=path.posix.basename(name.replaceAll('\\','/')),extension=path.extname(filename).toLowerCase();
    if(!types[extension])return;
    if(url.origin!==backend.url.origin||url.username||url.password||url.hash)throw new Error('Media output points outside its enrolled engine');
    if(!files.some(f=>f.url===url.href))files.push({url:url.href,filename,extension,content_type:types[extension]});
  };
  if(backend.kind==='ace-step'){
    for(const item of Array.isArray(result)?result:[]){
      if(typeof item?.file!=='string'||!item.file)continue;
      let url;
      if(/^https?:\/\//.test(item.file)||item.file.startsWith('/v1/audio?'))url=new URL(item.file,backend.url);
      else {url=new URL('/v1/audio',backend.url);url.searchParams.set('path',item.file);}
      if(url.pathname!=='/v1/audio'||!url.searchParams.get('path'))throw new Error('Unexpected ACE-Step output route');
      add(url,url.searchParams.get('path'));
    }
  }else if(backend.kind==='comfyui'){
    for(const node of Object.values(result?.outputs??{}))for(const entries of Object.values(node??{})){
      for(const item of Array.isArray(entries)?entries:[]){
        if(typeof item?.filename!=='string'||item.type!=='output')continue;
        const url=new URL('/view',backend.url);url.searchParams.set('filename',item.filename);url.searchParams.set('type','output');url.searchParams.set('subfolder',item.subfolder??'');add(url,item.filename);
      }
    }
  }else throw new Error('Unsupported media backend');
  if(!files.length)throw new Error('Native job has no supported output files to retain');
  return files;
}

export class MediaResults {
  constructor(directory){this.directory=directory;}
  file(jobId,fileId){
    if(!uuid.test(jobId)||!uuid.test(fileId))throw new Error('Invalid media result identifier');
    return path.join(this.directory,jobId,fileId);
  }
  async collect(job,backend,{signal}={}){
    if(job.state!=='completed'||job.backend!==backend.kind)throw new Error('Collect from the completed job and its original backend');
    const sources=mediaOutputFiles(backend,job.result),files=[];
    for(const source of sources){
      const id=randomUUID(),target=this.file(job.id,id),temporary=`${target}.part`;
      fs.mkdirSync(path.dirname(target),{recursive:true,mode:0o700});
      try{
        const response=await backend.fetch(source.url,{redirect:'error',signal,headers:backend.token?{authorization:`Bearer ${backend.token}`}:{}});
        if(!response.ok||!response.body)throw new Error(`Media output download failed (HTTP ${response.status})`);
        const hash=createHash('sha256');let bytes=0;
        const meter=new Transform({transform(chunk,_encoding,callback){bytes+=chunk.length;hash.update(chunk);callback(null,chunk);}});
        await pipeline(Readable.fromWeb(response.body),meter,fs.createWriteStream(temporary,{flags:'wx',mode:0o600}),{signal});
        if(bytes===0)throw new Error('Native output file was empty');
        const declared=response.headers.get('content-length');
        if(declared!==null&&!response.headers.get('content-encoding')&&Number(declared)!==bytes)throw new Error('Native output download was incomplete');
        const fd=fs.openSync(temporary,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
        fs.renameSync(temporary,target);
        const dir=fs.openSync(path.dirname(target),'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}
        files.push({id,filename:source.filename,content_type:source.content_type,bytes,sha256:hash.digest('hex')});
      }finally{if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
    }
    return {state:'ready',retained_at:new Date().toISOString(),files};
  }
  serve(req,res,job,fileId){
    const file=job.outputs?.state==='ready'&&job.outputs.files?.find(f=>f.id===fileId);
    if(!file)return false;
    const target=this.file(job.id,fileId);
    let fd;
    try{fd=fs.openSync(target,'r');if(fs.fstatSync(fd).size!==file.bytes)throw new Error('Retained output size differs');}
    catch(e){if(fd!==undefined)fs.closeSync(fd);throw e;}
    const stream=fs.createReadStream(target,{fd,autoClose:true});
    stream.on('error',()=>res.destroy());res.once('close',()=>stream.destroy());
    res.writeHead(200,{'content-type':file.content_type,'content-length':file.bytes,'cache-control':'private, no-store','x-content-type-options':'nosniff','content-disposition':`attachment; filename*=UTF-8''${encodeURIComponent(file.filename).replaceAll("'",'%27')}`});
    stream.pipe(res);return true;
  }
}
