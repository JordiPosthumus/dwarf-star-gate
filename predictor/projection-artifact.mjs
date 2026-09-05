// Private, offline evidence only. Not a prepared dataset or model activation.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {isMain} from '../ds4-gateway/config.mjs';
import {loadProjectionFiles,auditReplayProjection,projectReplayEvent} from './replay-projection.mjs';
import {TRAINING_INPUT_LIMIT} from './training-input.mjs';

const schemas=['dsg-latency-v2','dsg-latency-v3','dsg-latency-v4','dsg-occupancy-v1','dsg-occupancy-v2'];
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
function reject(code){throw Object.assign(new Error(code),{artifactCode:code});}
function directory(dir){
  const s=fs.lstatSync(dir);
  if(!s.isDirectory()||fs.realpathSync(dir)!==path.resolve(dir)||(s.mode&0o777)!==0o700||s.uid!==process.getuid())reject('private_directory_required');
}
function build(data,profiles){
  const {events,inventory,source}=loadProjectionFiles(data,profiles);
  if(source.incomplete_tails)reject('incomplete_source_tail');
  // One pinned in-memory input, not five independently read live snapshots.
  const checks=schemas.map(schema=>{
    const a=auditReplayProjection(events,inventory,{schema});
    if(!a.parity||!a.metadata_equal||a.changed_rows!==0)reject('replay_mismatch');
    return {feature_schema:schema,feature_builder_sha256:a.feature_builder_sha256,projector_sha256:a.projector_sha256,
      source_canonical_sha256:a.source_canonical_sha256,original_rows:a.original_rows,projected_rows:a.projected_rows,
      parity:a.parity,metadata_equal:a.metadata_equal,changed_rows:a.changed_rows};
  });
  const chunks=[];let bytes=0;
  for(const event of events){const b=Buffer.from(JSON.stringify(projectReplayEvent(event))+'\n');bytes+=b.length;
    if(bytes>TRAINING_INPUT_LIMIT)reject('projected_byte_budget');chunks.push(b);}
  const payloads={'events.jsonl':Buffer.concat(chunks,bytes),'inventory.json':Buffer.from(JSON.stringify(inventory)+'\n')};
  if(payloads['inventory.json'].length>1024**2)reject('inventory_byte_budget');
  const manifest={schema:1,format:'dsg-offline-replay-projection',authority:'none',production_enabled:false,
    artifact_builder_sha256:digest(fs.readFileSync(new URL(import.meta.url))),source,events:events.length,checks,
    files:Object.fromEntries(Object.entries(payloads).map(([name,b])=>[name,{bytes:b.length,sha256:digest(b)}]))};
  if(Buffer.byteLength(JSON.stringify(manifest)+'\n')>1024**2)reject('manifest_byte_budget');
  return {manifest,payloads};
}
function writeExclusive(file,bytes){
  const fd=fs.openSync(file,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
  try{let offset=0;while(offset<bytes.length){const n=fs.writeSync(fd,bytes,offset,bytes.length-offset);if(n<=0)reject('short_write');offset+=n;}fs.fsyncSync(fd);}
  finally{fs.closeSync(fd);}
}
function readPrivate(file,max){
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
  try{const s=fs.fstatSync(fd);
    if(!s.isFile()||s.nlink!==1||(s.mode&0o777)!==0o600||s.uid!==process.getuid())reject('private_file_required');
    if(!Number.isSafeInteger(s.size)||s.size<0||s.size>max)reject('artifact_byte_budget');
    const b=Buffer.alloc(s.size);let offset=0;
    while(offset<b.length){const n=fs.readSync(fd,b,offset,b.length-offset,offset);if(!n)reject('artifact_shrank');offset+=n;}
    return b;
  }finally{fs.closeSync(fd);}
}
export function createProjectionArtifact(data,profiles,output){
  // Never overwrite existing output, including dangling links. A failed write
  // leaves inspectable partial files; no manifest means no completed artifact.
  try{fs.lstatSync(output);reject('output_exists');}catch(e){if(e.code!=='ENOENT')throw e;}
  const parent=path.dirname(path.resolve(output));
  if(fs.realpathSync(parent)!==parent)reject('symlinked_output_parent');
  const {manifest,payloads}=build(data,profiles);
  fs.mkdirSync(output,{mode:0o700});directory(output);
  for(const [name,b] of Object.entries(payloads))writeExclusive(path.join(output,name),b);
  writeExclusive(path.join(output,'manifest.json'),Buffer.from(JSON.stringify(manifest)+'\n'));
  const fd=fs.openSync(output,fs.constants.O_RDONLY);try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  return {schema:1,state:'created',authority:'none',production_enabled:false,events:manifest.events,
    projected_bytes:manifest.files['events.jsonl'].bytes,schemas:manifest.checks.length,manifest_sha256:digest(JSON.stringify(manifest))};
}
export function verifyProjectionArtifact(data,profiles,output){
  directory(output);
  if(!isDeepStrictEqual(fs.readdirSync(output).sort(),['events.jsonl','inventory.json','manifest.json']))reject('unexpected_artifact_files');
  const manifest=JSON.parse(readPrivate(path.join(output,'manifest.json'),1024**2));
  // Do not trust names, paths, schemas or hashes chosen by an artifact. Rebuild
  // its entire deterministic manifest from original evidence and current code.
  const expected=build(data,profiles);
  if(!isDeepStrictEqual(manifest,expected.manifest))reject('provenance_mismatch');
  for(const [name,bytes] of Object.entries(expected.payloads)){
    const actual=readPrivate(path.join(output,name),name==='events.jsonl'?TRAINING_INPUT_LIMIT:1024**2);
    if(!actual.equals(bytes))reject('payload_mismatch');
  }
  return {schema:1,state:'verified',authority:'none',production_enabled:false,events:manifest.events,
    schemas:manifest.checks.length,manifest_sha256:digest(JSON.stringify(manifest))};
}
export function artifactArgs(args){
  const [mode,...rest]=args;if(!['create','verify'].includes(mode))reject('invalid_arguments');const values=new Map();
  for(let i=0;i<rest.length;i+=2){const k=rest[i],v=rest[i+1];
    if(!['--data','--profiles','--output'].includes(k)||values.has(k)||!v||v.startsWith('--'))reject('invalid_arguments');values.set(k,v);}
  if(values.size!==3)reject('invalid_arguments');
  return {mode,args:['--data','--profiles','--output'].map(k=>path.resolve(values.get(k)))};
}
if(isMain(import.meta.url))try{
  const {mode,args}=artifactArgs(process.argv.slice(2));
  console.log(JSON.stringify((mode==='create'?createProjectionArtifact:verifyProjectionArtifact)(...args)));
}catch(e){console.error('Projection artifact failed: '+(e.artifactCode??e.projectionCode??'invalid_input_or_storage'));process.exitCode=1;}
