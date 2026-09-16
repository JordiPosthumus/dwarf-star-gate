#!/usr/bin/env python3
"""Build the three pinned Spark engines and create stopped containers on an idle host."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import platform
import subprocess
import sys
import uuid

SOURCE = Path(__file__).resolve().parent
ENGINES = ('qwen38-repaired', 'h3', 'ace-step')


def preflight():
    if platform.system() != 'Linux' or platform.machine() not in ('aarch64', 'arm64') or sys.version_info < (3, 12):
        raise ValueError('Run on the idle ARM64 Spark with Python 3.12 or newer.')
    architecture = subprocess.check_output(['docker', 'version', '--format', '{{.Server.Arch}}'], text=True).strip()
    if architecture != 'arm64':
        raise ValueError('The Docker server must be ARM64.')
    gpu = subprocess.check_output(['nvidia-smi', '--query-gpu=name', '--format=csv,noheader'], text=True).strip()
    if not gpu or any('GB10' not in name for name in gpu.splitlines()):
        raise ValueError('This selected build requires the Spark GB10 GPU.')
    active = subprocess.check_output(['nvidia-smi', '--query-compute-apps=pid', '--format=csv,noheader,nounits'], text=True).strip()
    if active:
        raise ValueError('GPU work is active. Leave it running; use an idle new Spark for setup.')


def recipe_hash():
    digest = hashlib.sha256()
    inputs = [SOURCE / name for name in ('setup-spark.py', 'prepare-media.py', 'download-models.py', 'create-media.py', 'create-llm.py')]
    inputs.append(SOURCE.parent / 'server-profiles/qwen38-nvfp4-vllm.json')
    for engine in ENGINES:
        inputs.extend(path for path in (SOURCE / engine).rglob('*') if path.is_file()
                      and '__pycache__' not in path.parts and not path.name.startswith('test_')
                      and (path.suffix in ('.py', '.json', '.lock', '.txt') or path.name == 'Dockerfile' or path.name.startswith('LICENSE') or path.name == 'NOTICE.md'))
    for path in sorted(inputs):
        digest.update(str(path.relative_to(SOURCE.parent)).encode() + b'\0' + path.read_bytes())
    return digest.hexdigest()


class Setup:
    def __init__(self, directory):
        self.root = Path(directory).absolute()
        self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.receipt = self.root / 'setup.json'
        fingerprint = recipe_hash()
        if self.receipt.exists():
            self.state = json.loads(self.receipt.read_text())
            if self.state.get('recipe_sha256') != fingerprint:
                raise ValueError('Recipes changed since this setup began. Existing files are preserved; review before continuing.')
        else:
            if any(self.root.iterdir()):
                raise ValueError('Use an empty setup directory; existing files are preserved.')
            self.state = {'schema': 1, 'id': uuid.uuid4().hex[:12], 'recipe_sha256': fingerprint,
                          'engines': {}, 'state': 'preparing', 'scope': 'Stopped engines only. Native qualification and gateway registration still required.'}
            self.save()

    def save(self):
        self.state['updated_at'] = datetime.now(timezone.utc).isoformat()
        temporary = self.receipt.with_suffix('.tmp')
        temporary.write_text(json.dumps(self.state, indent=2) + '\n')
        temporary.replace(self.receipt)

    def run(self, engine, phase, command):
        self.state.update(state='running', engine=engine, phase=phase, error=None)
        self.save()
        print(f'{engine}: {phase} — see {self.root / "setup.log"}', flush=True)
        with (self.root / 'setup.log').open('a') as log:
            log.write('\n' + json.dumps({'at': self.state['updated_at'], 'engine': engine, 'phase': phase, 'command': command}) + '\n')
            log.flush()
            subprocess.run(command, stdout=log, stderr=subprocess.STDOUT, check=True)

    def prepare(self):
        try:
            for engine in ENGINES:
                preflight()  # Do not build over work that started since the previous engine.
                item = self.state['engines'].setdefault(engine, {})
                folder = self.root / engine
                folder.mkdir(exist_ok=True)
                context = Path(item['context']) if item.get('context') else folder / ('build-' + uuid.uuid4().hex[:8])
                if not item.get('context'):
                    command = ([sys.executable, str(SOURCE / engine / 'prepare.py'), str(context)] if engine == 'qwen38-repaired'
                               else [sys.executable, str(SOURCE / 'prepare-media.py'), engine, str(context)])
                    self.run(engine, 'prepare_sources', command)
                    item['context'] = str(context)
                    self.save()
                if not item.get('image'):
                    iidfile = folder / 'image.id'
                    self.run(engine, 'build_image', ['docker', 'build', '--platform', 'linux/arm64', '--iidfile', str(iidfile), str(context)])
                    item['image'] = iidfile.read_text().strip()
                    self.save()
                inspected = json.loads(subprocess.check_output(['docker', 'image', 'inspect', item['image']], text=True))[0]
                if inspected['Id'] != item['image']:
                    raise ValueError('Recorded image identity differs; preserved for inspection.')
                models, data = folder / 'models', folder / 'data'
                self.run(engine, 'verify_or_download_models', [sys.executable, str(SOURCE / 'download-models.py'), engine, str(models)])
                container_receipt = data / 'container.json'
                if not container_receipt.exists():
                    command = ([sys.executable, str(SOURCE / 'create-llm.py')] if engine == 'qwen38-repaired'
                               else [sys.executable, str(SOURCE / 'create-media.py'), engine])
                    self.run(engine, 'create_stopped_container', command + ['--image', item['image'], '--name', f'stargate-{engine}-{self.state["id"]}', '--models', str(models), '--data', str(data)])
                candidate = json.loads(container_receipt.read_text())
                actual = json.loads(subprocess.check_output(['docker', 'inspect', candidate['container']], text=True))[0]
                if actual['Id'] != candidate['container'] or actual['Image'] != item['image'] or actual['State']['Running']:
                    raise ValueError('Candidate identity or stopped state differs; no container was changed.')
                item.update(container=candidate['container'], models=str(models), data=str(data), state='prepared_stopped')
                self.save()
            self.state.update(state='prepared_stopped', phase='complete', error=None)
            self.save()
            return self.state
        except Exception as error:
            self.state.update(state='failed', error=str(error))
            self.save()
            raise


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', type=Path, help='Private empty setup directory, or the same directory to resume unchanged recipes')
    args = parser.parse_args()
    try:
        preflight()
        result = Setup(args.directory).prepare()
    except Exception as error:
        parser.exit(1, f'Setup stopped: {error}\nExisting services and files were preserved. Inspect setup.json and setup.log where present.\n')
    print(json.dumps(result, indent=2))
