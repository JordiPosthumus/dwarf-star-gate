"""Add explicit recipe fields to the pinned API; preserve omitted-field defaults.

This changes a new build context only. Never run it against a deployed checkout.
The build must run verify-api-fields.py before installing the candidate image.
"""
import ast
import hashlib
from pathlib import Path
import sys

PATCHES = {
    'acestep/api/job_blocking_generation.py': (
        '8d4325c466bac67341449948cbc601e8c2b07d33e4ac30844b686b3acc8a3242',
        '    result = run_generation_with_optional_sequential_cover_mode(\n',
        '    original_generate_music_fn = generate_music_fn\n'
        '    def generate_music_fn(*args, **kwargs):\n'
        '        # Observe only the actual handlers passed to this invocation. Do not\n'
        '        # infer a loaded LM from the process environment or selected label.\n'
        '        def snapshot():\n'
        '            dit = kwargs.get("dit_handler")\n'
        '            lm = kwargs.get("llm_handler")\n'
        '            dit_init = getattr(dit, "last_init_params", None) or {}\n'
        '            lm_init = getattr(lm, "_last_initialize_config", None) or {}\n'
        '            return {\n'
        '                "dit": {"config_path": dit_init.get("config_path"),\n'
        '                        "initialized": getattr(dit, "model", None) is not None},\n'
        '                "lm": {"model_path": lm_init.get("lm_model_path"),\n'
        '                       "full_model_path": getattr(lm, "_lm_full_model_path", None),\n'
        '                       "initialized": getattr(lm, "llm_initialized", False) is True,\n'
        '                       "passed_to_generator": lm is not None},\n'
        '            }\n'
        '        before = snapshot()\n'
        '        generated = original_generate_music_fn(*args, **kwargs)\n'
        '        after = snapshot()\n'
        '        receipt = {"schema": 1, "source": "acestep.api.generate_music_fn.handlers",\n'
        '                   "before": before, "after": after, "unchanged": before == after}\n'
        '        for audio in getattr(generated, "audios", None) or []:\n'
        '            audio["_stargate_runtime_models"] = __import__("copy").deepcopy(receipt)\n'
        '        return generated\n'
        '\n'
        '    result = run_generation_with_optional_sequential_cover_mode(\n'),
    'acestep/api/http/release_task_models.py': (
        '296c3973a7b51057f5e1fbe16f394d901a6c0492e30b957cf4d9741d4aa1f916',
        '    guidance_scale: float = 7.0\n',
        '    guidance_scale: float = 7.0\n'
        '    sampler_mode: Optional[Literal["euler", "heun"]] = None\n'
        '    dcw_enabled: Optional[bool] = None\n'),
    'acestep/api/http/release_task_request_builder.py': (
        '031ac48cde3c1afb83e0dd05c03bbba5d5c5339b8f2a5577ea373ab28b4f8255',
        '        guidance_scale=parser.float("guidance_scale", 7.0),\n',
        '        guidance_scale=parser.float("guidance_scale", 7.0),\n'
        '        sampler_mode=None if parser.get("sampler_mode") in (None, "") else parser.get("sampler_mode"),\n'
        '        dcw_enabled=None if parser.get("dcw_enabled") in (None, "") else parser.get("dcw_enabled"),\n'),
    'acestep/api/job_generation_setup.py': (
        'f0cc89a5fe6c8760747d31c78b01b41dc0c9c7ddd9de3b6bc6a539b7ac9120d5',
        '        guidance_scale=req.guidance_scale,\n',
        '        guidance_scale=req.guidance_scale,\n'
        '        **({} if req.sampler_mode is None else {"sampler_mode": req.sampler_mode}),\n'
        '        **({} if req.dcw_enabled is None else {"dcw_enabled": req.dcw_enabled}),\n'),
    'acestep/api/job_result_payload.py': (
        '0b77bb060f9412ad7cf479a09f1a5b3ae9461072d0169bd774a0222743763a43',
        '        "raw_audio_paths": list(audio_paths),\n',
        '        "raw_audio_paths": list(audio_paths),\n'
        '        "generation_receipts": {\n'
        '            path_to_audio_url(audio["path"]): {\n'
        '                "schema": 1, "source": "acestep.inference.audio.params",\n'
        '                "parameters": __import__("copy").deepcopy(audio["params"]),\n'
        '                "reported_models": {"lm": lm_model_name, "dit": dit_model_name},\n'
        '                **({"runtime_models": __import__("copy").deepcopy(audio["_stargate_runtime_models"])}\n'
        '                   if isinstance(audio.get("_stargate_runtime_models"), dict) else {}),\n'
        '            } for audio in audios if audio.get("path") and isinstance(audio.get("params"), dict)\n'
        '        },\n'),
    'acestep/api/http/query_result_service.py': (
        '609d4cbc718987af42be2e106550358b200f01682e5ded64670a801eab45c6fd',
        '                    "file": path,\n',
        '                    "file": path,\n'
        '                    **({"generation_receipt": record.result["generation_receipts"][path]}\n'
        '                       if path in record.result.get("generation_receipts", {}) else {}),\n'),
    'acestep/api/jobs/local_cache_updates.py': (
        'dcb2fd1cefc89259b9b601e82632967d6e9a10dcf743a69ad1af3b0d9cf6d171',
        '                        "file": path,\n',
        '                        "file": path,\n'
        '                        **({"generation_receipt": result["generation_receipts"][path]}\n'
        '                           if path in result.get("generation_receipts", {}) else {}),\n'),
}


def apply(root):
    root = Path(root)
    prepared = []
    for name, (sha, anchor, replacement) in PATCHES.items():
        path = root / name
        data = path.read_bytes()
        if hashlib.sha256(data).hexdigest() != sha:
            raise ValueError('Pinned ACE API source differs: ' + name)
        text = data.decode()
        if text.count(anchor) != 1:
            raise ValueError('Pinned ACE API anchor differs: ' + name)
        patched = text.replace(anchor, replacement, 1)
        ast.parse(patched)
        prepared.append((path, patched))
    # Verify every input before writing any output. A partial build failure is
    # never a usable image; the Docker build and verification must both pass.
    for path, patched in prepared:
        path.write_text(patched)
    return {'state': 'patched', 'files': [str(p.relative_to(root)) for p, _ in prepared],
            'scope': 'Explicit API sampler/DCW fields and per-audio native-parameter receipts; omitted defaults and generation inputs preserved.'}


if __name__ == '__main__':
    import json
    print(json.dumps(apply(sys.argv[1] if len(sys.argv) == 2 else '/opt/ace-step')))
