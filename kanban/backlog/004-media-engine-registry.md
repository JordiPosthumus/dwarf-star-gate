# Media engine registry: single source of truth + all engines
mediaEngines in media-hosts.mjs is hardcoded and incomplete; backend dispatcher only
knows music->ace-step, video->comfyui/h3.
- Give every engine a kind (minimax-m3 has none today)
- Add qwen-image-2.1 (new kind: image) and M3 as first-class engines
- media-resources.mjs hardcodes ['h3','ace-step'] recipes -> read registry + per-engine
  recipe manifests in examples/spark-build/<engine>/models.json
- media-jobs.mjs backend dispatch -> registry-driven
- UI tabs read /api/media engines (already do) — verify no local fallback list needed

Scope boundary: reuse #033's configured-model/hardware mapping. This card owns
media engine kinds, recipe manifests and dispatch, not a second fleet catalogue.

## PARTIAL 2026-09-22 ~21:10 (commit 31bf647)
- Registry carries complete kinds (minimax-m3 video, ltx video) and a planned
  qwen-image entry (kind image, machines m3-ultra) shown honestly as "planned".
- mediaRecipeResources now reads the supported registry instead of a hardcoded
  engine list; engines without a shipped manifest are honestly absent.
- Machines metadata per engine from the shared fleet machine table.
- REMAINING (needs the engine actually enrolled and qualified first): image as
  a job kind in the media-jobs store schema and backend dispatch, qwen-image
  execution adapter, recipe manifest under examples/spark-build/qwen-image/.
  Deliberately not faked: the UI shows it as planned, not selectable.