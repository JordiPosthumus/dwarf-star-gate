# Image compatibility protection

DS4 may reject a JPEG before generation with the exact response
`invalid or unsupported JPEG image`. It currently rejects a typed GIF with the
misleading generic response `invalid JSON request`. When the optional protection
is enabled, DSG keeps a Pi Chat Completions session usable without pretending an
engine failure succeeded.

## What happens

These steps describe the **gateway-only fallback**, not proof that the agent
completed its visual task. For history-aware preparation and a concrete image
selection tool, explicitly enroll the [Pi visual continuity companion](client-continuity.md#image-history-continuity-for-pi-explicit-enrollment).
The limit counts image blocks in the whole submitted conversation. A PNG contact
sheet is one image, not one image per tile. Merely reading fewer new screenshots
does not remove images still being resent from older turns.

1. DSG sends the original request to its assigned DS4 server unchanged.
2. A JPEG is eligible only after HTTP 400 with DS4's exact JPEG message. The
   generic GIF response is only a candidate: DSG must also parse the captured
   request as valid JSON, find a typed OpenAI Chat Completions `image_url` GIF
   data URI, strictly decode its base64 and verify GIF87a/GIF89a file magic.
   Otherwise the original status, headers and bytes pass through unchanged.
3. Eligible JPEGs are decoded under fixed byte limits, converted to PNG and
   retried once on the **same** DS4 server. Reasoning, output limits, tools,
   message order and every unrelated field are retained.
4. A proven GIF rejection is never converted. DSG withholds only the unsupported
   GIF from one transient recovery view, appends an explicit diagnostic and calls
   the **same** server once. The diagnostic says the GIF remains in client history,
   forbids pretending it was inspected and leaves the agent to extract selected
   PNG frames with tools, continue without it or ask the user. If that recovery
   call is rejected, DSG falls back to the fixed selected-PNG-frames guidance.
5. If JPEG conversion cannot be completed safely, or DS4 rejects the converted image,
   DSG returns HTTP 200 with a valid assistant turn explaining that the user should
   resend PNG/WebP or a standard RGB JPEG. Streaming callers receive a complete
   SSE turn and `[DONE]`; non-streaming callers receive a normal Chat Completions
   object with `finish_reason: "stop"`. Pi therefore remains alive.
6. DS4's exact `too many images; at most 16 are allowed` response is handled only
   when the captured request independently parses as valid Chat Completions JSON
   with more than 16 typed `image_url` blocks. DSG chooses no subset. It builds a
   transient recovery view with every visual block withheld, appends an explicit
   diagnostic for the model, and calls the **same** server once. The diagnostic
   gives the exact count and limit, says the images remain in client history,
   forbids pretending they were inspected, and leaves the agent to select images,
   build a contact sheet, compact visual history or ask the user. The client
   session and stored conversation are not edited. Text, roles, tools, reasoning,
   output limits and unrelated request fields are preserved.
7. A successful image-limit recovery is a normal model completion carrying
   `x-dsg-protection: vision-image-limit-recovery` and a bounded withheld-image
   count. If DS4 rejects the recovery request again, DSG completes the turn with
   the prior representative-frame/contact-sheet guidance. It never loops.

This guidance is labelled `DSG:` and the response carries
`x-dsg-protection: vision-jpeg-guidance`, `vision-gif-guidance` or
`vision-image-limit-guidance`. A successful image-limit recovery instead carries
`vision-image-limit-recovery`; successful GIF recovery carries
`vision-gif-recovery`. Every synthetic guidance message ends with
`(This is a message from the DSG gateway.)`. It is counted as a protected
compatibility turn—not model completion and not model failure.

## Boundaries

- First release: `POST /v1/chat/completions` only. DSG does not synthesize a
  response in a protocol it cannot represent faithfully.
- JPEG: one conversion and one same-server retry. Image-limit/GIF recovery: one
  bounded same-server diagnostic model call. GIF is never converted. There is no
  loop and no cross-server replay.
- The request is captured only while the protection is enabled, is not compressed,
  and stays within configured bounds. It is held in memory for that request and is
  never written to DSG logs, diagnostics, state or training data.
- Unknown string fields that merely resemble a data URI are not rewritten.
- A connection loss, partial stream, accelerator fault, timeout or any situation
  where generation may have started is **not** converted into guidance. DSG keeps
  the existing no-ambiguous-replay rule.
- Oversized and unrelated upstream errors preserve their original status, headers
  and bytes. A generic JSON error without an independently proven real typed GIF
  is never intercepted.
- The image-count rule is proof-gated: the exact backend wording alone is not
  sufficient. If DSG cannot parse and count the original typed images within its
  capture bound, the upstream 400 remains untouched. Visuals are withheld only
  from the diagnostic recovery call, never deleted from client history, and the
  model is explicitly told what happened and required to choose the next action.
- Automatic discovery uses the fixed stock `/usr/bin/sips` path on macOS.
  ImageMagick must be selected explicitly and is invoked from a fixed allowlist of
  absolute executable paths; DSG never searches a mutable `PATH` for image tools.

## Configuration and UI

```json
"vision_compatibility": {
  "enabled": true,
  "transcoder": "auto"
}
```

`auto` currently discovers stock macOS `sips`. Set `transcoder` explicitly to
`sips`, `magick`, `convert` or `none` when appropriate. With no converter, the
protection remains useful in **guidance-only** mode: it does not attempt JPEG
repair, but still turns a proven pre-generation JPEG rejection into a normal
resend instruction so the client chat stays alive. GIF recovery/guidance never
requires a converter. The local **Manage DS4 servers** panel
shows converter availability, repaired/guidance/failure counts and a durable
Enable/Disable control. The toggle is stored in DSG's private state file and does
not restart or reconfigure DS4.

Optional bounds are `max_request_bytes`, `max_image_bytes`,
`max_normalized_bytes` and `timeout_ms`. Defaults are 64 MiB, 48 MiB, 192 MiB and
30 seconds. Raising them increases transient memory or decoder exposure; lowering
them can turn more rejected images into the safe resend-guidance path.

The persisted toggle and operator-control ID remain `vision_jpeg` for backward
compatibility with existing DSG installations; the control covers documented
JPEG normalization and deterministic, agent-driven GIF recovery.

## Validation

The automated suite proves exact-error matching, byte-for-byte passthrough for
other errors, typed-field-only JPEG rewriting, no-selection visual recovery,
model-visible diagnostics, preservation of text/thinking/tools/output settings,
same-server one-shot recovery, no recovery loop, streaming and non-streaming guidance,
bounded metadata, invalid-transcoder handling, toggle persistence and no retry
when disabled. A deployment should additionally send
one representative rejected JPEG and GIF and confirm a successful PNG rescue (or
JPEG guidance) and a model-driven GIF recovery turn. For GIF, also confirm there
was no conversion, exactly one same-server recovery call and that unrelated
`invalid JSON request` responses remain untouched.
