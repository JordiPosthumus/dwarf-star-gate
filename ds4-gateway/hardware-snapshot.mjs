// Private dashboard-to-core bridge. Never used as a control channel.
import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
import {hardwareFeatures} from './prediction-hardware.mjs';
const ID=/^[\w-]{1,64}$/;
export function safeHardwareSnapshot(raw,node,at=Date.now()){
  if(!ID.test(node??''))return null;
  const f=hardwareFeatures(raw,at,node);if(f.hardware_sample_age_s===null)return null;
  const out={node,time:raw.time,observed_at:raw.observed_at};
  for(const [feature,keys] of [
    ['hardware_memory_used_fraction',['memory_used_bytes','memory_total_bytes','memory_scope']],
    ['hardware_activity_pct',['accelerator_activity_pct','accelerator_scope']],
    ['hardware_power_watts',['power_watts','power_scope']],
    ['hardware_clock_mhz',['clock_mhz','clock_scope']]
  ])if(f[feature]!==null)for(const key of keys)out[key]=raw[key];
  return Object.keys(out).length>3?out:null;
}
export class HardwareSnapshot {
  constructor(file,{now=Date.now}={}){this.file=file;this.now=now;this.rows=new Map();this.nextRead=0;this.error=null;}
  write(raw){let temporary;
    try{const at=this.now(),row=safeHardwareSnapshot(raw,raw?.node,at);if(!row)return;
      this.rows.set(row.node,row);for(const [id,sample] of this.rows)if(!safeHardwareSnapshot(sample,id,at))this.rows.delete(id);
      while(this.rows.size>128)this.rows.delete(this.rows.keys().next().value);
      temporary=this.file+'.'+randomUUID()+'.tmp';
      fs.writeFileSync(temporary,JSON.stringify({schema:1,samples:[...this.rows.values()]}),{mode:0o600,flag:'wx'});
      fs.renameSync(temporary,this.file);this.error=null;
    }catch{this.error='hardware_snapshot_write_failed';}finally{if(temporary)try{fs.unlinkSync(temporary);}catch{}}
  }
  get(node,at=this.now()){
    if(at>=this.nextRead){this.nextRead=at+1000;let fd;
      try{fd=fs.openSync(this.file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);const stat=fs.fstatSync(fd);
        if(!stat.isFile()||stat.size>256*1024)throw new Error();
        const bytes=Buffer.alloc(stat.size);let offset=0;while(offset<bytes.length){const n=fs.readSync(fd,bytes,offset,bytes.length-offset,offset);if(!n)throw new Error();offset+=n;}
        const data=JSON.parse(bytes.toString());if(data.schema!==1||!Array.isArray(data.samples)||data.samples.length>128)throw new Error();
        this.rows.clear();for(const raw of data.samples){const row=safeHardwareSnapshot(raw,raw?.node,at);if(row)this.rows.set(row.node,row);}this.error=null;
      }catch{this.rows.clear();this.error='hardware_snapshot_unavailable';}finally{if(fd!==undefined)fs.closeSync(fd);}
    }
    return safeHardwareSnapshot(this.rows.get(node),node,at);
  }
}
