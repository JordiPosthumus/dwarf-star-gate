# Media jobs — implementation in progress

These endpoints provide the durable queue and retained downloads. Genie can now
inspect the queue and assign a video job to an enrolled ComfyUI host. Its separate
runner drains that host, generates the result, saves the files, restores the
original LLM and verifies responses/cache reuse before readmission. A real
production Genie-led H3 cycle has passed, including retained downloads and LLM
return. A real ACE-Step XL/4B music cycle has also passed: normal API submission
woke Genie automatically, he assigned the host, and the runner generated audio,
retained it and verified LLM return. The Media view now exposes saved host choices and job results. Read-only resource checks are available; native memory-fit qualification and
complete fresh-host installation remain in progress.

For an isolated development installation, `"media_jobs": {"enabled": true}`
enables a private `media-jobs.json` beside the gateway state file. The existing
gateway process lock owns both stores; no additional service or database is
needed. The normal gateway bearer key protects every endpoint.

| Endpoint | Behavior |
| --- | --- |
| `POST /v1/music/jobs` | Queue native ACE-Step JSON parameters. |
| `POST /v1/video/jobs` | Queue a native ComfyUI JSON workflow envelope. |
| `GET /v1/music/jobs` or `/v1/video/jobs` | List recorded job status. |
| `GET /v1/music/jobs/{id}` or `/v1/video/jobs/{id}` | Read a saved job and any native result metadata. |
| `GET /v1/{music\|video}/jobs/{id}/files/{file_id}` | Download a retained output using the normal gateway bearer key. |

Each POST needs `Content-Type: application/json` and an `Idempotency-Key` of
1–200 printable characters. Reuse the same key when reconnecting or retrying a
submission whose response was lost. The same request returns the original job;
different content or priority with that key returns HTTP 409. A new job returns
HTTP 202 with its ID and status URL. Keys apply across both media routes.
The existing `x-dsg-priority` header accepts `high`, `normal` or `idle-only`;
priority orders waiting jobs only and never cancels active generation.
JSON submissions may be up to 2 MiB; binary asset upload is not implemented.

Status distinguishes gateway `queued`, native `submitting`/`submitted`,
`pending`/`running`, `completed`, `failed` and `uncertain`. ACE-Step's native
pending status does not distinguish queued from running. A completed native
job may contain result metadata before its files are retained. The coordinator
must call output collection and require `outputs.state: ready` before releasing
that engine. Files are streamed into private storage with size and SHA-256
receipts; status includes gateway download URLs. They remain downloadable after
the native engine stops and the gateway restarts. Failed copying is separately
visible as `outputs.state: failed`, and retrying collection fetches the original
result without repeating generation. No automatic file deletion is performed.
These behaviors are verified against HTTP fixtures. An installed H3 engine has
also generated real H.264 video and FLAC audio through an isolated gateway;
both retained downloads matched their size/hash receipts after H3 stopped.
The connected production path also passed with actual Genie status/start/status
calls, real media output and verified LLM return. Automatic queue wakeup is
enabled; its wakeup-to-tools path was separately tested with pinned Hermes and a
scripted model. Production music arrival has since exercised the automatic
watcher, actual Genie tool calls, native ACE-Step generation, authenticated audio
download after engine shutdown and automatic original-LLM readmission. This
qualifies the enrolled installation; it does not provide a fresh-machine image.

Before a native submission, the queue saves its intent and selected worker.
The allocator must first acquire that host through the existing
maintenance path, preserve at least one healthy serving LLM, and verify the
media engine is ready. The queue itself has no host shutdown authority.
Media maintenance uses `minimum_other_llms: 1` on the existing lock request.
The gateway checks capacity and acquires the lock together, so competing media
switches cannot reserve the last serving LLM. The Python maintenance adapter's
`purpose='media'` requires `media_maintenance_version: 1` in `/workers` before
starting. Existing operator and serving maintenance remain unchanged. Executors
must still recheck remaining LLM health before stopping a server, since a
different host can fail after a lock is acquired.
If acknowledgement is lost, it does not resubmit. A known native ID can be
observed on the original engine; missing history is not proof of completion.
Prompts and receipts remain private runtime data, and status responses omit
the submitted payload. No automatic deadline cancels accepted media jobs.

## Genie execution

`media_jobs.execution_enabled` defaults to false. The independent **Media jobs**
capability switch controls new assignments; turning it off does not cancel an
accepted operation or prevent the runner from returning its host. Queue intake
and downloads remain available while execution is off.

While the media capability is on, the existing ten-second dashboard tick wakes
Genie for actionable queued jobs. He studies current fleet demand and
chooses the host through the same tools as chat. Decisions appear in an
**Automatic media dispatch** conversation. The watcher waits for active chat to
finish, suppresses unchanged requests, and spaces changed-demand decisions by
at least one minute. The media switch also pauses these wakeups. A declined job
is reconsidered when observed fleet demand or host availability changes; it can
also be discussed directly with Genie.

Enroll a worker under `media_jobs.workers[worker_id].engines.video` with its
existing ComfyUI `kind: "comfyui"`, full Docker `container` ID, pinned `image`
digest and loopback `port`. The worker must already have a qualified Docker/Qwen
recovery enrollment and inspection entry identifying the same LLM container.
The new-Spark registration path can now save qualified media/recovery bindings
from retained setup receipts; full fresh-host acceptance remains outstanding.

In chat, Genie uses `media_job_status` to read jobs, eligible engine assignments
and current fleet demand, then `start_media_job` with a job ID and worker ID.
The runner continues when the chat or dashboard closes. Its saved job identity
survives gateway restart; an uncertain launch is reported without spawning again.
Repeated starts of an assigned job return its existing status. Music uses the
same lifecycle with an `engines.music` enrollment and `kind: "ace-step"`.
Its API must start with `ACESTEP_NO_INIT=false` so `/health` confirms model
initialization before submission. `/v1/stats` must report no queued or running
work before assignment and engine shutdown. Music remains queued on installations
without an enrolled music engine. The personal ACE-Step installation is not
modified or upgraded by this lifecycle.

`execution.phase` distinguishes `waiting_idle`, `starting_media`, `generating`,
`retaining_results`, `restoring_llm`, `checking_llm` and `returned`. Failures may
end in `failed_unchanged`, `failed_returned` or `needs_attention`; the last one
must be investigated rather than treated as a restored host. Generated files
can be ready before LLM readmission. The capability card and chat tool records
expose the observed phase and failure detail.

## Example video request

[`examples/media/h3-text-to-video.json`](../examples/media/h3-text-to-video.json)
is a native workflow for the qualified H3 model files. Its dimensions, frame
count, seed and sampling parameters belong to this example job; they do not
alter the installed engine's serving configuration. It produces separate video
and audio files. Edit node 7's prompt for another scene.

Submit that JSON to `POST /v1/video/jobs` with your normal gateway bearer key and
a unique `Idempotency-Key`. Poll the returned status URL; download the URLs in
`outputs.files` when `outputs.state` is `ready`. `execution.phase: returned`
confirms the host's LLM checks and readmission have finished.

## Example music request

[`examples/media/ace-step-xl-text-to-music.json`](../examples/media/ace-step-xl-text-to-music.json)
contains a ten-second instrumental request for an enrolled ACE-Step XL SFT
engine with its 4B music language model. Submit it to `POST /v1/music/jobs`
with the same bearer key and idempotency header as video. The duration, seed
and sampling settings are request parameters, not changes to LLM serving
configuration. The verified output is stereo 48 kHz FLAC.

Starting a media engine and restoring a large LLM can take several minutes;
native generation time excludes those transitions. The current executor returns
the LLM after each job. Warm media residency and batching across waiting jobs
are not implemented. The Media capability switch controls new assignments.

The qualified local API runs in a separate environment with the existing model
assets and ML packages mounted read-only; it preserves the personal ACE-Step
installation. Its source baseline is `dce621408bee8c31b4fcf4811682eb9359e1bc94`,
with that installation’s existing output-metadata patch retained. The native
qualification used Torch 2.12.0+cu130 and nano-vLLM with SDPA/eager attention;
it does not establish a fastest configuration.
Pinned standalone image recipes and a combined preparation command are now
included under `examples/spark-build`. They have native qualification on an
existing Spark; a complete fresh-host run remains unverified.

## Media view and machine choices

Open **Media** to see ACE-Step music and MiniMax H3 video jobs, retained result
downloads, and each machine’s placement switch. MiniMax M3 and LTX remain clearly
marked as planned. The switch saves a per-worker, per-engine choice in the
existing private gateway state, with a backup before each change. Already
enrolled engines remain allowed by default; machines without that engine start
with placement off. A choice survives gateway restart.

Turning a choice off excludes that engine/worker from Genie's available
assignments and rejects new starts in the core. Accepted work and its LLM-return
sequence continue. The overall Media capability switch remains separate.
Allowing a machine without an enrolled engine saves your preference only; it
does not install software, start a server, or establish readiness.

The view separates setup, placement permission, current LLM demand and return
status. Current memory readings are shown only when fresh; they include the
running LLM and do not establish whether another engine fits. **Check resources**
reads actual platform, GPU, memory and existing filesystem space through the
worker’s enrolled inspection connection. Genie has the same `inspect_media_host`
tool, controlled by the Server inspection switch. It never starts or stops a
service, downloads models or runs model code. Shared filesystems are grouped so
free space is not counted twice.

The check also reports exact model-file totals and manifest hashes for the
shipped H3 and ACE-Step recipes. Images, build caches and outputs need additional
space; the future installation destination must be checked separately. Matching
Linux ARM64/GB10 hardware is compatibility evidence, not a native runtime fit
result. Other platforms keep their existing capabilities and are labelled
unverified for these Spark recipes.

Observations carry their timestamp. The Media page keeps them until dashboard
restart; Genie's actual tool receipts remain with the conversation. Failed
inspection is shown explicitly, not as fresh readiness. Runtime memory fit
requires a native generation check using the selected configuration. A
recipe-driven setup action from this view remains unfinished; the separate New
Spark setup workflow remains for explicitly enrolled idle new hosts.

Result players and download links use local dashboard routes; the dashboard
adds the gateway credential on the server side. Keys stay out of browser URLs
and JavaScript. Normal status updates preserve player elements. In-app browser
playback validation encountered a renderer crash and is not claimed as passed;
retained audio download bytes matched their saved size and hash.
