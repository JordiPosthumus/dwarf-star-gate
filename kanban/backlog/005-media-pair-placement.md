# Media placement at machine granularity (Jordi decision: pair goes down together)
Today media hosts = gateway workers (TP=2 pairs). Jordi decided: for a media call, BOTH
sparks of a pair come down and both are used (media models are single-spark).
- Model physical machines vs LLM workers in the media host registry
- Eligibility: media may borrow a whole pair (drain worker, use both machines) but must
  keep the OTHER pair serving (the "another serving LLM" check stays, at machine level)
- Genie flow: drain glm53f-sparksXY (continuity door holds calls) -> run media on both
  sparks -> restore LLM
- Update media-host cards to show the pair, not individual workers
