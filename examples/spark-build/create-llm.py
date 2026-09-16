#!/usr/bin/env python3
"""Create a stopped selected-Qwen container from the public settings reference."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess


PROFILE = Path(__file__).resolve().parent.parent / 'server-profiles/qwen38-nvfp4-vllm.json'
ARTIFACTS = {'<CUSTOM_DETERMINISM_KERNEL>': '/opt/llm/kernel-det',
             '<CUSTOM_ASSETS>': '/opt/llm'}


def serving_arguments(profile):
    command = [profile['server_command']['model_path_argument']]
    for flag, value in profile['server_command']['flags'].items():
        if value is True:
            command.append(flag)
        elif value is not False:
            encoded = json.dumps(value, separators=(',', ':')) if isinstance(value, (dict, list)) else str(value)
            if flag.startswith('-cc.'):
                command.append(flag + '=' + encoded)
            else:
                command.extend([flag, encoded])
    environment = {}
    for key, value in profile['container_environment'].items():
        for placeholder, replacement in ARTIFACTS.items():
            value = value.replace(placeholder, replacement)
        if '<' in value or '>' in value:
            raise ValueError(f'Unresolved environment reference: {key}')
        environment[key] = value
    return command, environment


def create(image, name, models, data, port):
    model_dir, data = Path(models).resolve(), Path(data).absolute()
    for required in ['config.json', 'model.safetensors.index.json', 'tokenizer.json']:
        if not (model_dir / required).is_file():
            raise ValueError(f'Install and verify the selected checkpoint first: {required}')
    profile_bytes = PROFILE.read_bytes()
    profile = json.loads(profile_bytes)
    command, environment = serving_arguments(profile)
    inspected = json.loads(subprocess.check_output(['docker', 'image', 'inspect', image], text=True))[0]
    if inspected['Config'].get('Entrypoint') != ['vllm', 'serve']:
        raise ValueError('Expected the selected rebuilt vLLM image entrypoint')
    data.mkdir(mode=0o700, exist_ok=False)
    cache = data / 'cache'
    cache.mkdir()
    runtime = profile['container_runtime_settings']
    args = ['docker', 'create', '--name', name, '--gpus', runtime['gpus'],
            '--ipc', runtime['ipc'], '--shm-size', runtime['shm_size'],
            '--network', runtime['network_mode'], '--restart', runtime['restart_policy'],
            '-p', f'127.0.0.1:{port}:8000', '-v', f'{model_dir}:/models/qwen38:ro',
            '-v', f'{cache}:/root/.cache']
    for value in runtime['security_opt']:
        args += ['--security-opt', value]
    for key, value in environment.items():
        args += ['-e', f'{key}={value}']
    container = subprocess.check_output(args + [inspected['Id']] + command, text=True).strip()
    receipt = {'container': container, 'image': inspected['Id'], 'port': port,
               'profile_sha256': hashlib.sha256(profile_bytes).hexdigest(), 'started': False,
               'scope': 'Stopped candidate with selected serving settings. Native qualification, recovery enrollment and gateway registration are separate.'}
    (data / 'container.json').write_text(json.dumps(receipt, indent=2) + '\n')
    return receipt


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image', required=True)
    parser.add_argument('--name', required=True)
    parser.add_argument('--models', type=Path, required=True)
    parser.add_argument('--data', type=Path, required=True, help='New private data/cache directory')
    parser.add_argument('--port', type=int, default=8001)
    args = parser.parse_args()
    print(json.dumps(create(args.image, args.name, args.models, args.data, args.port), indent=2))
