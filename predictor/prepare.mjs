// Freeze a private evidence snapshot and replay the SAME feature builder used
// by the running gateway. Never copy this output into the published tree.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {replay} from '../ds4-gateway/prediction-features.mjs';
import {isMain} from '../ds4-gateway/config.mjs';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export function prepare(data,profiles,output) {
  if(fs.existsSync(output))throw new Error('Candidate directory already exists');
  const files=fs.readdirSync(data).filter(f=>/^routing-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort(),events=[],blobs=[];let bytes=0;
  for(const name of files){const full=path.join(data,name);if(!fs.lstatSync(full).isFile())throw new Error('Evidence must be a regular file');const fd=fs.openSync(full,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const size=fs.fstatSync(fd).size;bytes+=size;if(bytes>128*1024**2)throw new Error('Training snapshot exceeds 128 MiB; no input silently discarded');const b=Buffer.alloc(size);let n=0;while(n<size){const r=fs.readSync(fd,b,n,size-n,n);if(!r)throw new Error('Evidence shrank during snapshot');n+=r;}blobs.push({name,bytes:b});const text=b.toString('utf8'),end=text.lastIndexOf('\n');for(const line of text.slice(0,end<0?0:end).split('\n').filter(Boolean))events.push(JSON.parse(line));}finally{fs.closeSync(fd);}}
  if(!files.length)throw new Error('No evidence files');
  if(!fs.lstatSync(profiles).isFile())throw new Error('Inventory must be a regular file');const inventoryBytes=fs.readFileSync(profiles),inventory=JSON.parse(inventoryBytes);
  if(inventory.schema!==1||!inventory.workers)throw new Error('Versioned worker inventory required');
  const dataset=replay(events,inventory);if(dataset.rows.length>100000)throw new Error('Prepared data exceeds bounded trainer row budget');
  fs.mkdirSync(path.join(output,'snapshots'),{recursive:true,mode:0o700});
  for(const b of blobs)fs.writeFileSync(path.join(output,'snapshots',b.name),b.bytes,{flag:'wx',mode:0o600});
  fs.writeFileSync(path.join(output,'snapshots','worker-inventory.json'),inventoryBytes,{flag:'wx',mode:0o600});
  dataset.snapshot={created_at:new Date().toISOString(),bytes,hashes:Object.fromEntries([...blobs.map(b=>[b.name,hash(b.bytes)]),['worker-inventory.json',hash(inventoryBytes)]]),feature_builder_sha256:hash(fs.readFileSync(new URL('../ds4-gateway/prediction-features.mjs',import.meta.url)))};
  fs.writeFileSync(path.join(output,'prepared.json'),JSON.stringify(dataset)+'\n',{flag:'wx',mode:0o600});return {rows:dataset.rows.length,kinds:Object.fromEntries(['admission','updated','remaining'].map(k=>[k,dataset.rows.filter(r=>r.kind===k).length])),snapshot:dataset.snapshot};
}
if(isMain(import.meta.url))try{const args=process.argv.slice(2),get=k=>{const i=args.indexOf(k);if(i<0||!args[i+1])throw new Error('Use --data --profiles --output');return path.resolve(args[i+1]);};console.log(JSON.stringify(prepare(get('--data'),get('--profiles'),get('--output'))));}catch(e){console.error(e.message);process.exitCode=1;}
