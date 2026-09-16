#!/usr/bin/env python3
"""Create a stopped media container; never take over a GPU or enroll a worker."""
import argparse
import json
import os
from pathlib import Path
import subprocess


def create(engine, image, name, models, data, port=None):
    models, data = Path(models).resolve(), Path(data).absolute()
    if not models.is_dir():
        raise ValueError('Install and verify model assets first')
    image_id = subprocess.check_output(['docker', 'image', 'inspect', image, '--format', '{{.Id}}'], text=True).strip()
    data.mkdir(mode=0o700, exist_ok=False)
    native_port = 8002 if engine == 'ace-step' else 8188
    args = ['docker', 'create', '--name', name, '--gpus', 'all', '--ipc=host',
            '--user', f'{os.getuid()}:{os.getgid()}',
            '-p', f'127.0.0.1:{port or native_port}:{native_port}', '-v', f'{data}:/data']
    if engine == 'ace-step':
        args += ['-v', f'{models}:/models/ace-step']
    else:
        args += ['-v', f'{models}:/opt/ComfyUI/models:ro', '-e', 'HOME=/data', '-e', 'HF_HOME=/data/hf-cache']
        for folder in ['input', 'output', 'temp', 'user']:
            (data / folder).mkdir()
            args += ['-v', f'{data / folder}:/opt/ComfyUI/{folder}']
    container = subprocess.check_output(args + [image_id], text=True).strip()
    receipt = {'kind': 'ace-step' if engine == 'ace-step' else 'comfyui', 'image': image_id,
               'container': container, 'port': port or native_port, 'started': False,
               'scope': 'Stopped candidate container. Native qualification and gateway enrollment are separate.'}
    (data / 'container.json').write_text(json.dumps(receipt, indent=2) + '\n')
    return receipt


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('engine', choices=['ace-step', 'h3'])
    parser.add_argument('--image', required=True)
    parser.add_argument('--name', required=True)
    parser.add_argument('--models', type=Path, required=True)
    parser.add_argument('--data', type=Path, required=True, help='New writable private data directory')
    parser.add_argument('--port', type=int)
    args = parser.parse_args()
    print(json.dumps(create(args.engine, args.image, args.name, args.models, args.data, args.port), indent=2))
