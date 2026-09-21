# Fleet power switches: startScripts behind Star Gate UI (planned)
~/startScripts contains per-member start/stop/status (m3-control.py, spark-control.py
start|stop <sparks12|sparks34> <glm53f|ds41>, status-*, watch-*).
- Backend: server_operations gains service actions that exec these scripts with
  strictly allowlisted args; capture status JSON where available.
- Interlocks: drain before stop (never kill a worker with active/queued work);
  never auto-stop the last serving LLM; Genie asks first (autonomy model).
- UI: per-member power controls + current engine/status display.
- Split: (a) script adapter + interlocks + tests, (b) UI section.
Depends on operator confirmation flow; keep scripts as source of truth (no duplication
of launch logic in the gate).