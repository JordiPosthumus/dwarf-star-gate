---
name: stargate-media
description: Make videos and multi-clip films through the owner's DSG gateway. Submit individual H3 jobs or film batches with shared uploaded references, observe the same jobs, and retrieve generated video and audio while Genie manages the machines. Use when the user requests gateway or local Spark video production.
---

# Videos through DSG

Use the bundled `scripts/media_client.py` with Python 3. Its default gateway is
`http://127.0.0.1:30000`; another installation sets `SG_URL`. Set `SG_API_KEY` only
when that gateway requires bearer authentication. Never read another application's
credentials or manipulate Spark services to make a submission work.

Start with `capabilities` to inspect dispatch availability, the physical-Spark
budget, current slots, supported input formats and the distinction between the
short convenience recipe and full native workflows. Submit the complete requested
batch even when fewer slots are available: DSG owns placement and waiting. Do not
promise an ETA or parallelism that the live API does not support.

For a text clip, put `{"prompt":"the requested scene","seed":42}` in a private
JSON file. For production clips, preserve the user's existing native H3 graphs,
resolution, frames, steps, seeds and reference sizing. The short convenience
recipe is not a substitute for a high-quality film. Reference wiring uses
`ref_images.ref_image_0`, `ref_audios.ref_audio_0`, etc.; grouped reference lists
silently failed conditioning in older engines and are not equivalent.

Upload a shared asset once with `upload --file PATH --receipt INPUT_RECEIPT`.
Use the returned ID and name in all clips that need it. Text requests use
`reference_image` / `reference_audio`; native graphs use those returned names
in LoadImage/LoadAudio nodes and an `input_files` list of upload IDs. DSG transfers
inputs to selected engines. Do not use private engine-local filenames or SCP.

A film JSON file has this shape:

```json
{
  "name": "Example film",
  "defaults": {"seed": 42},
  "clips": [
    {"clip_id": "opening", "payload": {"prompt": "Opening scene"}},
    {"clip_id": "scene-02", "payload": {"prompt": "Second scene", "seed": 43}}
  ]
}
```

`defaults` supplies shared payload fields; individual clip fields override them.
For native workflows each `payload` can instead contain `prompt` as a node graph
and `input_files`. Keep artistic planning, reference/voice preparation and assembly
in the relevant production workflow; this skill supplies transport and tracking.

Run these commands using the script's actual installed path:

```sh
python3 scripts/media_client.py capabilities
python3 scripts/media_client.py submit --kind batch --request film.json --receipt film-receipt.json
python3 scripts/media_client.py wait --receipt film-receipt.json --seconds 45
python3 scripts/media_client.py download --receipt film-receipt.json --directory results
```

Use `--kind video` for one clip. `--priority high|normal|idle-only` selects queue
priority (default `normal`); use the same priority when retrying. The private
receipt is written **before submission** and retains the exact request and
idempotency key. If acknowledgement is lost, repeat
the same submit command and receipt; never create a new receipt as a retry. After
acceptance, use `status` or bounded `wait` calls. A wait timeout does not cancel
or fail generation. Continue observing that identity, including after reconnect.
For an uncertain upload, preserve its receipt and report that its acknowledgement
was lost rather than silently uploading repeated copies.

Retrieve completed clips while others run. Downloads verify the gateway's byte
count and SHA-256 and never overwrite different local content. Native video may
have a separate generated audio file: retain both and use H3's generated audio
for assembly; do not silently replace it with the reference voice track.

Report generated output and GLM restoration separately. A completed video does
not prove its machines have returned to language service. Preserve successful
clips; a user-requested retake is a new intentional job with a new receipt, not
a replay of the film. Do not release held jobs, change owner budgets, cancel work
or issue direct lifecycle commands. Genie and DSG own those operations.
