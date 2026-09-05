// Two durable display-only high-water marks; never a routing or model input.
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
const FILE=/^metrics-\d{4}-\d{2}-\d{2}\.jsonl$/,KINDS=['prefill','decode'];
const valid=(p,now)=>p&&Number.isFinite(p.tps)&&p.tps>0&&Number.isFinite(p.time)&&p.time>0&&p.time<=now;
export class RatePeaks {
  constructor(directory,{readBytes=1024*1024,now=Date.now}={}){
    if(!path.isAbsolute(directory)||!Number.isSafeInteger(readBytes)||readBytes<1024||readBytes>4*1024*1024)throw new Error('Invalid rate-peak reader');
    Object.assign(this,{directory,readBytes,now});this.file=path.join(directory,'rate-peaks.json');
    this.peaks={prefill:null,decode:null};this.cursors=new Map();this.dirty=false;this.status='catching_up';this.error=null;this.loadFailed=false;this.malformed=0;
    let fd;
    try{
      this.checkDirectory();fd=fs.openSync(this.file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
      const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.size>4096)throw new Error();
      const data=JSON.parse(fs.readFileSync(fd,'utf8'));if(data.schema!==1)throw new Error();
      for(const kind of KINDS){if(data[kind]!==null&&!valid(data[kind],now()))throw new Error();}
      for(const kind of KINDS)if(data[kind])this.peaks[kind]={tps:data[kind].tps,time:data[kind].time};
    }catch(error){if(error.code!=='ENOENT'){this.error='peak_record_unreadable';this.loadFailed=true;}}
    finally{if(fd!==undefined)fs.closeSync(fd);}
  }
  checkDirectory(){const stat=fs.lstatSync(this.directory);if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error();}
  accept(row){
    if(!KINDS.includes(row?.kind)||!valid(row,this.now())||! /^[a-zA-Z0-9][\w-]{0,63}$/.test(row.node??''))return;
    if(!this.peaks[row.kind]||row.tps>this.peaks[row.kind].tps){this.peaks[row.kind]={tps:row.tps,time:row.time};this.dirty=true;}
  }
  flush(){
    if(!this.dirty||this.loadFailed)return;
    let temporary;
    try{
      this.checkDirectory();
      try{const stat=fs.lstatSync(this.file);if(!stat.isFile()||stat.isSymbolicLink())throw new Error();}catch(error){if(error.code!=='ENOENT')throw error;}
      temporary=this.file+'.'+randomUUID()+'.tmp';
      fs.writeFileSync(temporary,JSON.stringify({schema:1,...this.peaks})+'\n',{mode:0o600,flag:'wx'});
      fs.renameSync(temporary,this.file);this.dirty=false;this.error=null;
    }catch{this.error='peak_record_write_failed';}
    finally{if(temporary)try{fs.unlinkSync(temporary);}catch{}}
  }
  poll(){
    try{
      this.checkDirectory();const files=fs.readdirSync(this.directory).filter(name=>FILE.test(name)).sort();let budget=this.readBytes,backlog=false;
      for(const name of this.cursors.keys())if(!files.includes(name))this.cursors.delete(name);
      for(const name of files){
        if(budget===0){backlog=true;break;}
        const fd=fs.openSync(path.join(this.directory,name),fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
        try{
          const stat=fs.fstatSync(fd);if(!stat.isFile())throw new Error();
          const identity=`${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;let c=this.cursors.get(name);
          const anchor=c?Buffer.alloc(c.anchor.length):Buffer.alloc(0);
          if(!c||c.identity!==identity||stat.size<c.offset||(anchor.length&&(fs.readSync(fd,anchor,0,anchor.length,c.offset-anchor.length)!==anchor.length||!anchor.equals(c.anchor)))){
            c={identity,offset:0,fragment:Buffer.alloc(0),skipping:false,anchor:Buffer.alloc(0)};this.cursors.set(name,c);
          }
          const chunk=Buffer.alloc(Math.min(budget,Math.max(0,stat.size-c.offset)));
          const read=chunk.length?fs.readSync(fd,chunk,0,chunk.length,c.offset):0;c.offset+=read;budget-=read;
          const buffer=Buffer.concat([c.fragment,chunk.subarray(0,read)]);let from=0,end;
          while((end=buffer.indexOf(10,from))>=0){
            if(!c.skipping&&end-from<=65536){try{this.accept(JSON.parse(buffer.subarray(from,end).toString('utf8')));}catch{this.malformed++;}}
            c.skipping=false;from=end+1;
          }
          c.fragment=Buffer.from(buffer.subarray(from));if(c.fragment.length>65536||c.skipping){c.fragment=Buffer.alloc(0);c.skipping=true;}
          c.anchor=Buffer.alloc(Math.min(64,c.offset));if(c.anchor.length)fs.readSync(fd,c.anchor,0,c.anchor.length,c.offset-c.anchor.length);
          if(c.offset<stat.size){backlog=true;break;}
        }finally{fs.closeSync(fd);}
      }
      this.status=backlog?'catching_up':'ready';
    }catch{this.status='unavailable';}
    this.flush();
  }
  snapshot(){return {schema:1,...structuredClone(this.peaks),history_status:this.status,persistence_error:this.error,malformed_lines:this.malformed};}
}
