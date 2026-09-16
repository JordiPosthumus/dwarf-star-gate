#!/usr/bin/env python3
"""Install or verify an engine's pinned model assets, preserving existing files."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import urllib.request


def verify(path, item):
    if path.stat().st_size != item['bytes']:
        return False
    with path.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest() == item['sha256']


def install(manifest, destination, verify_only=False, cache=None):
    root = Path(destination).absolute()
    for item in json.loads(Path(manifest).read_text())['files']:
        relative = Path(item['path'])
        if relative.is_absolute() or '..' in relative.parts:
            raise ValueError('Invalid model path')
        target = root / relative
        if target.exists():
            if not verify(target, item):
                raise ValueError(f'Existing model differs; preserved without replacement: {target}')
            print(f'Verified {relative}', flush=True)
            continue
        if verify_only:
            raise FileNotFoundError(target)
        target.parent.mkdir(parents=True, exist_ok=True)
        partial = target.with_name(target.name + '.stargate-download')
        cached = Path(cache) / relative if cache else None
        if cached and cached.is_file() and not partial.exists() and verify(cached, item):
            print(f'Copying verified cached asset {relative}', flush=True)
            shutil.copyfile(cached, partial)
        elif 'content' in item:
            if not partial.exists():
                with partial.open('xb') as output:
                    output.write(item['content'].encode())
        elif not partial.exists() or partial.stat().st_size != item['bytes']:
            offset = partial.stat().st_size if partial.exists() else 0
            headers = {'User-Agent': 'StarGate-model-setup'}
            if offset:
                headers['Range'] = f'bytes={offset}-'
            request = urllib.request.Request(item['url'], headers=headers)
            print(f'Downloading {relative} ({item["bytes"]:,} bytes; resume {offset:,})', flush=True)
            with urllib.request.urlopen(request, timeout=120) as response:
                append = offset and response.status == 206
                if append and not response.headers.get('Content-Range', '').startswith(f'bytes {offset}-'):
                    raise ValueError('Unexpected resume response')
                with partial.open('ab' if append else 'wb') as output:
                    while chunk := response.read(8 * 1024 * 1024):
                        output.write(chunk)
                    output.flush()
                    os.fsync(output.fileno())
        if not verify(partial, item):
            raise ValueError(f'Download hash differs; partial file retained: {partial}')
        # Atomic publish without overwriting a file created by another process.
        os.link(partial, target)
        partial.unlink()
        print(f'Installed {relative}', flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('engine', choices=['ace-step', 'h3', 'qwen38-repaired'])
    parser.add_argument('destination', type=Path)
    parser.add_argument('--verify-only', action='store_true')
    parser.add_argument('--cache', type=Path, help='Optional existing asset tree; matching files are copied after hash verification')
    args = parser.parse_args()
    install(Path(__file__).resolve().parent / args.engine / 'models.json', args.destination, args.verify_only, args.cache)
