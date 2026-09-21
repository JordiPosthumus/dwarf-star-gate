# Dashboard: per-worker rolling cache-hit fraction
Data source: request-history finish events already carry usage.prompt_tokens/cached_tokens
per node (see cache-continuity-evidence.mjs retention). The pair-audit abstains too much;
compute a simple prompt-token-weighted cached share per worker over recent completed finishes.
- Add usage summary (requests, prompt_tokens, cached_tokens, recent-30m variant) per node
  to the cacheSnapshot base (independent of pair-audit blocked status)
- Surface in status snapshot; UI reads d.cache_continuity.usage
- Tooltip carries old audit evidence (assessed pairs, suspicion counts, caveats)
