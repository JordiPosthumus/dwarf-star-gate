# Admit GLM-5.3-Flash-oQ8e-mtp (M3 Ultra) to Star Gate
Jordi approved adding the new M3 monster model as a gateway worker.
- Endpoint: http://127.0.0.1:8013/v1, oMLX, api key "none", model GLM-5.3-Flash-oQ8e-mtp, context 400000
- Worker id: glm53f-m3, backend openai, max_concurrent_requests 1 (334GB monster on shared M3)
- Aliases: PoolModel -> GLM-5.3-Flash-oQ8e-mtp (no alias for the raw name, oMLX accepts it)
- Add model route "GLM-5.3-Flash-oQ8e-mtp" -> [glm53f-m3]
- Verify: readiness, one generation through the door, no chunked-body quarantine (oMLX accepts chunked? verify after a few requests)
Done: admitted, serving, verified.

Done: 2026-09-21 — m3-studio (dead Qwen) removed; glm53f-m3 admitted (PoolModel alias,
api_key_file ~/.dsg-secrets/glm53f-m3.key = "none", concurrency 1, ctx 400k). Route
GLM-5.3-Flash-oQ8e-mtp added. Park/start restart with Continuity Door hold. Verified:
PoolModel generation + explicit route generation through door; worker healthy+serving.
NOTE: model server on :8013 was NOT touched (pi runs directly on it).
