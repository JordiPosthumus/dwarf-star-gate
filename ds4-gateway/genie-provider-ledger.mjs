// Completed pool-fallback receipts only. Never conversation text or action authority.
import fs from 'node:fs';
import path from 'node:path';
import {validCallId} from './continuity.mjs';

export const PROVIDER_LEDGER_LIMIT=16*1024*1024;
const unavailable='Pool action history unavailable; inspect private storage. No automatic repair or deletion.';
function receipt(value){
  if(!value||validCallId(value.id)!==value.id||!Number.isSafeInteger(value.time)||value.time<0||value.served_by!=='pool_fallback'||
    !(value.served_on===null||typeof value.served_on==='string'&&/^[\w-]{1,64}$/.test(value.served_on)))throw new Error('Invalid receipt');
  return {id:value.id,time:value.time,served_by:'pool_fallback',served_on:value.served_on};
}
export class GenieProviderLedger {
  constructor(directory,{maxBytes=PROVIDER_LEDGER_LIMIT,io=fs}={}){
    this.directory=path.resolve(directory);this.file=path.join(this.directory,'pool-actions.jsonl');this.maxBytes=maxBytes;this.io=io;
    this.bytes=0;this.rows=[];this.seen=new Map();this.identity=null;this.error=null;this.loaded=false;
    try{
      if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>PROVIDER_LEDGER_LIMIT)throw new Error();
      let exists=true;try{fs.lstatSync(directory);}catch(error){if(error.code!=='ENOENT')throw error;exists=false;}
      if(exists)this.load();
      this.loaded=true;
    }catch{this.rows=[];this.seen.clear();this.error=unavailable;}
  }
  checkDirectory(){
    const info=fs.lstatSync(this.directory);
    if(fs.realpathSync(this.directory)!==path.resolve(this.directory)||!info.isDirectory()||(info.mode&0o777)!==0o700||info.uid!==process.getuid())throw new Error();
  }
  open(flags){
    const fd=fs.openSync(this.file,flags|fs.constants.O_NOFOLLOW,0o600),s=fs.fstatSync(fd);
    if(!s.isFile()||s.nlink!==1||(s.mode&0o777)!==0o600||s.uid!==process.getuid()){fs.closeSync(fd);throw new Error();}
    return fd;
  }
  apply(row){
    this.seen.set(row.id,JSON.stringify(row));
    this.rows.push(row);this.rows.sort((a,b)=>b.time-a.time||a.id.localeCompare(b.id));this.rows=this.rows.slice(0,30);
  }
  load(){
    this.checkDirectory();
    // lstat, not existsSync: dangling links are not an empty ledger.
    try{fs.lstatSync(this.file);}catch(error){if(error.code==='ENOENT')return;throw error;}
    const fd=this.open(fs.constants.O_RDONLY);let text,s;
    try{
      s=fs.fstatSync(fd);if(s.size>this.maxBytes)throw new Error();const bytes=Buffer.alloc(s.size);
      let at=0;while(at<bytes.length){const n=fs.readSync(fd,bytes,at,bytes.length-at,at);if(n<=0)throw new Error();at+=n;}
      if(fs.fstatSync(fd).size!==s.size)throw new Error();text=bytes.toString('utf8');
    }finally{fs.closeSync(fd);}
    if(text&&!text.endsWith('\n'))throw new Error();
    for(const line of text.split('\n').filter(Boolean)){
      if(Buffer.byteLength(line)>512)throw new Error();const event=JSON.parse(line);
      if(event.schema!==1||Object.keys(event).sort().join(',')!=='id,schema,served_by,served_on,time')throw new Error();
      const row=receipt(event);if(this.seen.has(row.id))throw new Error();this.apply(row);
    }
    this.bytes=s.size;this.identity={dev:s.dev,ino:s.ino};
  }
  append(value){
    if(this.error)return false;
    let lock,fd,saved=false;
    try{
      const row=receipt(value),previous=this.seen.get(row.id);
      if(previous!==undefined){if(previous!==JSON.stringify(row))throw new Error();return true;}
      const bytes=Buffer.from(JSON.stringify({schema:1,...row})+'\n');
      if(this.bytes+bytes.length>this.maxBytes){this.error='Pool action history storage ceiling reached; new receipts are session-only. Nothing deleted.';return false;}
      const created=fs.mkdirSync(this.directory,{recursive:true,mode:0o700});this.checkDirectory();
      lock=fs.openSync(path.join(this.directory,'writer.lock'),fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
      fd=this.open(fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_APPEND);
      const s=fs.fstatSync(fd);
      if(s.size!==this.bytes||this.identity&&(s.dev!==this.identity.dev||s.ino!==this.identity.ino))throw new Error();
      let at=0;while(at<bytes.length){const n=this.io.writeSync(fd,bytes,at,bytes.length-at);if(!Number.isInteger(n)||n<=0||n>bytes.length-at)throw new Error();at+=n;}
      this.io.fsyncSync(fd);
      // Include the parent entries of newly created directories, not only the
      // journal entry itself. Never acknowledge just a buffered file write.
      const through=created?path.dirname(created):this.directory;
      for(let current=this.directory;;current=path.dirname(current)){
        const directory=fs.openSync(current,fs.constants.O_RDONLY);try{this.io.fsyncSync(directory);}finally{fs.closeSync(directory);}
        if(current===through)break;
      }
      this.bytes+=bytes.length;this.identity={dev:s.dev,ino:s.ino};this.apply(row);saved=true;
    }catch{this.error=unavailable;}
    finally{
      // A cleanup failure is diagnostic too, never an exception into Genie's
      // completed review or a reason to issue inference/actions a second time.
      try{if(fd!==undefined)fs.closeSync(fd);}catch{this.error=unavailable;}
      if(lock!==undefined){try{fs.closeSync(lock);fs.unlinkSync(path.join(this.directory,'writer.lock'));}catch{this.error=unavailable;}}
    }
    return saved&&!this.error;
  }
  recent(){return this.rows.map(row=>({...row}));}
  status(){return {available:this.loaded&&!this.error,error:this.error,bytes:this.loaded?this.bytes:null,max_bytes:this.maxBytes,saved_receipts:this.loaded?this.seen.size:null,scope:'completed pool-fallback receipts; no review text or action authority'};}
}
