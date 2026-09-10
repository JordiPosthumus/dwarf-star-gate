import {createHash} from 'node:crypto';
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const SHARED_QWEN_MODEL='qwen3.8-flash-next';
export const NATIVE_QWEN_MODEL='Qwen3.8-Flash-Next-MLX-8bit-MTP';
export function preparePiModelRoutes(configuration){
  const provider=configuration?.providers?.['spark-gateway'];
  const shared=provider?.models?.find(model=>model.id===SHARED_QWEN_MODEL);
  if(!shared)throw new Error('Current shared Qwen profile is required');
  const existingNative=provider.models.find(model=>model.id===NATIVE_QWEN_MODEL);
  const common=structuredClone(shared),native=structuredClone(existingNative??shared);
  common.headers={...common.headers,'x-dsg-model':SHARED_QWEN_MODEL};
  native.id=NATIVE_QWEN_MODEL;
  if(!existingNative)native.name='Qwen 3.8 Flash Next — M3 only (8-bit)';
  native.headers={...native.headers,'x-dsg-model':NATIVE_QWEN_MODEL};
  return {
    provider:'spark-gateway',models:[common,native],
    source_profile_sha256:digest({shared,native:existingNative??null,compat:provider.compat??null}),
    source_policy:'Regenerate from the current profile immediately before deployment; never restore an old profile snapshot.',
    default_model_unchanged:SHARED_QWEN_MODEL,
    add_exact_budget_model:`spark-gateway/${NATIVE_QWEN_MODEL}`,
    required_context_extension:'pi-extensions/dsg-qwen-route-history.js',
    deployment_requires:'Explicit gateway-restart authorization, loaded route rules, then current-profile Pi merge and context-extension load.',
  };
}
export function verifyPiModelRouteSource(staged,current){
  return staged?.source_profile_sha256===preparePiModelRoutes(current).source_profile_sha256;
}
