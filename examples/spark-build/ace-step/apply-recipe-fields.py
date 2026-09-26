"""Add explicit recipe fields to the pinned API; preserve omitted-field defaults.

This changes a new build context only. Never run it against a deployed checkout.
The build must run verify-api-fields.py before installing the candidate image.
"""
import ast
import hashlib
from pathlib import Path
import sys

PATCHES = {
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
            'scope': 'Explicit API sampler/DCW fields only; omitted defaults preserved.'}


if __name__ == '__main__':
    import json
    print(json.dumps(apply(sys.argv[1] if len(sys.argv) == 2 else '/opt/ace-step')))
