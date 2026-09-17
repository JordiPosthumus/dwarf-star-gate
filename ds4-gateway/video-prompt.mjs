import fs from 'node:fs';
import {createHash,randomInt} from 'node:crypto';

// A convenience form of the shipped, native-tested H3 recipe. Raw workflows
// remain untouched; callers can still use all their existing engine options.
export function prepareVideoPrompt(input,{resolveInput}={}){
  const reject=message=>{throw Object.assign(new Error(message),{status:400});};
  if(Object.keys(input).some(k=>!['prompt','seed','reference_image','reference_audio'].includes(k)))reject('Video prompt requests accept prompt, optional seed, and reference_image/reference_audio upload IDs. Use a native workflow for other options.');
  if(!input.prompt.trim())reject('A video prompt must contain text.');
  if(input.seed!==undefined&&(!Number.isSafeInteger(input.seed)||input.seed<0))reject('Video seed must be a non-negative safe integer.');
  const references=[];
  for(const kind of ['image','audio']){
    const key='reference_'+kind;if(!Object.hasOwn(input,key))continue;
    if(typeof input[key]!=='string'||!resolveInput)reject(`${key} must be the ID returned by POST /v1/video/inputs, not a filename, URL or inline file.`);
    let file;try{file=resolveInput(input[key]);}catch(e){throw Object.assign(new Error(`${key}: ${e.message} Upload the file to /v1/video/inputs and use its returned ID.`),{status:e.status??400});}
    if(!file.content_type.startsWith(kind+'/'))reject(`${key} requires an uploaded ${kind} file; this upload is ${file.content_type}.`);
    references.push({kind,...file});
  }
  const bytes=fs.readFileSync(new URL(references.length?'../examples/media/h3-reference-image.json':'../examples/media/h3-text-to-video.json',import.meta.url));
  const payload=JSON.parse(bytes),seed=input.seed??randomInt(0,2**32);
  payload.prompt['7'].inputs.prompt=input.prompt;
  payload.prompt['9'].inputs.seed=seed;
  if(references.length){
    delete payload.prompt['5'];delete payload.prompt['7'].inputs['ref_images.ref_image_0'];
    for(const file of references){
      const node=file.kind==='image'?'5':'15',group=file.kind==='image'?'ref_images.ref_image_0':'ref_audios.ref_audio_0';
      payload.prompt[node]={class_type:file.kind==='image'?'LoadImage':'LoadAudio',inputs:{[file.kind]:file.name}};
      payload.prompt['7'].inputs[group]=[node,0];
    }
    payload.input_files=references.map(file=>file.id);
  }
  const {width,height,length}=payload.prompt['7'].inputs;
  return {payload,generation:{engine:'h3',input_format:references.length?'references':'text',recipe_sha256:createHash('sha256').update(bytes).digest('hex'),
    ...(references.length?{reference_inputs:references.map(({kind,id,sha256})=>({kind,id,sha256})),reference_sizing:payload.prompt['7'].inputs.ref_image_size}:{}),
    width,height,frames:length,fps:payload.prompt['12'].inputs.fps,steps:payload.prompt['9'].inputs.steps,seed}};
}
