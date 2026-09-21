# Keep dashboard/gateway test suites green through the UI rewrite
npm test (or node --test) for dashboard.test.mjs, media-*.test.mjs. Run before/after
each UI change; card rewrite must keep 96 dashboard tests passing or update them
deliberately.

Done: 2026-09-21 — Full suite green: 1073 pass / 0 fail (14 skipped by design).
Fixed one real pre-existing failure: observer.test "fresh free compatible pool
capacity" still asserted model 'deepseek-v4-flash' against freeGeniePool's new
'PoolModel' coalescing (broken by commit e7cbc90's rename, uncaught). Test now
uses PoolModel + explicit fallback model. Committed as separate fix commit.
