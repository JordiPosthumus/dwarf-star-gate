#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { summarizeAttribution } from './attribution-summary.mjs';

const FILE=/^metrics-\d{4}-\d{2}-\d{2}\.jsonl$/;
const MAX_FILES=7,MAX_BYTES_PER_FILE=8*1024*1024,MAX_LINE_BYTES=64*1024,MAX_RECORDS=65536;

function boundedLines(file,maxBytes=MAX_BYTES_PER_FILE) {
  let fd;
  try{fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);}
  catch(error){if(['ELOOP','ENOENT','ENOTDIR'].includes(error.code))return {lines:[],skipped:'not_regular'};throw error;}
  try{
    const stat=fs.fstatSync(fd);if(!stat.isFile())return {lines:[],skipped:'not_regular'};
    const length=Math.min(stat.size,maxBytes),offset=stat.size-length,buffer=Buffer.alloc(length);
    if(length)fs.readSync(fd,buffer,0,length,offset);
    const text=buffer.toString('utf8'),lines=text.split('\n');if(offset>0)lines.shift();
    return {lines,partial:offset>0};
  }finally{fs.closeSync(fd);}
}

export function auditAttributionDirectory(directory,{maxFiles=MAX_FILES,maxBytesPerFile=MAX_BYTES_PER_FILE}={}) {
  if(typeof directory!=='string'||!path.isAbsolute(directory))throw new Error('Attribution audit directory must be an absolute path');
  if(!Number.isSafeInteger(maxFiles)||maxFiles<1||maxFiles>MAX_FILES)throw new Error(`maxFiles must be an integer from 1 to ${MAX_FILES}`);
  if(!Number.isSafeInteger(maxBytesPerFile)||maxBytesPerFile<1024||maxBytesPerFile>MAX_BYTES_PER_FILE)throw new Error(`maxBytesPerFile must be an integer from 1024 to ${MAX_BYTES_PER_FILE}`);
  const root=fs.lstatSync(directory);if(!root.isDirectory()||root.isSymbolicLink())throw new Error('Attribution audit directory must be a real directory');
  const files=fs.readdirSync(directory).filter(name=>FILE.test(name)).sort().slice(-maxFiles);
  const rows=[];let malformed_lines=0,oversized_lines=0,partial_files=0,skipped_files=0,truncated_records=0;
  for(const name of files){
    const result=boundedLines(path.join(directory,name),maxBytesPerFile);
    if(result.skipped){skipped_files++;continue;}if(result.partial)partial_files++;
    for(const line of result.lines){
      if(!line.trim())continue;if(Buffer.byteLength(line)>MAX_LINE_BYTES){oversized_lines++;continue;}
      try{const row=JSON.parse(line);if(row?.event==='engine_attribution'){if(rows.length<MAX_RECORDS)rows.push(row);else truncated_records++;}}
      catch{malformed_lines++;}
    }
  }
  return {schema:1,mode:'read_only_shadow_audit',files_read:files.length-skipped_files,partial_files,skipped_files,
    malformed_lines,oversized_lines,truncated_records,...summarizeAttribution(rows),
    privacy:'Counts, bounded reason codes and configured server IDs only. No prompts, responses, request IDs, sample IDs, paths or credentials are returned.'};
}

function args(argv) {
  let directory=path.resolve('runtime/dashboard'),maxFiles=3;
  for(let i=0;i<argv.length;i++){
    if(argv[i]==='--directory'&&argv[i+1])directory=path.resolve(argv[++i]);
    else if(argv[i]==='--files'&&argv[i+1])maxFiles=Number(argv[++i]);
    else if(argv[i]==='--help')return {help:true};
    else throw new Error(`Unknown or incomplete argument: ${argv[i]}`);
  }
  if(!Number.isInteger(maxFiles)||maxFiles<1||maxFiles>MAX_FILES)throw new Error(`--files must be an integer from 1 to ${MAX_FILES}`);
  return {directory,maxFiles};
}

if(import.meta.url===pathToFileURL(process.argv[1]??'').href){
  try{
    const input=args(process.argv.slice(2));
    if(input.help){console.log('Usage: node ds4-gateway/attribution-audit.mjs [--directory PATH] [--files 1..7]');process.exit(0);}
    console.log(JSON.stringify(auditAttributionDirectory(input.directory,{maxFiles:input.maxFiles}),null,2));
  }catch(error){console.error(`DSG attribution audit: ${error.message}`);process.exit(1);}
}
