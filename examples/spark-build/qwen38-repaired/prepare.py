#!/usr/bin/env python3
"""Prepare verified Spark image inputs in a NEW folder; never build or launch."""
import argparse
import hashlib
import json
from pathlib import Path
import urllib.request


SOURCE = Path(__file__).resolve().parent


def digest(data):
    return hashlib.sha256(data).hexdigest()


def download(url):
    request = urllib.request.Request(url, headers={'User-Agent': 'StarGate-build-preparation'})
    with urllib.request.urlopen(request, timeout=30) as response:
        data = response.read(4 * 1024 * 1024 + 1)
    if len(data) > 4 * 1024 * 1024:
        raise ValueError('Unexpectedly large build input')
    return data


def prepare(destination, *, fetch=download, source=SOURCE):
    source = Path(source)
    manifest_bytes = (source / 'manifest.json').read_bytes()
    manifest = json.loads(manifest_bytes)
    destination = Path(destination).absolute()
    # Never overwrite a personal checkout or a previous partial preparation.
    destination.mkdir(mode=0o700, parents=False, exist_ok=False)
    receipt = {'manifest_sha256': digest(manifest_bytes), 'files': [],
               'scope': 'Source preparation only. No image build, model download or server action.'}

    def write(relative, data, expected=None):
        relative = Path(relative)
        if relative.is_absolute() or '..' in relative.parts:
            raise ValueError('Invalid build input path')
        if expected is not None and digest(data) != expected:
            raise ValueError(f'Build input hash differs: {relative}')
        path = destination / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open('xb') as output:
            output.write(data)
        receipt['files'].append({'path': relative.as_posix(), 'sha256': digest(data)})

    upstream = manifest['upstream']
    repository = upstream['repository'].removeprefix('https://github.com/')
    for item in upstream['files']:
        data = fetch(f'https://raw.githubusercontent.com/{repository}/{upstream["revision"]}/{item["path"]}')
        write(item['path'], data, item['sha256'])
    dockerfile = (destination / 'Dockerfile.v0.29').read_text()
    old = manifest['upstream_base_line']
    if dockerfile.splitlines().count(old) != 1:
        raise ValueError('The verified upstream base image declaration changed')
    dockerfile = dockerfile.replace(old + '\n', 'FROM ' + manifest['base_image'] + '\n', 1)
    dockerfile += '\n# Retained reasoning/parser repair; exact input hashes are in build-receipt.json.\n'
    for item in manifest['repair_files']:
        data = (source / 'repair' / item['path']).read_bytes()
        write('repair/' + item['path'], data, item['sha256'])
        dockerfile += f'COPY repair/{item["path"]} /usr/local/lib/python3.12/dist-packages/{item["path"]}\n'
    write('Dockerfile', dockerfile.encode())
    for name in ['NOTICE.md', 'LICENSE-APACHE-2.0', 'manifest.json']:
        write('stargate-source/' + name, (source / name).read_bytes())
    # A completion receipt exists only after every required input was verified.
    with (destination / 'build-receipt.json').open('x') as output:
        json.dump(receipt, output, indent=2)
        output.write('\n')
    return receipt


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('destination', type=Path, help='New build directory; its parent must already exist')
    args = parser.parse_args()
    try:
        receipt = prepare(args.destination)
    except Exception as error:
        parser.exit(1, f'Preparation failed: {error}. Any partial folder is preserved; use a new destination.\n')
    print(f'Verified {len(receipt["files"])} build-context files in {args.destination}.')
    print('No image was built and no server was changed. Follow README.md for the separate build and qualification steps.')
