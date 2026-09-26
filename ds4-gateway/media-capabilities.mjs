import {prepareVideoPrompt} from './video-prompt.mjs';

// Public client guidance contains no container identities, SSH targets,
// credentials, filesystem paths or other clients' prompts/job records.
export function videoCapabilities(status,config){
  const {generation}=prepareVideoPrompt({prompt:'Capability metadata',seed:0});
  const {seed,...recipe}=generation;
  const candidates=(status.workers??[]).filter(w=>!w.busy&&w.kinds.includes('video')&&w.budget?.allowed!==false&&
    status.hosts?.some(h=>h.id===w.id&&h.engines?.some(e=>e.kind==='video'&&e.ready)));
  let remaining=status.media_budget?.remaining_sparks??Infinity,slots=0;const selected=new Set();
  for(const w of candidates.sort((a,b)=>(a.budget?.sparks_required??1)-(b.budget?.sparks_required??1))){
    const physical=w.budget?.machines??[w.id],cost=physical.length;
    if(cost>remaining||physical.some(id=>selected.has(id)))continue;
    physical.forEach(id=>selected.add(id));remaining-=cost;slots+=w.parallel_kinds?.includes('video')?2:1;
  }
  return {schema:1,enabled:status.enabled===true,automatic_dispatch_enabled:status.automatic_dispatch_enabled===true,
    routes:{capabilities:'/v1/video/capabilities',inputs:'/v1/video/inputs',jobs:'/v1/video/jobs',batches:'/v1/video/batches'},
    submission:{formats:['text_prompt','native_workflow'],atomic_film_batches:true,max_batch_clips:128,max_json_bytes:2*1024*1024,
      priorities:['high','normal','idle-only'],idempotency_key_required:true,insufficient_capacity:'queued',requested_parallelism_supported:false},
    capacity:{...status.media_budget,available_generation_slots:status.enabled&&status.automatic_dispatch_enabled?slots:0,
      eligible_generation_slots:slots,paired_members_parallel:(status.workers??[]).some(w=>w.parallel_kinds?.includes('video')),
      scope:'Advisory snapshot. Opted-in pairs with both enrolled engines can run one generation on each member under shared ownership. Otherwise one selected member runs. All affected physical members consume budget; ownership and serving availability are rechecked before action.'},
    recipes:{h3_short:recipe,text_prompt_fields:['prompt','seed','reference_image','reference_audio'],
      native_workflow:{preserved:true,scope:'Use a native H3 workflow for resolution, per-clip frames, steps, reference sizing and multiple references. The gateway validates its reference wiring and the selected engine validates the graph; no implicit quality reduction.'}},
    references:{portable_uploads:true,upload_route:'/v1/video/inputs',native_workflow_input_field:'input_files',
      max_file_bytes:config.media_jobs?.input_max_bytes??100*1024*1024,total_storage_bytes:config.media_jobs?.input_total_bytes??2*1024**3,
      reference_socket_format:'ref_images.ref_image_0 / ref_audios.ref_audio_0 / ref_videos.ref_video_0',
      scope:'Upload each shared asset once; use its returned ID and name. DSG transfers it to the selected engine. File presence is not proof of reference fidelity.'},
    results:{per_clip_available:true,separate_video_and_audio:true,original_generated_audio_preserved:true,
      generation_and_restoration_separate:true,estimated_wait_seconds:null,estimate_reason:'No calibrated estimate for the requested recipe.'}};
}
