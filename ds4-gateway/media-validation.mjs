const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const reject=message=>{throw Object.assign(new Error(message),{status:400});};
const groups={ref_images:'ref_image_',ref_audios:'ref_audio_',ref_videos:'ref_video_',ref_video_audios:'ref_video_audio_'};

// Catch the known silent H3 Autogrow failure before reserving a worker. Do not
// rewrite graphs or apply this node's conventions to unrelated custom nodes.
export function validateVideoReferences(payload,files=[]){
  if(!object(payload.prompt))return;
  for(const [id,node] of Object.entries(payload.prompt)){
    if(node?.class_type!=='MiniMaxH3ReferenceToVideo')continue;
    const inputs=node.inputs??{};
    for(const [group,prefix] of Object.entries(groups)){
      if(inputs[group]!=null&&(typeof inputs[group]!=='object'||Object.keys(inputs[group]).length))reject(`H3 node ${id}: ${group} is not a native reference socket. Use "${group}.${prefix}0": ["SOURCE_NODE_ID", 0]. The grouped form can silently generate without the reference. See examples/media/h3-reference-files.json. No job was queued.`);
      for(const [key,value] of Object.entries(inputs)){
        if(Object.hasOwn(groups,key))continue;
        if(!key.startsWith(group+'.')&&!new RegExp(`^${prefix}\\d+$`).test(key))continue;
        if(!new RegExp(`^${group}\\.${prefix}(0|[1-9]\\d*)$`).test(key))reject(`H3 node ${id}: invalid reference socket ${key}. Use ${group}.${prefix}0 (then 1, 2, …). No job was queued.`);
        if(!Array.isArray(value)||value.length!==2||typeof value[0]!=='string'||!Number.isSafeInteger(value[1])||value[1]<0||!object(payload.prompt[value[0]]))reject(`H3 node ${id}, ${key}: connect ["SOURCE_NODE_ID", output_index] to an existing workflow node. A filename or <Picture1> in the prompt does not connect an image. No job was queued.`);
      }
    }
  }
  const names=new Set(files.map(file=>file.name));
  for(const [id,node] of Object.entries(payload.prompt)){
    const field={LoadImage:'image',LoadAudio:'audio',LoadVideo:'file'}[node?.class_type],name=node?.inputs?.[field];
    if(typeof name==='string'&&name.startsWith('stargate/')&&!names.has(name))reject(`Video node ${id}: its uploaded file is missing from input_files. Include the ID returned by POST /v1/video/inputs and use that upload's exact name in the loader. No job was queued.`);
  }
}

// Installed-engine facts, never a stale hard-coded model allowlist. Custom and
// dynamic input validation remains with ComfyUI; validate only explicit combos.
export function validateVideoCatalog(payload,catalog){
  if(!object(payload.prompt)||!Object.keys(payload.prompt).length)throw Error('Video workflow is empty. Supply a prompt string or a ComfyUI API workflow; no generation submitted.');
  for(const [id,node] of Object.entries(payload.prompt)){
    const schema=catalog[node?.class_type];
    if(!schema)throw Error(`Video node ${id}: Missing native node ${node?.class_type??'(class_type missing)'}. Install that node on the selected engine or use the matching shipped H3 example; no generation submitted.`);
    for(const [key,value] of Object.entries(node.inputs??{})){
      if(node.class_type==='MiniMaxH3ReferenceToVideo'&&key.includes('.')){
        const [group,socket]=key.split('.'),template=(schema.input?.optional?.[group]??schema.input?.required?.[group])?.[1]?.template;
        if(groups[group]&&template){
          const index=Number(socket.slice(template.prefix?.length));
          const accepted=Array.isArray(template.names)?template.names.includes(socket):typeof template.prefix==='string'&&Number.isSafeInteger(template.max)&&socket===`${template.prefix}${index}`&&index>=0&&index<template.max;
          if(!accepted)throw Error(`H3 node ${id}, ${key}: this reference socket is not recognized by the installed engine and would be ignored. Check ${group} in /object_info; no generation submitted.`);
        }
      }
      const spec=schema.input?.required?.[key]??schema.input?.optional?.[key],choices=spec?.[0];
      // Stock LoadImage lists only top-level files; native VALIDATE_INPUTS
      // resolves subfolders such as our uploaded stargate/<id>.png references.
      // Leave file existence to ComfyUI without weakening other combo checks.
      if(node.class_type==='LoadImage'&&key==='image'&&spec?.[1]?.image_upload===true)continue;
      if(typeof value==='string'&&Array.isArray(choices)&&!choices.includes(value))throw Error(`Video node ${id} (${node.class_type}), ${key}: the selected value is not available on this engine. Check its /object_info catalog and installed model/file names; no generation submitted. Requested value: ${value}`);
    }
  }
}
