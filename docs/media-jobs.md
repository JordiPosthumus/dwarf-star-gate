# Media jobs — implementation in progress

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
retained it and verified LLM return. The Media view now exposes saved host choices and job results. Read-only resource checks are available; native memory-fit qualification and
complete fresh-host installation remain in progress.

For an isolated development installation, `"media_jobs": {"enabled": true}`
enables a private `media-jobs.json` beside the gateway state file. The existing
gateway process lock owns both stores; no additional service or database is
needed. The normal gateway bearer key protects every endpoint.

| Endpoint | Behavior |
| --- | --- |
| `POST /v1/music/jobs` | Queue native ACE-Step JSON parameters. |
| `POST /v1/video/jobs` | Queue an H3 text prompt or a native ComfyUI JSON workflow envelope. |
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

For a basic H3 video, agents can submit text directly:

```sh
curl "$SG_URL/v1/video/jobs" \
  -H "Authorization: Bearer $SG_API_KEY" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: my-first-video' \
  --data '{"prompt":"A paper boat floating on a calm pond, with soft water sounds.","seed":42}'
```

Set `SG_URL` to the gateway address and `SG_API_KEY` to its normal bearer key.
The text form uses the shipped H3 workflow: 608×352, 96 frames at 24 fps
(approximately four seconds), 20 sampling steps, video with audio and a separate
audio result. Only `prompt` and optional `seed` are accepted in this convenience
form. Omitting the seed chooses one when the job is first created. The response's
`generation` field reports the exact selected settings and recipe hash.
Retries with the same idempotency key retain the original seed and workflow,
including after a gateway restart or recipe update. For reference inputs or other
generation settings, submit a native workflow as before. The prompt remains in
private job storage and is excluded from public job-status fields.

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

## Submit from the dashboard

Open **Media → MiniMax H3**, describe the scene and choose **Queue video**.
The form uses the same text-video API and shipped short-video recipe as agents.
Genie chooses an eligible machine; progress, results and LLM return appear in the
existing job cards. If media placement is off, the request stays queued.

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
requires a native generation check using the selected configuration. A
recipe-driven setup action is now connected in source for eligible existing
workers, with the controls now deployed through a coordinated core/dashboard
update. Complete native qualification of this new whole workflow remains
outstanding. The separate New Spark setup workflow remains
for explicitly enrolled idle new hosts.

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

Lifecycle, retained enrollment/restart, private control routes and UI controls
have fixture tests. The pinned Hermes runtime has called the setup tool and its
actual receipt remains in chat. These checks do not yet establish complete native
existing-host installation. Production activation preserved existing capability
and placement choices, private settings and active maintenance locks. The
continuity Door stayed running; the core finished admitted work before replacement.

Result players and download links use local dashboard routes; the dashboard
adds the gateway credential on the server side. Keys stay out of browser URLs
and JavaScript. Normal status updates preserve player elements. In-app browser
playback validation encountered a renderer crash and is not claimed as passed;
retained audio download bytes matched their saved size and hash.
