# Local oMLX inspection

Genie's existing `inspect_server` tool supports an explicitly enrolled local
oMLX installation. In the private configuration's `genie_chat.inspection.workers`
map, set the worker's target to:

```json
{
  "kind": "omlx-local",
  "root": "/absolute/path/to/installation",
  "url": "http://127.0.0.1:8013/v1",
  "api_key_file": "/absolute/path/to/private/key"
}
```

The key file is optional for an unauthenticated endpoint; otherwise it must have
mode 0600. Its contents are used only for local model discovery and are excluded
from tool results. HTTP redirects are not followed.

The collector reads `serve.sh`, `start.py`, `state/settings.json`,
`state/model_settings.json` and `server.pid` under the enrolled root. Missing
files are reported as unavailable. It returns credential-redacted contents and
original file hashes, live model metadata and listening-process observations.
If `omlx-src` has its own Git metadata, its disk revision and tracked-change state
are reported separately from the unestablished loaded revision.

The tool accepts only a registered worker ID. It cannot choose another path,
run a launcher, restart a server or alter files. Docker `selected_default`
inspection does not apply to local oMLX. This inspection is preparation for a
configuration record or recovery plan; it grants no recovery authority and does
not establish that current disk settings were loaded by the running process.
