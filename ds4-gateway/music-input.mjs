const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const reject=message=>{throw Object.assign(new Error(`ACE-Step: ${message} No job was queued.`),{status:400});};
const decode=v=>{if(object(v))return v;try{const parsed=JSON.parse(v);return object(parsed)?parsed:{};}catch{return {};}};

export function musicRecipeRequirements(payload){
  const nonempty=v=>object(v)||Array.isArray(v)?Object.keys(v).length>0:Boolean(v);
  const meta=['metas','meta','metadata','user_metadata','userMetadata'].find(k=>nonempty(payload[k]));
  const sources=[payload,decode(payload.param_obj),decode(payload[meta])];
  return ['sampler_mode','dcw_enabled'].filter(key=>{
    const source=sources.find(s=>s[key]!=null);
    return source!==undefined&&source[key]!=='';
  });
}

// Matches release_task_param_parser.py in the pinned ACE-Step build (dce6214).
// Validate only supplied effective values; never expand defaults or rewrite the
// request. Preserve aliases, native source precedence and automatic sentinels.
const numbers=[
  ['int','inference_steps','inferenceSteps'],['int','bpm'],['int','batch_size'],
  ['float','audio_duration','duration','audioDuration','target_duration','targetDuration'],
  ['float','guidance_scale','guidanceScale'],
  ['float','audio_cover_strength','audioCoverStrength','cover_strength','coverStrength'],
  ['float','cover_noise_strength','coverNoiseStrength'],
  ...['repainting_start','repainting_end','cfg_interval_start','cfg_interval_end','shift','repaint_wav_crossfade_sec','repaint_strength','lm_temperature','lm_cfg_scale','lm_top_p','lm_repetition_penalty'].map(k=>['float',k]),
  ...['lm_top_k','repaint_latent_crossfade_frames'].map(k=>['int',k]),
];
const booleans=[
  ['thinking'],['dcw_enabled'],['use_random_seed','useRandomSeed'],['sample_mode','sampleMode'],
  ['analysis_only','analysisOnly'],['full_analysis_only','fullAnalysisOnly'],
  ['extract_codes_only','extractCodesOnly'],['use_format','useFormat','format'],
  ['use_tiled_decode','useTiledDecode'],['constrained_decoding','constrainedDecoding','constrained'],
  ['constrained_decoding_debug','constrainedDecodingDebug'],['use_cot_caption','cot_caption','cot-caption'],
  ['use_cot_language','cot_language','cot-language'],['is_format_caption','isFormatCaption'],
  ['allow_lm_batch','allowLmBatch','parallel_thinking'],['use_adg'],
];

export function validateMusicInputs(payload){
  const nonempty=v=>object(v)||Array.isArray(v)?Object.keys(v).length>0:Boolean(v);
  const meta=['metas','meta','metadata','user_metadata','userMetadata'].find(k=>nonempty(payload[k]));
  const sources=[payload,decode(payload.param_obj),decode(payload[meta])];
  const effective=aliases=>{
    for(const source of sources)for(const key of aliases)if(source[key]!=null)return {key,value:source[key]};
    return null;
  };
  for(const [kind,...aliases] of numbers){
    const item=effective(aliases);if(!item)continue;
    const {key,value}=item;
    if(typeof value==='string'&&!value.trim())continue; // Native automatic/default value.
    const string=typeof value==='string'?value.trim():null;
    const numeric=typeof value==='number'?value:string!==null?Number(string.replaceAll('_','')):NaN;
    // Python accepts bool as int, but not as float through its text conversion.
    if(kind==='int'&&typeof value==='boolean')continue;
    const syntax=string===null||new RegExp(kind==='int'?'^[+-]?[0-9](?:_?[0-9])*$':'^[+-]?(?:[0-9](?:_?[0-9])*(?:\\.(?:[0-9](?:_?[0-9])*)?)?|\\.[0-9](?:_?[0-9])*)(?:[eE][+-]?[0-9](?:_?[0-9])*)?$').test(string);
    if(!syntax||!Number.isFinite(numeric)||(kind==='int'&&!Number.isInteger(numeric)))reject(`${key} must be ${kind==='int'?'an integer':'a number'} (a numeric string is also accepted). The native parser can silently use a default for malformed values; remove this field to request its default.`);
  }
  for(const aliases of booleans){
    const item=effective(aliases);if(!item)continue;
    const {key,value}=item;
    if(typeof value==='boolean'||value===0||value===1)continue;
    if(typeof value==='string'&&['','1','0','true','false','yes','no','y','n','on','off'].includes(value.trim().toLowerCase()))continue;
    reject(`${key} must be true or false (or a supported boolean string such as "yes" or "no"). Other text can silently turn this option off.`);
  }
  const sampler=effective(['sampler_mode']);
  if(sampler&&sampler.value!==''&&!['euler','heun'].includes(sampler.value))reject('sampler_mode must be "euler" or "heun". Omit it to preserve the engine default.');
  for(const key of ['ref_audio','reference_audio','ctx_audio','src_audio'])if(payload[key]!=null&&payload[key]!=='')reject(`${key} is a multipart upload field, not a JSON audio reference. Use reference_audio_path or src_audio_path for a file already present on the selected ACE-Step host. This music endpoint does not transfer a file from a local filename.`);
  if(payload.input_files!==undefined&&(!Array.isArray(payload.input_files)||payload.input_files.length))reject('input_files transfers uploaded references for video jobs only. Music JSON currently uses reference_audio_path or src_audio_path for files already on the selected ACE-Step host.');
}
