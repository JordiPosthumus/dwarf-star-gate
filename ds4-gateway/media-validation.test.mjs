import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Readable} from 'node:stream';
import {MediaJobs} from './media-jobs.mjs';

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
