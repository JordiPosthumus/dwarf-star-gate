// Metadata only: this is a size preflight, not a data-quality or fit-readiness verdict.
import fs from 'node:fs';
import path from 'node:path';
import {isMain} from '../ds4-gateway/config.mjs';

export const TRAINING_INPUT_LIMIT=128*1024**2;
export const TRAINING_INPUT_LIMIT_ERROR='Training snapshot exceeds 128 MiB; no input silently discarded';
export function trainingInputAudit(data){
  const files=fs.readdirSync(data).filter(name=>/^routing-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).sort().map(name=>{
    const stat=fs.lstatSync(path.join(data,name));
    if(!stat.isFile())throw new Error('Evidence must be a regular file');
    if(!Number.isSafeInteger(stat.size)||stat.size<0)throw new Error('Invalid evidence size');
    return {name,bytes:stat.size};
  });
  let bytes=0;
  for(const file of files){bytes+=file.bytes;if(!Number.isSafeInteger(bytes))throw new Error('Invalid aggregate evidence size');}
  return {schema:1,metadata_only:true,state:!files.length?'empty':bytes>TRAINING_INPUT_LIMIT?'over_budget':'within_budget',
    file_count:files.length,bytes,limit_bytes:TRAINING_INPUT_LIMIT,overage_bytes:Math.max(0,bytes-TRAINING_INPUT_LIMIT),files};
}
export function trainingInputArgs(args){
  if(args.length!==2||args[0]!=='--data'||!args[1]||args[1].startsWith('--'))throw new Error('Use --data DIRECTORY');
  return path.resolve(args[1]);
}
if(isMain(import.meta.url))try{
  const result=trainingInputAudit(trainingInputArgs(process.argv.slice(2)));
  console.log(JSON.stringify(result));if(result.state!=='within_budget')process.exitCode=1;
}catch(e){console.error(e.message);process.exitCode=1;}
