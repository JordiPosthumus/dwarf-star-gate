import fs from 'node:fs';
import path from 'node:path';
export function readEvidence(directory,{maxBytes=128*1024**2}={}) {
  const events=[];let bytes=0,incompleteTails=0;
  const files=fs.readdirSync(directory).filter(f=>/^routing-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
  for(const file of files){const fd=fs.openSync(path.join(directory,file),fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
    try{const stat=fs.fstatSync(fd);if(!stat.isFile()||(bytes+=stat.size)>maxBytes)throw new Error('Evidence is nonregular or exceeds the audit byte budget; no silent truncation');
      const b=Buffer.alloc(stat.size);let at=0;while(at<b.length){const n=fs.readSync(fd,b,at,b.length-at,at);if(!n)throw new Error('Evidence shrank during read');at+=n;}
      const text=b.toString('utf8'),end=text.lastIndexOf('\n');if(end!==text.length-1)incompleteTails++;
      for(const line of text.slice(0,end<0?0:end).split('\n').filter(Boolean)){try{events.push(JSON.parse(line));}catch{throw new Error('Malformed complete evidence line; inspect privately');}}
    }finally{fs.closeSync(fd);}}
  return {events,source:{files:files.length,bytes,incomplete_tails:incompleteTails}};
}
