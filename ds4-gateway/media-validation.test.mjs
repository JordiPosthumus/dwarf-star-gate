import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Readable} from 'node:stream';
import {MediaJobs} from './media-jobs.mjs';
import {validateVideoCatalog,validateVideoReferences} from './media-validation.mjs';

test('shipped H3 reference recipes preserve ordinary ref_image_size settings and native graphs',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sg-reference-recipes-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const jobs=new MediaJobs(path.join(dir,'jobs.json'));
  const upload=async(type)=>{const stream=Readable.from(['fixture']);stream.headers={'content-type':type,'content-length':'7'};return jobs.inputs.receive(stream);};
  const image=await upload('image/png'),audio=await upload('audio/wav');
  for(const file of ['h3-reference-image.json','h3-reference-files.json'])for(const size of ['match','max']){
    const payload=JSON.parse(fs.readFileSync(new URL('../examples/media/'+file,import.meta.url)));
    payload.prompt['7'].inputs.ref_image_size=size;
    if(payload.input_files){payload.prompt['5'].inputs.image=image.name;payload.prompt['15'].inputs.audio=audio.name;payload.input_files=[image.id,audio.id];}
    const accepted=jobs.enqueue('video',payload,{key:file+size});
    assert.deepEqual(accepted.job.payload,payload);
    assert.equal(accepted.job.payload.prompt['7'].inputs.ref_image_size,size);
  }
  const payload=JSON.parse(fs.readFileSync(new URL('../examples/media/h3-reference-image.json',import.meta.url)));
  payload.prompt['7'].inputs.ref_image_0=payload.prompt['7'].inputs['ref_images.ref_image_0'];
  delete payload.prompt['7'].inputs['ref_images.ref_image_0'];
  assert.throws(()=>jobs.enqueue('video',payload,{key:'misplaced-socket'}),e=>e.status===400&&/invalid reference socket ref_image_0/.test(e.message));
});

// Stock ComfyUI LoadImage lists only top-level files in INPUT_TYPES, but its
// native VALIDATE_INPUTS resolves subfolders. Uploaded references live there.
test('stock image upload paths reach native validation unchanged despite an incomplete dropdown',()=>{
  const payload={prompt:{image:{class_type:'LoadImage',inputs:{image:'stargate/00112233-4455-6677-8899-aabbccddeeff.png'}}}};
  const original=structuredClone(payload);
  for(const choices of [[],['top-level.png']]){
    validateVideoCatalog(payload,{LoadImage:{input:{required:{image:[choices,{image_upload:true}]}}}});
    assert.deepEqual(payload,original);
  }
  assert.throws(()=>validateVideoReferences(payload,[]),/missing from input_files/);
  validateVideoReferences(payload,[{name:payload.prompt.image.inputs.image}]);
});

test('file validation exception preserves node, model and other combo validation',()=>{
  const workflow=(class_type,key,value)=>({prompt:{one:{class_type,inputs:{[key]:value}}}});
  assert.throws(()=>validateVideoCatalog(workflow('Missing','image','nested/image.png'),{}),/Missing native node/);
  for(const [class_type,key,options] of [
    ['UNETLoader','unet_name',{}],
    ['CustomImageLoader','image',{image_upload:true}],
    ['LoadImage','image',{}],
    ['LoadImage','mode',{image_upload:true}],
  ]){
    const catalog={[class_type]:{input:{required:{[key]:[['available'],options]}}}};
    assert.throws(()=>validateVideoCatalog(workflow(class_type,key,'unavailable'),catalog),/selected value is not available/);
    validateVideoCatalog(workflow(class_type,key,'available'),catalog);
  }
});
