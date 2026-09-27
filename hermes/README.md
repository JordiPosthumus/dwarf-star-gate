# Gate Genie profile

`SOUL.md` here is the first-run default. The dashboard seeds it only if the
owner's file does not exist. It never resets an existing file, even an empty one.

The editable copy lives at `<directory of state_file>/hermes-home/SOUL.md`.
`ds4-gateway/hermes-profile.mjs` exports `hermesHome(config)` as the shared
profile location. The native Hermes launcher must set `HERMES_HOME`
to that directory; it must not replace OS `HOME` or restrict local access.
## Install the native runtime

The source pin is recorded in `source.json`. This baseline is unmodified upstream
Hermes; no private runtime or additional agent implementation is bundled.
Use these commands from the Star Gate checkout on macOS or Linux:

```sh
git clone https://github.com/NousResearch/hermes-agent.git vendor/hermes
git -C vendor/hermes checkout --detach 8c9fe964009096e46f44292d036c1e0ac33c3026
export HERMES_HOME="$PWD/runtime/hermes-home"
export HERMES_RUNTIME_DIR="$HERMES_HOME/tools"
bash vendor/hermes/setup-hermes.sh --runtime-only
vendor/hermes/.hermes/bin/hermes setup
vendor/hermes/.hermes/bin/hermes --run-module gateway.run
```

For an existing checkout, inspect its changes before updating; do not overwrite
it with these first-install instructions. If your gateway uses a different
`state_file` directory, set `HERMES_HOME` to that directory's `hermes-home` instead.
Keep these environment values in any service definition you create. Never replace
OS `HOME`. Native setup manages Python/dependencies and configures the model and
Telegram; the gateway's setup command installs only gateway configuration.
Use your Star Gate API key and endpoint with a registered model or PoolModel,
or choose another provider in native setup. Keep keys in the private profile.
Follow native Hermes' service installation instructions for background operation.
Verify a Telegram reply before relying on the service. Dependency installation
needs network access; no model weights are included.

## Profile and UI

The dashboard's Soul tab reads and saves that exact file. Each changed save
backs up the previous content under `hermes-home/soul-history/`, then replaces
SOUL atomically. A loaded revision detects stale browser drafts; this is edit
conflict detection, never a runtime hash requirement or startup permission gate.
To restore a previous version, copy its text into the editor and save.

Saving does not restart Hermes or rebuild a live conversation's cached prompt.
Native Hermes reads SOUL when building session context; start a new session to
use the saved text. SOUL is one part of the native prompt, alongside Hermes'
own prompts, tools, skills, memory, and applicable context files. This feature
does not modify those or claim to grant OS permissions through prompt text.

Credentials belong in the private profile `.env`, never in Git. Choose native
Hermes approval and instruction-file settings for your own installation. This
repository does not impose the maintainer's settings on other installations.
Configure permitted Telegram users through native Hermes setup.

## Memory viewer

SGUI's Memory tab reads this profile's `memories/MEMORY.md`, `memories/USER.md`
and Markdown files under `skills/`. It shows the native files, including missing
or empty memory, and has a searchable, collapsed file list. It does not maintain
a second store, edit the files, poll the model, or generate summaries. Saved files
can differ from the frozen memory snapshot in an existing conversation.

## Gateway inference priority

Star Gate schedules identified Genie requests ahead of other waiting requests,
including ordinary high-priority work. Existing generations finish normally;
conversation order, model compatibility, request bodies, limits and capacities
are preserved. Unaffined Genie calls can use the next compatible free worker.
Sustained Genie traffic can delay ordinary queued traffic; active work is never
preempted. This is scheduling, not a fleet-management permission.

Set `genie_priority_key` in your private gateway configuration and use the same
value in the native Hermes profile's route-specific headers:

```yaml
custom_providers:
  - name: Star Gate
    base_url: http://127.0.0.1:30000/v1
    extra_headers:
      x-stargate-genie-key: YOUR_PRIVATE_MATCHING_VALUE
```

Merge into an existing matching provider entry instead of replacing its other
settings. Keep the value out of Git. Existing gateway/API authorization remains
unchanged. The scheduling header is stripped before forwarding to model servers;
requests without a matching value keep their normal priority. Other model
endpoints do not receive the route-specific header.

A fresh native client reads these headers. An already-created Telegram client
may need an idle reload; configuring the file is not proof that an existing
conversation is sending them. Inspect Current Jobs for `priority_policy: genie`
(or its “Genie · next slot” UI label) on an actual request before claiming that
conversation has priority. Never interrupt a working turn to force activation.
