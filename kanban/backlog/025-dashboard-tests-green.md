# Keep dashboard/gateway test suites green through the UI rewrite
npm test (or node --test) for dashboard.test.mjs, media-*.test.mjs. Run before/after
each UI change; card rewrite must keep 96 dashboard tests passing or update them
deliberately.
