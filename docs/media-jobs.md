# Media jobs and per-machine setup

These endpoints provide the durable queue and retained downloads. Downloads support
single HTTP byte ranges, including open-ended and suffix ranges, so players can
seek without downloading the whole result again. Authentication and retained file
bytes are unchanged. Genie can now
inspect the queue and assign a video job to an enrolled ComfyUI host. Its separate
runner drains that host, generates the result, saves the files, restores the
original LLM and verifies responses/cache reuse before readmission. A real
production Genie-led H3 cycle has passed, including retained downloads and LLM
return. A real ACE-Step XL/4B music cycle has also passed: normal API submission
woke Genie automatically, he assigned the host, and the runner generated audio,
retained it and verified LLM return. The Media view exposes saved host choices, per-member engine inventories and job results. Existing-host setup has passed native generation, retained-output decoding and verified LLM return on connected Sparks. Each installation still needs its own qualification; these receipts do not establish installation on pristine hardware.

Genie can select a finite batch when `media_job_status` reports
`batch_jobs_supported`: `start_media_job` accepts optional `following_job_ids`
for up to seven additional queued, unassigned jobs of the same engine and
priority. It reserves the whole selection together, runs each job once in order,
retains each result separately and restores/verifies the original LLM once.
This uses the existing media capability and maintenance controls, with no
additional service or idle-residency timer. Genie chooses the batch size based on
current text demand; at least one other LLM remains serving.

Higher-priority unassigned media work is checked between jobs. On such an arrival,
an unavailable checkpoint, or a failed batch job, the runner returns the original
LLM before releasing unsubmitted jobs to the queue. Already submitted generation
is never repeated or cancelled. Completed results remain available during return;
an unfinished return keeps the batch reserved and visibly needs attention.
These paths have component and installed-Hermes integration coverage; a native
multi-job cycle is a separate installation acceptance check.

For an isolated development installation, `"media_jobs": {"enabled": true}`
enables a private `media-jobs.json` beside the gateway state file. The existing
gateway process lock owns both stores; no additional service or database is
needed. The normal gateway bearer key protects every endpoint.

| Endpoint | Behavior |
| --- | --- |
| `POST /v1/music/jobs` | Queue native ACE-Step JSON parameters. |
| `POST /v1/video/jobs` | Queue an H3 text prompt or a native ComfyUI JSON workflow envelope. |
| `GET /v1/video/capabilities` | Read supported submission formats, physical budget, advisory slots and current limitations. |
| `POST /v1/video/batches` | Atomically queue a film containing 1–128 independently identified clips. |
| `GET /v1/video/batches` or `/v1/video/batches/{id}` | Inspect film progress, partial results and restoration separately. |
| `POST /v1/video/inputs` | Store raw image, audio or video bytes for a later video job. |
| `GET /v1/video/inputs/{id}` | Read the uploaded file's name, size and SHA-256 receipt. |
| `DELETE /v1/video/inputs/{id}` | Explicitly remove an input that no unfinished job uses. |
| `GET /v1/music/jobs` or `/v1/video/jobs` | List recorded job status. |
| `GET /v1/music/jobs/{id}` or `/v1/video/jobs/{id}` | Read a saved job and any native result metadata. |
| `GET /v1/{music\|video}/jobs/{id}/files/{file_id}` | Download a retained output using the normal gateway bearer key. |

Each job POST needs `Content-Type: application/json` and an `Idempotency-Key` of
1–200 printable characters. Reuse the same key when reconnecting or retrying a
submission whose response was lost. The same request returns the original job;
different content or priority with that key returns HTTP 409. A new job returns
HTTP 202 with its ID and status URL. Keys apply across both media routes.
The existing `x-dsg-priority` header accepts `high`, `normal` or `idle-only`;
priority orders waiting jobs only and never cancels active generation.

## Film submissions and client integration

The film API accepts `name`, optional shared payload `defaults`, and `clips`:

```json
{
  "name": "Example film",
  "defaults": {"seed": 42},
  "clips": [
    {"clip_id": "opening", "payload": {"prompt": "Opening scene"}},
    {"clip_id": "ending", "payload": {"prompt": "Closing scene", "seed": 43}}
  ]
}
```

Each clip has a unique `clip_id` (1–64 letters, digits, dots, underscores or
hyphens, starting with a letter or digit). Clip payload fields override shared
defaults. Native workflow envelopes are supported; use them to preserve a
production's resolution, frame counts, reference sizing and multiple references.
Upload shared reference assets once and reuse their IDs/names. The whole request
has a 2 MiB JSON limit; inputs travel through the separate upload API.

All clips validate before one durable queue write. A rejected last clip does not
leave earlier clips queued. Film and individual job keys share one idempotency
namespace. Keep the same body, priority and key after a lost acknowledgement;
the original batch, clip IDs, seeds and job IDs survive gateway restart.
`counts` and each clip's `outputs` expose partial completion. `generation_complete`
and `restoration_complete` are separate: generated videos are downloadable before
their machines have completed verified LLM return. An uncertain native operation
needs reconciliation rather than resubmission. A requested retake uses a new
individual job, leaving the original film and successful clips intact.

The portable Hermes skill lives at `examples/hermes/stargate-media`. Copy that
directory into your Hermes skills directory (normally
`~/.hermes/skills/creative/stargate-media`), preserving an existing installation
in a timestamped backup before replacing it. The bundled Python 3 client uses
the standard library on macOS/Linux; no cloud media provider is needed. Configure
`SG_URL` and, when required by your gateway policy, `SG_API_KEY` in your normal
private environment. Do not put credentials in a skill or tracked file.

```sh
python3 examples/hermes/stargate-media/scripts/media_client.py capabilities
python3 examples/hermes/stargate-media/scripts/media_client.py submit \
  --kind batch --request film.json --receipt film-receipt.json --priority normal
python3 examples/hermes/stargate-media/scripts/media_client.py wait \
  --receipt film-receipt.json --seconds 45
python3 examples/hermes/stargate-media/scripts/media_client.py download \
  --receipt film-receipt.json --directory results
```

The private receipt is flushed to disk before submitting. Reuse the same receipt
after interruption; after acknowledgement, repeated submit only reads status.
Changed payloads or priorities cannot overwrite that receipt. Downloads verify
byte count and SHA-256 and refuse to overwrite differing local files. Both native
video and generated audio are retained. Input upload acknowledgement currently
has no idempotent lookup: an uncertain upload is preserved and reported instead
of silently making more copies.

## Physical media budget and deferred work

`media_jobs.max_borrowed_sparks` optionally limits the number of physical machines
borrowed by media execution or setup. It is a nonnegative integer. Omitting it
preserves the installation's existing policy; zero prevents new borrowing without
cancelling accepted work. Configure `machine_groups` so every alias identifies
its physical members. A two-machine GLM pair consumes two units even when only
one member runs media. Multiple job records for the same ownership are counted
once. Uncertain/unfinished returns retain ownership. A later mapping change
cannot erase saved physical reservations. The budget supplements existing
serving-floor, native-idle, owner-pause and maintenance checks.

`media_jobs.held_job_ids` optionally names saved job UUIDs to keep deferred.
Held queued/unassigned jobs remain visible with `dispatch_hold`, retain their
idempotent identities, and are excluded from dispatch and watcher prompts. Holds
do not cancel an already assigned operation. Before enabling automatic dispatch
on an installation with old backlog, explicitly identify any jobs that should
remain deferred. Removing a hold makes that queued job eligible again.

The capabilities endpoint reports `max_borrowed_sparks`, `borrowed_sparks`,
`remaining_sparks`, and nonoverlapping advisory generation slots. Missing capacity
queues accepted films; it does not grant clients lifecycle authority. Slot counts
do not promise immediate execution, and unknown timing estimates remain null.

Set `media_jobs.parallel_pair_members: true` to opt an installation into shared
pair execution after qualifying both member engines and validating the parallel
workload. This does not alter per-engine concurrency: one generation runs per
physical member. The selected worker must have an exact pair binding, two
physical machine mappings, and both engines enrolled. Genie sees eligible kinds
in `workers[].parallel_kinds` and may pass `parallel_members: true` with two to
eight already queued compatible jobs to `start_media_job`. It cannot also select
an individual `member`. Default single-member behavior remains available.

One coordinator reserves both physical machines, checks both media engines before
draining, captures/stops the exact original GLM pair, and runs separate sequential
clip queues on the two members concurrently. All member/job assignments persist
before launch. Both outputs must be retained and all accepted native work must
settle before engines are stopped and the pair is restored and verified once.
A failure vetoes new clips without cancelling or replaying its sibling's accepted
job. Unsubmitted clips return to the queue only after verified pair return.
The Fleet view shows both member jobs under the shared operation.

The capability API reports `paired_members_parallel` only when an opted-in
worker has both enrollments; its slot count counts one slot per enabled member
while charging both physical members to the budget once. Clients still cannot
request a per-film parallelism limit (`requested_parallelism_supported: false`).
Detached execution survives core replacement without another launch. A killed
runner retains its claimed operation and uncertain state for reconciliation;
automatic resumption after runner death is not implemented. Do not launch a new
runner or replay native submissions to bypass that uncertainty.

**Native acceptance still required:** simultaneous generation on actual enrolled
members, full autonomous film production through installed Hermes, and native
six-machine operation. Component/fault tests prove ownership, overlapping fixture
generations and transport identities; they do not prove native memory fit,
throughput, output fidelity or production availability. Qualify those properties
before enabling the parallel policy on an installation.

## Individual clips and references

For a basic H3 video, agents can submit text directly:

```sh
curl "$SG_URL/v1/video/jobs" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: my-first-video' \
  --data '{"prompt":"A paper boat floating on a calm pond, with soft water sounds.","seed":42}'
```

Set `SG_URL` to the gateway address. With `"lan_auth": "none"`, localhost and clients in the configured LAN /24 need no Authorization header, API key, or client provisioning on any gateway route. Other peers still require the configured bearer key. Omit this setting (or use `"lan_auth": "bearer"`) to require bearer authentication everywhere. For bearer mode, add `-H "Authorization: Bearer $SG_API_KEY"` to each example. Set `lan_auth_prefix` to the first three address octets with a trailing dot (for example, `192.0.2.` in documentation examples). The policy uses the actual TCP peer, never forwarded headers.
The text form uses the shipped H3 workflow: 608×352, 96 frames at 24 fps
(approximately four seconds), 20 sampling steps, video with audio and a separate
audio result. The convenience form accepts `prompt`, optional `seed`, and optional
`reference_image` / `reference_audio` upload IDs. Omitting the seed chooses one when the job is first created. The response's
`generation` field reports the exact selected settings and recipe hash.
Retries with the same idempotency key retain the original seed and workflow,
including after a gateway restart or recipe update. For other generation settings
or multiple references of the same type, submit a native workflow as before. The prompt remains in
private job storage and is excluded from public job-status fields.

For a reference image, upload it to the gateway first (the file can be on the
agent's machine), then use the returned `id`:

```sh
curl "$SG_URL/v1/video/inputs" \
  -H 'Content-Type: image/png' --data-binary @reference.png

curl "$SG_URL/v1/video/jobs" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: my-reference-video' \
  --data '{"prompt":"Animate <Picture 1> gently.","reference_image":"UPLOAD_ID","seed":42}'
```

`reference_audio` works the same way with an audio upload ID and the `<Audio 1>`
tag. One image and one audio reference can be combined. Star Gate freezes the
correct native wiring and transfers the retained files to the selected worker;
you do not need to copy them separately onto each Spark. A filename that exists
on only one worker is not a portable reference.

Genie sees `input_requirements` for stock `LoadImage` / `LoadAudio` nodes and can
call `inspect_media_inputs(job_id, worker_id)` before choosing a worker. The tool
uses the Server inspection switch and reads mounted file metadata through the
enrolled connection, without starting H3 or draining the LLM. Results identify
present, missing, non-file or unknown paths on that worker. Unmounted paths,
custom launchers/loaders and unresolved symlinks remain unverified; unknown does
not mean missing. The existing start API remains available, and native validation
still runs before generation. File presence alone does not prove valid decoding
or reference fidelity. The check and its outcome are retained in chat activity.


This form uses the shipped REF2VA recipe: 608×352, 124 frames at 24 fps, 20 steps,
reference sizing `match`. The receipt exposes these settings plus the reference
IDs and hashes. A valid receipt confirms the requested inputs, not visual fidelity.
Use a native workflow for `max` reference sizing or other settings. Missing IDs
and mismatched image/audio upload types fail before queueing.

JSON submissions may be up to 2 MiB. Upload larger reference files separately
using the input endpoint below.

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
calls, real media output and verified LLM return. Automatic queue wakeup is available when its capability and dispatch settings are enabled; its wakeup-to-tools path was separately tested with pinned Hermes and a
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

While the media capability is on and `media_jobs.automatic_dispatch` is not false, the existing ten-second dashboard tick wakes
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

## Submit from the dashboard

Open **Media → MiniMax H3**, describe the scene and choose **Queue video**.
The form uses the same text-video API and shipped short-video recipe as agents.
Genie chooses an eligible machine; progress, results and LLM return appear in the
existing job cards. If media placement is off, the request stays queued.

Fleet server cards also identify a gateway-managed H3 or ACE-Step operation,
its current stage, active batch job, elapsed time and retained outputs. Hardware
telemetry stays visible; LLM-specific measurements are expandable while media is
running. When H3 supplies native progress, the card shows the current node and
sampling steps separately from the runner heartbeat. Finishing a sampling node
does not mean the whole job or LLM restoration is complete. Missing or stale
progress remains explicit; the display does not invent an ETA.

Genie's `media_job_status()` tool provides a compact fleet and queue overview.
For full saved native results, file manifests or error details, Genie can call
`media_job_status` with a `job_id`. Summaries do not delete or replace full records.

If submission is not confirmed, retry the unchanged prompt. The browser keeps its
request key in this tab's session storage, including across reloads, so the retry
returns the same job. Editing the prompt creates a different request. The gateway
API key stays on the server. The form is enabled only when the connected gateway
advertises text-video support.

## Example video request

[`examples/media/h3-text-to-video.json`](../examples/media/h3-text-to-video.json)
is a native workflow for the qualified H3 model files. Its dimensions, frame
count, seed and sampling parameters belong to this example job; they do not
alter the installed engine's serving configuration. It produces video with an
embedded soundtrack plus a separate audio file. Edit node 7's prompt for another scene.

Submit that JSON to `POST /v1/video/jobs` with your normal gateway bearer key and
a unique `Idempotency-Key`. Poll the returned status URL; download the URLs in
`outputs.files` when `outputs.state` is `ready`. `execution.phase: returned`
confirms the host's LLM checks and readmission have finished.

For a reference-to-video workflow, the installed ComfyUI V3 node uses namespaced
dynamic input keys: `ref_images.ref_image_0`, `ref_audios.ref_audio_0`,
`ref_videos.ref_video_0`, and `ref_video_audios.ref_video_audio_0`. Each value is
the usual `["source_node_id", output_index]` link. Number additional inputs from
zero. Bare keys such as `ref_image_1` are not equivalent and can cause an
unexpected-keyword error. References can use files already in the engine's input
storage, or gateway uploads as described below. This describes the installed input schema; the verified example
above is text-to-video, not a claim that every reference workflow has passed.
The [reference-image example](../examples/media/h3-reference-image.json) provides
the namespaced wiring with a synthetic colour image and REF2VA weights. The
portable H3 model manifest now includes those weights alongside FL2VA; older
installations may only have FL2VA. Run the normal H3 model setup against that
installation's model tree to add the missing asset without replacing its files.
Do not infer image conditioning from the `MiniMaxH3ImageToVideo` class name:
without `first_frame` or `last_frame` links, that node runs text-to-video.

### Upload references through the gateway

Use the same gateway address and bearer key as your LLM requests. The gateway
stores uploads privately and transfers them to whichever enrolled ComfyUI engine
is assigned the job. Clients do not need a Spark address or SSH access.

```sh
# STAR_GATE_URL is the gateway origin, without /v1; STAR_GATE_API_KEY is its key.
curl --fail-with-body "$STAR_GATE_URL/v1/video/inputs" \
  -H "Authorization: Bearer $STAR_GATE_API_KEY" \
  -H 'Content-Type: image/png' --data-binary @reference.png > image-receipt.json
```

The [uploaded-reference example](../examples/media/h3-reference-files.json)
contains the complete image-plus-audio workflow. Replace its four `UPLOADED_*`
placeholders with the two upload receipts before submitting it as a video job.
Its sample prompt describes a paper boat and a synthetic tone; edit that prompt
to match your references. The video includes its soundtrack, with a separate
FLAC output retained as well.

Keep the returned `id` and `name`. Add `"input_files": ["<returned id>"]` alongside
`prompt` in the job JSON. Replace the reference-image example's node 5 with
`{"class_type":"LoadImage","inputs":{"image":"<returned name>"}}`; the existing
`ref_images.ref_image_0` link remains `["5", 0]`. For audio, upload with
`Content-Type: audio/wav`, add that ID to `input_files`, and use a `LoadAudio`
node with `inputs.audio` set to its returned name. Connect that node's output 0
to `ref_audios.ref_audio_0`. Do not pass the input ID as a native filename.

Uploads require `Content-Length` (curl supplies it for a regular file).
Supported types are PNG, JPEG, WebP, GIF, WAV, FLAC, MP3, Ogg, MP4 and WebM;
the selected native loader still determines which formats it can decode.
Defaults are 100 MiB per file and 2 GiB of stored inputs, adjustable through
`media_jobs.input_max_bytes` and `media_jobs.input_total_bytes`. Uploads are
streamed to disk, and in-flight uploads finish before a coordinated core restart.
Job progress shows `transferring_inputs` before native generation. A transfer
failure is reported and follows the existing original-LLM restoration path.

Inputs survive gateway restarts and are retained until explicitly deleted.
Use `DELETE /v1/video/inputs/{id}` with the same bearer key when no longer needed;
an unfinished job keeps its references protected. This deletes the gateway copy,
not native engine files or job outputs. Uploads do not use job idempotency keys:
keep the receipt, since repeating an upload creates a separate input. Upload
receipts expose metadata, not a public file download URL.

The upload path has isolated API, transfer and restoration tests. In a real
installation, two gateway uploads automatically woke Genie; his actual tools
read fleet status and assigned a host. Native image/audio files matched both
upload hashes, the reference workflow succeeded, and the retained H.264/AAC
video and separate FLAC fully decoded. This tests reference input processing,
not identity or voice fidelity. The original LLM returned automatically with its
container configuration preserved, successful responses and two 4,800-token
warm-cache hits before gateway readmission.

A later synthetic colour-preservation check failed: a blue reference produced
an orange billboard with both tested samplers. Reference fidelity remains
unresolved for that case. Correct transfer and namespaced wiring must not be
presented as proof that the generated result faithfully follows a reference.

When ComfyUI records a node execution error, the Media tab and job API show the
node and its error message separately from the host's LLM restoration phase.
Pre-execution workflow validation errors, such as a missing model or invalid
input filename, are retained with the failed job as well.
The failed job and native receipt remain available; viewing them never resubmits
the generation.

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
requires a native generation check using the selected configuration. The recipe-driven setup action is available for eligible existing workers. Native setup has passed on connected Sparks, including a newly prepared ACE-Step installation and retained Docker-engine reuse; qualification remains specific to the selected engine and physical member. The separate New Spark setup workflow is for explicitly enrolled idle new hosts.

The existing-worker setup lifecycle uses a separate detached runner, connected
to **Set up ACE-Step / MiniMax H3** in Media and Genie's `setup_media_host` tool.
Turn on the Media capability and allow placement on the chosen machine first.
The machine needs a matching Docker/Qwen recovery and inspection enrollment.
Setup preserves an already enrolled engine instead of replacing it. New files
go under the enrolled SSH account's `.local/share/star-gate/media-setup`, in a
separate directory for each saved operation.
It uses the existing maintenance controls to drain an enrolled Docker/Qwen LLM,
prepares only selected media recipes in a separate directory, reuses the native
sample qualifier, then restores the exact original LLM and checks responses and
cache reuse before readmission. A lost preparation acknowledgement is observed
without repeating the installation. The Media page reports preparation bytes,
native qualification and return state. After verified return, a fresh comparison
of the stopped media container precedes saving its engine binding in the existing
private gateway state, with a backup. Existing engines, capability switches and
placement choices are preserved. A pending final enrollment can be retried with
**Finish setup**, without repeating installation or generation.

Retained media enrollment follows the enrolled physical machine, so an LLM or
local tunnel update on that same machine does not discard its qualified media.
An in-progress setup still requires its exact original configuration when it
finishes. A replacement machine cannot inherit saved engines from the previous
machine; the prior records remain in the timestamped state backup. Older records
without a physical-machine binding retain their original exact-binding check.

Lifecycle, retained enrollment/restart, private control routes and UI controls have fixture tests. The actual Genie has also called the setup tool on connected hardware: native media generation, full decoding, current paired-LLM restoration and final enrollment passed. These receipts establish those installations, separately from the fixture tests and from pristine-host acceptance. Guarded control-service activation keeps the continuity Door running and drains admitted work before replacing the core.

Result players and download links use local dashboard routes; the dashboard
adds the gateway credential on the server side. Keys stay out of browser URLs
and JavaScript. Normal status updates preserve player elements. In-app browser
playback validation encountered a renderer crash and is not claimed as passed;
retained audio download bytes matched their saved size and hash.

### Diagnosing rejected or failed media jobs

Star Gate reports the engine, native HTTP status, and available node/field error
through the job API and Media tab. Failed jobs can also include `next_step` for
memory, disk, missing-model/node and unreadable-file errors. Native prompts and
traceback objects are not copied into these explanations. The original native
receipt remains available in the installation's private job storage.

For H3 references, use `"ref_images.ref_image_0": ["SOURCE_NODE_ID", 0]` (audio:
`ref_audios.ref_audio_0`; video: `ref_videos.ref_video_0`; paired soundtrack:
`ref_video_audios.ref_video_audio_0`). The grouped form `ref_images: [[...]]`
can be silently ignored by ComfyUI. Star Gate rejects that form and malformed
reference links before queueing. Files named `stargate/...` in supported loaders
must also be listed by their upload IDs in `input_files` so they are transferred
to the selected worker. Naming `<Picture1>` in a prompt alone does not wire an image.

Once the chosen engine is available, its live `/object_info` catalog is checked
for missing nodes, unavailable combo values (including model filenames), and
unsupported H3 reference indices before generation is submitted. These checks
need a running engine; they are not all pre-allocation checks. Valid raw graphs
are not rewritten, and generation settings are not reduced automatically.

The stock `LoadImage.image` upload dropdown is not an authoritative file list:
ComfyUI lists top-level input files there, while its native validator accepts
subfolders. Star Gate therefore leaves this field's file validation to native
`POST /prompt`, including uploaded `stargate/...` references. Missing or invalid
files still receive the native node error; upload association and transfer checks
remain in place. Other combo values, including model filenames, remain checked
against the live catalog.

ACE-Step HTTP validation errors retain the field location and reason. Native
failed-task messages are shown rather than a generic generation failure. An
unreadable reply or a cache timeout that still contains a running task remains
uncertain: Star Gate observes the original task without cancelling or replaying it.

Retry an unchanged request with its original `Idempotency-Key` to retrieve its
existing job. Use a new key after correcting a rejected/failed request. A lost
reply is not permission to submit again with a new key. Producing a valid video
file does not, by itself, prove reference conditioning or identity fidelity.

ACE-Step numeric and boolean preflight checks catch malformed supplied values
before queueing, including aliases and effective fields in `param_obj` or
metadata. For example, `inference_steps: "careful"` would otherwise silently
become 8; `thinking: "please"` would become false. Use numbers or numeric strings,
and true/false or ordinary boolean strings. Null/empty automatic values, negative
native sentinels, advanced options and accepted-job retries are preserved.
The gateway does not set new duration, step or batch limits.

Music JSON accepts `reference_audio_path` / `src_audio_path` and their native
aliases for files already present on the selected ACE-Step host. Multipart field
names such as `ref_audio` in JSON, or nonempty video `input_files`, are rejected
with an explanation rather than silently ignored. Automatic music reference
upload/transfer is not implemented by this check.


### Existing paired GLM workers

An operator can enroll `media_jobs.pairs[worker_id]` with kind
`glm53-docker-pair`, its served `model`, the exact `worker_binding` route
(`id`, `url`, and any `ssh`, `ssh_fallbacks`, `remote_port` fields), and two
`members` in head/rank order. Each member names an enrolled `ssh` target and
Docker `container`; the head must match its server-inspection enrollment.
Include the head's `recipe_root` to retain and guard its launcher files.
This is trusted local configuration, never model-provided shell input.

For your own worker names, configure `machine_groups` to describe shared hardware:
for example `{"my-pair":["gpu-a","gpu-b"],"other-model-on-a":["gpu-a"]}`.
Use the same physical IDs for every route or SSH alias on a machine. Media uses
these groups to prevent treating another model on borrowed hardware as the LLM
that must remain available. If groups are absent, configured pair member SSH
targets and single-worker inspection SSH targets supply the hardware identity;
different aliases require explicit groups.

`engine_members: {"video": 0, "music": 1}` supplies default setup destinations;
omitted assignments use the head. For a standard configuration with both engines
on every physical Spark, call `setup_media_host` for each engine with `member: 0`
and `member: 1`. These are indices into your configured pair, never fixed hostnames.
For example, `{"worker_id":"my-pair","engine":"h3","member":1}` sets up H3
on your rank member. Repeat with `engine: "ace-step"` for music.

`inspect_media_host`, `inspect_media_inputs`, and `start_media_job` accept the same
optional `member`. Status exposes separate `members[].engines` inventories; an
installation on one member does not qualify the other. Each setup retains its
own native proof and survives service restarts. A repeated setup observes its
existing operation without launching again. The first qualified engine may
become the default if none exists; adding another member never replaces an
existing default. Calls without `member` keep the existing default behavior.
Retained per-member engines are stored separately from default selections.

To reuse a previous Star Gate media preparation on the same physical host,
operators can configure `media_jobs.reuse[worker_id][member][engine]` with its
absolute remote `directory` and exact `container`, `image`, `kind`, and `port`
from the retained preparation receipt. `engine` is `h3` or `ace-step`; `kind` is
`comfyui` or `ace-step`. This trusted configuration selects a candidate, not a
qualified enrollment. Normal setup still drains the current LLM, verifies the
retained container and source receipt, generates and fully decodes new output,
and restores the current LLM before enrollment. It preserves the old source
directory, model files, image and container instead of building a duplicate.
Changed or missing source evidence refuses reuse and returns the current LLM;
it does not silently fall back to rebuilding or replacing the old engine.

For an existing Docker installation made outside Star Gate, replace `directory`
with `"source":"docker"` and pin the same four engine fields. This path observes
the exact stopped container and its native port, snapshots its complete Docker
configuration, and performs the same fresh qualification and current-LLM return.
It does not rewrite the existing launch command, mounts, image or model files.

The existing `setup_media_host` and `start_media_job` tools then borrow the
whole pair. They retain both complete Docker configurations and file backups,
drain the virtual worker, require a serving LLM on separate machines, stop both
originals by ID, and run media on the selected member. Return starts the original rank
before the original head. Changed settings or mounted files prevent automatic
return; uncertainty retains the maintenance hold. Native model metadata and a
readiness response must pass before readmission. That response is a serving
check, not a new performance benchmark or cache comparison.

H3 and ACE-Step setup still installs each selected engine separately and
requires native output retention and full decoding before saving enrollment.
Paired support does not enroll, start, or migrate any machine on installation.
Keep `media_jobs.automatic_dispatch: false` when only explicit media tool calls
are wanted. The Media capability still controls those calls; this additional
setting prevents the dashboard from waking Genie for queued media jobs.


Retained preparations can outlive the LLM that originally created them. Reuse
checks the selected engine's original image, command, port and mounts while
pinning the current LLM for this operation. The old LLM identity remains in the
provenance receipt; its container does not need to exist. Source records remain
unchanged, and the normal idle and current-LLM return checks still apply.

If read-only preflight fails before any maintenance, stop or preparation intent,
correct the cause and pass its exact saved `at` value as `expected_failed_at` to
`setup_media_host` (or use **Retry setup** in Media). The executor confirms that
the runner exited and the target binding is unchanged, archives the full failed
attempt, then retries under the same operation ID. Ordinary repeated calls only
observe it. A stale timestamp, live runner, uncertain failure or any transition
intent refuses retry; inspect that operation instead. This never reruns an
uncertain native installation or generation.


### Maintain an owner-selected standard

Set `media_jobs.standard.enabled` to true and provide explicit `targets`, for
example:

```json
{
  "enabled": true,
  "targets": [
    {"worker_id": "my-pair", "member": 0, "engine": "h3"},
    {"worker_id": "my-pair", "member": 0, "engine": "ace-step"},
    {"worker_id": "my-pair", "member": 1, "engine": "h3"},
    {"worker_id": "my-pair", "member": 1, "engine": "ace-step"}
  ]
}
```

This is standing authority to set up those engines through Genie. It preserves
placement choices and the Media capability; neither is switched on implicitly.
The existing dashboard tick compares this standard with separate per-member
enrollments, waits for idle capacity and wakes the actual Genie for the next
missing engine. Saved observations and chat request identities survive reloads.
Native setup still enforces its own reservation, resource, qualification and LLM
return checks. `media_job_status` and the dashboard media API expose
`standard_setup`; a recorded enrollment does not mean a server is currently running.

Long-running operations are observed without resubmission. A qualified return
with unfinished enrollment wakes Genie to finish that same operation. A failed
or uncertain operation gets one read-only diagnosis per changed failure; it is
never automatically replayed. Other eligible targets can continue. An ended
Genie reply with no observed setup is reported as needing attention. This loop
is independent of `automatic_dispatch`, which controls queued media jobs.

Resource inspection also reports a bounded, read-only inventory of Docker
containers publishing native media ports. These are candidates, not qualification
or permission to replace an engine. Missing observations remain unknown; private
container environments and commands are excluded.

This standard watcher covers enrolled media setup. It does not yet autonomously
select, qualify and promote arbitrary upstream recipe releases. That improvement
loop is a separate requirement; having trial and rollout tools is insufficient.

A configured reuse candidate can be corrected after a confirmed read-only
preflight failure. The executor requires the worker, LLM, physical members and
inspection/recovery binding to remain identical. Older operation records gain
that separate infrastructure identity only while their original complete
configuration still matches. Only an exited attempt with no maintenance, stop or
preparation intent becomes eligible for retry.

For an owner-enabled standard target, Genie can call `repair_media_setup` with
its exact saved failure timestamp. A fixed native reader verifies the current
LLM identity and running state, then requires a complete bounded Docker inventory
to prove the old media container absent. It selects a unique stopped container
with a recognized native engine command and port. Active, unknown, ambiguous or
unsupported candidates refuse correction. With no candidate, it selects a
separate fresh preparation; old model files, images, directories and receipts
remain intact. It never starts or stops a service during source selection.
The shipped H3 entrypoint, directly or behind its exact `tini` wrapper, is a
recognized candidate only in its expected ComfyUI working directory. Recognition
does not qualify the models or generated media. When the native source reader
changes, the watcher permits one new read-only selection attempt for the same
failed preflight; unchanged readers do not repeatedly wake Genie. This does not
repeat native setup or relax the timestamp, exited-runner or preservation gates.

The selection is backed up and saved through the gateway's owned state, with a
native evidence receipt. It survives restart on the same enrolled physical
machine; an explicit change to the operator's configured source takes precedence.
Existing qualified engines cannot be replaced by this tool. Media, inspection,
placement and standard-target permissions all apply. A lost reply returns the
same saved decision.

The watcher then observes `retry_ready` and asks Genie for a same-operation retry
with the exact failure timestamp. The full previous attempt is archived. Fresh
native generation, retained output decoding, current LLM restoration and final
enrollment remain mandatory. This correction path cannot replay a failed or
uncertain installation that progressed beyond read-only preflight.

Native queue observations use the gateway's current engine enrollments, including
engines qualified after dashboard startup. Paired engines are queried on their
own physical member, with one observation per member/kind; the original default
selection does not create a duplicate probe. A changed enrollment invalidates
old in-flight observations. Unbound or unreachable engines remain unknown.
These read-only queue probes do not prove installation integrity or successful
generation, and do not automatically replace an enrolled engine.

An enabled standard also requests a read-only native container audit through
actual Genie after setup activity is idle, initially and every 24 hours.
`media_jobs.standard.audit_interval_hours` selects a positive whole number of
hours; `audit_enabled: false` disables these audits. Media and Server inspection
must both remain enabled. `audit_media_standard` takes no arguments: it checks
only the standard's currently enrolled container IDs, images and native port
bindings on each physical member. The gateway saves dated evidence with a backup;
status reads never open SSH connections. Changed host or engine bindings invalidate
old observations. Busy setup is deferred, and uncertain chat submission retains
its original request identity across watcher restart.
If Genie finishes an audit reply without fresh native evidence, the watcher
requests one corrective read-only tool call. That request also retains its
identity across lost acknowledgements and restarts. Two replies without a native
receipt leave visible attention status; neither narrative claims nor repeated
chat turns count as a successful audit. A dated unavailable result is evidence
of an unsuccessful observation, not absence and not a reason for this retry.

The results distinguish **present**, **absent**, **changed** and **unavailable**.
Absence requires a complete native Docker inventory on the host with the enrolled
LLM reference; an SSH or inspection failure is unavailable. A present container
does not prove model-file integrity, generation, cache performance or readiness.
Failures wake Genie for read-only diagnosis without erasing enrollment, changing
placement, restarting or replacing a service. Automatic replacement of an already
enrolled missing engine remains unsupported; this audit is detection and evidence,
not a completed repair or upstream-improvement loop.
