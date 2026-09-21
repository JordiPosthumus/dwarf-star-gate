# Dashboard: per-worker rolling cache-hit fraction
Data source: request-history finish events already carry usage.prompt_tokens/cached_tokens
per node (see cache-continuity-evidence.mjs retention). The pair-audit abstains too much;
compute a simple prompt-token-weighted cached share per worker over recent completed finishes.
- Add usage summary (requests, prompt_tokens, cached_tokens, recent-30m variant) per node
  to the cacheSnapshot base (independent of pair-audit blocked status)
- Surface in status snapshot; UI reads d.cache_continuity.usage
- Tooltip carries old audit evidence (assessed pairs, suspicion counts, caveats)

Done: 2026-09-21 — cache-continuity-evidence.mjs now emits a `usage` summary
(per-worker requests/prompt/cached tokens, 30-min recent variant, cached_fraction +
recent_cached_fraction) computed from retained finish events, independent of pair-audit
blocked status (blocked usage carries its own status and empty workers). UI wiring comes
with the card rewrite (002). Tests extended in request-history.test.mjs.
