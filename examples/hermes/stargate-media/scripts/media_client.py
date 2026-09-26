#!/usr/bin/env python3
"""Durable DSG client: public media API only; no fleet administration."""
import argparse
from contextlib import contextmanager
import fcntl
import hashlib
import json
import mimetypes
import os
from pathlib import Path
import re
import stat
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

ID = re.compile(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}')
RETURNED = {'returned', 'failed_returned', 'failed_unchanged'}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def base_url(value):
    p = urllib.parse.urlsplit(value)
    if p.scheme not in ('http', 'https') or not p.hostname or p.username or p.password or p.query or p.fragment:
        raise ValueError('Use a gateway HTTP(S) URL without credentials, query or fragment')
    value = value.rstrip('/')
    return value[:-3] if value.endswith('/v1') else value


def atomic(filename, value):
    filename = Path(filename)
    filename.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temp = filename.with_name(filename.name + '.' + str(uuid.uuid4()) + '.tmp')
    try:
        fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as out:
            json.dump(value, out); out.write('\n'); out.flush(); os.fsync(out.fileno())
        os.replace(temp, filename)
        fd = os.open(filename.parent, os.O_RDONLY)
        try: os.fsync(fd)
        finally: os.close(fd)
    finally:
        if temp.exists(): temp.unlink()


def read_receipt(filename):
    fd = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd) as source:
        info = os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ValueError('Receipt must be an owner-only regular file')
        value = json.load(source)
    if value.get('schema') != 1 or value.get('kind') not in ('batch', 'video', 'music', 'upload'):
        raise ValueError('Unknown receipt format; preserve it for inspection')
    base_url(value['gateway'])
    return value


@contextmanager
def receipt_lock(filename):
    filename = Path(filename)
    filename.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd = os.open(str(filename) + '.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ValueError('Receipt lock must be owner-only')
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally: os.close(fd)


def request(gateway, route, *, data=None, key=None, priority=None, content_type='application/json', token=None):
    headers = {'Accept': 'application/json', 'Connection': 'close'}
    token = os.environ.get('SG_API_KEY') if token is None else token
    if token: headers['Authorization'] = 'Bearer ' + token
    if data is not None: headers['Content-Type'] = content_type
    if key: headers['Idempotency-Key'] = key
    if priority: headers['X-DSG-Priority'] = priority
    req = urllib.request.Request(base_url(gateway) + route, data=data, headers=headers)
    return urllib.request.build_opener(NoRedirect()).open(req, timeout=30)


def route_for(receipt):
    identity = receipt.get('id')
    if not isinstance(identity, str) or not ID.fullmatch(identity):
        raise ValueError('Submission is not acknowledged; retry submit with this same receipt')
    resource = {'batch': 'batches', 'video': 'jobs', 'music': 'jobs', 'upload': 'inputs'}[receipt['kind']]
    return '/v1/' + ('music' if receipt['kind'] == 'music' else 'video') + '/' + resource + '/' + identity


def status(receipt):
    with request(receipt['gateway'], route_for(receipt)) as response:
        value = json.load(response)
    if value.get('id') != receipt['id']:
        raise ValueError('Gateway returned a different identity')
    if receipt['kind'] in ('music', 'video') and value.get('kind') != receipt['kind']:
        raise ValueError('Gateway returned a different media kind')
    return value


def submit(gateway, kind, payload, filename, priority='normal'):
    if kind not in ('batch', 'video', 'music') or priority not in ('high', 'normal', 'idle-only'):
        raise ValueError('Use a video, music or batch request and a supported priority')
    gateway = base_url(gateway)
    with receipt_lock(filename):
        file = Path(filename)
        if file.exists():
            receipt = read_receipt(file)
            if (receipt['gateway'], receipt['kind'], receipt.get('payload'), receipt.get('priority', 'normal')) != (gateway, kind, payload, priority):
                raise ValueError('Receipt belongs to another request; do not overwrite it')
            if receipt.get('id'): return status(receipt)
        else:
            receipt = {'schema': 1, 'gateway': gateway, 'kind': kind, 'key': str(uuid.uuid4()), 'payload': payload, 'priority': priority}
            atomic(file, receipt) # Durable before the first network attempt.
        route = '/v1/' + ('music' if kind == 'music' else 'video') + '/' + ('batches' if kind == 'batch' else 'jobs')
        with request(gateway, route, data=json.dumps(payload).encode(), key=receipt['key'], priority=priority) as response:
            value = json.load(response)
        if not isinstance(value.get('id'), str) or not ID.fullmatch(value['id']):
            raise ValueError('Acknowledgement lacks a valid identity; preserve and retry this receipt')
        atomic(file, {**receipt, 'id': value['id']})
        return value


def upload(gateway, file, filename):
    gateway = base_url(gateway); file = Path(file)
    data = file.read_bytes(); digest = hashlib.sha256(data).hexdigest()
    with receipt_lock(filename):
        receipt_file = Path(filename)
        if receipt_file.exists():
            receipt = read_receipt(receipt_file)
            if receipt['kind'] != 'upload' or receipt['gateway'] != gateway or receipt.get('sha256') != digest:
                raise ValueError('Upload receipt belongs to different input; preserve it')
            if receipt.get('id'): return status(receipt)
            raise ValueError('Prior upload acknowledgement is uncertain; do not upload another copy automatically')
        receipt = {'schema': 1, 'gateway': gateway, 'kind': 'upload', 'sha256': digest, 'bytes': len(data)}
        atomic(receipt_file, receipt)
        with request(gateway, '/v1/video/inputs', data=data, content_type=mimetypes.guess_type(file)[0] or 'application/octet-stream') as response:
            value = json.load(response)
        if value.get('sha256') != digest or value.get('bytes') != len(data) or not ID.fullmatch(value.get('id', '')):
            raise ValueError('Upload integrity not confirmed; preserve receipt')
        atomic(receipt_file, {**receipt, 'id': value['id']})
        return value


def brief(value):
    if 'clips' in value:
        return {k: value[k] for k in ('id', 'name', 'state', 'counts', 'held', 'generation_complete', 'restoration_complete', 'status_url') if k in value} | {
            'clips': [brief(c) for c in value['clips']]}
    return {k: value[k] for k in ('id', 'clip_id', 'state', 'dispatch_hold', 'detail', 'generation', 'outputs', 'name', 'sha256', 'bytes', 'content_type') if k in value} | {
        'restoration_phase': value.get('execution', {}).get('phase')}


def finished(value):
    if 'clips' in value: return value.get('state') in ('completed', 'failed', 'needs_attention')
    return bool(value.get('dispatch_hold')) or value.get('state') == 'uncertain' or value.get('execution', {}).get('phase') in RETURNED | {'needs_attention', 'launch_uncertain', 'observation_failed'}


def download(receipt, directory):
    value = status(receipt); directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True, mode=0o700); saved = []
    for job in value.get('clips', [value]):
        if job.get('outputs', {}).get('state') != 'ready': continue
        if not ID.fullmatch(job.get('id', '')): raise ValueError('Invalid output job identity')
        for meta in job['outputs']['files']:
            if not ID.fullmatch(meta.get('id', '')) or not re.fullmatch('[a-f0-9]{64}', meta.get('sha256', '')):
                raise ValueError('Invalid output file identity')
            if type(meta.get('bytes')) is not int or meta['bytes'] < 1 or not isinstance(meta.get('filename'), str):
                raise ValueError('Invalid output file metadata')
            extension = Path(meta['filename']).suffix.lower()
            if not re.fullmatch(r'\.[a-z0-9]{1,8}', extension): extension = '.bin'
            target = directory / (job['id'] + '-' + meta['id'] + extension)
            if target.exists():
                if target.is_symlink() or target.stat().st_size != meta['bytes'] or hashlib.sha256(target.read_bytes()).hexdigest() != meta['sha256']:
                    raise ValueError('Existing output differs; it was preserved')
            else:
                temp = target.with_name(target.name + '.' + str(uuid.uuid4()) + '.part')
                try:
                    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                    digest = hashlib.sha256(); count = 0
                    route = '/v1/' + ('music' if receipt['kind'] == 'music' else 'video') + '/jobs/' + job['id'] + '/files/' + meta['id']
                    with os.fdopen(fd, 'wb') as out, request(receipt['gateway'], route) as response:
                        while chunk := response.read(1024 * 1024):
                            count += len(chunk)
                            if count > meta['bytes']: raise ValueError('Output exceeds its recorded byte count')
                            digest.update(chunk); out.write(chunk)
                        out.flush(); os.fsync(out.fileno())
                    if count != meta['bytes'] or digest.hexdigest() != meta['sha256']:
                        raise ValueError('Output failed byte-count or SHA-256 verification')
                    os.link(temp, target) # Exclusive destination: never replace a concurrent result.
                finally:
                    if temp.exists(): temp.unlink()
            saved.append({'job_id': job['id'], 'clip_id': job.get('clip_id'), 'path': str(target.resolve()), 'sha256': meta['sha256']})
    return {'status': brief(value), 'downloaded': saved}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--gateway', default=os.environ.get('SG_URL', 'http://127.0.0.1:30000'))
    subs = parser.add_subparsers(dest='action', required=True)
    subs.add_parser('capabilities')
    p = subs.add_parser('submit'); p.add_argument('--kind', choices=['batch', 'video', 'music'], default='video'); p.add_argument('--request', required=True); p.add_argument('--receipt', required=True); p.add_argument('--priority', choices=['high', 'normal', 'idle-only'], default='normal')
    p = subs.add_parser('upload'); p.add_argument('--file', required=True); p.add_argument('--receipt', required=True)
    for name in ('status', 'wait', 'download'):
        p = subs.add_parser(name); p.add_argument('--receipt', required=True)
        if name == 'wait': p.add_argument('--seconds', type=int, default=45)
        if name == 'download': p.add_argument('--directory', required=True)
    args = parser.parse_args()
    if args.action == 'capabilities':
        with request(args.gateway, '/v1/video/capabilities') as response: value = json.load(response)
    elif args.action == 'submit': value = brief(submit(args.gateway, args.kind, json.loads(Path(args.request).read_text()), args.receipt, args.priority))
    elif args.action == 'upload': value = upload(args.gateway, args.file, args.receipt)
    else:
        receipt = read_receipt(args.receipt)
        if args.action == 'download': value = download(receipt, args.directory)
        else:
            value = status(receipt)
            if args.action == 'wait':
                if not 0 <= args.seconds <= 60: raise ValueError('Use a bounded wait of 0–60 seconds; repeat to observe the same job')
                end = time.monotonic() + args.seconds
                while not finished(value) and time.monotonic() < end:
                    time.sleep(max(0, min(3, end - time.monotonic()))); value = status(receipt)
            value = brief(value)
    print(json.dumps(value, indent=2))


if __name__ == '__main__':
    try: main()
    except urllib.error.HTTPError as error:
        print(json.dumps({'error': 'Gateway HTTP ' + str(error.code), 'scope': 'Receipt retained. Inspect the same identity; do not create a replacement submission.'})); raise SystemExit(1)
    except (OSError, ValueError, KeyError) as error:
        print(json.dumps({'error': str(error), 'scope': 'Existing receipts and jobs were preserved.'})); raise SystemExit(1)
