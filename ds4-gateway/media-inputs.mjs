import fs from 'node:fs';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';

const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const extensions={'image/png':'.png','image/jpeg':'.jpg','image/webp':'.webp','image/gif':'.gif','audio/wav':'.wav','audio/x-wav':'.wav','audio/flac':'.flac','audio/mpeg':'.mp3','audio/ogg':'.ogg','video/mp4':'.mp4','video/webm':'.webm'};
const fail=(status,message)=>Object.assign(new Error(message),{status});
// Private staging for the existing authenticated media API, not a public file host.
// Completed inputs stay until explicit deletion; unsuccessful new uploads roll back.
export class MediaInputs {
  constructor(directory,{input_max_bytes=100*1024*1024,input_total_bytes=2*1024**3}={}){
    if(!Number.isSafeInteger(input_max_bytes)||input_max_bytes<1||!Number.isSafeInteger(input_total_bytes)||input_total_bytes<input_max_bytes)throw Error('Invalid media input storage limits');
    this.directory=directory;this.maxBytes=input_max_bytes;this.totalBytes=input_total_bytes;this.pending=new Map();
  }
  get active(){return this.pending.size;}
  file(id){if(typeof id!=='string'||!uuid.test(id))throw fail(400,'Invalid video input ID');return path.join(this.directory,id,'data');}
  usedBytes(){
    if(!fs.existsSync(this.directory))return 0;
    let total=0;
    for(const id of fs.readdirSync(this.directory))if(uuid.test(id)&&!this.pending.has(id))for(const name of ['data','data.partial']){
      try{total+=fs.statSync(path.join(this.directory,id,name)).size;}catch(e){if(e.code!=='ENOENT')throw e;}
    }
    return total;
  }
  info(id){
    const file=this.file(id);let value;
    try{value=JSON.parse(fs.readFileSync(path.join(path.dirname(file),'metadata.json'),'utf8'));}
    catch(e){throw fail(e.code==='ENOENT'?404:409,'Video input metadata is unavailable; stored files were preserved.');}
    if(value.id!==id||!extensions[value.content_type]||value.name!==`stargate/${id}${extensions[value.content_type]}`||!Number.isSafeInteger(value.bytes)||value.bytes<1||!/^[a-f0-9]{64}$/.test(value.sha256))throw fail(409,'Video input metadata is invalid; stored files were preserved.');
    try{const st=fs.lstatSync(file);if(!st.isFile()||st.size!==value.bytes)throw Error();}catch{throw fail(409,'Video input data is unavailable; stored files were preserved.');}
    return {id:value.id,name:value.name,content_type:value.content_type,bytes:value.bytes,sha256:value.sha256};
  }
  forJob(ids){
    if(ids===undefined)return [];
    if(!Array.isArray(ids))throw fail(400,'input_files must be an array of uploaded video input IDs');
    return [...new Set(ids)].map(id=>this.info(id));
  }
  remove(id){
    const folder=path.dirname(this.file(id));if(this.pending.has(id))throw fail(409,'Video input upload is still running');
    if(!fs.existsSync(folder))throw fail(404,'Unknown video input');
    fs.rmSync(folder,{recursive:true});return {id,deleted:true};
  }
  async receive(req){
    if(req.headers['content-length']==='0'||(!req.headers['content-length']&&!req.headers['transfer-encoding']))throw fail(400,'Empty body; upload a nonempty image, audio or video file.');
    const content_type=(req.headers['content-type']??'').split(';')[0].trim().toLowerCase(),extension=extensions[content_type];
    if(!extension)throw fail(415,'Use a supported image, audio or video Content-Type for the raw file upload.');
    const declared=req.headers['content-length'];if(typeof declared!=='string'||!/^\d+$/.test(declared))throw fail(411,'Content-Length is required for video input uploads');
    const length=Number(declared);if(!Number.isSafeInteger(length)||length<1||length>this.maxBytes)throw fail(413,`Video input must be between 1 and ${this.maxBytes} bytes`);
    fs.mkdirSync(this.directory,{recursive:true,mode:0o700});
    const reserved=[...this.pending.values()].reduce((a,b)=>a+b,0),disk=fs.statfsSync(this.directory);
    if(this.usedBytes()+reserved+length>this.totalBytes||disk.bavail*disk.bsize<length+64*1024*1024)throw fail(507,'Video input storage is full; explicitly delete unused inputs or adjust the configured storage limit.');
    const id=randomUUID(),folder=path.dirname(this.file(id));fs.mkdirSync(folder,{mode:0o700});
    const partial=path.join(folder,'data.partial'),hash=createHash('sha256');let bytes=0,complete=false;
    const meter=new Transform({transform(chunk,_encoding,done){bytes+=chunk.length;if(bytes>length)return done(fail(413,'Video input exceeded its declared size'));hash.update(chunk);done(null,chunk);}});
    this.pending.set(id,length);
    try{
      await pipeline(req,meter,fs.createWriteStream(partial,{flags:'wx',mode:0o600}));
      if(bytes!==length)throw fail(400,'Video input was incomplete');
      const fd=fs.openSync(partial,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
      fs.renameSync(partial,this.file(id));
      const info={id,name:`stargate/${id}${extension}`,content_type,bytes,sha256:hash.digest('hex')};
      const meta=fs.openSync(path.join(folder,'metadata.json'),'wx',0o600);try{fs.writeFileSync(meta,JSON.stringify(info)+'\n');fs.fsyncSync(meta);}finally{fs.closeSync(meta);}
      const dir=fs.openSync(folder,'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}
      complete=true;return info;
    }finally{this.pending.delete(id);if(!complete)fs.rmSync(folder,{recursive:true,force:true});}
  }
}
