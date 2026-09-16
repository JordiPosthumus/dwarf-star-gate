#!/usr/bin/env python3
"""Prepare a pinned media build in a new directory (Python 3.12+)."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import tarfile
import urllib.request


ROOT = Path(__file__).resolve().parent


def prepare(engine, destination, archive_cache=None):
    source = ROOT / engine
    manifest = json.loads((source / 'manifest.json').read_text())
    destination = Path(destination).absolute()
    destination.mkdir(mode=0o700, exist_ok=False)
    receipt = {'engine': engine, 'archives': [], 'scope': 'Build inputs only; no server changed.'}
    for item in manifest['archives']:
        archive = destination / (item['name'] + '.tar.gz')
        cached = Path(archive_cache) / archive.name if archive_cache else None
        if cached and cached.is_file():
            shutil.copyfile(cached, archive)
        else:
            request = urllib.request.Request(item['archive_url'], headers={'User-Agent': 'StarGate-build'})
            with urllib.request.urlopen(request, timeout=90) as response, archive.open('xb') as output:
                shutil.copyfileobj(response, output)
        with archive.open('rb') as stream:
            actual = hashlib.file_digest(stream, 'sha256').hexdigest()
        if actual != item['sha256']:
            raise ValueError(f"Source archive hash differs: {item['name']}")
        extracted = destination / item['name']
        extracted.mkdir()
        with tarfile.open(archive) as bundle:
            bundle.extractall(extracted, filter='data')
        children = list(extracted.iterdir())
        if len(children) != 1 or not children[0].is_dir():
            raise ValueError('Unexpected archive layout')
        children[0].rename(destination / (item['name'] + '-src'))
        extracted.rmdir()
        archive.unlink()  # Only our verified copy, never the caller's archive cache.
        receipt['archives'].append(item)
    for path in source.iterdir():
        if path.is_file():
            shutil.copyfile(path, destination / path.name)
    (destination / 'build-receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
    return receipt


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('engine', choices=['ace-step', 'h3'])
    parser.add_argument('destination', type=Path)
    parser.add_argument('--archive-cache', type=Path, help='Optional previously downloaded archives; hashes still checked')
    args = parser.parse_args()
    prepare(args.engine, args.destination, args.archive_cache)
    print(f'Build context prepared at {args.destination}. No image built or server changed.')
