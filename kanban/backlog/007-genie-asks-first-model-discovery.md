# Genie proposes new models (the "would have liked the Genie to approach me" flow)
When a new model appears (server dir, HF cache, M3 checkpoint), Genie notices and asks:
"Admit GLM-5.3-Flash-oQ8e-mtp to the gate?" with recipe/context/concurrency summary.
- Scan known model roots (DS4-GLM/models, SparkSetup, HF caches) for unknown checkpoints
- Prepare an admit proposal (worker id, url, aliases, context, max_concurrent) as a draft
- Ask-first via chat/Telegram; never self-admit without a yes
Depends on 006 for the reaching-out channel (dashboard chat works first).
