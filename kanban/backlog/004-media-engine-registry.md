# Media engine registry: single source of truth + all engines
mediaEngines in media-hosts.mjs is hardcoded and incomplete; backend dispatcher only
knows music->ace-step, video->comfyui/h3.
- Give every engine a kind (minimax-m3 has none today)
- Add qwen-image-2.1 (new kind: image) and M3 as first-class engines
- media-resources.mjs hardcodes ['h3','ace-step'] recipes -> read registry + per-engine
  recipe manifests in examples/spark-build/<engine>/models.json
- media-jobs.mjs backend dispatch -> registry-driven
- UI tabs read /api/media engines (already do) — verify no local fallback list needed
