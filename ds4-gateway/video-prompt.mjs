import fs from 'node:fs';
import {createHash,randomInt} from 'node:crypto';

// A convenience form of the shipped, native-tested H3 recipe. Raw workflows
// remain untouched; callers can still use all their existing engine options.
export function prepareVideoPrompt(input){
  const reject=message=>{throw Object.assign(new Error(message),{status:400});};
  if(Object.keys(input).some(k=>!['prompt','seed'].includes(k)))reject('Text video requests accept prompt and optional seed. Use a native workflow for other options.');
  if(!input.prompt.trim())reject('A video prompt must contain text.');
  if(input.seed!==undefined&&(!Number.isSafeInteger(input.seed)||input.seed<0))reject('Video seed must be a non-negative safe integer.');
  const bytes=fs.readFileSync(new URL('../examples/media/h3-text-to-video.json',import.meta.url));
  const payload=JSON.parse(bytes),seed=input.seed??randomInt(0,2**32);
  payload.prompt['7'].inputs.prompt=input.prompt;
  payload.prompt['9'].inputs.seed=seed;
  const {width,height,length}=payload.prompt['7'].inputs;
  return {payload,generation:{engine:'h3',input_format:'text',recipe_sha256:createHash('sha256').update(bytes).digest('hex'),
    width,height,frames:length,fps:payload.prompt['12'].inputs.fps,steps:payload.prompt['9'].inputs.steps,seed}};
}
