#!/usr/bin/env python3
"""Fixed read-only pair capture with private receipts, separate from enrollment."""
import fcntl
import json
import os
from pathlib import Path
import re
import stat
import sys
from datetime import datetime, timezone

sys.path.insert(0, str(Path(__file__).resolve().parent))
from recovery_pair import fingerprint, require
from recovery_pair_native import capture_pair, private_read, private_save


def folder(raw):
    root = Path(raw)
    info = root.lstat()
    require(root.is_absolute() and stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid()
            and not info.st_mode & 0o077, 'pair_capture_directory_unverified')
    request = private_read(root / 'request.json')
    require(set(request) == {'action_id', 'worker_id', 'created_at', 'binding', 'route'}
            and re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', request['action_id'])
            and request['action_id'] == root.name and request['worker_id'] == request['binding']['worker_id'], 'pair_capture_request_unverified')
    return root, request


def lease(root):
    fd = os.open(root / 'capture.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    info = os.fstat(fd)
    if not (stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and not info.st_mode & 0o077):
        os.close(fd)
        raise ValueError('pair_capture_lock_unverified')
    return fd


def status(root, request):
    try:
        result = private_read(root / 'receipt.json')
        require(result['action_id'] == request['action_id'] and result['worker_id'] == request['worker_id']
                and result['request_hash'] == fingerprint(request), 'pair_capture_receipt_unverified')
        return result
    except FileNotFoundError:
        pass
    fd = lease(root)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            state = 'unverified'  # No live lease proves neither completion nor a safe replay.
        except BlockingIOError:
            state = 'preparing'
    finally:
        os.close(fd)
    return {'action_id': request['action_id'], 'worker_id': request['worker_id'], 'state': state,
            'scope': 'Read-only capture; no enrollment or restart authority. Observe this same action.'}


def run(root, request, capture=capture_pair):
    fd = lease(root)
    try:
        # A simultaneous read-only status probe may briefly hold the lock.
        # Wait for it; a duplicate runner then sees the existing durable claim.
        fcntl.flock(fd, fcntl.LOCK_EX)
        if (root / 'receipt.json').exists():
            return status(root, request)
        # A durable claim prevents replay after lost execution acknowledgement.
        claim = os.open(root / 'capture-intent', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            os.fsync(claim)
        finally:
            os.close(claim)
        parent = os.open(root, os.O_RDONLY)
        try:
            os.fsync(parent)
        finally:
            os.close(parent)
        result = {'action_id': request['action_id'], 'worker_id': request['worker_id'],
                  'request_hash': fingerprint(request), 'created_at': request['created_at']}
        try:
            evidence = capture(request['binding'])
            evidence['route'] = request['route']
            private_save(root / 'evidence.json', evidence)
            result.update(state='prepared', evidence_sha256=fingerprint(evidence), context_length=evidence['enrollment']['context_length'],
                          concurrency=evidence['enrollment']['concurrency'], members=2,
                          scope='Fresh stable pair identity/configuration capture only. Not enrolled, restart-qualified or authorized to mutate.')
        except Exception as error:
            reason = str(error)
            # Retain bounded diagnostics privately; none enter the tool receipt.
            diagnostic = {'type': type(error).__name__, 'message': reason[-8192:]}
            for key in ('stdout', 'stderr'):
                value = getattr(error, key, None)
                if value is not None:
                    diagnostic[key] = (value.decode('utf8', errors='replace') if isinstance(value, bytes) else str(value))[-16384:]
            private_save(root / 'failure.json', diagnostic)
            result.update(state='failed', reason=reason if re.fullmatch(r'pair_[a-z_]+|invalid_pair_[a-z_]+', reason) else 'pair_native_capture_unavailable')
        result['finished_at'] = datetime.now(timezone.utc).isoformat()
        private_save(root / 'receipt.json', result)
        return result
    finally:
        os.close(fd)


def main():
    try:
        require(len(sys.argv) in (2, 3) and (len(sys.argv) == 2 or sys.argv[2] == '--status'), 'pair_capture_invocation_invalid')
        root, request = folder(sys.argv[1])
        result = status(root, request) if len(sys.argv) == 3 else run(root, request)
        print(json.dumps(result))
    except Exception:
        print(json.dumps({'error': 'pair_capture_unverified'}))
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
