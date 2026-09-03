# JPEG compatibility protection

DS4 may reject a JPEG before generation with the exact response
`invalid or unsupported JPEG image`. When the optional protection is enabled,
DSG keeps a Pi Chat Completions session usable without pretending an engine
failure succeeded.

## What happens

1. DSG sends the original request to its assigned DS4 server unchanged.
2. Only an HTTP 400 response containing that exact DS4 message activates the
   protection. Other response codes, messages and bodies remain ordinary upstream
   responses.
3. DSG finds only typed OpenAI Chat Completions `image_url` data URIs declared as
   JPEG, decodes them under fixed byte limits, converts them to PNG and retries
   once on the **same** DS4 server. Reasoning, output limits, tools, message order
   and every unrelated field are retained.
4. If conversion cannot be completed safely, or DS4 rejects the converted image,
   DSG returns HTTP 200 with a valid assistant turn explaining that the user should
   resend PNG, WebP or a standard RGB JPEG. Streaming callers receive a complete
   SSE turn and `[DONE]`; non-streaming callers receive a normal Chat Completions
   object with `finish_reason: "stop"`. Pi therefore remains alive.

This guidance is labelled `DSG:` and the response carries
`x-dsg-protection: vision-jpeg-guidance`. It is counted as a protected
compatibility turn—not model completion and not model failure.

## Boundaries

- First release: `POST /v1/chat/completions` only. DSG does not synthesize a
  response in a protocol it cannot represent faithfully.
- One conversion and one same-server retry. There is no loop and no cross-server
  replay.
- The request is captured only while the protection is enabled, is not compressed,
  and stays within configured bounds. It is held in memory for that request and is
  never written to DSG logs, diagnostics, state or training data.
- Unknown string fields that merely resemble a data URI are not rewritten.
- A connection loss, partial stream, accelerator fault, timeout or any situation
  where generation may have started is **not** converted into guidance. DSG keeps
  the existing no-ambiguous-replay rule.
- Oversized and unrelated upstream errors preserve their original status, headers
  and bytes. The exact JPEG error is the only intercepted engine response.
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
protection remains useful in **guidance-only** mode: it does not attempt repair,
but it still turns the exact pre-generation JPEG rejection into a normal resend
instruction so the client chat stays alive. The local **Manage DS4 servers** panel
shows converter availability, repaired/guidance/failure counts and a durable
Enable/Disable control. The toggle is stored in DSG's private state file and does
not restart or reconfigure DS4.

Optional bounds are `max_request_bytes`, `max_image_bytes`,
`max_normalized_bytes` and `timeout_ms`. Defaults are 64 MiB, 48 MiB, 192 MiB and
30 seconds. Raising them increases transient memory or decoder exposure; lowering
them can turn more rejected images into the safe resend-guidance path.

## Validation

The automated suite proves exact-error matching, byte-for-byte passthrough for
other errors, typed-field-only rewriting, preservation of thinking/tools/output
settings, same-server one-shot retry, streaming and non-streaming guidance,
bounded metadata, invalid-transcoder handling, toggle persistence and no retry
when disabled. A deployment should additionally send one representative rejected
JPEG and confirm either a successful PNG rescue or the complete guidance turn.
