# Image compatibility protection

DS4 may reject a JPEG before generation with the exact response
`invalid or unsupported JPEG image`. It currently rejects a typed GIF with the
misleading generic response `invalid JSON request`. When the optional protection
is enabled, DSG keeps a Pi Chat Completions session usable without pretending an
engine failure succeeded.

## What happens

1. DSG sends the original request to its assigned DS4 server unchanged.
2. A JPEG is eligible only after HTTP 400 with DS4's exact JPEG message. The
   generic GIF response is only a candidate: DSG must also parse the captured
   request as valid JSON, find a typed OpenAI Chat Completions `image_url` GIF
   data URI, strictly decode its base64 and verify GIF87a/GIF89a file magic.
   Otherwise the original status, headers and bytes pass through unchanged.
3. Eligible JPEGs are decoded under fixed byte limits, converted to PNG and
   retried once on the **same** DS4 server. Reasoning, output limits, tools,
   message order and every unrelated field are retained.
4. A proven GIF rejection is not converted or retried. DSG returns a fixed,
   successful assistant turn asking the user to send selected frames from the
   GIF as PNGs. The GIF is never silently omitted from a model request.
5. If JPEG conversion cannot be completed safely, or DS4 rejects the converted image,
   DSG returns HTTP 200 with a valid assistant turn explaining that the user should
   resend PNG/WebP or a standard RGB JPEG. Streaming callers receive a complete
   SSE turn and `[DONE]`; non-streaming callers receive a normal Chat Completions
   object with `finish_reason: "stop"`. Pi therefore remains alive.
6. DS4's exact `too many images; at most 16 are allowed` response is handled only
   when the captured request independently parses as valid Chat Completions JSON
   with more than 16 typed `image_url` blocks. DSG does not discard images. It
   completes the turn with advice to choose representative frames, build a contact
   sheet, or compact/start a fresh visual turn.

This guidance is labelled `DSG:` and the response carries
`x-dsg-protection: vision-jpeg-guidance`, `vision-gif-guidance` or
`vision-image-limit-guidance`. Every synthetic message ends with
`(This is a message from the DSG gateway.)`. It is counted as a protected
compatibility turn—not model completion and not model failure.

## Boundaries

- First release: `POST /v1/chat/completions` only. DSG does not synthesize a
  response in a protocol it cannot represent faithfully.
- JPEG: one conversion and one same-server retry. GIF: no conversion and no
  retry. There is no loop and no cross-server replay.
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
  capture bound, the upstream 400 remains untouched.
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
resend instruction so the client chat stays alive. GIF guidance never requires a
converter. The local **Manage DS4 servers** panel
shows converter availability, repaired/guidance/failure counts and a durable
Enable/Disable control. The toggle is stored in DSG's private state file and does
not restart or reconfigure DS4.

Optional bounds are `max_request_bytes`, `max_image_bytes`,
`max_normalized_bytes` and `timeout_ms`. Defaults are 64 MiB, 48 MiB, 192 MiB and
30 seconds. Raising them increases transient memory or decoder exposure; lowering
them can turn more rejected images into the safe resend-guidance path.

The persisted toggle and operator-control ID remain `vision_jpeg` for backward
compatibility with existing DSG installations; the control covers documented
JPEG repair and deterministic GIF guidance.

## Validation

The automated suite proves exact-error matching, byte-for-byte passthrough for
other errors, typed-field-only JPEG rewriting, preservation of
thinking/tools/output settings, same-server one-shot JPEG retry, streaming and
non-streaming guidance, bounded metadata, invalid-transcoder handling, toggle
persistence and no retry when disabled. A deployment should additionally send
one representative rejected JPEG and GIF and confirm a successful PNG rescue (or
JPEG guidance) and the fixed GIF guidance turn. For GIF, also confirm there was
no normalized retry and that unrelated `invalid JSON request` responses remain
untouched.
