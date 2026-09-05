# Machine speed charts

Prefill is blue and decode is green across each activity bar, speed number and
trace. The charts share a separate vertical scale per phase across the fleet:
zero to the highest recorded DS4 chunk speed, without headroom, percentile cuts
or a rolling-window ceiling. Numbers are displayed as whole t/s; tooltips retain
the exact ceiling. No measurements yet uses a 0–1 placeholder, not a measured peak.

The dashboard seeds two high-water marks from **all retained** daily metrics files,
incrementally reading at most 1 MiB per poll. New live measurements also update
the marks. A small private `runtime/dashboard/rate-peaks.json` persists only each
phase's speed and timestamp; new maxima do not add an ever-growing history.
They survive dashboard/model restarts and telemetry rotation. This display record
does not change raw telemetry, training data, gauges, scheduling or model settings.

“Highest recorded” means recoverable DSG history plus observations since this
record began. Already-deleted logs cannot be recovered. Tooltips report initial
catch-up, unreadable history and persistence failures. An unreadable existing peak
record is preserved for investigation, not silently overwritten. A real unusual
peak remains the ceiling; this view deliberately does not discard outliers.

The 15-minute traces compress missing measurement intervals into narrow
idle-coloured separators. They never interpolate across gaps. Missing rates do
not prove hardware idle. The horizontal axis is compressed, not wall-clock aligned;
the separate activity bar retains its wall-clock layout and accessible phase labels.
