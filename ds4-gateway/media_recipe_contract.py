"""Read-only proof of explicit ACE API fields on an exact enrolled container.

Docker cp reads stopped containers. No start, exec, stop, write or generation is
performed. This is an API-wiring witness, not a native audio qualification.
"""
import hashlib
import io
import json
import re
import subprocess
import sys
import tarfile

FILES = ('acestep/constants.py', 'acestep/inference.py',
         'acestep/api/http/release_task_param_parser.py', 'acestep/api/http/release_task_models.py',
         'acestep/api/http/release_task_request_builder.py', 'acestep/api/job_generation_setup.py')
SUPPORTED = {'sampler_mode': ['euler', 'heun'], 'dcw_enabled': [True, False]}


def require(value):
    if not value:
        raise ValueError('ACE recipe field proof is unavailable or changed')


def inspect_recipe(container, image, execute=subprocess.run):
    require(isinstance(container, str) and re.fullmatch(r'[a-f0-9]{64}', container) and
            isinstance(image, str) and re.fullmatch(r'sha256:[a-f0-9]{64}', image))
    def run(args):
        result = execute(['docker', *args], capture_output=True, check=True, timeout=30)
        require(len(result.stdout) <= 8 * 1024 * 1024)
        return result.stdout
    def inspect():
        rows = json.loads(run(['inspect', container]))
        require(isinstance(rows, list) and len(rows) == 1)
        c = rows[0]
        require(c['Id'] == container and c['Image'] == image and c['Config']['WorkingDir'] == '/opt/ace-step')
        return c
    def read(path):
        raw = run(['cp', container + ':' + path, '-'])
        with tarfile.open(fileobj=io.BytesIO(raw)) as archive:
            members = archive.getmembers()
            require(len(members) == 1 and members[0].isfile() and members[0].size <= 8 * 1024 * 1024)
            return archive.extractfile(members[0]).read()
    before = inspect()
    receipt_bytes = read('/opt/stargate/recipe-fields-verification.json')
    receipt = json.loads(receipt_bytes)
    require(receipt.get('schema') == 1 and receipt.get('state') == 'verified' and
            receipt.get('supported') == SUPPORTED and type(receipt.get('checks')) is int and receipt['checks'] >= 52 and
            isinstance(receipt.get('source_sha256'), dict) and set(receipt['source_sha256']) == set(FILES))
    for name in FILES:
        expected = receipt['source_sha256'][name]
        require(isinstance(expected, str) and re.fullmatch(r'[a-f0-9]{64}', expected))
        require(hashlib.sha256(read('/opt/ace-step/' + name)).hexdigest() == expected)
    after = inspect()
    require(all(before[key] == after[key] for key in ('Id', 'Image', 'Config', 'HostConfig', 'Mounts', 'State')))
    return {'schema': 1, 'state': 'verified', 'container': container, 'image': image,
            'supported': SUPPORTED, 'receipt_sha256': hashlib.sha256(receipt_bytes).hexdigest(),
            'source_sha256': receipt['source_sha256'], 'container_state_unchanged': True,
            'scope': 'Read-only build-proof/source binding; not native synthesis or audio fidelity.'}


if __name__ == '__main__':
    try:
        require(len(sys.argv) == 3)
        print(json.dumps(inspect_recipe(*sys.argv[1:])))
    except Exception:
        print(json.dumps({'state': 'unverified', 'reason': 'ACE recipe field support is not proven for this exact image and source.'}))
        sys.exit(1)
